/**
 * POST /api/catalog-import
 *
 * Importa (o aggiorna) il catalogo del cliente da feed Merchant, CSV o
 * sitemap. L'import e' idempotente: la chiave e' `(client_id, sku)`, quindi
 * ri-eseguirlo aggiorna prezzi e disponibilita' invece di duplicare righe.
 *
 * Ogni prezzo importato genera anche uno snapshot `is_own = true`: lo storico
 * del nostro prezzo parte da qui.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { importFromCsv, importFromFeed, importFromSitemap, type CatalogRow } from './utils/feed';
import { normalizeDomain, normalizeText } from './utils/matching';

const MAX_PRODUCTS = 2000;

interface RequestBody {
  source: 'feed' | 'csv' | 'sitemap';
  feedUrl?: string;
  sitemapUrl?: string;
  csvContent?: string;
  limit?: number;
  /** Se true sostituisce il catalogo: i prodotti assenti vengono disattivati. */
  replace?: boolean;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  const limit = Math.min(body.limit ?? 500, MAX_PRODUCTS);
  const db = supabaseAdmin();

  const { data: settings } = await db
    .from('pt_settings')
    .select('currency, own_domain')
    .eq('client_id', moca.clientId)
    .maybeSingle();

  const defaultCurrency = settings?.currency ?? 'EUR';

  let rows: CatalogRow[];
  try {
    rows = await loadRows(body, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import non riuscito';
    throw new HttpError(400, `Import non riuscito: ${message}`);
  }

  if (rows.length === 0) {
    throw new HttpError(400, 'Nessun prodotto valido trovato nella sorgente indicata');
  }

  // Lo SKU e' la chiave di upsert: se manca lo deriviamo in modo stabile,
  // cosi' un secondo import riconosce lo stesso prodotto.
  const seen = new Set<string>();
  const products = rows
    .map((row) => ({ ...row, sku: row.sku?.trim() || deriveSku(row) }))
    .filter((row) => {
      if (seen.has(row.sku)) return false; // duplicati nella stessa sorgente
      seen.add(row.sku);
      return true;
    });

  const now = new Date().toISOString();

  const { data: upserted, error } = await db
    .from('pt_products')
    .upsert(
      products.map((row) => ({
        client_id: moca.clientId,
        sku: row.sku,
        gtin: row.gtin,
        mpn: row.mpn,
        brand: row.brand,
        title: row.title.slice(0, 500),
        category: row.category,
        product_url: row.productUrl,
        image_url: row.imageUrl,
        own_price: row.price,
        own_list_price: row.listPrice,
        own_availability: row.availability,
        currency: row.currency ?? defaultCurrency,
        own_price_checked_at: row.price !== null ? now : null,
        is_active: true,
      })),
      { onConflict: 'client_id,sku' },
    )
    .select('id, sku, own_price, currency');

  if (error) {
    console.error('[catalog-import] Upsert prodotti fallito:', error.message);
    throw new HttpError(500, 'Salvataggio del catalogo non riuscito');
  }

  const imported = upserted ?? [];

  // Storico del nostro prezzo (una rilevazione al giorno per prodotto).
  const ownSnapshots = imported
    .filter((p) => p.own_price !== null)
    .map((p) => ({
      client_id: moca.clientId,
      product_id: p.id,
      domain: null,
      is_own: true,
      price: p.own_price,
      total_price: p.own_price,
      currency: p.currency,
      source: 'catalogo',
      captured_at: now,
    }));

  if (ownSnapshots.length > 0) {
    const { error: snapshotError } = await db
      .from('pt_price_snapshots')
      .upsert(ownSnapshots, { onConflict: 'product_id,domain_key,captured_on' });
    if (snapshotError) {
      // Il catalogo e' salvato: segnaliamo ma non falliamo l'import.
      console.warn('[catalog-import] Snapshot prezzi propri non salvati:', snapshotError.message);
    }
  }

  let deactivated = 0;
  if (body.replace) {
    deactivated = await deactivateMissing(moca.clientId, new Set(products.map((p) => p.sku)));
  }

  // Registra il dominio del cliente come "nostro" se non lo e' gia'.
  const ownDomain = settings?.own_domain ?? inferOwnDomain(products);
  if (ownDomain) {
    await db
      .from('pt_competitors')
      .upsert(
        { client_id: moca.clientId, domain: ownDomain, label: 'Il tuo sito', is_own: true },
        { onConflict: 'client_id,domain', ignoreDuplicates: true },
      );
  }

  return ok(
    {
      imported: imported.length,
      deactivated,
      withGtin: products.filter((p) => p.gtin).length,
      withoutPrice: products.filter((p) => p.price === null).length,
    },
    headers,
  );
});

/**
 * Disattiva i prodotti non presenti nell'import corrente.
 * Confrontiamo gli SKU lato applicativo invece di usare un filtro `not.in`:
 * gli SKU possono contenere virgole e virgolette, che romperebbero la
 * serializzazione della lista in PostgREST.
 */
async function deactivateMissing(clientId: string, keptSkus: Set<string>): Promise<number> {
  const db = supabaseAdmin();

  const { data: active } = await db
    .from('pt_products')
    .select('id, sku')
    .eq('client_id', clientId)
    .eq('is_active', true);

  const staleIds = (active ?? []).filter((p) => !keptSkus.has(p.sku as string)).map((p) => p.id as string);
  if (staleIds.length === 0) return 0;

  // A blocchi: una lista di UUID troppo lunga supera i limiti della query string.
  const CHUNK = 200;
  for (let i = 0; i < staleIds.length; i += CHUNK) {
    const { error } = await db
      .from('pt_products')
      .update({ is_active: false })
      .eq('client_id', clientId)
      .in('id', staleIds.slice(i, i + CHUNK));
    if (error) {
      console.warn('[catalog-import] Disattivazione parziale:', error.message);
      break;
    }
  }

  return staleIds.length;
}

async function loadRows(body: RequestBody, limit: number): Promise<CatalogRow[]> {
  switch (body.source) {
    case 'feed':
      if (!body.feedUrl) throw new Error('URL del feed mancante');
      assertHttpUrl(body.feedUrl);
      return importFromFeed(body.feedUrl, limit);

    case 'sitemap':
      if (!body.sitemapUrl) throw new Error('URL della sitemap mancante');
      assertHttpUrl(body.sitemapUrl);
      return importFromSitemap(body.sitemapUrl, Math.min(limit, 150));

    case 'csv':
      if (!body.csvContent) throw new Error('Contenuto CSV mancante');
      return importFromCsv(body.csvContent, limit);

    default:
      throw new Error('Sorgente non supportata');
  }
}

/** Blocca schemi non http(s) e indirizzi interni (SSRF). */
function assertHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL non valida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Sono ammesse solo URL http o https');
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) throw new Error('Indirizzo di rete non consentito');
}

/**
 * SKU derivato quando la sorgente non lo espone.
 * Ordine: GTIN (stabile e globale) > MPN > slug del titolo.
 */
function deriveSku(row: CatalogRow): string {
  if (row.gtin) return `ean-${row.gtin}`;
  if (row.mpn) return `mpn-${normalizeText(row.mpn).replace(/\s+/g, '-')}`;

  const slug = normalizeText(`${row.brand ?? ''} ${row.title}`)
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return slug || `prod-${Date.now()}`;
}

function inferOwnDomain(products: CatalogRow[]): string | null {
  for (const product of products) {
    const domain = normalizeDomain(product.productUrl);
    if (domain) return domain;
  }
  return null;
}
