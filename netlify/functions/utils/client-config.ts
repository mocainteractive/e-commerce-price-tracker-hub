/**
 * Credenziali del cliente e verifica dell'accesso.
 *
 * Percorso ufficiale (docs/APP_INTEGRATION_GUIDE.md dell'Hub):
 *
 *   configurazione cliente su Moca Hub
 *        -> `configurations` nella risposta di validate-launch-token
 *        -> l'SDK le espone al frontend con getConfig()
 *        -> il frontend le passa a queste Netlify Functions nel body
 *
 * Le chiavi non sono mai hardcodate e non vivono in variabili d'ambiente
 * dell'app: appartengono al cliente, non al deploy.
 *
 * Restano due percorsi senza browser, dove le credenziali non possono
 * arrivare dal frontend: il postback di DataForSEO e la scansione
 * pianificata. Per quelli si legge la tabella `configurations` dell'Hub con
 * la service_role, che e' la stessa fonte da cui l'Hub le consegna.
 */
import { HttpError } from './http';
import { supabaseAdmin } from './supabase-admin';

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

/** Chiavi lette fra le configurazioni cliente dell'Hub. */
export const HUB_KEYS = {
  dfsLogin: 'DATAFORSEO_LOGIN',
  dfsPassword: 'DATAFORSEO_PASSWORD',
  anthropicKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
} as const;

/** Maschera una credenziale per i log: `mar••••@moca`. */
export function mask(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

const NOT_CONFIGURED =
  'Credenziali DataForSEO non configurate per questo cliente. Un amministratore deve impostare DATAFORSEO_LOGIN e DATAFORSEO_PASSWORD fra le configurazioni del cliente su Moca Hub, poi riapri l\'app dall\'Hub.';

/**
 * Credenziali per una richiesta che arriva dal browser.
 * `forwarded` sono quelle che il frontend ha ricevuto dall'Hub via getConfig().
 */
export async function resolveDataForSeoCredentials(
  clientId: string,
  forwarded: DataForSeoCredentials | null,
): Promise<DataForSeoCredentials> {
  if (forwarded?.login && forwarded.password) return forwarded;

  // Il frontend non le ha inoltrate: puo' succedere se la sessione e' stata
  // aperta prima che l'amministratore configurasse le chiavi.
  const fallback = await readDataForSeoFromHub(clientId);
  if (fallback) return fallback;

  throw new HttpError(400, NOT_CONFIGURED, 'DATAFORSEO_NOT_CONFIGURED');
}

/**
 * Credenziali per le esecuzioni senza browser (postback, scansione
 * pianificata). Qui l'unica fonte possibile e' la tabella dell'Hub.
 */
export async function loadDataForSeoCredentials(clientId: string): Promise<DataForSeoCredentials> {
  const credentials = await readDataForSeoFromHub(clientId);
  if (credentials) return credentials;

  // Solo sviluppo locale: `netlify dev` non ha accesso alle configurazioni.
  const login = process.env.DATAFORSEO_LOGIN ?? '';
  const password = process.env.DATAFORSEO_PASSWORD ?? '';
  if (login && password) {
    console.warn('[client-config] Credenziali DataForSEO da env (solo sviluppo locale)');
    return { login, password };
  }

  throw new HttpError(400, NOT_CONFIGURED, 'DATAFORSEO_NOT_CONFIGURED');
}

export interface AiCredentials {
  apiKey: string;
  model: string | null;
}

/**
 * Chiave Anthropic per la verifica AI dei match. Facoltativa: senza chiave
 * la scansione funziona con il solo matching deterministico.
 */
export async function resolveAiCredentials(
  clientId: string,
  forwarded: AiCredentials | null,
): Promise<AiCredentials | null> {
  if (forwarded?.apiKey) return forwarded;

  const hub = await readHubConfigurations(clientId, [HUB_KEYS.anthropicKey, HUB_KEYS.anthropicModel]);
  const fromHub = hub[HUB_KEYS.anthropicKey];
  if (fromHub) return { apiKey: fromHub, model: hub[HUB_KEYS.anthropicModel] || null };

  // Solo sviluppo locale.
  const fromEnv = process.env.ANTHROPIC_API_KEY ?? '';
  if (fromEnv) return { apiKey: fromEnv, model: process.env.ANTHROPIC_MODEL || null };

  return null;
}

async function readDataForSeoFromHub(clientId: string): Promise<DataForSeoCredentials | null> {
  const map = await readHubConfigurations(clientId, [HUB_KEYS.dfsLogin, HUB_KEYS.dfsPassword]);
  const login = map[HUB_KEYS.dfsLogin];
  const password = map[HUB_KEYS.dfsPassword];
  if (!login || !password) return null;

  console.info(`[client-config] DataForSEO come ${mask(login)} per il cliente ${clientId}`);
  return { login, password };
}

/** Lettura diretta delle configurazioni cliente dell'Hub. Mai lancia. */
async function readHubConfigurations(
  clientId: string,
  keys: string[],
): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('configurations')
      .select('config_key, config_value')
      .eq('client_id', clientId)
      .in('config_key', keys);

    if (error) {
      console.warn('[client-config] Lettura configurations non riuscita:', error.message);
      return {};
    }

    const map: Record<string, string> = {};
    for (const row of data ?? []) {
      const value = String(row.config_value ?? '').trim();
      if (value) map[row.config_key as string] = value;
    }
    return map;
  } catch (err) {
    // Supabase non configurato su questo deploy: non e' un errore fatale per
    // le richieste che portano gia' le credenziali dal frontend.
    console.warn('[client-config] Supabase non disponibile:', (err as Error).message);
    return {};
  }
}

