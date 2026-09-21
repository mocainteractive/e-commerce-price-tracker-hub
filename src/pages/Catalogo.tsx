/**
 * Catalogo - elenco dei prodotti monitorati con il loro posizionamento,
 * ricerca, filtro per stato e import da feed / CSV / sitemap.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Package, RefreshCw, Search, Upload } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Card, EmptyState, ErrorBanner, LoadingBlock, PositionBadge } from '../components/ui';
import { formatNumber, formatPercent, formatPrice } from '../lib/format';
import type { CatalogItem, PricePosition } from '../lib/types';

interface CatalogResponse {
  items: CatalogItem[];
  page: number;
  pageSize: number;
  total: number;
  currency: string;
}

const FILTERS: Array<{ value: PricePosition | ''; label: string }> = [
  { value: '', label: 'Tutti' },
  { value: 'caro', label: 'Fuori prezzo' },
  { value: 'allineato', label: 'Allineati' },
  { value: 'migliore', label: 'Prezzo migliore' },
  { value: 'sconosciuto', label: 'Non confrontati' },
];

export function Catalogo() {
  const { canWrite } = useMoca();
  const [searchParams, setSearchParams] = useSearchParams();

  const position = (searchParams.get('position') ?? '') as PricePosition | '';
  const page = Number(searchParams.get('page') ?? 1);
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const search = searchParams.get('search') ?? '';

  const [showImport, setShowImport] = useState(false);

  const { data, loading, error, reload } = useApiGet<CatalogResponse>('catalog', {
    search,
    position: position || undefined,
    page,
    pageSize: 25,
  });

  const updateParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Ogni cambio di filtro riparte dalla prima pagina.
    if (!('page' in patch)) next.delete('page');
    setSearchParams(next);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-moca-black">Catalogo</h2>
          <p className="text-sm text-moca-gray">
            {data ? `${formatNumber(data.total)} prodotti` : 'Caricamento…'}
          </p>
        </div>

        {canWrite && (
          <button onClick={() => setShowImport((v) => !v)} className="moca-btn-primary">
            <Upload size={16} />
            Importa catalogo
          </button>
        )}
      </div>

      {showImport && canWrite && (
        <ImportPanel
          onDone={() => {
            setShowImport(false);
            reload();
          }}
        />
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <form
            className="relative flex-1 min-w-[240px]"
            onSubmit={(event) => {
              event.preventDefault();
              updateParams({ search: searchInput.trim() });
            }}
          >
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-moca-gray" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Cerca per nome, SKU o codice EAN"
              className="moca-input pl-9"
              aria-label="Cerca nel catalogo"
            />
          </form>

          <div className="flex flex-wrap gap-2">
            {FILTERS.map((filter) => (
              <button
                key={filter.value || 'tutti'}
                onClick={() => updateParams({ position: filter.value })}
                className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                  position === filter.value
                    ? 'bg-moca-red-light text-moca-red border-moca-red'
                    : 'text-moca-black border-gray-300 hover:bg-gray-100'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <LoadingBlock />}
        {error && <ErrorBanner message={error} onRetry={reload} />}

        {data && !loading && data.items.length === 0 && (
          <EmptyState
            icon={Package}
            title="Nessun prodotto trovato"
            description={
              search || position
                ? 'Nessun prodotto corrisponde ai filtri impostati. Prova a modificarli.'
                : 'Il catalogo e\' vuoto: importalo dal feed Google Merchant, da un CSV o dalla sitemap del sito.'
            }
          />
        )}

        {data && !loading && data.items.length > 0 && (
          <>
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-moca-gray border-b border-gray-200">
                    <th className="py-3 pr-4 font-semibold">Prodotto</th>
                    <th className="py-3 pr-4 font-semibold text-right">Nostro prezzo</th>
                    <th className="py-3 pr-4 font-semibold text-right">Minimo mercato</th>
                    <th className="py-3 pr-4 font-semibold text-right">Scostamento</th>
                    <th className="py-3 pr-4 font-semibold text-right">Venditori</th>
                    <th className="py-3 font-semibold">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-gray-100 hover:bg-moca-bg/60">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-3">
                          {item.image_url && (
                            <img
                              src={item.image_url}
                              alt=""
                              className="h-10 w-10 object-contain rounded border border-gray-100 shrink-0"
                              loading="lazy"
                            />
                          )}
                          <div className="min-w-0">
                            <Link
                              to={`/catalogo/${item.id}`}
                              className="font-medium text-moca-black hover:text-moca-red line-clamp-1"
                            >
                              {item.title}
                            </Link>
                            <p className="text-xs text-moca-gray">
                              {item.brand ? `${item.brand} · ` : ''}
                              {item.gtin ? `EAN ${item.gtin}` : `SKU ${item.sku}`}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        {formatPrice(item.own_price, item.currency)}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        <div>{formatPrice(item.comparison.minPrice, item.currency)}</div>
                        {item.comparison.cheapestDomain && (
                          <div className="text-xs text-moca-gray truncate max-w-[140px] ml-auto">
                            {item.comparison.cheapestDomain}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        <span
                          className={
                            item.comparison.deltaVsMinPct === null
                              ? 'text-moca-gray'
                              : item.comparison.deltaVsMinPct > 0
                                ? 'text-moca-red'
                                : 'text-success'
                          }
                        >
                          {formatPercent(item.comparison.deltaVsMinPct)}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums text-moca-gray">
                        {formatNumber(item.comparison.competitorCount)}
                      </td>
                      <td className="py-3">
                        <PositionBadge position={item.comparison.position} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-5 text-sm">
                <button
                  className="moca-btn-secondary"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: String(page - 1) })}
                >
                  Precedente
                </button>
                <span className="text-moca-gray">
                  Pagina {page} di {totalPages}
                </span>
                <button
                  className="moca-btn-secondary"
                  disabled={page >= totalPages}
                  onClick={() => updateParams({ page: String(page + 1) })}
                >
                  Successiva
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

// -----------------------------------------------------------------------------

interface ImportResult {
  imported: number;
  deactivated: number;
  withGtin: number;
  withoutPrice: number;
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const { requestContext } = useMoca();
  const [source, setSource] = useState<'feed' | 'sitemap' | 'csv'>('feed');
  const [url, setUrl] = useState('');
  const [csvContent, setCsvContent] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiPost<{ success: true } & ImportResult>(requestContext, 'catalog-import', {
        source,
        feedUrl: source === 'feed' ? url : undefined,
        sitemapUrl: source === 'sitemap' ? url : undefined,
        csvContent: source === 'csv' ? csvContent : undefined,
        replace,
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import non riuscito');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Importa il catalogo">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {[
            { value: 'feed' as const, label: 'Feed Google Merchant' },
            { value: 'sitemap' as const, label: 'Sitemap del sito' },
            { value: 'csv' as const, label: 'File CSV' },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => setSource(option.value)}
              className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                source === option.value
                  ? 'bg-moca-red-light text-moca-red border-moca-red'
                  : 'text-moca-black border-gray-300 hover:bg-gray-100'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {source === 'csv' ? (
          <div>
            <label className="moca-label" htmlFor="csv-file">
              File CSV
            </label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className="moca-input"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setCsvContent(await file.text());
              }}
            />
            <p className="mt-1 text-xs text-moca-gray">
              Colonne riconosciute: titolo, sku, ean, mpn, marca, prezzo, url, immagine.
              Separatore virgola o punto e virgola.
            </p>
          </div>
        ) : (
          <div>
            <label className="moca-label" htmlFor="import-url">
              {source === 'feed' ? 'URL del feed' : 'URL della sitemap'}
            </label>
            <input
              id="import-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                source === 'feed'
                  ? 'https://www.esempio.it/feed-google-shopping.xml'
                  : 'https://www.esempio.it/sitemap-prodotti.xml'
              }
              className="moca-input"
            />
            {source === 'sitemap' && (
              <p className="mt-1 text-xs text-moca-gray">
                Le pagine vengono lette una a una per estrarre i dati strutturati:
                l'import da sitemap e' piu' lento e si ferma a 150 prodotti per volta.
              </p>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-moca-black">
          <input
            type="checkbox"
            checked={replace}
            onChange={(event) => setReplace(event.target.checked)}
            className="rounded border-gray-300 text-moca-red focus:ring-moca-red"
          />
          Disattiva i prodotti non presenti in questo import
        </label>

        {error && <ErrorBanner message={error} />}

        {result && (
          <div className="rounded-lg bg-success/10 p-4 text-sm">
            <p className="font-medium text-moca-black">
              {formatNumber(result.imported)} prodotti importati
            </p>
            <p className="mt-1 text-moca-gray">
              {formatNumber(result.withGtin)} con codice EAN
              {result.withoutPrice > 0 && ` · ${formatNumber(result.withoutPrice)} senza prezzo`}
              {result.deactivated > 0 && ` · ${formatNumber(result.deactivated)} disattivati`}
            </p>
            <p className="mt-2 text-xs text-moca-gray">
              I prodotti con codice EAN vengono riconosciuti con certezza sugli altri
              siti: piu' ne hai, piu' il confronto e' affidabile.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={submit}
            disabled={busy || (source === 'csv' ? !csvContent : !url)}
            className="moca-btn-primary"
          >
            {busy ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
            {busy ? 'Import in corso…' : 'Avvia import'}
          </button>
          {result && (
            <button onClick={onDone} className="moca-btn-secondary">
              Chiudi e aggiorna
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
