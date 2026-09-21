/**
 * Sessione applicativa del Price Tracker.
 *
 * Perche' non usiamo la sessione dell'SDK lato browser
 * -----------------------------------------------------
 * Il launch token dell'Hub e' monouso e scade in 5 minuti: una volta validato
 * non e' piu' riutilizzabile, quindi non puo' autenticare le chiamate
 * successive alle nostre Netlify Functions. Se il backend si fidasse di un
 * `client_id` inviato dal browser avremmo un IDOR (la service_role bypassa la
 * RLS e un utente potrebbe leggere i dati di clienti non suoi).
 *
 * Soluzione (prevista dalla skill moca-netlify-functions: "valida il moca_token
 * lato funzione"): il launch token viene validato da `auth-session`, che poi
 * emette un JWT applicativo firmato HS256 con `APP_SESSION_SECRET`. Il browser
 * conserva solo quel JWT; le credenziali DataForSEO restano server-side.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { HandlerEvent } from '@netlify/functions';
import { HttpError, requireEnv } from './http';

/** Ruoli reali dell'Hub. */
export type MocaRole = 'super_admin' | 'manager' | 'specialist' | 'external';

export interface AppSession {
  userId: string;
  userName: string;
  clientId: string;
  clientName: string;
  clientLogoUrl?: string;
  role: MocaRole;
  level: number;
  /** true solo per le sessioni mock in sviluppo locale. */
  mock: boolean;
}

const ISSUER = 'moca-price-tracker';
const TTL_SECONDS = 8 * 60 * 60; // 8 ore, allineato alla sessione dell'SDK Moca

function secretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv('APP_SESSION_SECRET'));
}

export async function signSession(session: AppSession): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const token = await new SignJWT({
    name: session.userName,
    client_id: session.clientId,
    client_name: session.clientName,
    client_logo_url: session.clientLogoUrl,
    role: session.role,
    level: session.level,
    mock: session.mock,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey());

  return { token, expiresAt };
}

export async function verifySession(token: string): Promise<AppSession> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: ISSUER,
    });

    return {
      userId: String(payload.sub),
      userName: String(payload.name ?? ''),
      clientId: String(payload.client_id),
      clientName: String(payload.client_name ?? ''),
      clientLogoUrl: payload.client_logo_url ? String(payload.client_logo_url) : undefined,
      role: payload.role as MocaRole,
      level: Number(payload.level ?? 0),
      mock: Boolean(payload.mock),
    };
  } catch {
    throw new HttpError(401, 'Sessione scaduta o non valida', 'SESSION_INVALID');
  }
}

/** Estrae e verifica la sessione dall'header Authorization. */
export async function requireSession(event: HandlerEvent): Promise<AppSession> {
  const header = event.headers.authorization ?? event.headers.Authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Autenticazione richiesta', 'NO_SESSION');
  }
  return verifySession(header.slice('Bearer '.length).trim());
}

export function isPrivileged(role: MocaRole): boolean {
  return role === 'super_admin' || role === 'manager';
}

/**
 * Gate di scrittura: gli utenti `external` possono solo consultare.
 * Chiamalo su ogni endpoint che modifica dati.
 */
export function requireWriteAccess(session: AppSession): void {
  if (session.role === 'external') {
    throw new HttpError(403, 'Il tuo ruolo non consente modifiche', 'READ_ONLY');
  }
}
