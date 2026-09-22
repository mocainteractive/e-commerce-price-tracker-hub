/**
 * POST /api/catalog-finalize
 *
 * Chiude un import "sostitutivo": disattiva i prodotti che l'import appena
 * concluso non ha toccato.
 *
 * Il criterio e' il timestamp: tutto cio' che non e' stato aggiornato da
 * quando l'import e' iniziato non era nella sorgente. Cosi' non serve spedire
 * l'elenco completo degli SKU, che con qualche migliaio di prodotti non
 * starebbe in una richiesta.
 *
 * L'istante di inizio lo fornisce QUESTO server (`{ begin: true }`), non il
 * browser: `updated_at` viene scritto dal database, e un PC con l'orologio
 * avanti di un minuto avrebbe fatto disattivare anche i prodotti appena
 * salvati.
 *
 * Lavora a blocchi e dice quanti ne restano, in modo che ogni chiamata resti
 * breve anche su cataloghi grandi.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';

const CHUNK = 300;

interface RequestBody {
  /** Se true restituisce solo l'istante corrente del server. */
  begin?: boolean;
  /** ISO 8601: istante di inizio dell'import, ottenuto con `begin`. */
  startedAt?: string;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);

  if (body.begin) {
    return ok({ startedAt: new Date().toISOString() }, headers);
  }

  const startedAt = body.startedAt ? new Date(body.startedAt) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    throw new HttpError(400, 'Istante di inizio import mancante o non valido');
  }
  // Un istante nel futuro non puo' venire da `begin`: sarebbe l'orologio del
  // browser, e disattiverebbe tutto il catalogo.
  if (startedAt.getTime() > Date.now() + 5000) {
    throw new HttpError(400, 'Istante di inizio import non valido: richiedilo al server con begin');
  }

  const db = supabaseAdmin();

  const { data: stale, error } = await db
    .from('pt_products')
    .select('id')
    .eq('client_id', moca.clientId)
    .eq('is_active', true)
    .lt('updated_at', startedAt.toISOString())
    .limit(CHUNK + 1);

  if (error) {
    console.error('[catalog-finalize] Lettura fallita:', error.message);
    throw new HttpError(500, `Impossibile completare l'import: ${error.message}`);
  }

  const rows = stale ?? [];
  if (rows.length === 0) return ok({ deactivated: 0, remaining: 0 }, headers);

  const batch = rows.slice(0, CHUNK).map((p) => p.id as string);

  const { error: updateError } = await db
    .from('pt_products')
    .update({ is_active: false })
    .eq('client_id', moca.clientId)
    .in('id', batch);

  if (updateError) {
    console.error('[catalog-finalize] Disattivazione fallita:', updateError.message);
    throw new HttpError(500, `Disattivazione non riuscita: ${updateError.message}`);
  }

  return ok({ deactivated: batch.length, remaining: rows.length > CHUNK ? 1 : 0 }, headers);
});
