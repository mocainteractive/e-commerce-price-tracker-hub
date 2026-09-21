/**
 * Recupero server-side delle configurazioni di un cliente.
 *
 * Le API key vivono nella tabella `configurations` dell'Hub, scoped per
 * `client_id`. Vengono lette qui con la service_role e usate per le chiamate di
 * terzi: non vengono MAI restituite al browser ne' scritte nei log in chiaro.
 */
import { HttpError } from './http';
import { supabaseAdmin } from './supabase-admin';
import { decryptJson } from './crypto';

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
    // Sorgente di ripiego: se l'app non condivide l'istanza Supabase dell'Hub
    // questa tabella non esiste. Non e' un errore fatale.
    console.warn('[client-config] Lettura diretta di configurations non riuscita:', error.message);
    return {};
  }

  return Object.fromEntries((data ?? []).map((r) => [r.config_key, r.config_value as string]));
}

/**
 * Configurazioni del cliente, nell'ordine in cui vanno cercate.
 *
 * 1. `pt_client_credentials` - la copia cifrata di quanto l'Hub ha consegnato
 *    all'ultimo accesso. E' il canale ufficiale: le chiavi arrivano dalla
 *    configurazione cliente del Moca Hub, esattamente come per le altre app.
 *    Funziona anche senza utente collegato (postback, scansione pianificata).
 * 2. tabella `configurations` dell'Hub - lettura diretta, utile al primo giro
 *    (cliente con scansione automatica attiva che non ha ancora aperto l'app)
 *    e quando l'app condivide l'istanza Supabase dell'Hub.
 * 3. variabili d'ambiente - solo sviluppo locale.
 */
async function resolveConfig(clientId: string, keys: string[]): Promise<Record<string, string>> {
  // Il mock locale non ha un client_id reale nell'Hub: salta le query.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
  if (!isUuid) return {};

  const stored = await readStoredConfig(clientId);
  if (keys.every((key) => stored[key])) return stored;

  // Copia assente o incompleta (chiave aggiunta nell'Hub dopo l'ultimo
  // accesso): completiamo da `configurations`, se raggiungibile.
  const direct = await readConfig(clientId, keys);
  return { ...stored, ...direct };
}

/** Legge e decifra la copia conservata all'ultimo accesso. */
async function readStoredConfig(clientId: string): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin()
    .from('pt_client_credentials')
    .select('payload')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    // Tabella assente o non raggiungibile: si prosegue con le altre sorgenti.
    console.warn('[client-config] Copia configurazioni non disponibile:', error.message);
    return {};
  }
  if (!data?.payload) return {};

  return decryptJson<Record<string, string>>(data.payload) ?? {};
}

/**
 * Credenziali DataForSEO del cliente, dalla configurazione su Moca Hub.
 */
export async function getDataForSeoCredentials(clientId: string): Promise<DataForSeoCredentials> {
  const cfg = await resolveConfig(clientId, ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']);

  let login = cfg.DATAFORSEO_LOGIN ?? '';
  let password = cfg.DATAFORSEO_PASSWORD ?? '';

  if (!login || !password) {
    login = login || process.env.DATAFORSEO_LOGIN || '';
    password = password || process.env.DATAFORSEO_PASSWORD || '';
    if (login && password) {
      console.warn('[client-config] Uso credenziali DataForSEO da env (solo sviluppo locale)');
    }
  }

  if (login && password) {
    console.info(`[client-config] DataForSEO come ${mask(login)} per il cliente ${clientId}`);
  }

  if (!login || !password) {
    throw new HttpError(
      400,
      'Credenziali DataForSEO non configurate per questo cliente. Un amministratore deve impostare DATAFORSEO_LOGIN e DATAFORSEO_PASSWORD fra le configurazioni del cliente su Moca Hub, poi riapri l\'app dall\'Hub per applicarle.',
      'DATAFORSEO_NOT_CONFIGURED',
    );
  }

  return { login, password };
}

/**
 * Le credenziali sono utilizzabili? Serve alla UI per avvisare subito, invece
 * di far fallire la prima scansione. Non restituisce mai i valori.
 */
export async function hasDataForSeoConfigured(clientId: string): Promise<boolean> {
  try {
    await getDataForSeoCredentials(clientId);
    return true;
  } catch {
    return false;
  }
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
