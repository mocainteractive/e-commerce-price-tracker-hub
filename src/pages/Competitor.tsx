/**
 * Competitor - chi vende i nostri prodotti, quanto spesso ci sta sotto e di
 * quanto. I domini si possono anche aggiungere a mano, per tenerli sotto
 * osservazione anche prima che una scansione li rilevi.
 */
import { useState } from 'react';
import { Plus, Store, Trash2 } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Badge, Card, EmptyState, ErrorBanner, LoadingBlock } from '../components/ui';
import { buildColorMap } from '../lib/chart-palette';
import { formatNumber, formatPercent } from '../lib/format';
import type { Competitor as CompetitorRow, CompetitorStat, DashboardData, Settings } from '../lib/types';

interface SettingsResponse {
  settings: Settings;
  competitors: CompetitorRow[];
}

export function Competitor() {
  const { requestContext, canWrite } = useMoca();
  const dashboard = useApiGet<DashboardData>('dashboard', { days: 30 });
  const config = useApiGet<SettingsResponse>('settings');

  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(requestContext, 'settings', body);
      config.reload();
      dashboard.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Operazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  if (dashboard.loading || config.loading) return <LoadingBlock />;
  if (dashboard.error) return <ErrorBanner message={dashboard.error} onRetry={dashboard.reload} />;
  if (!dashboard.data || !config.data) return null;

  const stats = dashboard.data.competitors;
  const tracked = config.data.competitors.filter((c) => !c.is_own);

  // Colori stabili: l'ordine deriva dai dati, non dalla classifica mostrata.
  const colors = buildColorMap(
    [...stats].map((s) => s.domain).sort(),
    config.data.settings.own_domain,
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-moca-black">Competitor</h2>
        <p className="text-sm text-moca-gray">
          {formatNumber(stats.length)} domini rilevati sulle ultime scansioni
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <Card title="Confronto sul catalogo">
        {stats.length === 0 ? (
          <EmptyState
            icon={Store}
            title="Nessun competitor rilevato"
            description="Avvia una scansione: i domini che vendono i tuoi prodotti compariranno qui automaticamente."
          />
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-moca-gray border-b border-gray-200">
                  <th className="py-3 pr-4 font-semibold">Dominio</th>
                  <th className="py-3 pr-4 font-semibold text-right">Prodotti in comune</th>
                  <th className="py-3 pr-4 font-semibold text-right">Sotto di noi</th>
                  <th className="py-3 pr-4 font-semibold text-right">Sopra di noi</th>
                  <th className="py-3 pr-4 font-semibold text-right">Scostamento medio</th>
                  <th className="py-3 font-semibold">Pressione</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((stat) => (
                  <tr key={stat.domain} className="border-b border-gray-100">
                    <td className="py-3 pr-4">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: colors.get(stat.domain) }}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-moca-black">
                          {stat.label ?? stat.domain}
                        </span>
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">
                      {formatNumber(stat.productsMatched)}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-moca-red">
                      {formatNumber(stat.cheaperThanUs)}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-success">
                      {formatNumber(stat.moreExpensive)}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">
                      {formatPercent(stat.avgDeltaPct)}
                    </td>
                    <td className="py-3">
                      <PressureBadge stat={stat} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-xs text-moca-gray">
              Lo scostamento medio e' quanto il competitor costa rispetto a noi:
              un valore negativo significa che vende a meno.
            </p>
          </div>
        )}
      </Card>

      <Card title="Domini monitorati">
        {canWrite && (
          <form
            className="flex flex-wrap items-end gap-3 mb-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!domain.trim()) return;
              void mutate({ addCompetitor: { domain: domain.trim() } });
              setDomain('');
            }}
          >
            <div className="flex-1 min-w-[240px]">
              <label className="moca-label" htmlFor="nuovo-competitor">
                Aggiungi un dominio
              </label>
              <input
                id="nuovo-competitor"
                type="text"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="competitor.it"
                className="moca-input"
              />
            </div>
            <button type="submit" disabled={busy} className="moca-btn-primary">
              <Plus size={16} />
              Aggiungi
            </button>
          </form>
        )}

        {tracked.length === 0 ? (
          <p className="text-sm text-moca-gray">
            Nessun dominio aggiunto a mano. I competitor rilevati dalle scansioni
            vengono comunque tracciati in automatico.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tracked.map((competitor) => (
              <li key={competitor.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-moca-black">{competitor.domain}</p>
                  {competitor.label && <p className="text-xs text-moca-gray">{competitor.label}</p>}
                </div>
                {canWrite && (
                  <button
                    onClick={() => mutate({ removeCompetitorId: competitor.id })}
                    disabled={busy}
                    className="moca-btn-secondary !px-3 !py-1.5"
                    title={`Rimuovi ${competitor.domain}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PressureBadge({ stat }: { stat: CompetitorStat }) {
  if (stat.productsMatched === 0) return <Badge>Nessun dato</Badge>;

  const share = stat.cheaperThanUs / stat.productsMatched;
  if (share >= 0.6) return <Badge tone="critico">Alta</Badge>;
  if (share >= 0.3) return <Badge tone="attenzione">Media</Badge>;
  return <Badge tone="positivo">Bassa</Badge>;
}
