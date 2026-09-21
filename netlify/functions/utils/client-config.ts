/**
 * Credenziali DataForSEO del cliente.
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
  const fallback = await readFromHubConfigurations(clientId);
  if (fallback) return fallback;

  throw new HttpError(400, NOT_CONFIGURED, 'DATAFORSEO_NOT_CONFIGURED');
}

/**
 * Credenziali per le esecuzioni senza browser (postback, scansione
 * pianificata). Qui l'unica fonte possibile e' la tabella dell'Hub.
 */
export async function loadDataForSeoCredentials(clientId: string): Promise<DataForSeoCredentials> {
  const credentials = await readFromHubConfigurations(clientId);
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

/** Lettura diretta delle configurazioni cliente dell'Hub. */
async function readFromHubConfigurations(
  clientId: string,
): Promise<DataForSeoCredentials | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('configurations')
      .select('config_key, config_value')
      .eq('client_id', clientId)
      .in('config_key', ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']);

    if (error) {
      console.warn('[client-config] Lettura configurations non riuscita:', error.message);
      return null;
    }

    const map = Object.fromEntries(
      (data ?? []).map((row) => [row.config_key, (row.config_value as string) ?? '']),
    );
    const login = map.DATAFORSEO_LOGIN?.trim();
    const password = map.DATAFORSEO_PASSWORD?.trim();

    if (!login || !password) return null;

    console.info(`[client-config] DataForSEO come ${mask(login)} per il cliente ${clientId}`);
    return { login, password };
  } catch (err) {
    // Supabase non configurato su questo deploy: non e' un errore fatale per
    // le richieste che portano gia' le credenziali dal frontend.
    console.warn('[client-config] Supabase non disponibile:', (err as Error).message);
    return null;
  }
}

/**
 * Verifica che l'utente sia assegnato al cliente.
 *
 * Come nelle altre app Moca, il contesto cliente arriva dal frontend dopo la
 * validazione del launch token. Qui aggiungiamo un controllo in piu' perche'
 * queste funzioni scrivono con la service_role, che scavalca la RLS: senza,
 * un `client_id` alterato leggerebbe i dati di un altro cliente.
 *
 * Se le tabelle dell'Hub non sono raggiungibili il controllo viene saltato,
 * per non bloccare i deploy che non condividono l'istanza Supabase.
 */
export async function assertClientAccess(
  userId: string,
  clientId: string,
  role: string,
): Promise<void> {
  if (!userId) return; // contesto senza utente (mock locale)
  if (role === 'super_admin' || role === 'manager' || role === 'admin') return;

  try {
    const { data, error } = await supabaseAdmin()
      .from('user_clients')
      .select('client_id')
      .eq('user_id', userId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (error) {
      console.warn('[client-config] Verifica user_clients non riuscita:', error.message);
      return;
    }
    if (!data) {
      throw new HttpError(403, 'Accesso negato a questo cliente', 'CLIENT_FORBIDDEN');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn('[client-config] Verifica permessi saltata:', (err as Error).message);
  }
}
