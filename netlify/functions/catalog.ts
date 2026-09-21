/**
 * GET /api/catalog?search=&position=&page=&pageSize=
 *
 * Elenco del catalogo con il posizionamento di prezzo calcolato su
 * `pt_latest_prices` (ultima rilevazione per prodotto/dominio).
 */
import type { Handler } from '@netlify/functions';
import { ok } from './utils/http';
import { authed } from './utils/guard';
import { supabaseAdmin } from './utils/supabase-admin';
import { comparePrices, type PricePosition } from './utils/pricing';
import { loadLatestPrices } from './utils/price-queries';
import { loadScanSettings } from './utils/scan-settings';

const MAX_PAGE_SIZE = 100;

export const handler: Handler = authed(['GET'], async (event, session, headers) => {
  const params = event.queryStringParameters ?? {};
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.min(Number(params.pageSize ?? 25), MAX_PAGE_SIZE);
  const search = params.search?.trim();
  const positionFilter = params.position as PricePosition | undefined;

  const db = supabaseAdmin();
  const settings = await loadScanSettings(db, session.clientId);

  let query = db
    .from('pt_products')
    .select(
      'id, sku, gtin, brand, title, category, product_url, image_url, own_price, currency, own_availability, own_price_checked_at, google_product_id',
      { count: 'exact' },
    )
    .eq('client_id', session.clientId)
    .eq('is_active', true);

  if (search) {
    // Ricerca su titolo, SKU ed EAN: sono i tre modi in cui si cerca un articolo.
    const escaped = search.replace(/[%,()]/g, ' ');
    query = query.or(`title.ilike.%${escaped}%,sku.ilike.%${escaped}%,gtin.ilike.%${escaped}%`);
  }

  // Il filtro per posizione si applica dopo il calcolo: senza filtro paghiamo
  // solo la pagina richiesta, con filtro serve un intervallo piu' ampio.
  const range = positionFilter
    ? { from: 0, to: MAX_PAGE_SIZE * 10 - 1 }
    : { from: (page - 1) * pageSize, to: page * pageSize - 1 };

  const { data: products, count } = await query
    .order('title', { ascending: true })
    .range(range.from, range.to);

  const rows = products ?? [];
  const priceMap = await loadLatestPrices(
    session.clientId,
    rows.map((p) => p.id as string),
  );

  let items = rows.map((product) => {
    const competitors = priceMap.get(product.id as string) ?? [];
    return {
      ...product,
      comparison: comparePrices(
        product.own_price !== null ? Number(product.own_price) : null,
        competitors,
        Number(settings.undercut_threshold),
      ),
    };
  });

  let total = count ?? items.length;
  if (positionFilter) {
    items = items.filter((item) => item.comparison.position === positionFilter);
    total = items.length;
    items = items.slice((page - 1) * pageSize, page * pageSize);
  }

  return ok({ items, page, pageSize, total, currency: settings.currency }, headers);
});
