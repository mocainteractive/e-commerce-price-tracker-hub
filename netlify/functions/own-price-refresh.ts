/**
 * POST /api/own-price-refresh
 *
 * Rilegge i prezzi dal sito del cliente a partire dai dati strutturati delle
 * pagine prodotto (JSON-LD, microdata, Open Graph).
 *
 * Serve perche' il confronto ha senso solo se il "nostro" prezzo e' aggiornato:
 * il feed puo' essere rigenerato una volta al giorno, la pagina no.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { extractProductFromUrl } from './utils/product-extract';

/** Quante pagine leggere per chiamata: il timeout della funzione e' 10s. */
const BATCH_SIZE = 20;
const CONCURRENCY = 4;

interface RequestBody {
  productIds?: string[];
  limit?: number;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  const limit = Math.min(body.limit ?? BATCH_SIZE, 50);
  const db = supabaseAdmin();

  let query = db
    .from('pt_products')
    .select('id, product_url, currency, own_price')
    .eq('client_id', moca.clientId)
    .eq('is_active', true)
    .not('product_url', 'is', null)
    .limit(limit);

  if (body.productIds?.length) {
    query = query.in('id', body.productIds.slice(0, limit));
  } else {
    // Senza selezione esplicita partiamo dai prodotti piu' "stantii".
    query = query.order('own_price_checked_at', { ascending: true, nullsFirst: true });
  }

  const { data: products } = await query;
  if (!products || products.length === 0) {
    throw new HttpError(400, 'Nessun prodotto con URL da aggiornare');
  }

  const now = new Date().toISOString();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const snapshots: Array<Record<string, unknown>> = [];

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((p) => extractProductFromUrl(p.product_url as string)),
    );

    for (let j = 0; j < batch.length; j += 1) {
      const product = batch[j];
      const extracted = results[j];

      if (!extracted?.price) {
        failed += 1;
        continue;
      }

      const previous = product.own_price !== null ? Number(product.own_price) : null;
      if (previous === extracted.price) unchanged += 1;
      else updated += 1;

      await db
        .from('pt_products')
        .update({
          own_price: extracted.price,
          own_list_price: extracted.listPrice,
          own_availability: extracted.availability,
          currency: extracted.currency ?? product.currency,
          own_price_checked_at: now,
        })
        .eq('id', product.id);

      snapshots.push({
        client_id: moca.clientId,
        product_id: product.id,
        domain: null,
        is_own: true,
        price: extracted.price,
        total_price: extracted.price,
        currency: extracted.currency ?? product.currency,
        availability: extracted.availability,
        source: 'sito_cliente',
        captured_at: now,
      });
    }
  }

  if (snapshots.length > 0) {
    const { error } = await db
      .from('pt_price_snapshots')
      .upsert(snapshots, { onConflict: 'product_id,domain_key,captured_on' });
    if (error) console.warn('[prezzi-propri] Snapshot non salvati:', error.message);
  }

  return ok({ checked: products.length, updated, unchanged, failed }, headers);
});
