/**
 * Recupero server-side delle configurazioni di un cliente.
 *
 * Le API key vivono nella tabella `configurations` dell'Hub, scoped per
 * `client_id`. Vengono lette qui con la service_role e usate per le chiamate di
 * terzi: non vengono MAI restituite al browser ne' scritte nei log in chiaro.
 */
import { HttpError } from './http';
import { supabaseAdmin } from './supabase-admin';

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

/** Maschera una credenziale per i log: `mar••••@moca`. */
export function mask(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

async function readConfig(clientId: string, keys: string[]): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin()
    .from('configurations')
    .select('config_key, config_value')
    .eq('client_id', clientId)
    .in('config_key', keys);

  if (error) {
    console.error('[client-config] Lettura configurations fallita:', error.message);
    throw new HttpError(500, 'Impossibile leggere la configurazione del cliente');
  }

  return Object.fromEntries((data ?? []).map((r) => [r.config_key, r.config_value as string]));
}

/**
 * Credenziali DataForSEO del cliente.
 * Fallback sulle variabili d'ambiente solo per lo sviluppo locale.
 */
export async function getDataForSeoCredentials(clientId: string): Promise<DataForSeoCredentials> {
  let login = '';
  let password = '';

  // Il mock locale non ha un client_id reale nell'Hub: salta la query.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);

  if (isUuid) {
    const cfg = await readConfig(clientId, ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']);
    login = cfg.DATAFORSEO_LOGIN ?? '';
    password = cfg.DATAFORSEO_PASSWORD ?? '';
  }

  if (!login || !password) {
    login = login || process.env.DATAFORSEO_LOGIN || '';
    password = password || process.env.DATAFORSEO_PASSWORD || '';
    if (login && password) {
      console.warn('[client-config] Uso credenziali DataForSEO da env (solo sviluppo locale)');
    }
  }

  if (!login || !password) {
    throw new HttpError(
      400,
      'Credenziali DataForSEO non configurate per questo cliente. Impostale su Moca Hub come DATAFORSEO_LOGIN e DATAFORSEO_PASSWORD.',
      'DATAFORSEO_NOT_CONFIGURED',
    );
  }

  return { login, password };
}

/**
 * Verifica che l'utente sia effettivamente assegnato al cliente.
 * Il JWT applicativo e' firmato da noi, ma la doppia verifica protegge dai
 * casi in cui l'assegnazione venga revocata nell'Hub durante la sessione.
 */
export async function assertClientAccess(
  userId: string,
  clientId: string,
  role: string,
): Promise<void> {
  if (role === 'super_admin' || role === 'manager') return;

  const { data, error } = await supabaseAdmin()
    .from('user_clients')
    .select('client_id')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    console.error('[client-config] Verifica user_clients fallita:', error.message);
    throw new HttpError(500, 'Impossibile verificare i permessi');
  }
  if (!data) {
    throw new HttpError(403, 'Accesso negato a questo cliente', 'CLIENT_FORBIDDEN');
  }
}
