/**
 * GET  /api/scan-runs?limit=20 -> cronologia delle scansioni
 * POST /api/scan-runs          -> azioni sulla cronologia
 *
 * Azioni POST:
 *   { action: 'stop',   runId }  chiude una scansione in corso come parziale
 *   { action: 'delete', runId }  elimina una scansione conclusa
 *   { action: 'clear' }          elimina tutte le scansioni concluse
 *
 * Le azioni esistono perche' una scansione puo' restare aperta se il browser
 * viene chiuso a meta': senza un modo per interromperla, il pulsante Avvia
 * scansione resterebbe disabilitato fino alla chiusura automatica (2 ore).
 *
 * Eliminare una run non tocca i prezzi rilevati: match e storico restano,
 * gli avvisi perdono solo il riferimento alla scansione.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';

interface PostBody {
  action?: 'stop' | 'delete' | 'clear';
  runId?: string;
}

export const handler: Handler = withMoca(['GET', 'POST'], async (event, moca, headers) => {
  const db = supabaseAdmin();

  if (event.httpMethod === 'POST') {
    requireWriteAccess(moca);
    await applyAction(moca.clientId, parseBody<PostBody>(event));
  }

  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 20), 1), 50);

  const base =
    'id, triggered_by, status, products_total, products_done, offers_found, error_message, started_at, finished_at';

  // `search_source` esiste dalla migration 0003: senza, si legge il resto.
  let rows: Array<Record<string, unknown>> = [];
  const full = await db
    .from('pt_scan_runs')
    .select(`${base}, search_source`)
    .eq('client_id', moca.clientId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (!full.error) {
    rows = (full.data ?? []) as Array<Record<string, unknown>>;
  } else {
    const { data } = await db
      .from('pt_scan_runs')
      .select(base)
      .eq('client_id', moca.clientId)
      .order('started_at', { ascending: false })
      .limit(limit);
    rows = (data ?? []) as Array<Record<string, unknown>>;
  }

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

async function applyAction(clientId: string, body: PostBody): Promise<void> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  if (body.action === 'stop') {
    if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

    const { data, error } = await db
      .from('pt_scan_runs')
      .update({ status: 'parziale', finished_at: now, error_message: 'Interrotta dall\'utente' })
      .eq('id', body.runId)
      .eq('client_id', clientId)
      .eq('status', 'in_corso')
      .select('id');

    if (error) throw new HttpError(500, `Interruzione non riuscita: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(404, 'Nessuna scansione in corso con questo identificativo');

    // I task Shopping ancora in volo non devono riaprire la run: si chiudono.
    await db
      .from('pt_scan_tasks')
      .update({ status: 'errore', error_message: 'Scansione interrotta dall\'utente', completed_at: now })
      .eq('run_id', body.runId)
      .eq('status', 'in_attesa');
    return;
  }

  if (body.action === 'delete') {
    if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

    const { error } = await db
      .from('pt_scan_runs')
      .delete()
      .eq('id', body.runId)
      .eq('client_id', clientId)
      .neq('status', 'in_corso');

    if (error) throw new HttpError(500, `Eliminazione non riuscita: ${error.message}`);
    return;
  }

  if (body.action === 'clear') {
    const { error } = await db
      .from('pt_scan_runs')
      .delete()
      .eq('client_id', clientId)
      .neq('status', 'in_corso');

    if (error) throw new HttpError(500, `Svuotamento non riuscito: ${error.message}`);
    return;
  }

  throw new HttpError(400, 'Azione non riconosciuta');
}
