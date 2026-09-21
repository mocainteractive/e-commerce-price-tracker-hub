/**
 * Query di lettura sullo storico prezzi, condivise fra catalogo, dashboard e
 * scheda prodotto.
 */
import { supabaseAdmin } from './supabase-admin';
import type { CompetitorPrice } from './pricing';

/** Ultime rilevazioni dei competitor, raggruppate per prodotto. */
export async function loadLatestPrices(
  clientId: string,
  productIds: string[],
): Promise<Map<string, CompetitorPrice[]>> {
  const map = new Map<string, CompetitorPrice[]>();
  if (productIds.length === 0) return map;

  const db = supabaseAdmin();
  // Una `in` con troppi UUID supera i limiti della query string di PostgREST.
  const CHUNK = 200;

  for (let i = 0; i < productIds.length; i += CHUNK) {
    const { data, error } = await db
      .from('pt_latest_prices')
      .select('product_id, domain, price, availability, captured_at, is_own')
      .eq('client_id', clientId)
      .in('product_id', productIds.slice(i, i + CHUNK));

    if (error) {
      console.error('[prezzi] Lettura pt_latest_prices fallita:', error.message);
      break;
    }

    for (const row of data ?? []) {
      // `is_own` e le righe senza dominio sono il nostro prezzo, gia' presente
      // su `pt_products.own_price`: qui servono solo i competitor.
      if (row.is_own || !row.domain) continue;

      const list = map.get(row.product_id as string) ?? [];
      list.push({
        domain: row.domain as string,
        price: Number(row.price),
        availability: row.availability as string | null,
        capturedAt: row.captured_at as string | null,
      });
      map.set(row.product_id as string, list);
    }
  }

  return map;
}
