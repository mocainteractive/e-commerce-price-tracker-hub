/**
 * GET /api/scan-runs?limit=20
 *
 * Cronologia delle scansioni con il dettaglio dei task ancora in volo, cosi'
 * la UI puo' mostrare l'avanzamento reale e proporre la raccolta manuale.
 */
import type { Handler } from '@netlify/functions';
import { ok } from './utils/http';
import { withMoca } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';

export const handler: Handler = withMoca(['GET'], async (event, moca, headers) => {
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 20), 1), 50);
  const db = supabaseAdmin();

  const { data: runs } = await db
    .from('pt_scan_runs')
    .select(
      'id, triggered_by, status, products_total, products_done, offers_found, error_message, started_at, finished_at',
    )
    .eq('client_id', moca.clientId)
    .order('started_at', { ascending: false })
    .limit(limit);

  const rows = runs ?? [];

  // Task ancora in attesa, per run: e' il numero che l'utente vuole vedere
  // scendere mentre la scansione procede.
  const pendingByRun = new Map<string, number>();
  if (rows.length > 0) {
    const { data: pending } = await db
      .from('pt_scan_tasks')
      .select('run_id')
      .eq('client_id', moca.clientId)
      .eq('status', 'in_attesa')
      .in(
        'run_id',
        rows.map((r) => r.id as string),
      );

    for (const task of pending ?? []) {
      const runId = task.run_id as string;
      pendingByRun.set(runId, (pendingByRun.get(runId) ?? 0) + 1);
    }
  }

  return ok(
    {
      runs: rows.map((run) => ({ ...run, pendingTasks: pendingByRun.get(run.id as string) ?? 0 })),
    },
    headers,
  );
});
