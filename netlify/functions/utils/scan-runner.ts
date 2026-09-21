/**
 * Avvio e raccolta di una scansione prezzi.
 *
 * Condiviso fra l'avvio manuale (`scan-start`), la raccolta (`scan-collect`) e
 * la scansione pianificata (`scheduled-scan`).
 *
 * Flusso:
 *   1. per ogni prodotto si sceglie l'endpoint piu' efficiente
 *      - `sellers`  se conosciamo gia' il product_id di Google Shopping
 *      - `products` altrimenti (la prima volta, o dopo 30 giorni)
 *   2. i task vengono creati su DataForSEO con `postback_url`
 *   3. i risultati arrivano via postback oppure vengono raccolti in polling
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DataForSeoClient } from './dataforseo';
import { HttpError } from './http';
import { buildSearchQuery } from './matching';
import {
  addOffersFound,
  buildPostbackUrl,
  processTask,
  refreshRunStatus,
  type ProductRow,
  type ScanSettings,
  type TaskRow,
} from './scan-processing';

/** Oltre questo periodo il product_id di Google va ri-risolto. */
const PRODUCT_ID_TTL_DAYS = 30;
/** Limite di task per singola chiamata task_post. */
const TASK_BATCH = 100;

export interface StartScanInput {
  clientId: string;
  settings: ScanSettings & { max_products_per_scan: number };
  productIds?: string[];
  triggeredBy: 'manuale' | 'pianificata';
  triggeredByUser?: string | null;
}

export interface StartScanResult {
  runId: string;
  productsQueued: number;
  tasksCreated: number;
  skipped: number;
}

