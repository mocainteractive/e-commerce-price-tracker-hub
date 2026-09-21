/**
 * Scheda prodotto - il confronto vero e proprio:
 * chi lo vende, a quanto, e come si e' mosso il prezzo nel tempo.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Plus,
  ShieldCheck,
  Store,
  X,
} from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  PositionBadge,
  PriceRangeBar,
} from '../components/ui';
import { PriceLineChart, type ChartSeries } from '../components/PriceLineChart';
import { buildColorMap, MAX_SERIES } from '../lib/chart-palette';
import {
  formatAvailability,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRelative,
} from '../lib/format';
import type { HistoryPoint, Match, PriceComparison, Product } from '../lib/types';

interface ProductResponse {
  product: Product;
  matches: Match[];
  history: HistoryPoint[];
  comparison: PriceComparison;
  currency: string;
}

const METHOD_LABELS: Record<Match['match_method'], string> = {
  gtin: 'Codice EAN',
  mpn: 'Codice produttore',
  google_shopping: 'Google Shopping',
  serp: 'Ricerca organica',
  manual: 'Inserito a mano',
};

export function Prodotto() {
  const { productId } = useParams<{ productId: string }>();
  const { requestContext, canWrite } = useMoca();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useApiGet<ProductResponse>('product-detail', {
    id: productId,
    days: 90,
  });

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiPost(requestContext, 'product-detail', { productId, ...body });
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Operazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const { product, matches, history, comparison, currency } = data;
  const activeMatches = matches.filter((m) => m.status !== 'escluso');

  return (
    <div className="space-y-6">
      <Link to="/catalogo" className="inline-flex items-center gap-2 text-sm text-moca-gray hover:text-moca-black">
        <ArrowLeft size={16} />
        Torna al catalogo
      </Link>

      {actionError && <ErrorBanner message={actionError} />}

      <Card>
        <div className="flex flex-col sm:flex-row gap-6">
          {product.image_url && (
            <img
              src={product.image_url}
              alt=""
              className="h-32 w-32 object-contain rounded-lg border border-gray-100 shrink-0"
            />
          )}

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold text-moca-black">{product.title}</h2>
                <p className="mt-1 text-sm text-moca-gray">
                  {product.brand && <span>{product.brand} · </span>}
                  SKU {product.sku}
                  {product.gtin && <span> · EAN {product.gtin}</span>}
                </p>
              </div>
              <PositionBadge position={comparison.position} />
            </div>

            <dl className="mt-5 grid gap-4 sm:grid-cols-4">
              <Metric label="Il tuo prezzo" value={formatPrice(product.own_price, currency)} />
              <Metric label="Minimo mercato" value={formatPrice(comparison.minPrice, currency)} />
              <Metric label="Media mercato" value={formatPrice(comparison.avgPrice, currency)} />
              <Metric
                label="Posizione"
                value={
                  comparison.rank
                    ? `${comparison.rank}° su ${comparison.competitorCount + 1}`
                    : '—'
                }
              />
            </dl>

            {comparison.minPrice !== null && comparison.maxPrice !== null && (
              <div className="mt-6">
                <PriceRangeBar
                  min={comparison.minPrice}
                  max={comparison.maxPrice}
                  own={product.own_price}
                  format={(value) => formatPrice(value, currency)}
                />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-moca-gray">
              <span>Disponibilita': {formatAvailability(product.own_availability)}</span>
              <span>Prezzo verificato {formatRelative(product.own_price_checked_at)}</span>
              {product.product_url && (
                <a
                  href={product.product_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-moca-red hover:underline"
                >
                  Apri la scheda sul tuo sito
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Andamento prezzi, ultimi 90 giorni">
        <PriceLineChart series={buildSeries(history)} currency={currency} />
      </Card>

      <Card
        title={`Venditori rilevati (${formatNumber(activeMatches.length)})`}
        action={canWrite ? <AddMatchButton onAdd={(addMatch) => act({ addMatch })} busy={busy} /> : undefined}
      >
        {activeMatches.length === 0 ? (
          <EmptyState
            icon={Store}
            title="Nessun venditore rilevato"
            description="Avvia una scansione dalla sezione Scansioni per cercare questo prodotto sugli altri e-commerce."
          />
        ) : (
          <ul className="divide-y divide-gray-100">
            {activeMatches.map((match) => (
              <li key={match.id} className="py-4 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-moca-black">
                      {match.seller_name ?? match.domain}
                    </p>
                    <Badge tone={match.match_method === 'gtin' ? 'positivo' : 'info'}>
                      {METHOD_LABELS[match.match_method]}
                    </Badge>
                    {match.status === 'confermato' && (
                      <Badge tone="positivo">
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck size={11} />
                          Confermato
                        </span>
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-moca-gray">
                    {match.domain} · affidabilita' {(match.confidence * 100).toFixed(0)}% ·
                    rilevato {formatRelative(match.last_seen_at)}
                  </p>
                  {match.offer_title && (
                    <p className="mt-1 text-xs text-moca-gray line-clamp-1">{match.offer_title}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {match.offer_url && (
                    <a
                      href={match.offer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="moca-btn-secondary !px-3 !py-1.5 text-xs"
                      title="Apri l'offerta"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                  {canWrite && match.status !== 'confermato' && (
                    <button
                      onClick={() => act({ matchId: match.id, status: 'confermato' })}
                      disabled={busy}
                      className="moca-btn-secondary !px-3 !py-1.5 text-xs"
                      title="Conferma che e' lo stesso prodotto"
                    >
                      <Check size={14} />
                    </button>
                  )}
                  {canWrite && (
                    <button
                      onClick={() => act({ matchId: match.id, status: 'escluso' })}
                      disabled={busy}
                      className="moca-btn-secondary !px-3 !py-1.5 text-xs"
                      title="Escludi: non e' lo stesso prodotto"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {matches.some((m) => m.status === 'escluso') && (
          <p className="mt-4 text-xs text-moca-gray">
            {formatNumber(matches.filter((m) => m.status === 'escluso').length)} venditori
            esclusi non vengono piu' considerati nelle scansioni successive.
          </p>
        )}
      </Card>

      {comparison.deltaVsAvgPct !== null && (
        <p className="text-sm text-moca-gray">
          Rispetto alla media di mercato sei {formatPercent(comparison.deltaVsAvgPct)}.
          Ultimo aggiornamento del confronto: {formatDateTime(product.own_price_checked_at)}.
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-moca-gray">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-moca-black">{value}</dd>
    </div>
  );
}

function AddMatchButton({
  onAdd,
  busy,
}: {
  onAdd: (match: { domain: string; url?: string }) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="moca-btn-secondary text-sm">
        <Plus size={16} />
        Aggiungi venditore
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!url.trim()) return;
        onAdd({ domain: url.trim(), url: url.trim() });
        setUrl('');
        setOpen(false);
      }}
    >
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://competitor.it/prodotto"
        className="moca-input !w-64 text-sm"
        aria-label="URL dell'offerta del competitor"
      />
      <button type="submit" disabled={busy} className="moca-btn-primary text-sm">
        Aggiungi
      </button>
      <button type="button" onClick={() => setOpen(false)} className="moca-btn-secondary text-sm">
        Annulla
      </button>
    </form>
  );
}

/**
 * Trasforma la serie "lunga" (giorno, dominio, prezzo) in una serie per
 * dominio. Oltre il numero di colori validati i domini minori confluiscono
 * in "Altri", che resta grigio: mai un colore generato al volo.
 */
function buildSeries(history: HistoryPoint[]): ChartSeries[] {
  const own = history.filter((point) => point.domain === null);
  const byDomain = new Map<string, HistoryPoint[]>();

  for (const point of history) {
    if (point.domain === null) continue;
    const list = byDomain.get(point.domain) ?? [];
    list.push(point);
    byDomain.set(point.domain, list);
  }

  // Ordine deterministico: piu' rilevazioni = piu' rilevante.
  const domains = [...byDomain.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain]) => domain);

  const shown = domains.slice(0, MAX_SERIES - 1); // uno slot resta a "noi"
  const colors = buildColorMap(shown, '__own__');

  const series: ChartSeries[] = [];

  if (own.length > 0) {
    series.push({
      key: '__own__',
      label: 'Il tuo prezzo',
      color: colors.get('__own__')!,
      points: own.map((p) => ({ day: p.day, price: p.price })),
    });
  }

  for (const domain of shown) {
    series.push({
      key: domain,
      label: domain,
      color: colors.get(domain)!,
      points: (byDomain.get(domain) ?? []).map((p) => ({ day: p.day, price: p.price })),
    });
  }

  return series;
}
