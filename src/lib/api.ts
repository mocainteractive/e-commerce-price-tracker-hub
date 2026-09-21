/**
 * Client per le Netlify Functions dell'app.
 *
 * Ogni chiamata porta il JWT di sessione emesso da `/api/auth-session`.
 * Le API key non passano mai di qui: restano lato server.
 */

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

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function handle<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.success === false) {
    // Sessione scaduta: l'unica via d'uscita e' ripassare dall'Hub.
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

export async function apiGet<T>(
  token: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }

  const suffix = query.toString() ? `?${query}` : '';
  const response = await fetch(`/api/${path}${suffix}`, { headers: authHeader(token) });
  return handle<T>(response);
}

export async function apiPost<T>(token: string, path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
  return handle<T>(response);
}
