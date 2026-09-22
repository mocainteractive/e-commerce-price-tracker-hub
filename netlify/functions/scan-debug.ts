/**
 * POST /api/scan-debug
 *
 * Esegue la ricerca su UN prodotto e restituisce tutto quello che succede:
 * la query inviata, i risultati grezzi, il punteggio di ogni candidato e il
 * motivo per cui e' stato tenuto o scartato.
 *
 * Non scrive nulla. Serve a rispondere alla domanda che altrimenti resta
 * senza risposta: "la scansione non ha trovato niente, perche'?". Senza
 * questo si finisce a indovinare, e su un motore di matching indovinare
 * non porta da nessuna parte.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { loadScanSettings } from './utils/scan-settings';
import { caricaContestoDomini, caricaEsclusiProdotto, scansionaProdotto } from './utils/serp-scan';
import type { ProductRow } from './utils/scan-processing';
import { MATCH_MIN_SCORE } from './utils/matching';

interface RequestBody {
  productId: string;
  cercaAncheEan?: boolean;
  /** Se true salva le offerte trovate invece di limitarsi a mostrarle. */
  salva?: boolean;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  const body = parseBody<RequestBody>(event);
  if (!body.productId) throw new HttpError(400, 'Identificativo prodotto mancante');

  const db = supabaseAdmin();

  const { data: product } = await db
    .from('pt_products')
    .select('id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id')
    .eq('id', body.productId)
    .eq('client_id', moca.clientId)
    .maybeSingle();

  if (!product) throw new HttpError(404, 'Prodotto non trovato');

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const contesto = await caricaContestoDomini(db, moca.clientId);
  const esclusi = await caricaEsclusiProdotto(db, body.productId);

  const diagnostica = await scansionaProdotto(
    db,
    dfs,
    product as ProductRow,
    settings,
    { ownDomains: contesto.ownDomains, excludedDomains: esclusi },
    {
      soloDiagnostica: body.salva !== true,
      cercaAncheEan: body.cercaAncheEan ?? true,
    },
  );

  return ok(
    {
      diagnostica,
      impostazioni: {
        paese: settings.location_code,
        lingua: settings.language_code,
        sogliaMatch: MATCH_MIN_SCORE,
      },
      salvato: body.salva === true,
    },
    headers,
  );
});
