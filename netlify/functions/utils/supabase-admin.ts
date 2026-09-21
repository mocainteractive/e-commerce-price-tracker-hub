/**
 * Client Supabase con service_role.
 *
 * ATTENZIONE: bypassa la RLS. Esiste solo lato server (Netlify Functions) e
 * ogni endpoint che lo usa DEVE aver gia' letto e autorizzato il `client_id`
 * della richiesta (vedi utils/moca-context.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http';

let cached: SupabaseClient | null = null;

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
    });
  } catch (err) {
    console.error('[supabase] createClient fallito:', (err as Error).message);
    throw new HttpError(
      500,
      'Database non configurato: impossibile inizializzare il client Supabase.',
      'SUPABASE_INIT_FAILED',
    );
  }

  return cached;
}

/** Azzera la cache. Usato solo dai test. */
export function resetSupabaseAdmin(): void {
  cached = null;
}
