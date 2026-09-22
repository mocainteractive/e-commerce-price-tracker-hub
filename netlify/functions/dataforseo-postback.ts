/**
 * POST /api/dataforseo-postback?secret=...&endpoint=...&id=...
 *
 * Callback chiamato da DataForSEO quando un task e' pronto.
 *
 * E' l'unico endpoint pubblico dell'app: non puo' avere una sessione utente,
 * quindi e' protetto da un segreto condiviso (`DATAFORSEO_POSTBACK_SECRET`)
 * incluso nell'URL di postback. Il segreto viene confrontato a tempo costante.
 *
 * Non ci fidiamo del corpo della richiesta: dal payload leggiamo solo l'id del
 * task, poi risaliamo a cliente e prodotto dalla nostra tabella `pt_scan_tasks`
 * e rileggiamo il risultato da DataForSEO con le nostre credenziali.
 */
import type { Handler, HandlerEvent } from '@netlify/functions';
import { timingSafeEqual } from 'node:crypto';
import { fail, json, withHttp } from './utils/http';
import { supabaseAdmin } from './utils/supabase-admin';
import { loadDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { addOffersFound, processTask, refreshRunStatus, type TaskRow } from './utils/scan-processing';
import { loadScanSettings } from './utils/scan-settings';
import { raccogliRicerche } from './utils/serp-tasks';
import { resolveAiCredentials } from './utils/client-config';

export const handler: Handler = withHttp(['POST'], async (event, headers) => {
  const avvio = Date.now();
  if (!isAuthorized(event)) {
    // Nessun dettaglio: non confermiamo neppure l'esistenza dell'endpoint.
    return fail(404, 'Non trovato', headers);
  }

  const taskId = extractTaskId(event);
  if (!taskId) return fail(400, 'Identificativo del task mancante', headers);

  const db = supabaseAdmin();

  const { data: task } = await db
    .from('pt_scan_tasks')
    .select('id, client_id, run_id, product_id, dfs_task_id, endpoint, status')
    .eq('dfs_task_id', taskId)
    .maybeSingle();

  if (!task) {
    console.warn(`[postback] Task sconosciuto: ${taskId}`);
    return json(200, { success: true, ignored: 'task sconosciuto' }, headers);
  }

  // DataForSEO puo' consegnare lo stesso postback piu' volte.
  if (task.status !== 'in_attesa') {
    return json(200, { success: true, ignored: 'gia elaborato' }, headers);
  }

  const settings = await loadScanSettings(db, task.client_id as string);
  const credentials = await loadDataForSeoCredentials(task.client_id as string);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  // Ricerca SERP: si raccolgono le ricerche di QUEL prodotto (principale ed
  // EAN insieme), con lettura delle schede e verifica AI.
  if (task.endpoint === 'serp') {
    const ai = settings.ai_match_enabled ? await resolveAiCredentials(task.client_id as string, null) : null;
    const esito = await raccogliRicerche(db, dfs, {
      clientId: task.client_id as string,
      runId: task.run_id as string,
      settings,
      ai,
      deadline: avvio + 8000,
      productIds: [task.product_id as string],
    });
    return json(200, { success: true, offers: esito.offerte, elaborati: esito.elaborati }, headers);
  }

  const offers = await processTask(db, dfs, task as unknown as TaskRow, settings);

  await addOffersFound(db, task.run_id as string, offers);
  await refreshRunStatus(db, task.run_id as string);

  return json(200, { success: true, offers }, headers);
});

function isAuthorized(event: HandlerEvent): boolean {
  const expected = process.env.DATAFORSEO_POSTBACK_SECRET;
  const provided = event.queryStringParameters?.secret;
  if (!expected || !provided) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // timingSafeEqual richiede buffer della stessa lunghezza.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * L'id del task arriva nella query string (`&id=$id`, sostituito da
 * DataForSEO). Il corpo lo riporta comunque: lo usiamo come riserva.
 */
function extractTaskId(event: HandlerEvent): string | null {
  const fromQuery = event.queryStringParameters?.id;
  if (fromQuery && fromQuery !== '$id') return fromQuery;

  try {
    const payload = JSON.parse(event.body ?? '{}') as { tasks?: Array<{ id?: string }> };
    return payload.tasks?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
