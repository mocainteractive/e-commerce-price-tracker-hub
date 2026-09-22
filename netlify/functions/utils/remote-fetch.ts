/**
 * Download di risorse esterne con budget di tempo e messaggi precisi.
 *
 * Il budget e' sotto i 10 secondi delle Netlify Functions: meglio un errore
 * chiaro subito che una funzione uccisa dalla piattaforma, che al browser
 * arriva come 502 senza spiegazione.
 *
 * Il budget copre TUTTO il trasferimento, corpo compreso. Prima copriva solo
 * l'attesa degli header: un feed generato al volo rispondeva in 4 secondi e
 * poi impiegava altri 90 a inviare 24 MB, la funzione moriva a 10 secondi e
 * l'utente vedeva un errore generico invece di questo messaggio.
 *
 * Gli errori distinguono i casi che l'utente puo' davvero risolvere: la
 * sorgente ha risposto con un errore suo, ci ha messo troppo, non era
 * raggiungibile, oppure ha risposto vuoto.
 */
import { HttpError } from './http';

/** Sotto i 10s della piattaforma, con margine per il parsing. */
export const DEFAULT_BUDGET_MS = 8000;

/** Oltre questa dimensione il documento non sta comunque nella risposta della funzione. */
export const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

const USER_AGENT = 'Mozilla/5.0 (compatible; MocaPriceTracker/1.0; +https://mocainteractive.com)';

export interface FetchedText {
  body: string;
  finalUrl: string;
  contentType: string | null;
  elapsedMs: number;
}

export interface FetchTextOptions {
  budgetMs?: number;
  maxBytes?: number;
  accept?: string;
}

export async function fetchText(
  url: string,
  budgetOrOptions: number | FetchTextOptions = DEFAULT_BUDGET_MS,
): Promise<FetchedText> {
  const options: FetchTextOptions =
    typeof budgetOrOptions === 'number' ? { budgetMs: budgetOrOptions } : budgetOrOptions;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  assertPublicHttpUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = Date.now();

  const timeoutError = () =>
    new HttpError(
      504,
      `La sorgente non ha risposto entro ${Math.round(budgetMs / 1000)} secondi. Se il feed viene generato al volo puo' essere troppo lento: salvalo in un file e caricalo, oppure usa una URL statica.`,
      'SOURCE_TIMEOUT',
    );

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: options.accept ?? 'application/xml, text/xml, text/csv, text/html;q=0.9, */*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw timeoutError();
      throw new HttpError(
        502,
        `Impossibile raggiungere la sorgente dopo ${Date.now() - startedAt} ms: ${(err as Error).message}`,
        'SOURCE_UNREACHABLE',
      );
    }

    // Un redirect potrebbe aver portato su un indirizzo interno: si ricontrolla
    // la destinazione finale, non solo quella richiesta.
    if (response.url) assertPublicHttpUrl(response.url);

    if (!response.ok) {
      throw new HttpError(
        502,
        `La sorgente ha risposto con HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}. L'errore e' del server che genera il feed, non dell'app: verifica che la URL sia ancora valida aprendola nel browser.`,
        'SOURCE_HTTP_ERROR',
      );
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw tooLarge(declared, maxBytes);

    let body: string;
    try {
      body = await readBody(response, maxBytes);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as Error).name === 'AbortError') throw timeoutError();
      throw new HttpError(
        502,
        `Trasferimento interrotto dopo ${Date.now() - startedAt} ms: ${(err as Error).message}`,
        'SOURCE_UNREACHABLE',
      );
    }

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
  } finally {
    clearTimeout(timer);
  }
}

/** Legge il corpo a blocchi, fermandosi appena supera il tetto di dimensione. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(received, maxBytes);
    }
    chunks.push(value);
  }

  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function tooLarge(bytes: number, maxBytes: number): HttpError {
  return new HttpError(
    413,
    `La sorgente pesa oltre ${Math.round(maxBytes / 1048576)} MB (${(bytes / 1048576).toFixed(1)} MB letti): troppo per il server. Salvala in un file e caricala dal browser, che non ha limiti.`,
    'SOURCE_TOO_LARGE',
  );
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

  if (isPrivateHost(url.hostname)) {
    throw new HttpError(400, 'Indirizzo di rete interna non consentito', 'PRIVATE_ADDRESS');
  }

  return url;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;

  // IPv6: loopback, non specificato, link-local, unique-local, IPv4 mappato.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    // `new URL` normalizza ::ffff:127.0.0.1 in ::ffff:7f00:1: si riconverte.
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const alto = parseInt(mappedHex[1], 16);
      const basso = parseInt(mappedHex[2], 16);
      return isPrivateIpv4(`${alto >> 8}.${alto & 255}.${basso >> 8}.${basso & 255}`);
    }
    return false;
  }

  return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? isPrivateIpv4(host) : false;
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || // 0.0.0.0/8: "questo host"
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, usato dai cloud interni
  );
}
