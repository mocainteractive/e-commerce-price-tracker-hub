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
      hasDataForSeo: context.hasDataForSeo,
    },
    headers,
  );
});

interface SessionContext {
  client: { id: string; name: string; logo_url?: string };
  user: { id: string; name: string; role: MocaRole; level: number; job_title?: string };
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
