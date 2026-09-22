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
import { ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { extractProductFromUrl } from './utils/product-extract';

/**
 * Quante pagine leggere per chiamata.
 * Tenuto basso di proposito: ogni pagina e' una richiesta di rete e la
 * funzione ha ~10 secondi. E' il browser a ripetere la chiamata finche'
 * `remaining` non arriva a zero, mostrando l'avanzamento.
 */
const BATCH_SIZE = 8;
/**
 * Tutte insieme, con un timeout per pagina che tiene la chiamata entro i
 * 10 secondi anche nel caso peggiore. Prima erano due giri da 4 con 12 secondi
 * di timeout ciascuno: un sito lento portava la funzione a 24 secondi.
 */
const CONCURRENCY = BATCH_SIZE;
const PAGE_TIMEOUT_MS = 6000;

interface RequestBody {
  productIds?: string[];
  limit?: number;
  /** ISO 8601: istante di avvio del giro, per non ripassare sugli stessi. */
  staleBefore?: string;
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  const limit = Math.min(body.limit ?? BATCH_SIZE, BATCH_SIZE);
  const db = supabaseAdmin();

  // `staleBefore` e' l'istante in cui il browser ha avviato il giro: i
  // prodotti gia' verificati dopo quell'istante sono fatti, e questo rende il
  // ciclo del browser terminante invece di ripassare sempre sugli stessi.
  const staleBefore = body.staleBefore ?? new Date().toISOString();

  const selection = () =>
    db
      .from('pt_products')
      .select('id, product_url, currency, own_price', { count: 'exact' })
      .eq('client_id', moca.clientId)
      .eq('is_active', true)
      .not('product_url', 'is', null)
      .or(`own_price_checked_at.is.null,own_price_checked_at.lt.${staleBefore}`);

  let query = selection().order('own_price_checked_at', { ascending: true, nullsFirst: true }).limit(limit);

  if (body.productIds?.length) {
    query = selection().in('id', body.productIds.slice(0, limit)).limit(limit);
  }

  const { data: products, count: pending } = await query;

  if (!products || products.length === 0) {
    // Non e' un errore: puo' voler dire che il giro e' finito.
    return ok({ checked: 0, updated: 0, unchanged: 0, failed: 0, remaining: 0 }, headers);
  }

  const now = new Date().toISOString();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  const snapshots: Array<Record<string, unknown>> = [];

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((p) => extractProductFromUrl(p.product_url as string, PAGE_TIMEOUT_MS)),
    );

    for (let j = 0; j < batch.length; j += 1) {
      const product = batch[j];
      const extracted = results[j];

      if (!extracted?.price) {
        failed += 1;
        // Segna comunque il prodotto come verificato, senza toccarne il
        // prezzo: altrimenti resterebbe "da fare" e il ciclo del browser non
        // terminerebbe mai. Verra' ritentato al giro successivo.
        await db
          .from('pt_products')
          .update({ own_price_checked_at: now })
          .eq('id', product.id);
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

  // `pending` contava le righe da fare PRIMA di questo lotto.
  const remaining = Math.max((pending ?? products.length) - products.length, 0);

  return ok({ checked: products.length, updated, unchanged, failed, remaining }, headers);
});
