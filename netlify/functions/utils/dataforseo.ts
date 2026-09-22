/**
 * Client DataForSEO (Merchant API + SERP API).
 *
 * Nota sulle modalita':
 *   * Google Shopping (merchant/google/*) e' SOLO asincrono:
 *     `task_post` -> `tasks_ready` / postback -> `task_get/advanced/{id}`.
 *   * Amazon (merchant/amazon/*) e SERP organico hanno anche il `live`.
 * Per questo il flusso di scansione passa da `pt_scan_tasks`.
 *
 * Tutte le chiamate avvengono lato server: login e password non raggiungono
 * mai il browser.
 */
import { HttpError } from './http';

const BASE_URL = 'https://api.dataforseo.com';

/** Codici di stato DataForSEO rilevanti. */
const STATUS_OK = 20000;
const STATUS_TASK_CREATED = 20100;
const STATUS_TASK_IN_QUEUE = 40602;

export interface DfsTask<T = unknown> {
  id: string;
  status_code: number;
  status_message: string;
  cost?: number;
  data?: Record<string, unknown>;
  result?: T[] | null;
}

interface DfsEnvelope<T> {
  status_code: number;
  status_message: string;
  cost?: number;
  tasks: DfsTask<T>[];
}

/** Item restituito da merchant/google/products/task_get/advanced. */
export interface ShoppingProductItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  position?: string;
  title?: string;
  url?: string;
  description?: string;
  seller?: string;
  domain?: string;
  price?: number | null;
  currency?: string | null;
  product_id?: string | null;
  data_docid?: string | null;
  product_image_url?: string | null;
  product_rating?: { value?: number; votes_count?: number } | null;
  shop_ad_aclk?: string | null;
}

/** Item restituito da merchant/google/sellers/task_get/advanced. */
export interface ShoppingSellerItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  position?: string;
  domain?: string | null;
  seller_name?: string | null;
  title?: string | null;
  url?: string | null;
  details?: string | null;
  base_price?: number | null;
  tax?: number | null;
  shipping_price?: number | null;
  total_price?: number | null;
  currency?: string | null;
  price_multiplier?: string | null;
  product_condition?: string | null;
  product_annotation?: string | null;
  product_availability?: string | null;
  rating?: { value?: number; votes_count?: number } | null;
}

export interface SellersResult {
  product_id?: string;
  title?: string;
  url?: string;
  image_url?: string;
  items_count?: number;
  items?: ShoppingSellerItem[] | null;
}

export interface ProductsResult {
  keyword?: string;
  se_domain?: string;
  location_code?: number;
  language_code?: string;
  items_count?: number;
  items?: ShoppingProductItem[] | null;
}

/**
 * Item della SERP organica.
 *
 * `price` e' la ragione per cui questa fonte e' utile al confronto prezzi:
 * Google mostra il prezzo nello snippet dei risultati e-commerce, e
 * DataForSEO lo restituisce gia' interpretato. A differenza degli endpoint
 * Google Shopping, questa chiamata e' **sincrona**: i risultati arrivano
 * subito, senza task da attendere.
 */
export interface OrganicItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  title?: string;
  url?: string;
  description?: string;
  breadcrumb?: string;
  website_name?: string;
  price?: {
    current?: number | null;
    regular?: number | null;
    currency?: string | null;
    displayed_price?: string | null;
    is_price_range?: boolean;
  } | null;
}

export interface OrganicResult {
  keyword?: string;
  se_domain?: string;
  location_code?: number;
  language_code?: string;
  items_count?: number;
  items?: OrganicItem[] | null;
}

export interface ProductsTaskPayload {
  keyword: string;
  location_code: number;
  language_code: string;
  depth?: number;
  price_min?: number;
  price_max?: number;
  sort_by?: 'relevance' | 'price_low_to_high' | 'price_high_to_low' | 'review_score';
  tag?: string;
  postback_url?: string;
  postback_data?: 'advanced' | 'html';
  priority?: 1 | 2;
}

export interface SellersTaskPayload {
  product_id: string;
  location_code: number;
  language_code: string;
  depth?: number;
  sort_by?: 'relevance' | 'base_price' | 'total_price';
  tag?: string;
  postback_url?: string;
  postback_data?: 'advanced' | 'html';
  priority?: 1 | 2;
}

export interface TaskHandle {
  /** id DataForSEO, null se la creazione del task e' fallita. */
  id: string | null;
  tag?: string;
  statusCode: number;
  statusMessage: string;
}

export class DataForSeoClient {
  private readonly authHeader: string;

  constructor(login: string, password: string) {
    this.authHeader = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<DfsEnvelope<T>> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      console.error(`[dataforseo] Errore di rete su ${path}:`, err);
      throw new HttpError(502, 'DataForSEO non raggiungibile');
    }

