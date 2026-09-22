/**
 * Elaborazione dei risultati DataForSEO -> match, storico prezzi, alert.
 *
 * Condiviso da `dataforseo-postback` (via callback) e `scan-collect` (via
 * polling): il risultato deve essere identico da qualunque via arrivi, e
 * l'elaborazione deve essere idempotente perche' lo stesso task puo' essere
 * consegnato due volte.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http';
import {
  DataForSeoClient,
  type ProductsResult,
  type SellersResult,
  type ShoppingSellerItem,
} from './dataforseo';
import {
  MATCH_MIN_SCORE,
  normalizeDomain,
  scoreMatch,
  type MatchMethod,
  type MatchSubject,
} from './matching';

export interface ScanSettings {
  location_code: number;
  language_code: string;
  currency: string;
  undercut_threshold: number;
  overprice_threshold: number;
}

export interface ProductRow {
  id: string;
  client_id: string;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  title: string;
  own_price: number | null;
  currency: string;
  google_product_id: string | null;
}

export interface TaskRow {
  id: string;
  client_id: string;
  run_id: string;
  product_id: string;
  dfs_task_id: string;
  endpoint: 'products' | 'sellers';
}

export interface OfferCandidate {
  domain: string;
  sellerName: string | null;
  offerUrl: string;
  offerTitle: string;
  price: number;
  shippingPrice: number | null;
  totalPrice: number | null;
  currency: string;
  availability: string | null;
  condition: string | null;
  /** Esito del matching, quando la fonte ha richiesto una valutazione. */
  matchMethod?: MatchMethod;
  confidence?: number;
}

/**
 * Da dove arriva un gruppo di offerte. Serve a `persistOffers`, che e'
 * condiviso fra la SERP organica (sincrona) e i task di Google Shopping.
 */
export interface OfferContext {
  runId: string | null;
  /** Valore salvato in `pt_price_snapshots.source`. */
  source: string;
  /** Metodo di match da usare quando l'offerta non ne porta uno proprio. */
  defaultMatchMethod: MatchMethod;
  /** Affidabilita' di default, idem. */
  defaultConfidence: number;
}

/**
 * Elabora un task completato. Restituisce quante offerte sono state salvate.
 * Non lancia: un singolo prodotto fallito non deve interrompere la scansione.
 */
export async function processTask(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  task: TaskRow,
  settings: ScanSettings,
): Promise<number> {
  try {
    const { data: product } = await db
      .from('pt_products')
      .select('id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id')
      .eq('id', task.product_id)
      .single<ProductRow>();

    if (!product) {
      await markTask(db, task.id, 'errore', 'Prodotto non piu\' presente in catalogo');
      return 0;
    }

    const offers =
      task.endpoint === 'sellers'
        ? await collectFromSellers(dfs, task, product)
        : await collectFromProducts(db, dfs, task, product, settings);

    const saved = await persistOffers(
      db,
      {
        runId: task.run_id,
        source: task.endpoint === 'sellers' ? 'google_sellers' : 'google_shopping',
        defaultMatchMethod: task.endpoint === 'sellers' ? 'gtin' : 'google_shopping',
        defaultConfidence: task.endpoint === 'sellers' ? 1 : MATCH_MIN_SCORE,
      },
      product,
      offers,
      settings,
    );
    await markTask(db, task.id, 'completato');
    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Errore sconosciuto';
    console.error(`[scan] Task ${task.dfs_task_id} fallito:`, message);
    await markTask(db, task.id, 'errore', message);
    return 0;
  }
}

// -----------------------------------------------------------------------------
// Raccolta offerte
// -----------------------------------------------------------------------------

/**
 * Risultato "sellers": la lista completa dei venditori di un product_id noto.
 * E' la fonte piu' ricca (spedizione, disponibilita', condizione).
 */
async function collectFromSellers(
  dfs: DataForSeoClient,
  task: TaskRow,
  product: ProductRow,
): Promise<OfferCandidate[]> {
  const result: SellersResult | null = await dfs.getSellersResult(task.dfs_task_id);
  if (!result?.items) return [];

  const offers: OfferCandidate[] = [];
  for (const item of result.items) {
    const offer = toOffer(item, product.currency);
    if (offer) offers.push(offer);
  }
  return offers;
}

/**
 * Risultato "products": la SERP di Google Shopping per la nostra query.
 * Qui serve il matching, perche' i risultati includono articoli diversi.
 * Come effetto collaterale risolviamo il `google_product_id`, che alle
 * scansioni successive permette di usare direttamente l'endpoint sellers.
 */
