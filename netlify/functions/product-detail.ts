/**
 * GET  /api/product-detail?id=<uuid>&days=90  -> scheda prodotto completa
 * POST /api/product-detail                    -> azioni sui match
 *
 * Azioni POST:
 *   { productId, matchId, status }            conferma o esclude un match
 *   { productId, addMatch: { domain, url } }  aggiunge un competitor a mano
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { authed } from './utils/guard';
import { requireWriteAccess } from './utils/session';
import { supabaseAdmin } from './utils/supabase-admin';
import { comparePrices } from './utils/pricing';
import { normalizeDomain } from './utils/matching';
import { loadScanSettings } from './utils/scan-settings';

interface PostBody {
  productId: string;
  matchId?: string;
  status?: 'confermato' | 'escluso' | 'auto';
  addMatch?: { domain: string; url?: string; sellerName?: string };
}

export const handler: Handler = authed(['GET', 'POST'], async (event, session, headers) => {
  const db = supabaseAdmin();

  if (event.httpMethod === 'POST') {
    requireWriteAccess(session);
    await applyAction(session.clientId, parseBody<PostBody>(event));
  }

  const productId =
    event.httpMethod === 'POST'
      ? parseBody<PostBody>(event).productId
      : event.queryStringParameters?.id;

  if (!productId) throw new HttpError(400, 'Identificativo prodotto mancante');

  const days = Math.min(Math.max(Number(event.queryStringParameters?.days ?? 90), 7), 365);
  const settings = await loadScanSettings(db, session.clientId);

  const { data: product } = await db
    .from('pt_products')
    .select('*')
    .eq('id', productId)
    .eq('client_id', session.clientId) // scoping esplicito: service_role ignora la RLS
    .maybeSingle();

  if (!product) throw new HttpError(404, 'Prodotto non trovato');

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [{ data: matches }, { data: history }, { data: ownCompetitors }] = await Promise.all([
    db
      .from('pt_matches')
      .select('id, domain, seller_name, offer_url, offer_title, match_method, confidence, status, last_seen_at')
      .eq('product_id', productId)
      .order('confidence', { ascending: false }),
    db
      .from('pt_price_snapshots')
      .select('domain, price, total_price, currency, availability, captured_on, is_own')
      .eq('product_id', productId)
      .gte('captured_on', since)
      .order('captured_on', { ascending: true })
      .limit(5000),
    db.from('pt_competitors').select('domain').eq('client_id', session.clientId).eq('is_own', true),
  ]);

  const ownDomains = new Set((ownCompetitors ?? []).map((c) => c.domain as string));
  const rows = history ?? [];

  // Ultimo prezzo per dominio, usato per il confronto "oggi".
  const latestByDomain = new Map<string, { price: number; availability: string | null }>();
  for (const row of rows) {
    if (row.is_own || !row.domain) continue;
    if (ownDomains.has(row.domain as string)) continue;
    latestByDomain.set(row.domain as string, {
      price: Number(row.price),
      availability: row.availability as string | null,
    });
  }

  const comparison = comparePrices(
    product.own_price !== null ? Number(product.own_price) : null,
    [...latestByDomain.entries()].map(([domain, value]) => ({ domain, ...value })),
    Number(settings.undercut_threshold),
  );

  return ok(
    {
      product,
      matches: matches ?? [],
      // La serie va al frontend "lunga": il grafico la trasforma in serie per dominio.
      history: rows.map((row) => ({
        day: row.captured_on,
        domain: row.is_own || !row.domain ? null : (row.domain as string),
        price: Number(row.price),
      })),
      comparison,
      currency: product.currency ?? settings.currency,
    },
    headers,
  );
});

async function applyAction(clientId: string, body: PostBody): Promise<void> {
  const db = supabaseAdmin();

  if (!body.productId) throw new HttpError(400, 'Identificativo prodotto mancante');

  // Il prodotto deve appartenere al cliente della sessione.
  const { data: product } = await db
    .from('pt_products')
    .select('id')
    .eq('id', body.productId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (!product) throw new HttpError(404, 'Prodotto non trovato');

  if (body.matchId && body.status) {
    const { error } = await db
      .from('pt_matches')
      .update({ status: body.status, confidence: body.status === 'confermato' ? 1 : undefined })
      .eq('id', body.matchId)
      .eq('product_id', body.productId);

    if (error) {
      console.error('[prodotto] Aggiornamento match fallito:', error.message);
      throw new HttpError(500, 'Aggiornamento del match non riuscito');
    }
  }

  if (body.addMatch) {
    const domain = normalizeDomain(body.addMatch.domain);
    if (!domain) throw new HttpError(400, 'Dominio non valido');

    const { error } = await db.from('pt_matches').upsert(
      {
        client_id: clientId,
        product_id: body.productId,
        domain,
        seller_name: body.addMatch.sellerName ?? null,
        offer_url: body.addMatch.url ?? '',
        match_method: 'manual',
        confidence: 1,
        status: 'confermato',
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'product_id,domain,offer_url' },
    );

    if (error) {
      console.error('[prodotto] Inserimento match manuale fallito:', error.message);
      throw new HttpError(500, 'Aggiunta del competitor non riuscita');
    }

    // Il dominio entra fra quelli monitorati, se non c'e' gia'.
    await db
      .from('pt_competitors')
      .upsert({ client_id: clientId, domain, is_own: false }, { onConflict: 'client_id,domain', ignoreDuplicates: true });
  }
}
