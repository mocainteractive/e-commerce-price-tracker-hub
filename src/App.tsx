import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  Bell,
  LayoutDashboard,
  Package,
  RadarIcon,
  Settings,
  Store,
  type LucideIcon,
} from 'lucide-react';
import { AppHeader } from './components/AppHeader';
import { Dashboard } from './pages/Dashboard';
import { Catalogo } from './pages/Catalogo';
import { Prodotto } from './pages/Prodotto';
import { Competitor } from './pages/Competitor';
import { Scansioni } from './pages/Scansioni';
import { Impostazioni } from './pages/Impostazioni';
import { Avvisi } from './pages/Avvisi';

const APP_TITLE = 'Price Tracker';

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/catalogo', label: 'Catalogo', icon: Package },
  { to: '/competitor', label: 'Competitor', icon: Store },
  { to: '/scansioni', label: 'Scansioni', icon: RadarIcon },
  { to: '/avvisi', label: 'Avvisi', icon: Bell },
  { to: '/impostazioni', label: 'Impostazioni', icon: Settings },
];

export default function App() {
  return (
    <div className="min-h-screen bg-moca-bg">
      <AppHeader appTitle={APP_TITLE} />

      <nav className="bg-white border-b border-gray-200 sticky top-16 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <ul className="flex gap-1 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                      isActive
                        ? 'border-moca-red text-moca-red'
                        : 'border-transparent text-moca-black hover:bg-gray-100'
                    }`
                  }
                >
                  <Icon size={16} />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/catalogo" element={<Catalogo />} />
          <Route path="/catalogo/:productId" element={<Prodotto />} />
          <Route path="/competitor" element={<Competitor />} />
          <Route path="/scansioni" element={<Scansioni />} />
          <Route path="/avvisi" element={<Avvisi />} />
          <Route path="/impostazioni" element={<Impostazioni />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 text-xs text-moca-gray">
          Dati di mercato forniti da Google Shopping tramite DataForSEO. I prezzi
          rilevati sono indicativi e possono variare rispetto a quelli di vendita.
        </div>
      </footer>
    </div>
  );
}
