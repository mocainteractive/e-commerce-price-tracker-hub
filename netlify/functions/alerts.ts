/**
 * GET  /api/alerts?onlyUnread=true&limit=50 -> elenco alert
 * POST /api/alerts { ids: [...] | all: true } -> segna come letti
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { authed } from './utils/guard';
import { requireWriteAccess } from './utils/session';
import { supabaseAdmin } from './utils/supabase-admin';

interface PostBody {
  ids?: string[];
  all?: boolean;
}

export const handler: Handler = authed(['GET', 'POST'], async (event, session, headers) => {
  const db = supabaseAdmin();

  if (event.httpMethod === 'POST') {
    requireWriteAccess(session);
    const body = parseBody<PostBody>(event);

    let query = db.from('pt_alerts').update({ is_read: true }).eq('client_id', session.clientId);
    if (!body.all) {
      if (!body.ids?.length) throw new HttpError(400, 'Nessun alert indicato');
      query = query.in('id', body.ids.slice(0, 500));
    } else {
      query = query.eq('is_read', false);
    }

    const { error } = await query;
    if (error) {
      console.error('[alert] Aggiornamento fallito:', error.message);
      throw new HttpError(500, 'Aggiornamento degli alert non riuscito');
    }
  }

  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 50), 1), 200);
  let query = db
    .from('pt_alerts')
    .select('id, kind, domain, message, own_price, competitor_price, delta_pct, is_read, created_at, product_id')
    .eq('client_id', session.clientId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (event.queryStringParameters?.onlyUnread === 'true') {
    query = query.eq('is_read', false);
  }

  const { data: alerts } = await query;
  return ok({ alerts: alerts ?? [] }, headers);
});
