/**
 * POST /api/scan-serp
 *
 * Analizza un prodotto sulla SERP organica e salva subito le offerte
 * trovate. E' il percorso principale della scansione, perche' sincrono: al
 * termine della chiamata i prezzi sono gia' nel database.
 *
 * Il browser ripete con `offset` crescente finche' `remaining` non e' zero.
 *
 * Un prodotto per chiamata, con una scadenza: una ricerca live costa qualche
 * secondo, la lettura delle schede e la verifica AI altri, e la funzione ne
 * ha ~10. Prima erano tre prodotti in sequenza senza alcun timeout, e bastava
 * una ricerca lenta perche' la piattaforma uccidesse la funzione e il
 * browser ricevesse un 502 senza diagnostica.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveAiCredentials, resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { loadScanSettings } from './utils/scan-settings';
import {
  caricaContestoDomini,
  caricaEsclusiProdotto,
  riassumi,
  scansionaProdotto,
} from './utils/serp-scan';
import { addOffersFound, refreshRunStatus, type ProductRow } from './utils/scan-processing';

/** Prodotti per chiamata. */
export const PRODOTTI_PER_CHIAMATA = 1;

/** Entro questo istante dall'avvio la risposta deve partire. */
const BUDGET_MS = 8500;

interface RequestBody {
  runId: string;
  offset?: number;
  productIds?: string[];
  cercaAncheEan?: boolean;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  const avvio = Date.now();
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

  const db = supabaseAdmin();
  const offset = Math.max(Number(body.offset) || 0, 0);

  const { data: run } = await db
    .from('pt_scan_runs')
    .select('id, status, products_total')
    .eq('id', body.runId)
    .eq('client_id', moca.clientId)
    .maybeSingle();

  if (!run) throw new HttpError(404, 'Scansione non trovata');
  if (run.status !== 'in_corso') {
    return ok({ analizzati: 0, offerte: 0, nextOffset: offset, remaining: 0, diagnostiche: [], closed: true }, headers);
  }

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);
  const ai = settings.ai_match_enabled ? await resolveAiCredentials(moca.clientId, moca.ai) : null;

  const columns =
    'id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id';

  let query = db
    .from('pt_products')
    .select(columns)
    .eq('client_id', moca.clientId)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .range(offset, offset + PRODOTTI_PER_CHIAMATA - 1);

  if (body.productIds?.length) {
    query = db
      .from('pt_products')
      .select(columns)
      .eq('client_id', moca.clientId)
      .in('id', body.productIds)
      .order('id', { ascending: true })
      .range(offset, offset + PRODOTTI_PER_CHIAMATA - 1);
  }

  const { data: products, error } = await query;
  if (error) throw new HttpError(500, `Lettura catalogo non riuscita: ${error.message}`);

  const lotto = (products ?? []) as ProductRow[];
  const total = run.products_total as number;

  if (lotto.length === 0) {
    // Il catalogo e' finito prima del totale previsto (prodotti disattivati
    // nel frattempo): si chiude la run al punto raggiunto.
    await db.from('pt_scan_runs').update({ products_done: total }).eq('id', body.runId);
    await refreshRunStatus(db, body.runId);
    return ok({ analizzati: 0, offerte: 0, nextOffset: offset, remaining: 0, diagnostiche: [] }, headers);
  }

  const contesto = await caricaContestoDomini(db, moca.clientId);
  const diagnostiche = [];
  let offerte = 0;

  for (const product of lotto) {
    const esclusi = await caricaEsclusiProdotto(db, product.id);

    const diagnostica = await scansionaProdotto(
      db,
      dfs,
      product,
      settings,
      { ownDomains: contesto.ownDomains, excludedDomains: esclusi },
      {
        runId: body.runId,
        cercaAncheEan: body.cercaAncheEan ?? settings.search_gtin_pass,
        deadline: avvio + BUDGET_MS,
        ai,
        pagePrices: settings.serp_page_prices,
      },
    );

    diagnostiche.push(riassumi(diagnostica));
    offerte += diagnostica.offerteSalvate;
  }

  const done = Math.min(offset + lotto.length, total);

  await db.from('pt_scan_runs').update({ products_done: done }).eq('id', body.runId);
  await addOffersFound(db, body.runId, offerte);

  const remaining = Math.max(total - done, 0);
  if (remaining === 0) await refreshRunStatus(db, body.runId);

  return ok(
    {
      analizzati: lotto.length,
      offerte,
      nextOffset: done,
      remaining,
      aiAttiva: ai !== null,
      elapsedMs: Date.now() - avvio,
      // Solo un riassunto: la diagnostica completa sta in /api/scan-debug.
      diagnostiche,
    },
    headers,
  );
});