async function collectFromProducts(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  task: TaskRow,
  product: ProductRow,
  settings: ScanSettings,
): Promise<OfferCandidate[]> {
  const result: ProductsResult | null = await dfs.getProductsResult(task.dfs_task_id);
  if (!result?.items) return [];

  const subject: MatchSubject = {
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    mpn: product.mpn,
    sku: product.sku,
    price: product.own_price,
  };

  const offers: OfferCandidate[] = [];
  let best: { score: number; googleProductId: string } | null = null;

  for (const item of result.items) {
    if (!item.title) continue;

    const verdict = scoreMatch(
      subject,
      {
        title: item.title,
        description: item.description,
        seller: item.seller,
        domain: item.domain,
        price: item.price ?? null,
      },
      'google_shopping',
    );
    if (!verdict.accepted) continue;

    if (item.product_id && (!best || verdict.score > best.score)) {
      best = { score: verdict.score, googleProductId: item.product_id };
    }

    const domain = normalizeDomain(item.domain ?? item.url);
    if (!domain || !item.price) continue;

    offers.push({
      domain,
      sellerName: item.seller ?? null,
      offerUrl: item.url ?? '',
      offerTitle: item.title,
      price: item.price,
      shippingPrice: null,
      totalPrice: null,
      currency: item.currency ?? product.currency,
      availability: null,
      condition: null,
    });
  }

  if (best) {
    await db
      .from('pt_products')
      .update({
        google_product_id: best.googleProductId,
        google_product_resolved_at: new Date().toISOString(),
      })
      .eq('id', product.id);

    // Il product_id e' appena stato risolto: chiediamo subito la lista
    // completa dei venditori, che nella SERP e' sempre troncata.
    await enqueueSellersTask(db, dfs, task, best.googleProductId, settings);
  }

  return offers;
}

async function enqueueSellersTask(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  task: TaskRow,
  googleProductId: string,
  settings: ScanSettings,
): Promise<void> {
  try {
    const [handle] = await dfs.postSellersTasks([
      {
        product_id: googleProductId,
        location_code: settings.location_code,
        language_code: settings.language_code,
        depth: 100,
        sort_by: 'total_price',
        tag: `${task.run_id}:${task.product_id}`,
        postback_url: buildPostbackUrl('sellers'),
        postback_data: 'advanced',
      },
    ]);

    if (!handle?.id) return;

    await db.from('pt_scan_tasks').insert({
      client_id: task.client_id,
      run_id: task.run_id,
      product_id: task.product_id,
      dfs_task_id: handle.id,
      endpoint: 'sellers',
    });
  } catch (err) {
    // Non bloccante: abbiamo comunque le offerte della SERP prodotti.
    console.warn('[scan] Impossibile accodare il task sellers:', (err as Error).message);
  }
}

export function buildPostbackUrl(endpoint: 'products' | 'sellers'): string | undefined {
  const base = process.env.APP_PUBLIC_URL?.replace(/\/$/, '');
  const secret = process.env.DATAFORSEO_POSTBACK_SECRET;
  if (!base || !secret) return undefined; // senza postback si usa il polling

  return `${base}/api/dataforseo-postback?secret=${encodeURIComponent(secret)}&endpoint=${endpoint}&id=$id`;
}

function toOffer(item: ShoppingSellerItem, fallbackCurrency: string): OfferCandidate | null {
  const domain = normalizeDomain(item.domain ?? item.url);
  const price = item.base_price ?? item.total_price ?? null;
  if (!domain || !price || price <= 0) return null;

  return {
    domain,
    sellerName: item.seller_name ?? null,
    offerUrl: item.url ?? '',
    offerTitle: item.title ?? '',
    price,
    shippingPrice: item.shipping_price ?? null,
    totalPrice: item.total_price ?? null,
    currency: item.currency ?? fallbackCurrency,
    availability: mapAvailability(item.product_availability),
    condition: item.product_condition ?? null,
  };
}

function mapAvailability(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.includes('out_of_stock') || value.includes('out of stock')) return 'non_disponibile';
  if (value.includes('in_stock') || value.includes('in stock')) return 'disponibile';
  if (value.includes('preorder')) return 'preordine';
  if (value.includes('backorder')) return 'ordinabile';
  return null;
}

