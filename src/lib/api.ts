/**
 * Client per le Netlify Functions dell'app.
 *
 * Ogni chiamata porta il contesto Moca (cliente, utente, ruolo) e, dove
 * servono, le credenziali DataForSEO che l'SDK ha ricevuto dall'Hub.
 * E' il pattern descritto in docs/APP_INTEGRATION_GUIDE.md: le chiavi le
 * passa il frontend, non vivono nelle variabili d'ambiente dell'app.
 */
import type { MocaRequestContext } from './MocaProvider';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.success === false) {
    // Contesto rifiutato: la sessione non e' piu' valida, si ripassa dall'Hub.
    if (response.status === 401) {
      sessionStorage.removeItem('moca_session');
    }
    throw new ApiError(
      response.status,
      payload.error ?? 'Si e\' verificato un errore imprevisto',
      payload.code,
    );
  }

  return payload as T;
}

/**
 * Le GET portano il contesto nella query string.
 * Le credenziali non viaggiano mai in query string (finirebbero nei log del
 * CDN): gli endpoint di sola lettura non ne hanno bisogno.
 */
export async function apiGet<T>(
  ctx: MocaRequestContext,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const query = new URLSearchParams({
    client_id: ctx.client_id,
    client_name: ctx.client_name,
    user_id: ctx.user_id,
    user_name: ctx.user_name,
    role: ctx.role,
  });

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }

  const response = await fetch(`/api/${path}?${query}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handle<T>(response);
}

/** Le POST portano contesto e credenziali nel body. */
export async function apiPost<T>(
  ctx: MocaRequestContext,
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ctx, ...body }),
  });
  return handle<T>(response);
}