// -----------------------------------------------------------------------------
// Autorizzazione
// -----------------------------------------------------------------------------

const ADMIN_ROLES = new Set(['super_admin', 'manager', 'admin']);

/**
 * Vero quando la richiesta arriva senza un deploy Netlify dietro (test,
 * emulatori locali) o da `netlify dev`. Solo li' si accetta un contesto senza
 * utente, che e' quello del Mock Mode.
 */
export function isLocalRuntime(): boolean {
  if (process.env.MOCA_ALLOW_ANONYMOUS_CONTEXT === 'true') return true;
  if (!process.env.NETLIFY) return true;
  return process.env.NETLIFY_DEV === 'true' || process.env.CONTEXT === 'dev';
}

/**
 * Verifica che l'utente esista sull'Hub e sia assegnato al cliente, e
 * restituisce il ruolo EFFETTIVO, letto dalla tabella `users`.
 *
 * Il ruolo dichiarato dal browser non conta: prima veniva creduto, e bastava
 * scrivere `role: super_admin` nel body per saltare ogni controllo e leggere
 * i dati di qualunque cliente con la service_role. Ora il ruolo e' quello
 * registrato sull'Hub, e senza utente riconosciuto la richiesta e' rifiutata.
 *
 * Resta un limite strutturale: la sessione non e' firmata, quindi chi conosce
 * lo UUID di un amministratore puo' ancora spacciarsi per lui. La soluzione
 * definitiva e' un token firmato dall'Hub, che l'SDK oggi non fornisce.
 */
export async function assertClientAccess(
  userId: string,
  clientId: string,
  claimedRole: string,
): Promise<string> {
  if (!userId) {
    if (isLocalRuntime()) return claimedRole || 'specialist';
    throw new HttpError(401, 'Sessione senza utente: riapri l\'app da Moca Hub', 'NO_USER');
  }

  let db: ReturnType<typeof supabaseAdmin>;
  try {
    db = supabaseAdmin();
  } catch (err) {
    // Senza database non c'e' nulla da verificare ne' da proteggere: in
    // locale si lascia lavorare (feed, estrazione), in produzione l'errore di
    // configurazione arriva all'utente cosi' com'e'.
    if (isLocalRuntime()) {
      console.warn('[client-config] Supabase assente: verifica utente saltata (solo sviluppo locale)');
      return claimedRole || 'specialist';
    }
    throw err;
  }

  let role = claimedRole || 'specialist';
  const { data: user, error: userError } = await db
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (userError) {
    // La tabella dell'Hub non e' leggibile: non ci si fida del ruolo dichiarato
    // per i privilegi, ma si lascia lavorare come specialist del cliente.
    console.warn('[client-config] Lettura users non riuscita:', userError.message);
    role = ADMIN_ROLES.has(role) ? 'specialist' : role;
  } else if (!user) {
    throw new HttpError(403, 'Utente non riconosciuto su Moca Hub', 'USER_UNKNOWN');
  } else {
    role = String(user.role ?? 'specialist');
  }

  if (ADMIN_ROLES.has(role)) return role;

  const { data, error } = await db
    .from('user_clients')
    .select('client_id')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    console.warn('[client-config] Verifica user_clients non riuscita:', error.message);
    return role;
  }
  if (!data) {
    throw new HttpError(403, 'Accesso negato a questo cliente', 'CLIENT_FORBIDDEN');
  }
  return role;
}