// -----------------------------------------------------------------------------
// Persistenza
// -----------------------------------------------------------------------------

export async function persistOffers(
  db: SupabaseClient,
  ctx: OfferContext,
  product: ProductRow,
  offers: OfferCandidate[],
  settings: ScanSettings,
): Promise<number> {
  if (offers.length === 0) return 0;

  // Domini esclusi manualmente: non devono rientrare a ogni scansione.
  const { data: excluded } = await db
    .from('pt_matches')
    .select('domain')
    .eq('product_id', product.id)
    .eq('status', 'escluso');
  const excludedDomains = new Set((excluded ?? []).map((m) => m.domain as string));

  const { data: ownRows } = await db
    .from('pt_competitors')
    .select('domain')
    .eq('client_id', product.client_id)
    .eq('is_own', true);
  const ownDomains = new Set((ownRows ?? []).map((c) => c.domain as string));

  // Un venditore puo' comparire piu' volte: teniamo l'offerta piu' bassa.
  const bestByDomain = new Map<string, OfferCandidate>();
  for (const offer of offers) {
    if (excludedDomains.has(offer.domain)) continue;
    const current = bestByDomain.get(offer.domain);
    if (!current || offer.price < current.price) bestByDomain.set(offer.domain, offer);
  }

  const now = new Date().toISOString();
  const deduped = [...bestByDomain.values()];

  // 1. Match (upsert idempotente sulla tripla prodotto/dominio/url).
  const matchRows = (allowAi: boolean) =>
    deduped.map((offer) => {
      const method = offer.matchMethod ?? ctx.defaultMatchMethod;
      return {
        client_id: product.client_id,
        product_id: product.id,
        domain: offer.domain,
        seller_name: offer.sellerName,
        offer_url: offer.offerUrl,
        offer_title: offer.offerTitle,
        // Il metodo 'ai' esiste dalla migration 0003: senza, si degrada a 'serp'.
        match_method: method === 'ai' && !allowAi ? 'serp' : method,
        confidence: offer.confidence ?? ctx.defaultConfidence,
        last_seen_at: now,
      };
    });

  let { data: matches, error: matchError } = await db
    .from('pt_matches')
    .upsert(matchRows(true), { onConflict: 'product_id,domain,offer_url', ignoreDuplicates: false })
    .select('id, domain');

  if (matchError && /match_method/.test(matchError.message)) {
    console.warn('[scan] match_method ai non ammesso (migration 0003 assente): salvo come serp');
    ({ data: matches, error: matchError } = await db
      .from('pt_matches')
      .upsert(matchRows(false), { onConflict: 'product_id,domain,offer_url', ignoreDuplicates: false })
      .select('id, domain'));
  }

  if (matchError) {
    console.error('[scan] Upsert match fallito:', matchError.message);
    return 0;
  }

  const matchIdByDomain = new Map((matches ?? []).map((m) => [m.domain as string, m.id as string]));

  // 2. Snapshot di prezzo (uno per prodotto/dominio/giorno).
  const { error: snapshotError } = await db.from('pt_price_snapshots').upsert(
    deduped.map((offer) => ({
      client_id: product.client_id,
      product_id: product.id,
      match_id: matchIdByDomain.get(offer.domain) ?? null,
      domain: offer.domain,
      is_own: ownDomains.has(offer.domain),
      price: offer.price,
      shipping_price: offer.shippingPrice,
      total_price: offer.totalPrice ?? offer.price,
      currency: offer.currency,
      availability: offer.availability,
      condition: offer.condition,
      source: ctx.source,
      captured_at: now,
    })),
    { onConflict: 'product_id,domain_key,captured_on', ignoreDuplicates: false },
  );

  if (snapshotError) {
    console.error('[scan] Upsert snapshot fallito:', snapshotError.message);
    return 0;
  }

  await createAlerts(db, ctx, product, deduped, ownDomains, settings);
  return deduped.length;
}

/**
 * Genera gli alert confrontando il nostro prezzo con quelli dei competitor.
 * Viene emesso al massimo un alert per tipo e prodotto per ogni scansione.
 */
