/**
 * POST /api/scan-start
 *
 * Avvia una scansione prezzi. Accoda i task su DataForSEO e ritorna subito:
 * i risultati arrivano in modo asincrono (postback o `scan-collect`), perche'
 * gli endpoint Google Shopping non hanno modalita' live.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { authed } from './utils/guard';
import { requireWriteAccess } from './utils/session';
import { supabaseAdmin } from './utils/supabase-admin';
import { getDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { startScan } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';

interface RequestBody {
  productIds?: string[];
}

export const handler: Handler = authed(['POST'], async (event, session, headers) => {
  requireWriteAccess(session);

  const db = supabaseAdmin();
  const body = parseBody<RequestBody>(event);

  // Una sola scansione per volta: evita di bruciare credito DataForSEO.
  const { data: running } = await db
    .from('pt_scan_runs')
    .select('id, started_at')
    .eq('client_id', session.clientId)
    .eq('status', 'in_corso')
    .limit(1);

  if (running && running.length > 0) {
    throw new HttpError(
      409,
      'E\' gia\' in corso una scansione per questo cliente. Attendi che termini.',
      'SCAN_IN_PROGRESS',
    );
  }

  const settings = await loadScanSettings(db, session.clientId);
  const credentials = await getDataForSeoCredentials(session.clientId);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const result = await startScan(db, dfs, {
    clientId: session.clientId,
    settings,
    productIds: body.productIds,
    triggeredBy: 'manuale',
    triggeredByUser: session.mock ? null : session.userId,
  });

  return ok({ ...result }, headers);
});
