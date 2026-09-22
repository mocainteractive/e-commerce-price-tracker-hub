/**
 * Client Supabase con service_role.
 *
 * ATTENZIONE: bypassa la RLS. Esiste solo lato server (Netlify Functions) e
 * ogni endpoint che lo usa DEVE aver gia' letto e autorizzato il `client_id`
 * della richiesta (vedi utils/moca-context.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http';

/**
 * Transport WebSocket fittizio per il client realtime di Supabase.
 *
 * Perche' esiste: il costruttore di RealtimeClient risolve SEMPRE un
 * WebSocket, anche quando il realtime non viene mai usato. Su Node < 22 non
 * esiste `globalThis.WebSocket`, la risoluzione lancia e `createClient`
 * fallisce, facendo rispondere 500 a ogni endpoint.
 *
 * Queste funzioni usano solo PostgREST (`.from()`, `.rpc()`): nessuna
 * sottoscrizione realtime, quindi questa classe non viene mai istanziata.
 * Se un giorno servisse il realtime, il costruttore lo dice a chiare lettere
 * invece di fallire in modo oscuro.
 *
 * L'alternativa sarebbe il pacchetto `ws`, ma e' CommonJS con `require`
 * dinamici: dentro il bundle ESM delle Netlify Functions si rompe con
 * "Dynamic require of events is not supported".
 */
class RealtimeNonSupportato {
  constructor() {
    throw new Error(
      'Il realtime di Supabase non e\' supportato in queste Netlify Functions. ' +
        'Per usarlo serve Node 22+ (WebSocket nativo) oppure un transport esplicito.',
    );
  }
}

let cached: SupabaseClient | null = null;

/**
 * Ultimo errore di inizializzazione, in chiaro.
 * Lo espone solo `/api/health`: agli endpoint normali va un messaggio generico,
 * ma senza il testo originale un problema come "supabase-js richiede Node 22"
 * resta invisibile e si finisce a indovinare.
 */
let initError: string | null = null;

export function getSupabaseInitError(): string | null {
  return initError;
}

/**
 * Normalizza il valore di SUPABASE_URL.
 *
 * Incollando la URL dalla dashboard di Supabase e' facile perdere lo schema
 * (`project-ref.supabase.co`) o lasciare uno slash finale: `createClient`
 * lancerebbe un errore generico, e ogni endpoint risponderebbe "Errore interno
 * del server" senza dire cosa manca. Qui il valore viene sistemato quando e'
 * recuperabile e rifiutato con un messaggio chiaro quando non lo e'.
 */
export function normalizeSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('valore vuoto');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const url = new URL(withScheme); // lancia se resta malformata
  if (!url.hostname.includes('.')) {
    throw new Error(`hostname non valido: ${url.hostname}`);
  }

  return url.origin;
}

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!rawUrl || !serviceKey) {
    const missing = [!rawUrl && 'SUPABASE_URL', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY']
      .filter(Boolean)
      .join(' e ');
    console.error(`[supabase] Variabili d'ambiente mancanti: ${missing}`);
    throw new HttpError(
      500,
      `Database non configurato: manca ${missing} fra le variabili d'ambiente di Netlify.`,
      'SUPABASE_NOT_CONFIGURED',
    );
  }

  let url: string;
  try {
    url = normalizeSupabaseUrl(rawUrl);
  } catch (err) {
    console.error('[supabase] SUPABASE_URL non valida:', (err as Error).message);
    throw new HttpError(
      500,
      'Database non configurato: SUPABASE_URL non e\' una URL valida. Deve essere nella forma https://<project-ref>.supabase.co',
      'SUPABASE_URL_INVALID',
    );
  }

  try {
    cached = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { 'X-Client-Info': 'moca-price-tracker' } },
      // Evita che RealtimeClient cerchi un WebSocket globale: vedi sopra.
      realtime: { transport: RealtimeNonSupportato as never },
    });
  } catch (err) {
    initError = `${(err as Error).message} (Node ${process.version})`;
    console.error('[supabase] createClient fallito:', initError);
    throw new HttpError(
      500,
      'Database non configurato: impossibile inizializzare il client Supabase.',
      'SUPABASE_INIT_FAILED',
    );
  }

  initError = null;
  return cached;
}

/** Azzera cache ed errore. Usato solo dai test. */
export function resetSupabaseAdmin(): void {
  cached = null;
  initError = null;
}
