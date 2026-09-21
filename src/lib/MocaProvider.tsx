/**
 * MocaProvider - context React per l'integrazione con Moca Hub.
 *
 * Esegue moca.init() una sola volta, mostra lo spinner durante la validazione
 * e, se fallisce, la schermata "Accesso Negato" con il link all'Hub.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { MocaSDK, type MocaClient, type MocaUser } from './moca-sdk';

const HUB_URL = import.meta.env.VITE_MOCA_HUB_URL ?? 'https://moca-central-hub.netlify.app';
const ALLOW_MOCK = import.meta.env.VITE_MOCA_ALLOW_MOCK === 'true';

interface MocaContextValue {
  client: MocaClient;
  user: MocaUser;
  /** true se il cliente ha le credenziali DataForSEO configurate nell'Hub. */
  hasDataForSeo: boolean;
  /** JWT applicativo per le chiamate a /api/*. */
  token: string;
  /** false per i ruoli in sola lettura (external). */
  canWrite: boolean;
  logout: () => void;
}

const MocaContext = createContext<MocaContextValue | null>(null);

export function useMoca(): MocaContextValue {
  const ctx = useContext(MocaContext);
  if (!ctx) throw new Error('useMoca deve essere usato dentro <MocaProvider>');
  return ctx;
}

export function MocaProvider({ children }: { children: ReactNode }) {
  const [sdk] = useState(() => new MocaSDK(HUB_URL));
  const [status, setStatus] = useState<'loading' | 'ok' | 'denied'>('loading');

  useEffect(() => {
    // Mock Mode: solo in locale e solo se l'ambiente lo consente.
    // Nessuna chiave reale nel repo: le credenziali restano lato server.
    if (ALLOW_MOCK) sdk.enableMockMode();

    sdk.init().then((authenticated) => setStatus(authenticated ? 'ok' : 'denied'));
  }, [sdk]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-moca-bg">
        <div className="animate-spin h-8 w-8 border-2 border-moca-red border-t-transparent rounded-full" />
        <span className="sr-only">Validazione dell'accesso in corso</span>
      </div>
    );
  }

  if (status === 'denied') {
    return <AccessoNegato hubUrl={HUB_URL} />;
  }

  const session = sdk.getSession()!;
  const value: MocaContextValue = {
    client: session.client,
    user: session.user,
    hasDataForSeo: session.hasDataForSeo,
    token: session.token,
    canWrite: session.user.role !== 'external',
    logout: () => {
      sdk.logout();
      window.location.href = HUB_URL;
    },
  };

  return <MocaContext.Provider value={value}>{children}</MocaContext.Provider>;
}

function AccessoNegato({ hubUrl }: { hubUrl: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-moca-bg text-center px-4">
      <div className="bg-white rounded-xl shadow-sm p-10 max-w-md">
        <div className="flex justify-center mb-4">
          <ShieldAlert size={48} className="text-moca-red" />
        </div>
        <h1 className="text-2xl font-bold text-moca-black mb-2">Accesso Negato</h1>
        <p className="text-moca-gray mb-6">
          Questa applicazione deve essere aperta tramite <strong>Moca Hub</strong>.
          Se hai gia' effettuato l'accesso, il link potrebbe essere scaduto: torna
          all'Hub e riapri l'app.
        </p>
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
