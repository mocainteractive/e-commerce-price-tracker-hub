/**
 * Catalogo - elenco dei prodotti monitorati con il loro posizionamento,
 * ricerca, filtro per stato e import da feed / CSV / sitemap.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Package, Search, Upload } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { useMoca } from '../lib/MocaProvider';
import { Card, EmptyState, ErrorBanner, LoadingBlock, PositionBadge } from '../components/ui';
import { ImportCatalogo } from '../components/ImportCatalogo';
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

      {showImport && canWrite && <ImportCatalogo onDone={reload} />}

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
