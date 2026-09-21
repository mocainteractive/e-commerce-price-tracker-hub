/**
 * POST /api/scan-start
 *
 * Avvia una scansione prezzi. Accoda i task su DataForSEO e ritorna subito:
 * i risultati arrivano in modo asincrono (postback o `scan-collect`), perche'
 * gli endpoint Google Shopping non hanno modalita' live.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { startScan } from './utils/scan-runner';
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
    .select('id, started_at')
    .eq('client_id', moca.clientId)
    .eq('status', 'in_corso')
    .limit(1);

  if (running && running.length > 0) {
    throw new HttpError(
      409,
      'E\' gia\' in corso una scansione per questo cliente. Attendi che termini.',
      'SCAN_IN_PROGRESS',
    );
  }

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const result = await startScan(db, dfs, {
    clientId: moca.clientId,
    settings,
    productIds: body.productIds,
    triggeredBy: 'manuale',
    triggeredByUser: moca.userId || null,
  });

  return ok({ ...result }, headers);
});
