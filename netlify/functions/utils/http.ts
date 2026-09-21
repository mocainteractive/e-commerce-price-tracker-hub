/**
 * Helper HTTP condivisi: CORS con allow-list, risposte JSON, parsing del body.
 *
 * Regola Moca: niente `Access-Control-Allow-Origin: *` sugli endpoint
 * autenticati. L'allow-list e' costruita a partire dall'ambiente cosi' da
 * coprire produzione, deploy preview e sviluppo locale senza toccare il codice.
 */
import type { HandlerEvent, HandlerResponse } from '@netlify/functions';

function buildAllowedOrigins(): string[] {
  const origins = [
    'http://localhost:5173',
    'http://localhost:4173',
    'http://localhost:8888',
    'https://moca-central-hub.netlify.app',
  ];

  for (const key of ['APP_PUBLIC_URL', 'MOCA_HUB_URL', 'URL', 'DEPLOY_PRIME_URL']) {
    const value = process.env[key];
    if (value) origins.push(value.replace(/\/$/, ''));
  }

  return [...new Set(origins)];
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowed = buildAllowedOrigins();
  const match = origin && allowed.includes(origin) ? origin : allowed[allowed.length - 1];

  return {
    'Access-Control-Allow-Origin': match,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

/** Errore verso il client: messaggio generico in italiano, niente dettagli interni. */
export function fail(
  statusCode: number,
  message: string,
  headers: Record<string, string> = {},
  code?: string,
): HandlerResponse {
  return json(statusCode, { success: false, error: message, code }, headers);
}

export function ok(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return json(200, { success: true, ...body }, headers);
}

export function parseBody<T = Record<string, unknown>>(event: HandlerEvent): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Corpo della richiesta non valido');
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Log dettagliato solo server-side; al client va un errore generico.
    console.error(`[config] Variabile d'ambiente mancante: ${name}`);
    throw new HttpError(500, 'Configurazione del servizio incompleta');
  }
  return value;
}

/**
 * Avvolge un handler: gestisce OPTIONS, CORS, metodo consentito ed errori.
 * Tutti gli endpoint dell'app passano di qui.
 */
export function withHttp(
  methods: Array<'GET' | 'POST'>,
  handler: (event: HandlerEvent, headers: Record<string, string>) => Promise<HandlerResponse>,
) {
  return async (event: HandlerEvent): Promise<HandlerResponse> => {
    const headers = corsHeaders(event.headers.origin);

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
    }
    if (!methods.includes(event.httpMethod as 'GET' | 'POST')) {
      return fail(405, 'Metodo non consentito', headers);
    }

    try {
      return await handler(event, headers);
    } catch (err) {
      if (err instanceof HttpError) {
        return fail(err.statusCode, err.message, headers, err.code);
      }
      console.error('[handler] Errore non gestito:', err);
      return fail(500, 'Errore interno del server', headers);
    }
  };
}
