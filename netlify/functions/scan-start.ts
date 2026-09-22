/**
 * POST /api/scan-start
 *
 * Crea la scansione. Con la fonte SERP non c'e' nulla da accodare: il browser
 * chiama `scan-serp` un prodotto per volta. Con Google Shopping accoda il
 * primo lotto di task e il browser prosegue con `scan-enqueue`. Con
 * "entrambe" fa le due cose.
 *
 * Perche' a lotti: accodare significa una chiamata HTTP a DataForSEO ogni
 * 100 prodotti, e su un catalogo grande la somma supererebbe i ~10 secondi
 * delle Netlify Functions. Il browser non ha quel limite, quindi e' lui a
 * scorrere il catalogo.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { enqueueBatch, PRODUCTS_PER_CALL } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';
import { createRun } from './utils/scan-processing';
import { accodaRicerche } from './utils/serp-tasks';

interface RequestBody {
  productIds?: string[];
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const db = supabaseAdmin();
  const body = parseBody<RequestBody>(event);

  // Una sola scansione per volta: evita di bruciare credito DataForSEO.
  const { data: running } = await db
    .from('pt_scan_runs')
    .select('id')
    .eq('client_id', moca.clientId)
    .eq('status', 'in_corso')
    .limit(1);

  if (running && running.length > 0) {
    throw new HttpError(
      409,
      'E\' gia\' in corso una scansione per questo cliente. Attendi che termini oppure raccogline i risultati.',
      'SCAN_IN_PROGRESS',
    );
  }

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  // Quanti prodotti verranno analizzati in totale.
  const { count: total } = await db
    .from('pt_products')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', moca.clientId)
    .eq('is_active', true);

  const productsTotal = Math.min(total ?? 0, settings.max_products_per_scan);

  if (productsTotal === 0) {
    throw new HttpError(
      400,
      'Nessun prodotto da analizzare. Importa prima il catalogo dalla sezione Catalogo.',
      'EMPTY_CATALOG',
    );
  }

  const runId = await createRun(db, {
    clientId: moca.clientId,
    triggeredBy: 'manuale',
    triggeredByUser: moca.userId || null,
    productsTotal,
    searchSource: settings.search_source,
  });

  const fonte = settings.search_source;
  const usaSerp = fonte === 'serp' || fonte === 'entrambe';
  const usaShopping = fonte === 'shopping' || fonte === 'entrambe';

  let enqueued = 0;
  let tasksCreated = 0;
  let nextOffset = 0;
  let serpPosted = 0;

  // Il primo lotto di ricerche SERP parte subito: cosi' i risultati iniziano
  // ad arrivare mentre il browser accoda il resto.
  if (usaSerp) {
    const serp = await accodaRicerche(db, dfs, {
      clientId: moca.clientId,
      runId,
      settings,
      productsTotal,
      priority: 2,
    });
    serpPosted = serp.prossimoOffset;
  }

  if (usaShopping) {
    const batch = await enqueueBatch(db, dfs, {
      clientId: moca.clientId,
      runId,
      settings,
      productIds: body.productIds,
      offset: 0,
    });
    enqueued = batch.enqueued;
    tasksCreated = batch.tasksCreated;
    nextOffset = batch.nextOffset;
  }

  return ok(
    {
      runId,
      productsTotal,
      fonte,
      // Parte SERP: prodotti gia' accodati e quanti restano da accodare.
      serpPosted,
      serpRemaining: usaSerp ? Math.max(productsTotal - serpPosted, 0) : 0,
      usaSerp,
      // Cursore della parte Google Shopping (asincrona, a lotti).
      enqueued,
      tasksCreated,
      nextOffset,
      remaining: usaShopping ? Math.max(productsTotal - nextOffset, 0) : 0,
      batchSize: PRODUCTS_PER_CALL,
      cercaAncheEan: settings.search_gtin_pass,
    },
    headers,
  );
});
