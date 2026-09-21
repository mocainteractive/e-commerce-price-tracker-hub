/**
 * Client Supabase con service_role.
 *
 * ATTENZIONE: bypassa la RLS. Esiste solo lato server (Netlify Functions) e
 * ogni endpoint che lo usa DEVE aver gia' letto e autorizzato il `client_id`
 * della richiesta (vedi utils/moca-context.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './http';

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'moca-price-tracker' } },
  });

  return cached;
}
