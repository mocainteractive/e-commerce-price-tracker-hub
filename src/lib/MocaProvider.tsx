/**
 * MocaProvider - integrazione con Moca Hub secondo il flusso ufficiale.
 *
 * Carica `public/moca-sdk.js` (copia dell'SDK dell'Hub), chiama `init()` una
 * sola volta, e mostra "Accesso Negato" se la sessione non e' valida.
 *
 * L'SDK valida `?moca_token=` direttamente con l'Hub e conserva in
 * sessionStorage client, user e `configurations` del cliente. Le chiavi
 * vengono poi inoltrate alle Netlify Functions dell'app, come previsto da
 * docs/APP_INTEGRATION_GUIDE.md ("Le chiavi vengono passate dall'app frontend
 * che le ha ricevute dal Moca Hub").
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  CONFIG_KEYS,
  type MocaApplication,
  type MocaClient,
  type MocaSDKInstance,
  type MocaUser,
} from './moca-types';

const MOCA_HUB_URL =
  (import.meta.env.VITE_MOCA_HUB_URL as string | undefined) ?? 'https://moca-central-hub.netlify.app';

declare global {
  interface Window {
    MocaSDK?: new (hubUrl: string) => MocaSDKInstance;
  }
}

/** Contesto che ogni chiamata alle nostre functions deve portare con se'. */
export interface MocaRequestContext {
  client_id: string;
  client_name: string;
  user_id: string;
  user_name: string;
  role: string;
  dfs_login?: string;
  dfs_password?: string;
  ai_key?: string;
  ai_model?: string;
}

interface MocaContextValue {
  client: MocaClient;
  user: MocaUser;
  application: MocaApplication | null;
  getConfig: (key: string) => string | null;
  hasConfig: (key: string) => boolean;
  /** true se il cliente ha le credenziali DataForSEO configurate nell'Hub. */
  hasDataForSeo: boolean;
  /** true se il cliente ha una chiave Anthropic nell'Hub (verifica AI dei match). */
  hasAi: boolean;
  /** false per i ruoli in sola lettura (external). */
  canWrite: boolean;
  /** Contesto da inoltrare alle Netlify Functions. */
  requestContext: MocaRequestContext;
  logout: () => void;
}

const MocaContext = createContext<MocaContextValue | null>(null);

export function useMoca(): MocaContextValue {
  const ctx = useContext(MocaContext);
  if (!ctx) throw new Error('useMoca deve essere usato dentro <MocaProvider>');
  return ctx;
}

function loadSdkScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.MocaSDK) return resolve();

    const existing = document.querySelector<HTMLScriptElement>('script[data-moca-sdk]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Caricamento moca-sdk.js fallito')));
      return;
    }

    const script = document.createElement('script');
    script.src = '/moca-sdk.js';
    script.async = true;
    script.dataset.mocaSdk = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Caricamento moca-sdk.js fallito'));
    document.head.appendChild(script);
  });
}

