/**
 * Impostazioni - sito del cliente, mercato di riferimento, soglie di allerta
 * e scansione automatica.
 */
import { useEffect, useState } from 'react';
import { Info, Save } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Card, ErrorBanner, LoadingBlock } from '../components/ui';
import type { Competitor, Settings } from '../lib/types';

interface SettingsResponse {
  settings: Settings;
  competitors: Competitor[];
}

/** Codici DataForSEO dei mercati piu' usati. */
const LOCATIONS = [
  { code: 2380, label: 'Italia', language: 'it' },
  { code: 2276, label: 'Germania', language: 'de' },
  { code: 2250, label: 'Francia', language: 'fr' },
  { code: 2724, label: 'Spagna', language: 'es' },
  { code: 2826, label: 'Regno Unito', language: 'en' },
  { code: 2840, label: 'Stati Uniti', language: 'en' },
];

const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF'];

export function Impostazioni() {
  const { requestContext, canWrite, user } = useMoca();
  const { data, loading, error, reload } = useApiGet<SettingsResponse>('settings');

  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);

  if (loading || !form) return <LoadingBlock />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await apiPost(requestContext, 'settings', {
        settings: {
          own_domain: form.own_domain,
          catalog_source: form.catalog_source,
          catalog_feed_url: form.catalog_feed_url,
          location_code: Number(form.location_code),
          language_code: form.language_code,
          currency: form.currency,
          undercut_threshold: Number(form.undercut_threshold),
          overprice_threshold: Number(form.overprice_threshold),
          auto_scan_enabled: form.auto_scan_enabled,
          max_products_per_scan: Number(form.max_products_per_scan),
          search_source: form.search_source,
          search_gtin_pass: form.search_gtin_pass,
        },
      });
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Salvataggio non riuscito');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-semibold text-moca-black">Impostazioni</h2>
        <p className="text-sm text-moca-gray">
          Configurazione del monitoraggio per questo cliente.
        </p>
      </div>

      {!canWrite && (
        <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <Info size={18} className="text-moca-gray shrink-0 mt-0.5" />
          <p className="text-moca-gray">
            Il tuo ruolo ({user.role}) consente la sola consultazione: le impostazioni
            sono in sola lettura.
          </p>
        </div>
      )}

      {saveError && <ErrorBanner message={saveError} />}

      <Card title="Il tuo sito">
        <div className="space-y-4">
          <div>
            <label className="moca-label" htmlFor="own-domain">
              Dominio del cliente
            </label>
            <input
              id="own-domain"
              type="text"
              value={form.own_domain ?? ''}
              onChange={(event) => update('own_domain', event.target.value || null)}
              disabled={!canWrite}
              placeholder="www.esempio.it"
              className="moca-input"
            />
            <p className="mt-1 text-xs text-moca-gray">
              Serve a distinguere le tue offerte da quelle dei competitor nelle rilevazioni.
            </p>
          </div>

          <div>
            <label className="moca-label" htmlFor="catalog-source">
              Sorgente del catalogo
            </label>
            <select
              id="catalog-source"
              value={form.catalog_source}
              onChange={(event) => update('catalog_source', event.target.value as Settings['catalog_source'])}
              disabled={!canWrite}
              className="moca-input"
            >
              <option value="feed">Feed Google Merchant</option>
              <option value="sitemap">Sitemap del sito</option>
              <option value="csv">File CSV</option>
              <option value="manual">Inserimento manuale</option>
            </select>
          </div>

          {form.catalog_source === 'feed' && (
            <div>
              <label className="moca-label" htmlFor="feed-url">
                URL del feed
              </label>
              <input
                id="feed-url"
                type="url"
                value={form.catalog_feed_url ?? ''}
                onChange={(event) => update('catalog_feed_url', event.target.value || null)}
                disabled={!canWrite}
                placeholder="https://www.esempio.it/feed-google-shopping.xml"
                className="moca-input"
              />
              <p className="mt-1 text-xs text-moca-gray">
                Salvando l'URL qui la scansione automatica potra' riusarlo senza reinserirlo.
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Mercato di riferimento">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="moca-label" htmlFor="location">
              Paese
            </label>
            <select
              id="location"
              value={form.location_code}
              onChange={(event) => {
                const location = LOCATIONS.find((l) => l.code === Number(event.target.value));
                update('location_code', Number(event.target.value));
                if (location) update('language_code', location.language);
              }}
              disabled={!canWrite}
              className="moca-input"
            >
              {LOCATIONS.map((location) => (
                <option key={location.code} value={location.code}>
                  {location.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="moca-label" htmlFor="language">
              Lingua delle ricerche
            </label>
            <input
              id="language"
              type="text"
              value={form.language_code}
              onChange={(event) => update('language_code', event.target.value)}
              disabled={!canWrite}
              maxLength={5}
              className="moca-input"
            />
          </div>

          <div>
            <label className="moca-label" htmlFor="currency">
              Valuta
            </label>
            <select
              id="currency"
              value={form.currency}
              onChange={(event) => update('currency', event.target.value)}
              disabled={!canWrite}
              className="moca-input"
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card title="Come cercare i prezzi">
        <div className="space-y-4">
          <div>
            <label className="moca-label" htmlFor="search-source">
              Fonte dei prezzi
            </label>
            <select
              id="search-source"
              value={form.search_source ?? 'serp'}
              onChange={(event) =>
                update('search_source', event.target.value as Settings['search_source'])
              }
              disabled={!canWrite}
              className="moca-input"
            >
              <option value="serp">Ricerca Google (consigliata)</option>
              <option value="shopping">Google Shopping</option>
            </select>
            <p className="mt-1 text-xs text-moca-gray">
              La ricerca Google e' immediata e i risultati portano gia' il prezzo:
              al termine della scansione i dati ci sono. Google Shopping lavora
              invece a richieste asincrone, quindi i risultati arrivano dopo e
              vanno raccolti.
            </p>
          </div>

          <label className="flex items-start gap-3 text-sm text-moca-black">
            <input
              type="checkbox"
              checked={form.search_gtin_pass ?? false}
              onChange={(event) => update('search_gtin_pass', event.target.checked)}
              disabled={!canWrite}
              className="mt-0.5 rounded border-gray-300 text-moca-red focus:ring-moca-red"
            />
            <span>
              Cerca anche il solo codice EAN
              <span className="block text-xs text-moca-gray mt-0.5">
                Raddoppia il costo della scansione. Utile quando i venditori
                pubblicano il codice nella scheda: in quel caso il riconoscimento
                e' certo. Da solo pero' porta molti risultati estranei, per questo
                non e' la ricerca principale.
              </span>
            </span>
          </label>
        </div>
      </Card>

      <Card title="Soglie di allerta">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="moca-label" htmlFor="undercut">
              Competitor sotto di noi oltre il (%)
            </label>
            <input
              id="undercut"
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={form.undercut_threshold}
              onChange={(event) => update('undercut_threshold', Number(event.target.value))}
              disabled={!canWrite}
              className="moca-input"
            />
            <p className="mt-1 text-xs text-moca-gray">
              Genera un avviso quando un competitor scende sotto il tuo prezzo di
              almeno questa percentuale. E' anche la tolleranza con cui un prodotto
              viene considerato "allineato".
            </p>
          </div>

          <div>
            <label className="moca-label" htmlFor="overprice">
              Siamo sopra il massimo di mercato oltre il (%)
            </label>
            <input
              id="overprice"
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={form.overprice_threshold}
              onChange={(event) => update('overprice_threshold', Number(event.target.value))}
              disabled={!canWrite}
              className="moca-input"
            />
            <p className="mt-1 text-xs text-moca-gray">
              Genera un avviso quando siamo il venditore piu' caro con questo margine.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Scansione automatica">
        <div className="space-y-4">
          <label className="flex items-start gap-3 text-sm text-moca-black">
            <input
              type="checkbox"
              checked={form.auto_scan_enabled}
              onChange={(event) => update('auto_scan_enabled', event.target.checked)}
              disabled={!canWrite}
              className="mt-0.5 rounded border-gray-300 text-moca-red focus:ring-moca-red"
            />
            <span>
              Esegui una scansione ogni giorno alle 06:00 UTC
              <span className="block text-xs text-moca-gray mt-0.5">
                Consumo stimato: una richiesta DataForSEO per prodotto, piu' una
                per ogni prodotto di cui va risolta l'identita' su Google Shopping.
              </span>
            </span>
          </label>

          <div className="max-w-xs">
            <label className="moca-label" htmlFor="max-products">
              Prodotti per scansione
            </label>
            <input
              id="max-products"
              type="number"
              min={1}
              max={2000}
              value={form.max_products_per_scan}
              onChange={(event) => update('max_products_per_scan', Number(event.target.value))}
              disabled={!canWrite}
              className="moca-input"
            />
            <p className="mt-1 text-xs text-moca-gray">
              Tetto di sicurezza sul costo di ogni esecuzione.
            </p>
          </div>
        </div>
      </Card>

      {canWrite && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="moca-btn-primary">
            <Save size={16} />
            {busy ? 'Salvataggio…' : 'Salva impostazioni'}
          </button>
          {saved && <span className="text-sm text-success">Impostazioni salvate.</span>}
        </div>
      )}
    </div>
  );
}
