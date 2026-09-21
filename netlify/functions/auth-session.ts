/**
 * POST /api/auth-session
 *
 * Scambia il launch token di Moca Hub con il JWT di sessione dell'app.
 *
 * La validazione avviene QUI, lato server, e non nel browser: cosi' le API key
 * contenute nella risposta dell'Hub (`configurations`) non raggiungono mai il
 * client, e ogni chiamata successiva porta un'identita' verificabile.
 * Vedi il commento esteso in utils/session.ts.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody, withHttp } from './utils/http';
import { signSession, type MocaRole } from './utils/session';
import { supabaseAdmin } from './utils/supabase-admin';
import { encryptJson } from './utils/crypto';
import { hasDataForSeoConfigured } from './utils/client-config';

interface RequestBody {
  token?: string;
  mock?: boolean;
}

interface HubResponse {
  success?: boolean;
  error?: string;
  code?: string;
  client?: { id: string; name: string; email?: string; logo_url?: string };
  user?: { id: string; name: string; email?: string; role: string; level?: number; job_title?: string };
  application?: { id: string; name: string; description?: string } | null;
  configurations?: Record<string, string>;
}

const hubUrl = () =>
  (process.env.MOCA_HUB_URL ?? process.env.VITE_MOCA_HUB_URL ?? 'https://moca-central-hub.netlify.app')
    .replace(/\/$/, '');

export const handler: Handler = withHttp(['POST'], async (event, headers) => {
  const body = parseBody<RequestBody>(event);

  const context = body.mock ? buildMockContext() : await validateWithHub(body.token);

  // Prepara le impostazioni di default del cliente al primo accesso.
  await ensureClientSetup(context.client.id);

  // Le configurazioni arrivano qui dall'Hub (stesso canale delle altre app
  // Moca) e vengono conservate cifrate: servono anche quando non c'e' un
  // utente collegato, cioe' al postback di DataForSEO e alla scansione
  // pianificata. Al browser non tornano mai.
  if (!context.mock && context.configurations) {
    await storeConfigurations(context.client.id, context.user.id, context.configurations);
  }

  const { token, expiresAt } = await signSession({
    userId: context.user.id,
    userName: context.user.name,
    clientId: context.client.id,
    clientName: context.client.name,
    clientLogoUrl: context.client.logo_url,
    role: context.user.role,
    level: context.user.level,
    mock: context.mock,
  });

  return ok(
    {
      token,
      expiresAt,
      client: context.client,
      user: context.user,
      // Nessuna `configurations` qui: le chiavi restano server-side.
      // Il flag viene ricalcolato su quanto il backend riesce davvero a
      // risolvere, non solo su quanto l'Hub ha appena consegnato: cosi' la UI
      // non promette scansioni che poi fallirebbero.
      hasDataForSeo: context.mock
        ? context.hasDataForSeo
        : await hasDataForSeoConfigured(context.client.id),
    },
    headers,
  );
});

interface SessionContext {
  client: { id: string; name: string; logo_url?: string };
  user: { id: string; name: string; role: MocaRole; level: number; job_title?: string };
  /** Mappa completa consegnata dall'Hub. Resta in questa funzione. */
  configurations?: Record<string, string>;
  hasDataForSeo: boolean;
  mock: boolean;
}

async function validateWithHub(token?: string): Promise<SessionContext> {
  if (!token) {
    throw new HttpError(400, 'Token di accesso mancante', 'NO_TOKEN');
  }

  let response: Response;
  try {
    response = await fetch(`${hubUrl()}/api/validate-launch-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    console.error('[auth] Hub non raggiungibile:', err);
    throw new HttpError(502, 'Moca Hub non raggiungibile');
  }

  const data = (await response.json().catch(() => ({}))) as HubResponse;

  if (!response.ok || !data.success || !data.client || !data.user) {
    // INVALID_TOKEN / TOKEN_CONSUMED / TOKEN_EXPIRED -> per l'app e' sempre
    // "Accesso Negato"; il dettaglio resta nei log.
    console.warn(`[auth] Validazione fallita: ${data.code ?? response.status}`);
    throw new HttpError(401, 'Token di accesso non valido o scaduto', data.code ?? 'INVALID_TOKEN');
  }

  return {
    client: { id: data.client.id, name: data.client.name, logo_url: data.client.logo_url },
    user: {
      id: data.user.id,
      name: data.user.name,
      role: (data.user.role as MocaRole) ?? 'specialist',
      level: data.user.level ?? 0,
      job_title: data.user.job_title,
    },
    configurations: data.configurations ?? {},
    hasDataForSeo: Boolean(
      data.configurations?.DATAFORSEO_LOGIN && data.configurations?.DATAFORSEO_PASSWORD,
    ),
    mock: false,
  };
}

/** Sessione fittizia per lo sviluppo locale. Mai abilitata in produzione. */
function buildMockContext(): SessionContext {
  if (process.env.MOCA_ALLOW_MOCK !== 'true') {
    throw new HttpError(403, 'Mock Mode non abilitato su questo ambiente', 'MOCK_DISABLED');
  }

  return {
    client: {
      id: process.env.MOCA_MOCK_CLIENT_ID || '00000000-0000-4000-8000-000000000001',
      name: 'Cliente Demo',
      logo_url: 'https://placehold.co/100/E52217/FFFFFF?text=DEMO',
    },
    user: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Sviluppatore', role: 'super_admin', level: 5 },
    hasDataForSeo: Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
    mock: true,
  };
}

/**
 * Conserva le configurazioni del cliente, cifrate.
 * Sovrascrive a ogni accesso: l'Hub e' sempre la fonte autorevole, questa e'
 * solo la copia che serve alle esecuzioni senza utente collegato.
 */
async function storeConfigurations(
  clientId: string,
  userId: string,
  configurations: Record<string, string>,
): Promise<void> {
  // Nessuna configurazione: non sovrascriviamo una copia valida con una vuota.
  if (Object.keys(configurations).length === 0) return;

  try {
    const { error } = await supabaseAdmin().from('pt_client_credentials').upsert(
      {
        client_id: clientId,
        payload: encryptJson(configurations),
        config_keys: Object.keys(configurations),
        updated_at: new Date().toISOString(),
        updated_by: userId,
      },
      { onConflict: 'client_id' },
    );

    if (error) console.warn('[auth] Configurazioni non conservate:', error.message);
  } catch (err) {
    // L'accesso deve riuscire comunque: senza copia, le scansioni avviate
    // dall'utente useranno le configurazioni lette al momento.
    console.warn('[auth] Cifratura configurazioni non riuscita:', (err as Error).message);
  }
}

/** Crea la riga di impostazioni al primo accesso del cliente. */
async function ensureClientSetup(clientId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('pt_settings')
      .upsert({ client_id: clientId }, { onConflict: 'client_id', ignoreDuplicates: true });

    if (error) console.warn('[auth] Inizializzazione impostazioni non riuscita:', error.message);
  } catch (err) {
    // Non blocchiamo il login: l'app mostrera' le impostazioni di default.
    console.warn('[auth] Supabase non disponibile durante il setup:', (err as Error).message);
  }
}
