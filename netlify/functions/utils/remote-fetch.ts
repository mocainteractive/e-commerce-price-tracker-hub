/**
 * Download di risorse esterne con budget di tempo e messaggi precisi.
 *
 * Il budget e' sotto i 10 secondi delle Netlify Functions: meglio un errore
 * chiaro subito che una funzione uccisa dalla piattaforma, che al browser
 * arriva come 502 senza spiegazione.
 *
 * Gli errori distinguono i casi che l'utente puo' davvero risolvere: la
 * sorgente ha risposto con un errore suo, ci ha messo troppo, non era
 * raggiungibile, oppure ha risposto vuoto.
 */
import { HttpError } from './http';

/** Sotto i 10s della piattaforma, con margine per il parsing. */
export const DEFAULT_BUDGET_MS = 8000;

const USER_AGENT = 'Mozilla/5.0 (compatible; MocaPriceTracker/1.0; +https://mocainteractive.com)';

export interface FetchedText {
  body: string;
  finalUrl: string;
  contentType: string | null;
  elapsedMs: number;
}

export async function fetchText(url: string, budgetMs = DEFAULT_BUDGET_MS): Promise<FetchedText> {
  assertPublicHttpUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/xml, text/xml, text/csv, text/html;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    if ((err as Error).name === 'AbortError') {
      throw new HttpError(
        504,
        `La sorgente non ha risposto entro ${Math.round(budgetMs / 1000)} secondi. Se il feed viene generato al volo puo' essere troppo lento: salvalo in un file e caricalo, oppure usa una URL statica.`,
        'SOURCE_TIMEOUT',
      );
    }
    throw new HttpError(
      502,
      `Impossibile raggiungere la sorgente dopo ${elapsed} ms: ${(err as Error).message}`,
      'SOURCE_UNREACHABLE',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new HttpError(
      502,
      `La sorgente ha risposto con HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}. L'errore e' del server che genera il feed, non dell'app: verifica che la URL sia ancora valida aprendola nel browser.`,
      'SOURCE_HTTP_ERROR',
    );
  }

  const body = await response.text();
  if (body.trim().length === 0) {
    throw new HttpError(
      502,
      'La sorgente ha risposto correttamente ma senza contenuto (0 byte).',
      'SOURCE_EMPTY',
    );
  }

  return {
    body,
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Blocca schemi non http(s) e indirizzi di rete interna.
 * Senza questo controllo la funzione diventerebbe un ponte verso i servizi
 * privati dell'infrastruttura (SSRF).
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `URL non valida: ${raw}`, 'BAD_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Sono ammesse solo URL http o https', 'BAD_URL_SCHEME');
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) {
    throw new HttpError(400, 'Indirizzo di rete interna non consentito', 'PRIVATE_ADDRESS');
  }

  return url;
}
