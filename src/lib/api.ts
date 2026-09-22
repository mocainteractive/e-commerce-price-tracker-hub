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
  const testo = await response.text();

  let payload: Record<string, unknown> = {};
  let eraJson = true;
  try {
    payload = testo ? (JSON.parse(testo) as Record<string, unknown>) : {};
  } catch {
    eraJson = false;
  }

  if (!response.ok || payload.success === false) {
    // Contesto rifiutato: la sessione non e' piu' valida, si ripassa dall'Hub.
    if (response.status === 401) {
      sessionStorage.removeItem('moca_session');
    }

    throw new ApiError(
      response.status,
      (payload.error as string) ?? descriviErrore(response, testo, eraJson),
      payload.code as string | undefined,
    );
  }

  return payload as T;
}

/**
 * Messaggio per le risposte che non sono JSON.
 *
 * Succede quando la funzione viene uccisa dalla piattaforma per superamento
 * del tempo massimo: la risposta e' un 502 con testo semplice, e senza questo
 * l'utente vedeva solo "errore imprevisto", che non aiuta nessuno.
 */
function descriviErrore(response: Response, testo: string, eraJson: boolean): string {
  if (response.status === 502 || response.status === 504) {
    return `L'operazione ha superato il tempo massimo consentito dal server (${response.status}). Riprova: il lavoro gia' svolto e' stato salvato.`;
  }
  if (response.status === 404) {
    return 'Funzione non trovata sul server: probabilmente il deploy non e\' aggiornato.';
  }
  if (!eraJson && testo) {
    const estratto = testo.trim().replace(/\s+/g, ' ').slice(0, 160);
    return `Il server ha risposto ${response.status} con un contenuto inatteso: "${estratto}"`;
  }
  return `Il server ha risposto ${response.status} senza dettagli.`;
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