export function MocaProvider({ children }: { children: ReactNode }) {
  const [sdk, setSdk] = useState<MocaSDKInstance | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'denied'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadSdkScript();
        if (cancelled) return;

        if (!window.MocaSDK) {
          throw new Error('MocaSDK non disponibile dopo il caricamento dello script');
        }

        const instance = new window.MocaSDK(MOCA_HUB_URL);

        // Mock Mode solo su localhost: simula la sessione dell'Hub.
        // Le chiavi di test vanno in .env.local, mai nel repo.
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') {
          console.info('[MocaProvider] Localhost: Mock Mode attivo');
          instance.enableMockMode({
            client: {
              // Le functions accettano solo UUID: il mock ne usa uno valido,
              // altrimenti in locale ogni chiamata verrebbe respinta.
              id: (import.meta.env.VITE_DEV_CLIENT_ID as string) || '00000000-0000-4000-8000-000000000001',
              name: 'Cliente Demo',
              logo_url: 'https://placehold.co/100/E52217/FFFFFF?text=DEMO',
            },
            user: {
              id: '00000000-0000-4000-8000-0000000000aa',
              name: 'Sviluppatore',
              role: 'super_admin',
              level: 5,
            },
            configurations: {
              [CONFIG_KEYS.dfsLogin]: (import.meta.env.VITE_DEV_DATAFORSEO_LOGIN as string) ?? '',
              [CONFIG_KEYS.dfsPassword]: (import.meta.env.VITE_DEV_DATAFORSEO_PASSWORD as string) ?? '',
              [CONFIG_KEYS.anthropicKey]: (import.meta.env.VITE_DEV_ANTHROPIC_API_KEY as string) ?? '',
            },
          });
        }

        const authenticated = await instance.init();
        if (cancelled) return;

        setSdk(instance);
        setStatus(authenticated ? 'ok' : 'denied');
      } catch (err) {
        if (cancelled) return;
        console.error('[MocaProvider] Inizializzazione fallita:', err);
        setError(err instanceof Error ? err.message : 'Errore sconosciuto');
        setStatus('denied');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<MocaContextValue | null>(() => {
    if (!sdk || status !== 'ok') return null;

    const client = sdk.getClient();
    const user = sdk.getUser();
    if (!client || !user) return null;

    const dfsLogin = sdk.getConfig(CONFIG_KEYS.dfsLogin) ?? '';
    const dfsPassword = sdk.getConfig(CONFIG_KEYS.dfsPassword) ?? '';
    const aiKey = sdk.getConfig(CONFIG_KEYS.anthropicKey) ?? '';
    const aiModel = sdk.getConfig(CONFIG_KEYS.anthropicModel) ?? '';

    return {
      client,
      user,
      application: sdk.getApplication(),
      getConfig: (key) => sdk.getConfig(key),
      hasConfig: (key) => {
        const v = sdk.getConfig(key);
        return typeof v === 'string' && v.length > 0;
      },
      hasDataForSeo: Boolean(dfsLogin && dfsPassword),
      hasAi: Boolean(aiKey),
      canWrite: user.role !== 'external',
      requestContext: {
        client_id: client.id,
        client_name: client.name,
        user_id: user.id,
        user_name: user.name,
        role: user.role,
        // Inoltrate solo se presenti: le functions hanno un fallback
        // sulle configurazioni cliente dell'Hub.
        ...(dfsLogin && dfsPassword ? { dfs_login: dfsLogin, dfs_password: dfsPassword } : {}),
        ...(aiKey ? { ai_key: aiKey, ...(aiModel ? { ai_model: aiModel } : {}) } : {}),
      },
      logout: () => {
        sdk.logout();
        window.location.href = MOCA_HUB_URL;
      },
    };
  }, [sdk, status]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-moca-bg">
        <div className="animate-spin h-8 w-8 border-2 border-moca-red border-t-transparent rounded-full" />
        <span className="sr-only">Validazione dell'accesso in corso</span>
      </div>
    );
  }

  if (status === 'denied' || !value) {
    return <AccessoNegato hubUrl={MOCA_HUB_URL} details={error} />;
  }

  return <MocaContext.Provider value={value}>{children}</MocaContext.Provider>;
}

function AccessoNegato({ hubUrl, details }: { hubUrl: string; details: string | null }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-moca-bg text-center px-4">
      <div className="bg-white rounded-xl shadow-sm p-10 max-w-md">
        <div className="flex justify-center mb-4">
          <ShieldAlert size={48} className="text-moca-red" />
        </div>
        <h1 className="text-2xl font-bold text-moca-black mb-2">Accesso Negato</h1>
        <p className="text-moca-gray mb-6">
          Questa applicazione deve essere aperta tramite <strong>Moca Hub</strong>.
          Il link di accesso e' monouso e scade dopo cinque minuti: torna all'Hub
          e riapri l'app.
        </p>
        {details && <p className="text-xs text-moca-gray mb-6">Dettaglio tecnico: {details}</p>}
        <a
          href={hubUrl}
          className="inline-block px-6 py-3 bg-moca-red text-white rounded-md font-semibold hover:opacity-90 transition-opacity"
        >
          Vai a Moca Hub
        </a>
      </div>
    </div>
  );
}