async function createAlerts(
  db: SupabaseClient,
  ctx: OfferContext,
  product: ProductRow,
  offers: OfferCandidate[],
  ownDomains: Set<string>,
  settings: ScanSettings,
): Promise<void> {
  const ownPrice = product.own_price;
  if (!ownPrice || ownPrice <= 0) return;

  const competitorOffers = offers.filter((o) => !ownDomains.has(o.domain));
  if (competitorOffers.length === 0) return;

  const cheapest = competitorOffers.reduce((min, o) => (o.price < min.price ? o : min));
  const deltaPct = Number((((cheapest.price - ownPrice) / ownPrice) * 100).toFixed(2));

  const alerts: Array<Record<string, unknown>> = [];

  // Un competitor ci sta sottoquotando oltre la soglia.
  if (deltaPct <= -settings.undercut_threshold) {
    alerts.push({
      kind: 'sottoprezzo',
      domain: cheapest.domain,
      delta_pct: deltaPct,
      competitor_price: cheapest.price,
      message: `${cheapest.domain} vende a ${cheapest.price.toFixed(2)} ${settings.currency}, ${Math.abs(deltaPct).toFixed(1)}% sotto il nostro prezzo`,
    });
  }

  // Siamo noi i piu' cari, oltre la soglia di tolleranza.
  const maxCompetitor = Math.max(...competitorOffers.map((o) => o.price));
  const overPct = Number((((ownPrice - maxCompetitor) / maxCompetitor) * 100).toFixed(2));
  if (overPct >= settings.overprice_threshold) {
    alerts.push({
      kind: 'sovrapprezzo',
      domain: null,
      delta_pct: overPct,
      competitor_price: maxCompetitor,
      message: `Siamo il venditore piu' caro: ${overPct.toFixed(1)}% sopra il massimo di mercato (${maxCompetitor.toFixed(2)} ${settings.currency})`,
    });
  }

  if (alerts.length === 0) return;

  await db.from('pt_alerts').insert(
    alerts.map((alert) => ({
      client_id: product.client_id,
      product_id: product.id,
      run_id: ctx.runId,
      own_price: ownPrice,
      ...alert,
    })),
  );
}

