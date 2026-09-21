/**
 * Dashboard - risposta a tre domande, in quest'ordine:
 *   1. come siamo messi a prezzo, oggi?
 *   2. come si sta muovendo il mercato?
 *   3. chi ci sta facendo concorrenza e dove?
 */
import { Link } from 'react-router-dom';
import {
  Bell,
  Package,
  Radar,
  Store,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { Card, EmptyState, ErrorBanner, LoadingBlock, StatTile, Badge } from '../components/ui';
import { PriceLineChart, type ChartSeries } from '../components/PriceLineChart';
import { SERIES_COLORS, STATUS_COLORS } from '../lib/chart-palette';
import { formatNumber, formatPercent, formatPrice, formatRelative } from '../lib/format';
import type { DashboardData, PricePosition } from '../lib/types';

const POSITION_LABELS: Record<PricePosition, string> = {
  migliore: 'Prezzo migliore',
  allineato: 'Allineati',
  caro: 'Fuori prezzo',
  sconosciuto: 'Non confrontati',
};

export function Dashboard() {
  const { data, loading, error, reload } = useApiGet<DashboardData>('dashboard', { days: 30 });

  if (loading) return <LoadingBlock label="Calcolo del posizionamento in corso" />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const { kpi, series, competitors, alerts, lastRun, currency } = data;

  if (kpi.productsTotal === 0) {
    return (
      <Card>
        <EmptyState
          icon={Package}
          title="Nessun prodotto in catalogo"
          description="Importa il catalogo dal feed Google Merchant, da un CSV o dalla sitemap del sito per iniziare a monitorare i prezzi."
          action={
            <Link to="/catalogo" className="moca-btn-primary">
              Vai al catalogo
            </Link>
          }
        />
      </Card>
    );
  }

  const chartSeries: ChartSeries[] = [
    {
      key: 'own',
      label: 'Il tuo prezzo medio',
      color: SERIES_COLORS[0],
      points: toPoints(series, 'own_avg'),
    },
    {
      key: 'market_avg',
      label: 'Media di mercato',
      color: SERIES_COLORS[1],
      points: toPoints(series, 'market_avg'),
    },
    {
      key: 'market_min',
      label: 'Minimo di mercato',
      color: SERIES_COLORS[2],
      points: toPoints(series, 'market_min_avg'),
    },
  ].filter((s) => s.points.length > 0);

  const deltaTone = kpi.avgDeltaVsMinPct === null
    ? 'neutro'
    : kpi.avgDeltaVsMinPct <= 0
      ? 'positivo'
      : kpi.avgDeltaVsMinPct <= 5
        ? 'attenzione'
        : 'critico';

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Prodotti monitorati"
          value={formatNumber(kpi.productsMonitored)}
          hint={`su ${formatNumber(kpi.productsTotal)} in catalogo`}
          icon={Package}
        />
        <StatTile
          label="Scostamento medio dal minimo"
          value={formatPercent(kpi.avgDeltaVsMinPct)}
          hint="quanto costiamo in piu' del prezzo piu' basso"
          icon={kpi.avgDeltaVsMinPct !== null && kpi.avgDeltaVsMinPct > 0 ? TrendingUp : TrendingDown}
          tone={deltaTone}
        />
        <StatTile
          label="Competitor rilevati"
          value={formatNumber(kpi.competitorsTracked)}
          hint="domini che vendono i nostri prodotti"
          icon={Store}
        />
        <StatTile
          label="Avvisi da leggere"
          value={formatNumber(kpi.unreadAlerts)}
          hint={lastRun ? `ultima scansione ${formatRelative(lastRun.started_at)}` : 'nessuna scansione'}
          icon={Bell}
          tone={kpi.unreadAlerts > 0 ? 'attenzione' : 'neutro'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Andamento prezzi, ultimi 30 giorni" className="lg:col-span-2">
          <PriceLineChart
            series={chartSeries}
            currency={currency}
            emptyLabel="Servono almeno due giorni di rilevazioni per disegnare l'andamento. Avvia una scansione e torna domani."
          />
        </Card>

        <Card title="Posizionamento del catalogo">
          <ul className="space-y-3">
            {(Object.keys(POSITION_LABELS) as PricePosition[]).map((position) => {
              const count = kpi.distribution[position] ?? 0;
              const share = kpi.productsTotal > 0 ? (count / kpi.productsTotal) * 100 : 0;

              return (
                <li key={position}>
                  <div className="flex items-baseline justify-between text-sm">
                    <Link
                      to={`/catalogo?position=${position}`}
                      className="text-moca-black hover:text-moca-red"
                    >
                      {POSITION_LABELS[position]}
                    </Link>
                    <span className="tabular-nums text-moca-gray">
                      {formatNumber(count)} · {share.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${share}%`, backgroundColor: STATUS_COLORS[position] }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Competitor piu' presenti"
          action={
            <Link to="/competitor" className="text-sm text-moca-red hover:underline">
              Vedi tutti
            </Link>
          }
        >
          {competitors.length === 0 ? (
            <EmptyState
              icon={Radar}
              title="Nessun competitor rilevato"
              description="Avvia una scansione per scoprire chi vende i tuoi stessi prodotti."
            />
          ) : (
            <ul className="divide-y divide-gray-100">
              {competitors.slice(0, 6).map((competitor) => (
                <li key={competitor.domain} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-moca-black truncate">
                      {competitor.label ?? competitor.domain}
                    </p>
                    <p className="text-xs text-moca-gray">
                      {formatNumber(competitor.productsMatched)} prodotti in comune ·{' '}
                      {formatNumber(competitor.cheaperThanUs)} sotto il nostro prezzo
                    </p>
                  </div>
                  <Badge
                    tone={
                      competitor.avgDeltaPct === null
                        ? 'neutro'
                        : competitor.avgDeltaPct < 0
                          ? 'critico'
                          : 'positivo'
                    }
                  >
                    {formatPercent(competitor.avgDeltaPct)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Ultimi avvisi"
          action={
            <Link to="/avvisi" className="text-sm text-moca-red hover:underline">
              Vedi tutti
            </Link>
          }
        >
          {alerts.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Nessun avviso"
              description="Quando un competitor scendera' sotto le tue soglie lo troverai qui."
            />
          ) : (
            <ul className="divide-y divide-gray-100">
              {alerts.slice(0, 6).map((alert) => (
                <li key={alert.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      to={`/catalogo/${alert.product_id}`}
                      className="text-sm text-moca-black hover:text-moca-red"
                    >
                      {alert.message}
                    </Link>
                    <Badge tone={alert.kind === 'sottoprezzo' ? 'critico' : 'attenzione'}>
                      {alert.kind === 'sottoprezzo' ? 'Sottoprezzo' : 'Sovrapprezzo'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-moca-gray">
                    {formatRelative(alert.created_at)}
                    {alert.competitor_price !== null &&
                      ` · ${formatPrice(alert.competitor_price, currency)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function toPoints(
  series: DashboardData['series'],
  key: 'own_avg' | 'market_avg' | 'market_min_avg',
): Array<{ day: string; price: number }> {
  return series
    .filter((point) => point[key] !== null)
    .map((point) => ({ day: point.day, price: Number(point[key]) }));
}
