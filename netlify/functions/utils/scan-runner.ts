/**
 * Accodamento e raccolta di una scansione prezzi.
 *
 * Tutto e' progettato per stare nei ~10 secondi di una Netlify Function:
 * ogni chiamata lavora su un lotto e dice a che punto e' arrivata, e' il
 * chiamante (il browser, o la scansione pianificata) a scorrere.
 *
 * Per ogni prodotto si sceglie l'endpoint piu' economico:
 *   - `sellers`  se il product_id di Google Shopping e' gia' noto e recente
 *   - `products` altrimenti, per risolverlo
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

/**
 * Prodotti accodati per chiamata.
 * Tenuto a 50 perche' nel caso peggiore diventano due richieste a DataForSEO
 * (una `sellers` e una `products`) piu' le scritture su database: con questo
 * numero si resta comodamente sotto il limite della piattaforma.
 */
export const PRODUCTS_PER_CALL = 50;

type ProductRowFull = ProductRow & { google_product_resolved_at: string | null };

export interface EnqueueInput {
  clientId: string;
  runId: string;
  settings: ScanSettings;
  productIds?: string[];
  offset: number;
}

export interface EnqueueResult {
  enqueued: number;
  tasksCreated: number;
  nextOffset: number;
}

export async function enqueueBatch(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const products = await selectProducts(db, input);

  if (products.length === 0) {
    return { enqueued: 0, tasksCreated: 0, nextOffset: input.offset };
  }

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
  tasksCreated += await postSellers(db, dfs, input, viaSellers);
  tasksCreated += await postProducts(db, dfs, input, viaProducts);

  if (tasksCreated === 0) {
    // Un lotto rifiutato per intero indica un problema di credenziali o di
    // credito: meglio fermarsi subito che accodare a vuoto tutto il catalogo.
    await db
      .from('pt_scan_runs')
      .update({
        status: 'errore',
        error_message: 'DataForSEO non ha accettato i task',
        finished_at: new Date().toISOString(),
      })
      .eq('id', input.runId);

    throw new HttpError(
      502,
      'DataForSEO non ha accettato alcun task. Verifica credenziali e credito residuo.',
      'DATAFORSEO_REJECTED',
    );
  }

  return {
    enqueued: products.length,
    tasksCreated,
    nextOffset: input.offset + products.length,
  };
}

async function selectProducts(db: SupabaseClient, input: EnqueueInput): Promise<ProductRowFull[]> {
  const columns =
    'id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id, google_product_resolved_at';

  let query = db
    .from('pt_products')
    .select(columns)
    .eq('client_id', input.clientId)
    .eq('is_active', true)
    // Ordine stabile: senza, la paginazione per offset potrebbe saltare righe.
    .order('id', { ascending: true })
    .range(input.offset, input.offset + PRODUCTS_PER_CALL - 1);

  if (input.productIds?.length) {
    query = db
      .from('pt_products')
      .select(columns)
      .eq('client_id', input.clientId)
      .eq('is_active', true)
      .in('id', input.productIds)
      .order('id', { ascending: true })
      .range(input.offset, input.offset + PRODUCTS_PER_CALL - 1);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[scan] Lettura catalogo fallita:', error.message);
    throw new HttpError(500, `Impossibile leggere il catalogo: ${error.message}`);
  }
  return (data ?? []) as ProductRowFull[];
}

async function postSellers(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: EnqueueInput,
  products: ProductRowFull[],
): Promise<number> {
  if (products.length === 0) return 0;

  const handles = await dfs.postSellersTasks(
    products.map((product) => ({
      product_id: product.google_product_id as string,
      location_code: input.settings.location_code,
      language_code: input.settings.language_code,
      depth: 100,
      sort_by: 'total_price' as const,
      tag: `${input.runId}:${product.id}`,
      postback_url: buildPostbackUrl('sellers'),
      postback_data: 'advanced' as const,
    })),
  );

  return saveTasks(db, input, products, handles, 'sellers');
}

async function postProducts(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: EnqueueInput,
  products: ProductRowFull[],
): Promise<number> {
  if (products.length === 0) return 0;

  const handles = await dfs.postProductsTasks(
    products.map((product) => ({
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
      tag: `${input.runId}:${product.id}`,
      postback_url: buildPostbackUrl('products'),
      postback_data: 'advanced' as const,
    })),
  );

  return saveTasks(db, input, products, handles, 'products');
}

async function saveTasks(
  db: SupabaseClient,
  input: EnqueueInput,
  products: ProductRowFull[],
  handles: Array<{ id: string | null; statusMessage: string }>,
  endpoint: 'products' | 'sellers',
): Promise<number> {
  // DataForSEO restituisce i task nello stesso ordine in cui li abbiamo inviati.
  const rows = products
    .map((product, index) => ({ product, handle: handles[index] }))
    .filter((pair) => pair.handle?.id)
    .map((pair) => ({
      client_id: input.clientId,
      run_id: input.runId,
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

/** Quanti task elaborare per chiamata: ognuno e' una task_get su DataForSEO. */
export const TASKS_PER_CALL = 15;

/**
 * Raccoglie i task pronti. Il chiamante ripete finche' `stillPending` non
 * arriva a zero.
 */
export async function collectPendingTasks(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  clientId: string,
  settings: ScanSettings,
  options: { runId?: string; maxTasks?: number } = {},
): Promise<CollectResult> {
  const maxTasks = Math.min(options.maxTasks ?? TASKS_PER_CALL, TASKS_PER_CALL);

  // Solo i task Google Shopping: quelli SERP hanno la loro raccolta
  // (utils/serp-tasks.ts) con lettura delle schede e verifica AI.
  let query = db
    .from('pt_scan_tasks')
    .select('id, client_id, run_id, product_id, dfs_task_id, endpoint', { count: 'exact' })
    .eq('client_id', clientId)
    .eq('status', 'in_attesa')
    .in('endpoint', ['products', 'sellers'])
    .order('created_at', { ascending: true })
    .limit(maxTasks);

  if (options.runId) query = query.eq('run_id', options.runId);

  const { data: pending, count } = await query;
  const tasks = (pending ?? []) as TaskRow[];
  if (tasks.length === 0) return { processed: 0, offers: 0, stillPending: 0 };

  // `tasks_ready` evita di pagare una task_get su risultati non pronti.
  const ready = new Set([
    ...(await safeReady(() => dfs.sellersTasksReady())),
    ...(await safeReady(() => dfs.productsTasksReady())),
  ]);

  let processed = 0;
  let offers = 0;
  // Offerte per run: una raccolta puo' toccare piu' scansioni contemporanee.
  const offersByRun = new Map<string, number>();

  for (const task of tasks) {
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

  return {
    processed,
    offers,
    stillPending: Math.max((count ?? tasks.length) - processed, 0),
  };
}

async function safeReady(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn('[scan] tasks_ready non disponibile:', (err as Error).message);
    return [];
  }
}
