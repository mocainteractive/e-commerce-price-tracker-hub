/**
 * POST /api/scan-start
 *
 * Crea la scansione e accoda il PRIMO lotto di prodotti su DataForSEO.
 * Restituisce `remaining`: il browser richiama `scan-enqueue` finche' non
 * arriva a zero.
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

  const { data: run, error: runError } = await db
    .from('pt_scan_runs')
    .insert({
      client_id: moca.clientId,
      triggered_by: 'manuale',
      triggered_by_user: moca.userId || null,
      products_total: productsTotal,
      status: 'in_corso',
    })
    .select('id')
    .single();

  if (runError || !run) {
    console.error('[scan-start] Creazione run fallita:', runError?.message);
    throw new HttpError(500, `Impossibile avviare la scansione: ${runError?.message ?? 'errore sconosciuto'}`);
  }

  const runId = run.id as string;

  // Con la SERP organica non c'e' nulla da accodare: la ricerca e' sincrona
  // e il browser chiama direttamente `scan-serp` lotto dopo lotto.
  if (settings.search_source === 'serp') {
    return ok(
      {
        runId,
        productsTotal,
        fonte: 'serp',
        enqueued: 0,
        tasksCreated: 0,
        nextOffset: 0,
        remaining: productsTotal,
        cercaAncheEan: settings.search_gtin_pass,
      },
      headers,
    );
  }

  const batch = await enqueueBatch(db, dfs, {
    clientId: moca.clientId,
    runId,
    settings,
    productIds: body.productIds,
    offset: 0,
  });

  return ok(
    {
      runId,
      productsTotal,
      fonte: settings.search_source,
      enqueued: batch.enqueued,
      tasksCreated: batch.tasksCreated,
      nextOffset: batch.nextOffset,
      remaining: Math.max(productsTotal - batch.nextOffset, 0),
      batchSize: PRODUCTS_PER_CALL,
      cercaAncheEan: settings.search_gtin_pass,
    },
    headers,
  );
});
