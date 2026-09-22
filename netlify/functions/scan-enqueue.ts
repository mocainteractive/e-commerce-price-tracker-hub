/**
 * POST /api/scan-enqueue
 *
 * Accoda il lotto successivo di prodotti su una scansione gia' aperta.
 * Il browser lo richiama finche' `remaining` non arriva a zero.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { enqueueBatch } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';

interface RequestBody {
  runId: string;
  offset: number;
  productIds?: string[];
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

  const db = supabaseAdmin();

  // La run deve essere di questo cliente ed essere ancora aperta.
  const { data: run } = await db
    .from('pt_scan_runs')
    .select('id, status, products_total')
    .eq('id', body.runId)
    .eq('client_id', moca.clientId)
    .maybeSingle();

  if (!run) throw new HttpError(404, 'Scansione non trovata');
  if (run.status !== 'in_corso') {
    return ok({ enqueued: 0, tasksCreated: 0, nextOffset: 0, remaining: 0, closed: true }, headers);
  }

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const batch = await enqueueBatch(db, dfs, {
    clientId: moca.clientId,
    runId: body.runId,
    settings,
    productIds: body.productIds,
    offset: Math.max(Number(body.offset) || 0, 0),
  });

  return ok(
    {
      enqueued: batch.enqueued,
      tasksCreated: batch.tasksCreated,
      nextOffset: batch.nextOffset,
      remaining: Math.max((run.products_total as number) - batch.nextOffset, 0),
    },
    headers,
  );
});