async function markTask(
  db: SupabaseClient,
  taskId: string,
  status: 'completato' | 'errore',
  errorMessage?: string,
): Promise<void> {
  await db
    .from('pt_scan_tasks')
    .update({
      status,
      error_message: errorMessage ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', taskId);
}

export type RunStatus = 'in_corso' | 'completata' | 'parziale' | 'errore';

export type RunSource = 'serp' | 'shopping' | 'entrambe';

export interface RunStatusInput {
  /** Prodotti previsti e prodotti analizzati dal percorso sincrono (SERP). */
  productsTotal: number;
  productsDone: number;
  /** Task Google Shopping della run, per stato. Vuoti per una run solo SERP. */
  tasks: Array<{ status: string }>;
  startedAt: string | null;
  /** Fonte della run: decide se conta il cursore SERP, i task, o entrambi. */
  searchSource?: RunSource;
  /** Solo per i test: "adesso". */
  now?: number;
}

/** Oltre questo tempo una run aperta viene chiusa come parziale. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Decide lo stato di una run. Funzione pura, cosi' si puo' verificare.
 *
 * Il caso senza task era il buco: una run SERP non ne crea, e la versione
 * precedente usciva senza toccare lo stato. La run restava "in corso" per
 * sempre, il pulsante Avvia scansione restava disabilitato e la scansione
 * pianificata saltava il cliente.
 */
export function computeRunStatus(input: RunStatusInput): {
  status: RunStatus;
  finished: boolean;
  productsDone: number;
  errorMessage: string | null;
} {
  const now = input.now ?? Date.now();
  const startedAt = input.startedAt ? new Date(input.startedAt).getTime() : now;
  const stale = now - startedAt > STALE_AFTER_MS;

  const pending = input.tasks.filter((t) => t.status === 'in_attesa').length;
  const failed = input.tasks.filter((t) => t.status === 'errore').length;
  const tasksDone = input.tasks.length - pending;

  // Senza fonte dichiarata (run create prima della migration 0003) si deduce:
  // se ha task e' Google Shopping, altrimenti SERP.
  const source: RunSource = input.searchSource ?? (input.tasks.length > 0 ? 'shopping' : 'serp');

  // La parte sincrona e' finita quando il cursore ha raggiunto il totale.
  // Una run solo Shopping non ha cursore: per lei conta solo lo stato dei task.
  const serpDone = source === 'shopping' || input.productsDone >= input.productsTotal;
  const productsDone = source === 'shopping' ? tasksDone : input.productsDone;

  const finished = (serpDone && pending === 0) || stale;
  if (!finished) return { status: 'in_corso', finished: false, productsDone, errorMessage: null };

  const allTasksFailed = input.tasks.length > 0 && failed === input.tasks.length;
  const status: RunStatus = allTasksFailed
    ? 'errore'
    : failed > 0 || pending > 0 || !serpDone
      ? 'parziale'
      : 'completata';

  const errorMessage = failed > 0
    ? `${failed} prodotti non elaborati`
    : stale && !serpDone
      ? 'Scansione interrotta: non tutti i prodotti sono stati analizzati'
      : null;

  return { status, finished: true, productsDone, errorMessage };
}

/**
 * Aggiorna i contatori della run e la chiude quando non resta lavoro:
 * ne' task Google Shopping in volo, ne' prodotti da cercare sulla SERP.
 */
export async function refreshRunStatus(db: SupabaseClient, runId: string): Promise<void> {
  const [{ data: tasks }, run] = await Promise.all([
    db.from('pt_scan_tasks').select('status').eq('run_id', runId),
    loadRun(db, runId),
  ]);

  if (!run) return;
  // Una run gia' chiusa non si riapre: il postback tardivo di un task non
  // deve rimettere "in corso" una scansione conclusa.
  if (run.status !== 'in_corso') return;

  const verdict = computeRunStatus({
    productsTotal: Number(run.products_total ?? 0),
    productsDone: Number(run.products_done ?? 0),
    tasks: (tasks ?? []) as Array<{ status: string }>,
    startedAt: run.started_at,
    searchSource: run.search_source ?? undefined,
  });

  await db
    .from('pt_scan_runs')
    .update({
      status: verdict.status,
      products_done: verdict.productsDone,
      finished_at: verdict.finished ? new Date().toISOString() : null,
      error_message: verdict.errorMessage,
    })
    .eq('id', runId);
}

export interface RunRow {
  id: string;
  client_id: string;
  status: string;
  products_total: number;
  products_done: number;
  started_at: string | null;
  /** Assente se la migration 0003 non e' stata applicata. */
  search_source: RunSource | null;
}

/**
 * Legge una run tollerando l'assenza della colonna `search_source`
 * (migration 0003 non applicata): in quel caso la fonte resta null e viene
 * dedotta dai task.
 */
export async function loadRun(db: SupabaseClient, runId: string): Promise<RunRow | null> {
  const base = 'id, client_id, status, products_total, products_done, started_at';
  const full = await db.from('pt_scan_runs').select(`${base}, search_source`).eq('id', runId).maybeSingle();
  if (!full.error) return (full.data as RunRow | null) ?? null;

  const { data } = await db.from('pt_scan_runs').select(base).eq('id', runId).maybeSingle();
  return data ? ({ ...(data as Omit<RunRow, 'search_source'>), search_source: null } as RunRow) : null;
}

/**
 * Crea una run. Registra la fonte quando la colonna esiste (migration 0003),
 * altrimenti ripiega sulle sole colonne originali.
 */
export async function createRun(
  db: SupabaseClient,
  input: {
    clientId: string;
    triggeredBy: 'manuale' | 'pianificata';
    triggeredByUser: string | null;
    productsTotal: number;
    searchSource: RunSource;
  },
): Promise<string> {
  const base = {
    client_id: input.clientId,
    triggered_by: input.triggeredBy,
    triggered_by_user: input.triggeredByUser,
    products_total: input.productsTotal,
    status: 'in_corso',
  };

  let { data, error } = await db
    .from('pt_scan_runs')
    .insert({ ...base, search_source: input.searchSource })
    .select('id')
    .single();

  if (error && /search_source/.test(error.message)) {
    console.warn('[scan] Colonna search_source assente (migration 0003): run creata senza fonte');
    ({ data, error } = await db.from('pt_scan_runs').insert(base).select('id').single());
  }

  if (error || !data) {
    console.error('[scan] Creazione run fallita:', error?.message);
    throw new HttpError(500, `Impossibile avviare la scansione: ${error?.message ?? 'errore sconosciuto'}`);
  }
  return data.id as string;
}

/** Somma le offerte trovate a una run (contatore cumulativo). */
export async function addOffersFound(
  db: SupabaseClient,
  runId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const { data } = await db.from('pt_scan_runs').select('offers_found').eq('id', runId).single();
  await db
    .from('pt_scan_runs')
    .update({ offers_found: (data?.offers_found ?? 0) + count })
    .eq('id', runId);
}
