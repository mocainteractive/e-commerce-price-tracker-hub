/**
 * POST /api/scan-collect
 *
 * Raccoglie i risultati dei task DataForSEO ancora in attesa.
 * E' il percorso di riserva del postback: se il callback non arriva (rete,
 * deploy in corso, URL pubblica non configurata) la UI puo' sempre forzare
 * la raccolta da qui.
 *
 * Idempotente: un task gia' elaborato non viene rielaborato.
 */
import type { Handler } from '@netlify/functions';
import { ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { collectPendingTasks } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';

interface RequestBody {
  runId?: string;
  /** Quanti task elaborare in questa chiamata (il timeout e' 26s). */
  maxTasks?: number;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  // Raccogliere i risultati scrive match e snapshot: e' una modifica.
  requireWriteAccess(moca);

  const db = supabaseAdmin();
  const body = parseBody<RequestBody>(event);

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  const result = await collectPendingTasks(db, dfs, moca.clientId, settings, {
    runId: body.runId,
    maxTasks: Math.min(body.maxTasks ?? 30, 60),
  });

  return ok({ ...result }, headers);
});