    if (response.status === 401) {
      throw new HttpError(
        401,
        'Credenziali DataForSEO non valide. Verificale su Moca Hub.',
        'DATAFORSEO_UNAUTHORIZED',
      );
    }
    if (response.status === 402) {
      throw new HttpError(402, 'Credito DataForSEO esaurito', 'DATAFORSEO_NO_CREDIT');
    }

    const payload = (await response.json()) as DfsEnvelope<T>;

    if (!response.ok || (payload.status_code !== STATUS_OK && payload.status_code !== STATUS_TASK_CREATED)) {
      console.error(
        `[dataforseo] ${path} -> ${payload.status_code} ${payload.status_message}`,
      );
      throw new HttpError(502, `DataForSEO ha risposto con un errore: ${payload.status_message}`);
    }

    return payload;
  }

  // --- Google Shopping: ricerca prodotti ------------------------------------

  /** Crea i task di ricerca prodotto. Max 100 task per chiamata. */
  async postProductsTasks(payloads: ProductsTaskPayload[]): Promise<TaskHandle[]> {
    const res = await this.request<never>('POST', '/v3/merchant/google/products/task_post', payloads);
    return res.tasks.map(toHandle);
  }

  async getProductsResult(taskId: string): Promise<ProductsResult | null> {
    const res = await this.request<ProductsResult>(
      'GET',
      `/v3/merchant/google/products/task_get/advanced/${encodeURIComponent(taskId)}`,
    );
    return firstResult(res);
  }

  async productsTasksReady(): Promise<string[]> {
    return this.tasksReady('/v3/merchant/google/products/tasks_ready');
  }

  // --- Google Shopping: venditori di un prodotto ----------------------------

  /** Crea i task "sellers". Richiede un `product_id` di Google Shopping. */
  async postSellersTasks(payloads: SellersTaskPayload[]): Promise<TaskHandle[]> {
    const res = await this.request<never>('POST', '/v3/merchant/google/sellers/task_post', payloads);
    return res.tasks.map(toHandle);
  }

  async getSellersResult(taskId: string): Promise<SellersResult | null> {
    const res = await this.request<SellersResult>(
      'GET',
      `/v3/merchant/google/sellers/task_get/advanced/${encodeURIComponent(taskId)}`,
    );
    return firstResult(res);
  }

  async sellersTasksReady(): Promise<string[]> {
    return this.tasksReady('/v3/merchant/google/sellers/tasks_ready');
  }

  // --- SERP organico: fallback per EAN/SKU ----------------------------------

  /**
   * Ricerca organica live: e' la fonte prezzi principale.
   *
   * Due motivi pratici rispetto a Google Shopping: e' **sincrona**, quindi i
   * risultati si vedono subito invece di attendere un task; e gli item
   * portano gia' il prezzo mostrato nello snippet, che per gli e-commerce
   * e' quasi sempre presente.
   */
  async organicLive(
    keyword: string,
    locationCode: number,
    languageCode: string,
    depth = 30,
  ): Promise<OrganicResult | null> {
    const res = await this.request<OrganicResult>('POST', '/v3/serp/google/organic/live/advanced', [
      {
        keyword,
        location_code: locationCode,
        language_code: languageCode,
        depth,
        // I risultati e-commerce con prezzo arrivano dalla ricerca desktop.
        device: 'desktop',
        os: 'windows',
      },
    ]);
    return firstResult(res);
  }

  // --- comune ---------------------------------------------------------------

  private async tasksReady(path: string): Promise<string[]> {
    const res = await this.request<{ id?: string }>('GET', path);
    const ids: string[] = [];
    for (const task of res.tasks ?? []) {
      for (const item of task.result ?? []) {
        if (item?.id) ids.push(item.id);
      }
    }
    return ids;
  }
}

function toHandle(task: DfsTask): TaskHandle {
  const created = task.status_code === STATUS_TASK_CREATED || task.status_code === STATUS_OK;
  if (!created) {
    console.error(`[dataforseo] task_post rifiutato: ${task.status_code} ${task.status_message}`);
  }
  return {
    id: created ? task.id : null,
    tag: task.data?.tag as string | undefined,
    statusCode: task.status_code,
    statusMessage: task.status_message,
  };
}

function firstResult<T>(res: DfsEnvelope<T>): T | null {
  const task = res.tasks?.[0];
  if (!task) return null;

  // Il task esiste ma non e' ancora pronto: non e' un errore, si riprova dopo.
  if (task.status_code === STATUS_TASK_IN_QUEUE) return null;

  if (task.status_code !== STATUS_OK) {
    console.error(`[dataforseo] task_get: ${task.status_code} ${task.status_message}`);
    return null;
  }
  return task.result?.[0] ?? null;
}

/** Vero quando un task e' fallito in modo definitivo (inutile ritentare). */
export function isTerminalTaskError(statusCode: number): boolean {
  return statusCode >= 40000 && statusCode !== STATUS_TASK_IN_QUEUE;
}
