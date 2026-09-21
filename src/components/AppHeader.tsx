/**
 * AppHeader - header conforme al Design System v2.0 di Moca Hub.
 *
 * Layout a 3 zone, sticky, sfondo moca-black:
 *   Sx     -> logo + nome cliente + utente
 *   Centro -> titolo dell'app
 *   Dx     -> logo Moca (versione light) + pulsante Esci
 */
import { LogOut } from 'lucide-react';
import { useMoca } from '../lib/MocaProvider';

const MOCA_LOGO = 'https://mocainteractive.com/assets/svg/logo-light.svg';

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  specialist: 'Specialist',
  external: 'Esterno',
};

export function AppHeader({ appTitle }: { appTitle: string }) {
  const { client, user, logout } = useMoca();

  return (
    <header className="bg-moca-black text-white sticky top-0 z-50 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Sx: cliente */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {client.logo_url && (
              <img
                src={client.logo_url}
                alt={client.name}
                className="h-10 w-10 object-contain bg-white rounded-md p-1 shrink-0"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{client.name}</p>
              <p className="text-xs text-gray-300 truncate">
                {user.name} · {ROLE_LABELS[user.role] ?? user.role}
              </p>
            </div>
          </div>

          {/* Centro: titolo app */}
          <div className="hidden md:flex flex-1 justify-center">
            <h1 className="text-lg font-semibold truncate">{appTitle}</h1>
          </div>

          {/* Dx: logo Moca + logout */}
          <div className="flex-1 flex items-center justify-end gap-4">
            <img src={MOCA_LOGO} alt="Moca" className="h-6 opacity-80 hidden sm:block" />
            <button
              onClick={logout}
              className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-moca-red transition-colors"
              title="Esci"
            >
              <LogOut size={18} />
              <span className="hidden sm:inline text-sm">Esci</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
