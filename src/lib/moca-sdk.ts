/**
 * Moca SDK (TypeScript) - integrazione con Moca Hub.
 *
 * Stesso contratto di rete dell'SDK ufficiale (`?moca_token=` -> sessione di
 * 8 ore in sessionStorage), con una differenza voluta:
 *
 *   la validazione del launch token avviene su una nostra Netlify Function
 *   (`/api/auth-session`) invece che nel browser.
 *
 * Motivo: la risposta dell'Hub contiene le `configurations` del cliente, cioe'
 * le API key in chiaro. Validando lato server quelle chiavi non entrano mai nel
 * browser; al client torna solo un JWT di sessione firmato, che autentica in
 * modo verificabile le chiamate successive al nostro backend.
 * Vedi netlify/functions/utils/session.ts.
 */

export interface MocaClient {
  id: string;
  name: string;
  email?: string;
  logo_url?: string;
}

export interface MocaUser {
  id: string;
  name: string;
  email?: string;
  /** Ruoli reali dell'Hub: super_admin | manager | specialist | external */
  role: string;
  level?: number;
  job_title?: string;
}

export interface MocaSession {
  token: string;
  expiresAt: number;
  client: MocaClient;
  user: MocaUser;
  hasDataForSeo: boolean;
}

const SESSION_KEY = 'moca_session';

export class MocaSDK {
  private readonly hubUrl: string;
  private readonly exchangeUrl: string;
  private session: MocaSession | null = null;
  private mockEnabled = false;

  constructor(hubUrl: string, exchangeUrl = '/api/auth-session') {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.exchangeUrl = exchangeUrl;
  }

  /** Abilita il Mock Mode per lo sviluppo locale. Chiamare PRIMA di init(). */
  enableMockMode(): void {
    this.mockEnabled = true;
  }

  /** Valida il launch token o ripristina la sessione. Una sola volta all'avvio. */
  async init(): Promise<boolean> {
    const restored = this.loadSession();
    if (restored) {
      this.session = restored;
      return true;
    }

    const token = new URLSearchParams(window.location.search).get('moca_token');

    if (token) {
      const okResult = await this.exchange({ token });
      if (okResult) this.cleanUrl();
      return okResult;
    }

    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (this.mockEnabled && isLocal) {
      console.info('[Moca SDK] MOCK MODE attivo (solo sviluppo locale)');
      return this.exchange({ mock: true });
    }

    console.warn('[Moca SDK] Nessun token nell\'URL e nessuna sessione attiva');
    return false;
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  getSession(): MocaSession | null {
    return this.session;
  }

  getClient(): MocaClient | null {
    return this.session?.client ?? null;
  }

  getUser(): MocaUser | null {
    return this.session?.user ?? null;
  }

  /** JWT applicativo da mettere in `Authorization` verso /api/*. */
  getToken(): string | null {
    return this.session?.token ?? null;
  }

  getHubUrl(): string {
    return this.hubUrl;
  }

  logout(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.session = null;
  }

  // --- privati ---------------------------------------------------------------

  private async exchange(payload: { token?: string; mock?: boolean }): Promise<boolean> {
    try {
      const res = await fetch(this.exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        console.error('[Moca SDK] Validazione fallita:', data.code ?? res.status);
        return false;
      }

      this.session = {
        token: data.token,
        expiresAt: data.expiresAt,
        client: data.client,
        user: data.user,
        hasDataForSeo: Boolean(data.hasDataForSeo),
      };
      this.saveSession();
      return true;
    } catch (err) {
      console.error('[Moca SDK] Errore di rete nella validazione:', err);
      return false;
    }
  }

  private loadSession(): MocaSession | null {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (!stored) return null;

      const session = JSON.parse(stored) as MocaSession;
      // `expiresAt` e' in secondi (claim `exp` del JWT).
      if (!session.expiresAt || session.expiresAt * 1000 <= Date.now()) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private saveSession(): void {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    } catch (err) {
      console.error('[Moca SDK] Impossibile salvare la sessione:', err);
    }
  }

  private cleanUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete('moca_token');
    window.history.replaceState({}, document.title, url.toString());
  }
}
