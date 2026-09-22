/**
 * POST /api/scan-serp
 *
 * Analizza un lotto di prodotti sulla SERP organica e salva subito le offerte
 * trovate. E' il percorso principale della scansione, perche' sincrono: al
 * termine della chiamata i prezzi sono gia' nel database.
 *
 * Il browser ripete con `offset` crescente finche' `remaining` non e' zero.
 * Il lotto e' piccolo perche' ogni prodotto e' una ricerca live su DataForSEO
 * (qualche secondo), e la funzione ha ~10 secondi.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { loadScanSettings } from './utils/scan-settings';
import {
  caricaContestoDomini,
  caricaEsclusiProdotto,
  scansionaProdotto,
  type ProdottoDiagnostica,
} from './utils/serp-scan';
import { refreshRunStatus, addOffersFound, type ProductRow } from './utils/scan-processing';

/**
 * Tetto massimo di prodotti per chiamata.
 *
 * Il numero reale lo decide il budget di tempo qui sotto, non questa
 * costante: una ricerca live su DataForSEO puo' durare da uno a sette
 * secondi, quindi un numero fisso o spreca tempo o supera il limite della
 * piattaforma. Con tre ricerche fisse la funzione veniva uccisa da Netlify e
 * al browser arrivava un 502 senza spiegazione.
 */
export const MAX_PRODOTTI_PER_CHIAMATA = 4;

/**
 * Budget di lavoro, sotto i ~10 secondi della piattaforma.
 * Almeno un prodotto viene sempre analizzato, altrimenti il ciclo del
 * browser non avanzerebbe mai.
 */
const BUDGET_MS = 6500;

interface RequestBody {
  runId: string;
  offset?: number;
  productIds?: string[];
  cercaAncheEan?: boolean;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

  const iniziatoAlle = Date.now();
  const db = supabaseAdmin();
  const offset = Math.max(Number(body.offset) || 0, 0);

  const { data: run } = await db
    .from('pt_scan_runs')
    .select('id, status, products_total')
    .eq('id', body.runId)
    .eq('client_id', moca.clientId)
    .maybeSingle();

  if (!run) throw new HttpError(404, 'Scansione non trovata');

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const columns =
    'id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id';

  let query = db
    .from('pt_products')
    .select(columns)
    .eq('client_id', moca.clientId)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .range(offset, offset + MAX_PRODOTTI_PER_CHIAMATA - 1);

  if (body.productIds?.length) {
    query = db
      .from('pt_products')
      .select(columns)
      .eq('client_id', moca.clientId)
      .in('id', body.productIds)
      .order('id', { ascending: true })
      .range(offset, offset + MAX_PRODOTTI_PER_CHIAMATA - 1);
  }

  const { data: products, error } = await query;
  if (error) throw new HttpError(500, `Lettura catalogo non riuscita: ${error.message}`);

  const lotto = (products ?? []) as ProductRow[];

  if (lotto.length === 0) {
    await refreshRunStatus(db, body.runId);
    return ok({ analizzati: 0, offerte: 0, nextOffset: offset, remaining: 0, diagnostiche: [] }, headers);
  }

  const contesto = await caricaContestoDomini(db, moca.clientId);
  const diagnostiche: ProdottoDiagnostica[] = [];
  let offerte = 0;
  let analizzati = 0;

  for (const product of lotto) {
    // Il primo prodotto si fa sempre; dagli altri in poi solo se resta tempo.
    if (analizzati > 0 && Date.now() - iniziatoAlle > BUDGET_MS) break;

    const esclusi = await caricaEsclusiProdotto(db, product.id);

    const diagnostica = await scansionaProdotto(
      db,
      dfs,
      product,
      settings,
      { ownDomains: contesto.ownDomains, excludedDomains: esclusi },
      { runId: body.runId, cercaAncheEan: body.cercaAncheEan ?? false },
    );

    diagnostiche.push(diagnostica);
    offerte += diagnostica.offerteSalvate;
    analizzati += 1;
  }

  const done = offset + analizzati;

  await db
    .from('pt_scan_runs')
    .update({ products_done: done })
    .eq('id', body.runId);

  await addOffersFound(db, body.runId, offerte);

  const remaining = Math.max((run.products_total as number) - done, 0);
  if (remaining === 0) await refreshRunStatus(db, body.runId);

  return ok(
    {
      analizzati,
      offerte,
      nextOffset: done,
      remaining,
      // Solo un riassunto: la diagnostica completa sta in /api/scan-debug.
      diagnostiche: diagnostiche.map((d) => ({
        titolo: d.titolo,
        query: d.query.map((q) => q.query),
        risultati: d.query.reduce((sum, q) => sum + q.risultatiTotali, 0),
        conPrezzo: d.query.reduce((sum, q) => sum + q.conPrezzo, 0),
        accettati: d.query.reduce((sum, q) => sum + q.candidati.filter((c) => c.accettato).length, 0),
        offerteSalvate: d.offerteSalvate,
        errore: d.query.find((q) => q.errore)?.errore ?? null,
      })),
    },
    headers,
  );
});
