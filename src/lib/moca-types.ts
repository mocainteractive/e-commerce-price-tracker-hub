/** Forma della sessione restituita da /api/validate-launch-token dell'Hub. */

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

export interface MocaApplication {
  id: string;
  name: string;
  description?: string;
}

/** Istanza esposta da public/moca-sdk.js (SDK ufficiale dell'Hub). */
export interface MocaSDKInstance {
  init: () => Promise<boolean>;
  enableMockMode: (config: {
    client?: Partial<MocaClient>;
    user?: Partial<MocaUser>;
    configurations?: Record<string, string>;
  }) => void;
  isAuthenticated: () => boolean;
  getClient: () => MocaClient | null;
  getUser: () => MocaUser | null;
  getApplication: () => MocaApplication | null;
  getConfig: (key: string) => string | null;
  getAllConfigs: () => Record<string, string>;
  logout: () => void;
}

/** Chiavi di configurazione attese fra le configurazioni cliente dell'Hub. */
export const CONFIG_KEYS = {
  dfsLogin: 'DATAFORSEO_LOGIN',
  dfsPassword: 'DATAFORSEO_PASSWORD',
} as const;
