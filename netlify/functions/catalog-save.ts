/**
 * POST /api/catalog-save
 *
 * Salva un lotto di prodotti. E' il "lavoratore" dell'import: il browser
 * legge la sorgente (in proprio o via fetch-source), la divide in lotti e
 * chiama questo endpoint tante volte quante servono.
 *
 * Ogni chiamata resta ben sotto i 10 secondi di Netlify, e l'operazione e'
 * idempotente: la chiave e' `(client_id, sku)`, quindi ripetere un lotto
 * aggiorna invece di duplicare.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { deriveSku, type CatalogRow } from './utils/feed';
import { normalizeDomain } from './utils/matching';

/** Righe per chiamata: un upsert di 200 prodotti sta comodamente nei tempi. */
export const MAX_ROWS_PER_BATCH = 200;

interface RequestBody {
  rows: CatalogRow[];
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  const rows = body.rows ?? [];

  if (rows.length === 0) throw new HttpError(400, 'Nessuna riga da salvare');
  if (rows.length > MAX_ROWS_PER_BATCH) {
    throw new HttpError(400, `Massimo ${MAX_ROWS_PER_BATCH} righe per lotto, ricevute ${rows.length}`);
  }

  const db = supabaseAdmin();

  const { data: settings } = await db
    .from('pt_settings')
    .select('currency, own_domain')
    .eq('client_id', moca.clientId)
    .maybeSingle();

  const defaultCurrency = settings?.currency ?? 'EUR';
  const now = new Date().toISOString();

  // Lo SKU e' la chiave di upsert. Se manca lo deriviamo in modo stabile,
  // cosi' un secondo import riconosce lo stesso prodotto.
  const seen = new Set<string>();
  const products = rows
    .filter((row) => row?.title)
    .map((row) => ({ ...row, sku: row.sku?.trim() || deriveSku(row) }))
    .filter((row) => {
      if (seen.has(row.sku)) return false; // duplicati dentro lo stesso lotto
      seen.add(row.sku);
      return true;
    });

  if (products.length === 0) {
    throw new HttpError(400, 'Nessuna riga valida nel lotto: manca il titolo prodotto');
  }

  const { data: upserted, error } = await db
    .from('pt_products')
    .upsert(
      products.map((row) => ({
        client_id: moca.clientId,
        sku: row.sku,
        gtin: row.gtin,
        mpn: row.mpn,
        brand: row.brand,
        title: String(row.title).slice(0, 500),
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
    .select('id, own_price, currency');

  if (error) {
    console.error('[catalog-save] Upsert fallito:', error.message);
    throw new HttpError(500, `Salvataggio non riuscito: ${error.message}`);
  }

  const saved = upserted ?? [];

  // Storico del nostro prezzo: una rilevazione al giorno per prodotto.
  const snapshots = saved
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

  let snapshotError: string | null = null;
  if (snapshots.length > 0) {
    const { error: snapErr } = await db
      .from('pt_price_snapshots')
      .upsert(snapshots, { onConflict: 'product_id,domain_key,captured_on' });
    if (snapErr) {
      // Il catalogo e' salvato: lo segnaliamo ma non facciamo fallire il lotto.
      snapshotError = snapErr.message;
      console.warn('[catalog-save] Snapshot non salvati:', snapErr.message);
    }
  }

  // Al primo lotto registra il dominio del cliente fra quelli "nostri".
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
      saved: saved.length,
      skipped: rows.length - products.length,
      withGtin: products.filter((p) => p.gtin).length,
      withoutPrice: products.filter((p) => p.price === null).length,
      snapshotError,
    },
    headers,
  );
});

function inferOwnDomain(rows: Array<{ productUrl: string | null }>): string | null {
  for (const row of rows) {
    const domain = normalizeDomain(row.productUrl);
    if (domain) return domain;
  }
  return null;
}
