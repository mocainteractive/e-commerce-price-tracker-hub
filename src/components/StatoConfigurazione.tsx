/**
 * Pannello di stato della configurazione.
 *
 * Interroga /api/health e compare solo quando qualcosa non va. Serve a dire
 * subito quale variabile manca o quale migration non e' stata eseguita,
 * invece di lasciare le pagine con un errore generico.
 */
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { Card } from './ui';

interface Check {
  ok: boolean;
  dettaglio: string;
}

interface HealthResponse {
  pronto: boolean;
  riepilogo: string;
  checks: Record<string, Check>;
  versione: string;
}

const ETICHETTE: Record<string, string> = {
  supabase_url: 'URL Supabase',
  supabase_service_key: 'Chiave service_role',
  postback_secret: 'Segreto postback DataForSEO',
  app_public_url: 'URL pubblica dell\'app',
  tabella_pt_settings: 'Tabella impostazioni',
  tabella_pt_products: 'Tabella prodotti',
  tabella_pt_price_snapshots: 'Tabella storico prezzi',
  tabella_configurations: 'Configurazioni cliente (Hub)',
  funzione_pt_price_index: 'Funzione indice prezzi',
};

export function StatoConfigurazione({ sempreVisibile = false }: { sempreVisibile?: boolean }) {
  const { data, loading } = useApiGet<HealthResponse>('health');

  if (loading || !data) return null;

  const problemi = Object.entries(data.checks).filter(([, check]) => !check.ok);
  if (problemi.length === 0 && !sempreVisibile) return null;

  const righe = sempreVisibile ? Object.entries(data.checks) : problemi;

  return (
    <Card title="Stato della configurazione">
      <div className="flex items-start gap-3 mb-4">
        {data.pronto ? (
          <CheckCircle2 size={20} className="text-success shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
        )}
        <p className="text-sm text-moca-black">{data.riepilogo}</p>
      </div>

      <ul className="divide-y divide-gray-100">
        {righe.map(([key, check]) => (
          <li key={key} className="py-2.5 flex items-start gap-3">
            {check.ok ? (
              <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
            ) : (
              <XCircle size={16} className="text-moca-red shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-moca-black">{ETICHETTE[key] ?? key}</p>
              <p className="text-xs text-moca-gray break-words">{check.dettaglio}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-moca-gray">
        Le variabili si impostano su Netlify, in Site configuration, Environment
        variables. Le tabelle si creano eseguendo{' '}
        <code>supabase/migrations/0001_price_tracker.sql</code> sull'istanza
        Supabase condivisa con l'Hub.
      </p>
    </Card>
  );
}
