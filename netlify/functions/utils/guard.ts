/**
 * Wrapper per gli endpoint autenticati.
 *
 * Mette in fila i tre controlli che ogni endpoint deve superare prima di
 * toccare il database con la service_role:
 *   1. CORS + metodo (withHttp)
 *   2. JWT di sessione valido (requireSession)
 *   3. utente effettivamente assegnato al cliente (assertClientAccess)
 *
 * Il passo 3 e' ridondante rispetto al JWT firmato, ma intercetta le revoche
 * di assegnazione avvenute nell'Hub durante le 8 ore di vita della sessione.
 */
import type { HandlerEvent, HandlerResponse } from '@netlify/functions';
import { withHttp } from './http';
import { requireSession, type AppSession } from './session';
import { assertClientAccess } from './client-config';

export function authed(
  methods: Array<'GET' | 'POST'>,
  handler: (
    event: HandlerEvent,
    session: AppSession,
    headers: Record<string, string>,
  ) => Promise<HandlerResponse>,
) {
  return withHttp(methods, async (event, headers) => {
    const session = await requireSession(event);

    // La sessione mock non ha un utente reale nell'Hub: salta la verifica.
    if (!session.mock) {
      await assertClientAccess(session.userId, session.clientId, session.role);
    }

    return handler(event, session, headers);
  });
}