export async function startScan(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: StartScanInput,
): Promise<StartScanResult> {
  const products = await selectProducts(db, input);

  if (products.length === 0) {
    throw new HttpError(
      400,
      'Nessun prodotto da analizzare. Importa prima il catalogo dalla sezione Catalogo.',
      'EMPTY_CATALOG',
    );
  }

  const { data: run, error: runError } = await db
    .from('pt_scan_runs')
    .insert({
      client_id: input.clientId,
      triggered_by: input.triggeredBy,
      triggered_by_user: input.triggeredByUser ?? null,
      products_total: products.length,
      status: 'in_corso',
    })
    .select('id')
    .single();

  if (runError || !run) {
    console.error('[scan] Creazione run fallita:', runError?.message);
    throw new HttpError(500, 'Impossibile avviare la scansione');
  }

  const runId = run.id as string;
  const cutoff = Date.now() - PRODUCT_ID_TTL_DAYS * 24 * 60 * 60 * 1000;

  const viaSellers: ProductRowFull[] = [];
  const viaProducts: ProductRowFull[] = [];

  for (const product of products) {
    const resolvedAt = product.google_product_resolved_at
      ? new Date(product.google_product_resolved_at).getTime()
      : 0;

    if (product.google_product_id && resolvedAt > cutoff) viaSellers.push(product);
    else viaProducts.push(product);
  }

  let tasksCreated = 0;
  tasksCreated += await postSellers(db, dfs, runId, input, viaSellers);
  tasksCreated += await postProducts(db, dfs, runId, input, viaProducts);

  if (tasksCreated === 0) {
    await db
      .from('pt_scan_runs')
      .update({
        status: 'errore',
        error_message: 'DataForSEO non ha accettato alcun task',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    throw new HttpError(502, 'DataForSEO non ha accettato i task di scansione');
  }

  return {
    runId,
    productsQueued: products.length,
    tasksCreated,
    skipped: products.length - tasksCreated,
  };
}

async function selectProducts(db: SupabaseClient, input: StartScanInput): Promise<ProductRowFull[]> {
  let query = db
    .from('pt_products')
    .select(
      'id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id, google_product_resolved_at',
    )
    .eq('client_id', input.clientId)
    .eq('is_active', true)
    .limit(input.settings.max_products_per_scan);

  if (input.productIds?.length) {
    query = query.in('id', input.productIds.slice(0, input.settings.max_products_per_scan));
  }

  const { data, error } = await query;
  if (error) {
    console.error('[scan] Lettura catalogo fallita:', error.message);
    throw new HttpError(500, 'Impossibile leggere il catalogo');
  }
  return (data ?? []) as ProductRowFull[];
}

type ProductRowFull = ProductRow & { google_product_resolved_at: string | null };

async function postSellers(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  runId: string,
  input: StartScanInput,
  products: ProductRowFull[],
): Promise<number> {
  let created = 0;

  for (let i = 0; i < products.length; i += TASK_BATCH) {
    const batch = products.slice(i, i + TASK_BATCH);

    const handles = await dfs.postSellersTasks(
      batch.map((product) => ({
        product_id: product.google_product_id as string,
        location_code: input.settings.location_code,
        language_code: input.settings.language_code,
        depth: 100,
        sort_by: 'total_price' as const,
        tag: `${runId}:${product.id}`,
        postback_url: buildPostbackUrl('sellers'),
        postback_data: 'advanced' as const,
      })),
    );

    created += await saveTasks(db, runId, input.clientId, batch, handles, 'sellers');
  }

  return created;
}

async function postProducts(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  runId: string,
  input: StartScanInput,
  products: ProductRowFull[],
): Promise<number> {
  let created = 0;

  for (let i = 0; i < products.length; i += TASK_BATCH) {
    const batch = products.slice(i, i + TASK_BATCH);

    const handles = await dfs.postProductsTasks(
      batch.map((product) => ({
        keyword: buildSearchQuery({
          title: product.title,
          brand: product.brand,
          gtin: product.gtin,
          mpn: product.mpn,
          sku: product.sku,
          price: product.own_price,
        }),
        location_code: input.settings.location_code,
        language_code: input.settings.language_code,
        depth: 40,
        tag: `${runId}:${product.id}`,
        postback_url: buildPostbackUrl('products'),
        postback_data: 'advanced' as const,
      })),
    );

    created += await saveTasks(db, runId, input.clientId, batch, handles, 'products');
  }

  return created;
}

async function saveTasks(
  db: SupabaseClient,
  runId: string,
  clientId: string,
  products: ProductRowFull[],
  handles: Array<{ id: string | null; statusMessage: string }>,
  endpoint: 'products' | 'sellers',
): Promise<number> {
  // DataForSEO restituisce i task nello stesso ordine in cui li abbiamo inviati.
  const rows = products
    .map((product, index) => ({ product, handle: handles[index] }))
    .filter((pair) => pair.handle?.id)
    .map((pair) => ({
      client_id: clientId,
      run_id: runId,
      product_id: pair.product.id,
      dfs_task_id: pair.handle.id as string,
      endpoint,
    }));

  if (rows.length === 0) return 0;

  const { error } = await db.from('pt_scan_tasks').upsert(rows, { onConflict: 'dfs_task_id' });
  if (error) {
    console.error('[scan] Salvataggio task fallito:', error.message);
    return 0;
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Raccolta
// -----------------------------------------------------------------------------

export interface CollectResult {
  processed: number;
  offers: number;
  stillPending: number;
}

/**
 * Raccoglie i task pronti. `maxTasks` limita il lavoro al timeout della
 * funzione: quello che resta viene ripreso alla chiamata successiva.
 */
export async function collectPendingTasks(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  clientId: string,
  settings: ScanSettings,
  options: { runId?: string; maxTasks?: number } = {},
): Promise<CollectResult> {
  const maxTasks = options.maxTasks ?? 40;

  let query = db
    .from('pt_scan_tasks')
    .select('id, client_id, run_id, product_id, dfs_task_id, endpoint')
    .eq('client_id', clientId)
    .eq('status', 'in_attesa')
    .order('created_at', { ascending: true })
    .limit(maxTasks + 1);

  if (options.runId) query = query.eq('run_id', options.runId);

  const { data: pending } = await query;
  const tasks = (pending ?? []) as TaskRow[];
  if (tasks.length === 0) return { processed: 0, offers: 0, stillPending: 0 };

  const batch = tasks.slice(0, maxTasks);

  // `tasks_ready` evita di pagare una task_get su risultati non pronti.
  const ready = new Set([
    ...(await safeReady(() => dfs.sellersTasksReady())),
    ...(await safeReady(() => dfs.productsTasksReady())),
  ]);

  let processed = 0;
  let offers = 0;
  // Offerte per run: una raccolta puo' toccare piu' scansioni contemporanee.
  const offersByRun = new Map<string, number>();

  for (const task of batch) {
    // Se `tasks_ready` e' vuoto (es. risultati gia' consegnati via postback)
    // proviamo comunque il task_get: e' l'unico modo per chiudere la run.
    if (ready.size > 0 && !ready.has(task.dfs_task_id)) continue;

    const saved = await processTask(db, dfs, task, settings);
    offers += saved;
    processed += 1;
    offersByRun.set(task.run_id, (offersByRun.get(task.run_id) ?? 0) + saved);
  }

  for (const [runId, runOffers] of offersByRun) {
    await addOffersFound(db, runId, runOffers);
    await refreshRunStatus(db, runId);
  }

  return { processed, offers, stillPending: Math.max(0, tasks.length - processed) };
}

async function safeReady(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn('[scan] tasks_ready non disponibile:', (err as Error).message);
    return [];
  }
}
