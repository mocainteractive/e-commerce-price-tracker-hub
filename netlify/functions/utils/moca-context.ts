/**
 * Contesto Moca per le Netlify Functions.
 *
 * Segue il pattern ufficiale documentato in docs/APP_INTEGRATION_GUIDE.md
 * dell'Hub e usato da tutte le app satellite:
 *
 *   l'SDK valida il launch token nel browser, riceve dall'Hub client, user e
 *   `configurations`, e l'app passa alle proprie Netlify Functions il contesto
 *   e le chiavi che servono, via body o header.
 *
 * Qui il contesto viene letto e normalizzato una volta sola, cosi' ogni
 * endpoint parte dagli stessi campi gia' validati.
 */
import type { HandlerEvent, HandlerResponse } from '@netlify/functions';
import { HttpError, parseBody, withHttp } from './http';
import { assertClientAccess } from './client-config';

/** Ruoli reali dell'Hub. */
export type MocaRole = 'super_admin' | 'manager' | 'specialist' | 'external' | 'admin';

export interface MocaContext {
  clientId: string;
  clientName: string;
  userId: string;
  userName: string;
  role: MocaRole;
  /** Credenziali DataForSEO inoltrate dal frontend, se disponibili. */
  dataForSeo: { login: string; password: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ContextPayload {
  client_id?: string;
  client_name?: string;
  user_id?: string;
  user_name?: string;
  role?: string;
  dfs_login?: string;
  dfs_password?: string;
}

/**
 * Il contesto arriva nel body per le POST e nella query string per le GET.
 * Lo stesso endpoint puo' servire entrambe (es. settings, product-detail).
 */
function readContext(event: HandlerEvent): MocaContext {
  const fromQuery = (event.queryStringParameters ?? {}) as ContextPayload;
  const fromBody = event.httpMethod === 'POST' ? parseBody<ContextPayload>(event) : {};
  const payload: ContextPayload = { ...fromQuery, ...fromBody };

  const clientId = payload.client_id?.trim() ?? '';
  if (!clientId) {
    throw new HttpError(401, 'Contesto cliente mancante: riapri l\'app da Moca Hub', 'NO_CONTEXT');
  }
  // Il client_id dell'Hub e' sempre un UUID. Il controllo scarta subito i
  // valori malformati prima che finiscano in una query.
  if (!UUID_RE.test(clientId)) {
    throw new HttpError(400, 'Identificativo cliente non valido', 'BAD_CLIENT_ID');
  }

  const login = payload.dfs_login?.trim() ?? '';
  const password = payload.dfs_password?.trim() ?? '';

  return {
    clientId,
    clientName: payload.client_name?.trim() ?? '',
    userId: payload.user_id?.trim() ?? '',
    userName: payload.user_name?.trim() ?? '',
    role: (payload.role as MocaRole) ?? 'specialist',
    dataForSeo: login && password ? { login, password } : null,
  };
}

/**
 * Wrapper degli endpoint dell'app: CORS e metodo (withHttp), contesto Moca
 * letto e verifica che l'utente sia davvero assegnato al cliente.
 *
 * L'ultimo passo serve perche' queste funzioni scrivono con la service_role,
 * che scavalca la RLS: e' l'unica cosa che impedisce a un `client_id` alterato
 * di leggere i dati di un altro cliente.
 */
export function withMoca(
  methods: Array<'GET' | 'POST'>,
  handler: (
    event: HandlerEvent,
    moca: MocaContext,
    headers: Record<string, string>,
  ) => Promise<HandlerResponse>,
) {
  return withHttp(methods, async (event, headers) => {
    const moca = readContext(event);
    await assertClientAccess(moca.userId, moca.clientId, moca.role);
    return handler(event, moca, headers);
  });
}

/** Gli utenti `external` possono solo consultare. */
export function requireWriteAccess(moca: MocaContext): void {
  if (moca.role === 'external') {
    throw new HttpError(403, 'Il tuo ruolo non consente modifiche', 'READ_ONLY');
  }
}
