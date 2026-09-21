/**
 * Avvisi - scostamenti rilevati durante le scansioni.
 * Ogni avviso porta direttamente alla scheda del prodotto interessato.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Badge, Card, EmptyState, ErrorBanner, LoadingBlock } from '../components/ui';
import { formatPercent, formatPrice, formatRelative } from '../lib/format';
import type { Alert } from '../lib/types';

interface AlertsResponse {
  alerts: Alert[];
}

const KIND_LABELS: Record<Alert['kind'], { label: string; tone: 'critico' | 'attenzione' | 'info' }> = {
  sottoprezzo: { label: 'Competitor sotto prezzo', tone: 'critico' },
  sovrapprezzo: { label: 'Siamo i piu\' cari', tone: 'attenzione' },
  nuovo_competitor: { label: 'Nuovo competitor', tone: 'info' },
  non_disponibile: { label: 'Non disponibile', tone: 'attenzione' },
};

export function Avvisi() {
  const { token, canWrite } = useMoca();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useApiGet<AlertsResponse>('alerts', {
    onlyUnread: onlyUnread ? 'true' : undefined,
    limit: 100,
  });

  const markRead = async (body: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiPost(token, 'alerts', body);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Operazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-moca-black">Avvisi</h2>
          <p className="text-sm text-moca-gray">
            Scostamenti oltre le soglie impostate, rilevati durante le scansioni.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-moca-black">
            <input
              type="checkbox"
              checked={onlyUnread}
              onChange={(event) => setOnlyUnread(event.target.checked)}
              className="rounded border-gray-300 text-moca-red focus:ring-moca-red"
            />
            Solo da leggere
          </label>

          {canWrite && (
            <button
              onClick={() => markRead({ all: true })}
              disabled={busy}
              className="moca-btn-secondary"
            >
              <CheckCheck size={16} />
              Segna tutti come letti
            </button>
          )}
        </div>
      </div>

      {actionError && <ErrorBanner message={actionError} />}

      <Card>
        {loading && <LoadingBlock />}
        {error && <ErrorBanner message={error} onRetry={reload} />}

        {data && !loading && data.alerts.length === 0 && (
          <EmptyState
            icon={Bell}
            title="Nessun avviso"
            description={
              onlyUnread
                ? 'Hai letto tutti gli avvisi.'
                : "Quando un competitor scendera' sotto le tue soglie lo troverai qui."
            }
          />
        )}

        {data && !loading && data.alerts.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {data.alerts.map((alert) => {
              const kind = KIND_LABELS[alert.kind];
              return (
                <li
                  key={alert.id}
                  className={`py-4 flex flex-wrap items-start justify-between gap-4 ${
                    alert.is_read ? 'opacity-60' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={kind.tone}>{kind.label}</Badge>
                      {!alert.is_read && <Badge tone="info">Da leggere</Badge>}
                    </div>
                    <Link
                      to={`/catalogo/${alert.product_id}`}
                      className="mt-2 block text-sm text-moca-black hover:text-moca-red"
                    >
                      {alert.message}
                    </Link>
                    <p className="mt-1 text-xs text-moca-gray">
                      {formatRelative(alert.created_at)}
                      {alert.own_price !== null && ` · il tuo prezzo ${formatPrice(alert.own_price)}`}
                      {alert.competitor_price !== null &&
                        ` · competitor ${formatPrice(alert.competitor_price)}`}
                      {alert.delta_pct !== null && ` · ${formatPercent(alert.delta_pct)}`}
                    </p>
                  </div>

                  {canWrite && !alert.is_read && (
                    <button
                      onClick={() => markRead({ ids: [alert.id] })}
                      disabled={busy}
                      className="moca-btn-secondary text-sm"
                    >
                      Segna come letto
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
