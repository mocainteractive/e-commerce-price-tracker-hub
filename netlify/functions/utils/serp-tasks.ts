/**
 * Ricerche SERP in coda: accodamento e raccolta.
 *
 * Perche' in coda e non live
 * --------------------------
 * La ricerca organica live di DataForSEO impiega spesso 5-8 secondi. Dentro
 * una Netlify Function da 10 secondi, tolte le letture sul database,
 * restavano 4-5 secondi e meta' delle ricerche andava in timeout. Con la
 * coda (task_post -> tasks_ready -> task_get):
 *
 *   * accodare e' immediato: 100 ricerche per chiamata;
 *   * i risultati arrivano in uno o due minuti (priorita' alta) e restano
 *     disponibili per 30 giorni: nessun timeout puo' perderli;
 *   * la raccolta legge risultati gia' pronti e spende il tempo della
 *     funzione dove serve, cioe' matching, prezzo dalla scheda e AI;
 *   * costa meno della live.
 *
 * I task SERP stanno in `pt_scan_tasks` con endpoint 'serp' e `query_type`
 * (principale o ean), accanto ai task Google Shopping. Un prodotto e'
 * "fatto" quando nessuno dei suoi task e' piu' in attesa.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataForSeoClient, OrganicItem, SerpTaskPayload } from './dataforseo';
import { HttpError } from './http';
import type { AiCredentials } from './client-config';
import type { FullScanSettings } from './scan-settings';
import {
  addOffersFound,
  buildPostbackUrl,
  refreshRunStatus,
  type ProductRow,
} from './scan-processing';
import {
  caricaContestoDomini,
  caricaEsclusiProdotto,
  costruisciRicerche,
  riassumi,
  scansionaProdotto,
  soggettoDi,
  type Ricerca,
  type SerpScanOptions,
} from './serp-scan';

/** Prodotti accodati per chiamata: con la passata EAN sono 100 task, il massimo di DataForSEO. */
export const PRODOTTI_PER_ACCODAMENTO = 50;

const COLONNE_PRODOTTO =
  'id, client_id, sku, gtin, mpn, brand, title, own_price, currency, google_product_id';

const MIGRATION_0004 =
  'La tabella dei task non accetta ancora le ricerche SERP in coda: esegui supabase/migrations/0004_serp_in_coda.sql.';

interface TaskSerpRow {
  id: string;
  product_id: string;
  dfs_task_id: string;
  query_type: 'principale' | 'ean' | null;
  query: string | null;
}

// -----------------------------------------------------------------------------
// Accodamento
// -----------------------------------------------------------------------------

/** Quanti prodotti della run hanno gia' almeno un task SERP (o uno scarto). */
export async function contaProdottiAccodati(db: SupabaseClient, runId: string): Promise<number> {
  const { data, error } = await db
    .from('pt_scan_tasks')
    .select('product_id')
    .eq('run_id', runId)
    .eq('endpoint', 'serp');
  if (error) return 0;
  return new Set((data ?? []).map((t) => t.product_id as string)).size;
}

export interface EsitoAccodamento {
  accodati: number;
  taskCreati: number;
  /** Prodotti della run con ricerche accodate, dopo questa chiamata. */
  prossimoOffset: number;
}

/**
 * Accoda le ricerche del prossimo lotto di prodotti. Idempotente: il punto di
 * partenza e' quanti prodotti hanno gia' task, letto dal database, cosi' una
 * ripresa dopo un browser chiuso non duplica nulla.
 */
export async function accodaRicerche(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: {
    clientId: string;
    runId: string;
    settings: FullScanSettings;
    productsTotal: number;
    /** 2 = priorita' alta (scansione manuale), 1 = coda normale (pianificata). */
    priority: 1 | 2;
  },
): Promise<EsitoAccodamento> {
  const offset = await contaProdottiAccodati(db, input.runId);
  if (offset >= input.productsTotal) return { accodati: 0, taskCreati: 0, prossimoOffset: offset };

  const quanti = Math.min(PRODOTTI_PER_ACCODAMENTO, input.productsTotal - offset);
  const { data, error } = await db
    .from('pt_products')
    .select(COLONNE_PRODOTTO)
    .eq('client_id', input.clientId)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .range(offset, offset + quanti - 1);

  if (error) throw new HttpError(500, `Impossibile leggere il catalogo: ${error.message}`);

  const products = (data ?? []) as ProductRow[];
  if (products.length === 0) return { accodati: 0, taskCreati: 0, prossimoOffset: offset };

  const now = new Date().toISOString();
  const payloads: SerpTaskPayload[] = [];
  const attesi: Array<{ product: ProductRow; ricerca: Ricerca }> = [];
  const righe: Array<Record<string, unknown>> = [];

  for (const product of products) {
    const ricerche = costruisciRicerche(soggettoDi(product), input.settings.search_gtin_pass);

    if (ricerche.length === 0) {
      // Niente da cercare: si registra uno scarto, cosi' il prodotto conta
      // come fatto e la run puo' chiudersi.
      righe.push({
        client_id: input.clientId,
        run_id: input.runId,
        product_id: product.id,
        dfs_task_id: `scarto:${input.runId}:${product.id}`,
        endpoint: 'serp',
        query_type: 'principale',
        query: '',
        status: 'errore',
        error_message: 'Prodotto senza titolo, marca o codice: impossibile costruire una ricerca',
        completed_at: now,
      });
      continue;
    }

    for (const ricerca of ricerche) {
      attesi.push({ product, ricerca });
      payloads.push({
        keyword: ricerca.query,
        location_code: input.settings.location_code,
        language_code: input.settings.language_code,
        depth: 30,
        priority: input.priority,
        tag: `${input.runId}:${product.id}:${ricerca.tipo}`,
        postback_url: buildPostbackUrl('serp'),
        postback_data: 'advanced',
      });
    }
  }

  let taskCreati = 0;
  if (payloads.length > 0) {
    const handles = await dfs.postSerpTasks(payloads);
    // DataForSEO restituisce i task nello stesso ordine in cui li abbiamo inviati.
    attesi.forEach(({ product, ricerca }, index) => {
      const handle = handles[index];
      if (handle?.id) {
        taskCreati += 1;
        righe.push({
          client_id: input.clientId,
          run_id: input.runId,
          product_id: product.id,
          dfs_task_id: handle.id,
          endpoint: 'serp',
          query_type: ricerca.tipo,
          query: ricerca.query,
        });
      } else {
        righe.push({
          client_id: input.clientId,
          run_id: input.runId,
          product_id: product.id,
          dfs_task_id: `rifiutato:${input.runId}:${product.id}:${ricerca.tipo}`,
          endpoint: 'serp',
          query_type: ricerca.tipo,
          query: ricerca.query,
          status: 'errore',
          error_message: `DataForSEO ha rifiutato la ricerca: ${handle?.statusMessage ?? 'nessuna risposta'}`,
          completed_at: now,
        });
      }
    });

    if (taskCreati === 0) {
      // Un lotto rifiutato per intero indica un problema di credenziali o di
      // credito: meglio fermarsi subito che accodare a vuoto tutto il catalogo.
      await db
        .from('pt_scan_runs')
        .update({ status: 'errore', error_message: 'DataForSEO non ha accettato le ricerche', finished_at: now })
        .eq('id', input.runId);
      throw new HttpError(
        502,
        `DataForSEO non ha accettato alcuna ricerca (${handles[0]?.statusMessage ?? 'nessuna risposta'}). Verifica credenziali e credito residuo.`,
        'DATAFORSEO_REJECTED',
      );
    }
  }

  const { error: insertError } = await db.from('pt_scan_tasks').upsert(righe, { onConflict: 'dfs_task_id' });
  if (insertError) {
    console.error('[serp] Salvataggio task fallito:', insertError.message);
    if (/endpoint|query_type|query/.test(insertError.message)) throw new HttpError(500, MIGRATION_0004, 'MIGRATION_MISSING');
    throw new HttpError(500, `Salvataggio delle ricerche non riuscito: ${insertError.message}`);
  }

  return { accodati: products.length, taskCreati, prossimoOffset: offset + products.length };
}

// -----------------------------------------------------------------------------
// Raccolta
// -----------------------------------------------------------------------------

export interface EsitoRaccolta {
  /** Prodotti elaborati in questa chiamata. */
  elaborati: number;
  offerte: number;
  /** Task SERP della run ancora in attesa dopo questa chiamata. */
  inAttesa: number;
  /** Prodotti della run con tutte le ricerche concluse. */
  prodottiFatti: number;
  diagnostiche: ReturnType<typeof riassumi>[];
}

/**
 * Raccoglie i risultati pronti e li elabora, prodotto per prodotto, finche'
 * c'e' tempo. Le ricerche non ancora pronte restano in attesa: il chiamante
 * riprova dopo qualche secondo.
 */
export async function raccogliRicerche(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  input: {
    clientId: string;
    runId: string;
    settings: FullScanSettings;
    ai: AiCredentials | null;
    /** Istante entro cui bisogna aver finito. */
    deadline: number;
    /** Solo questi prodotti (postback). */
    productIds?: string[];
  },
): Promise<EsitoRaccolta> {
  const tempoResiduo = () => input.deadline - Date.now();

  let query = db
    .from('pt_scan_tasks')
    .select('id, product_id, dfs_task_id, query_type, query')
    .eq('run_id', input.runId)
    .eq('endpoint', 'serp')
    .eq('status', 'in_attesa')
    .order('created_at', { ascending: true })
    .limit(80);
  if (input.productIds?.length) query = query.in('product_id', input.productIds);

  const { data: pendingRows, error } = await query;
  if (error) {
    if (/endpoint|query_type/.test(error.message)) throw new HttpError(500, MIGRATION_0004, 'MIGRATION_MISSING');
    throw new HttpError(500, `Lettura delle ricerche non riuscita: ${error.message}`);
  }

  const pending = (pendingRows ?? []) as TaskSerpRow[];
  const esito: EsitoRaccolta = { elaborati: 0, offerte: 0, inAttesa: 0, prodottiFatti: 0, diagnostiche: [] };

  if (pending.length > 0) {
    // Ordine di arrivo: DataForSEO elenca i task pronti non ancora letti. Se
    // la lista e' vuota (postback gia' passato, o servizio indisponibile) si
    // prova comunque il task_get: un task in coda risponde "in coda" senza costo.
    let ready: Set<string>;
    try {
      ready = new Set(await dfs.serpTasksReady());
    } catch (err) {
      console.warn('[serp] tasks_ready non disponibile:', (err as Error).message);
      ready = new Set();
    }

    const perProdotto = new Map<string, TaskSerpRow[]>();
    for (const task of pending) {
      const list = perProdotto.get(task.product_id) ?? [];
      list.push(task);
      perProdotto.set(task.product_id, list);
    }

    // Prima i prodotti con tutti i task gia' pronti.
    const gruppi = [...perProdotto.entries()].sort(([, a], [, b]) => {
      const prontiA = a.every((t) => ready.has(t.dfs_task_id)) ? 0 : 1;
      const prontiB = b.every((t) => ready.has(t.dfs_task_id)) ? 0 : 1;
      return prontiA - prontiB;
    });

    const contesto = await caricaContestoDomini(db, input.clientId);

    for (const [productId, tasks] of gruppi) {
      if (tempoResiduo() < 3500) break;
      if (ready.size > 0 && !tasks.some((t) => ready.has(t.dfs_task_id))) continue;

      const risultati: NonNullable<SerpScanOptions['risultati']> = {};
      const esitiTask: Array<{ task: TaskSerpRow; stato: 'completato' | 'errore'; messaggio?: string }> = [];
      let inCoda = false;

      for (const task of tasks) {
        const tipo = task.query_type ?? 'principale';
        try {
          const outcome = await dfs.fetchSerpTask(task.dfs_task_id);
          if (outcome.state === 'in_coda') {
            inCoda = true;
          } else if (outcome.state === 'pronto') {
            risultati[tipo] = outcome.items as OrganicItem[];
            esitiTask.push({ task, stato: 'completato' });
          } else {
            risultati[tipo] = { errore: `DataForSEO: ${outcome.message}` };
            esitiTask.push({ task, stato: 'errore', messaggio: outcome.message });
          }
        } catch (err) {
          // Rete o timeout verso DataForSEO: il task resta in attesa, si riprova.
          console.warn(`[serp] task ${task.dfs_task_id} non letto: ${(err as Error).message}`);
          inCoda = true;
        }
      }

      // Si elabora solo quando TUTTE le ricerche del prodotto sono arrivate,
      // per salvare le offerte una volta sola con il quadro completo.
      if (inCoda) continue;

      const { data: productRow } = await db
        .from('pt_products')
        .select(COLONNE_PRODOTTO)
        .eq('id', productId)
        .maybeSingle();

      const product = productRow as ProductRow | null;
      if (!product) {
        await segnaTask(db, tasks.map((t) => t.id), 'errore', 'Prodotto non piu\' presente in catalogo');
        continue;
      }

      const esclusi = await caricaEsclusiProdotto(db, productId);
      const diagnostica = await scansionaProdotto(
        db,
        dfs,
        product,
        input.settings,
        { ownDomains: contesto.ownDomains, excludedDomains: esclusi },
        {
          runId: input.runId,
          cercaAncheEan: input.settings.search_gtin_pass,
          deadline: input.deadline,
          ai: input.ai,
          pagePrices: input.settings.serp_page_prices,
          risultati,
        },
      );

      for (const e of esitiTask) await segnaTask(db, [e.task.id], e.stato, e.messaggio);

      esito.elaborati += 1;
      esito.offerte += diagnostica.offerteSalvate;
      esito.diagnostiche.push(riassumi(diagnostica));
    }
  }

  // Stato della run: prodotti fatti e task ancora in attesa.
  const { data: tuttiTask } = await db
    .from('pt_scan_tasks')
    .select('product_id, status')
    .eq('run_id', input.runId)
    .eq('endpoint', 'serp');

  const statoPerProdotto = new Map<string, boolean>();
  let inAttesa = 0;
  for (const t of tuttiTask ?? []) {
    const pid = t.product_id as string;
    const pendente = t.status === 'in_attesa';
    if (pendente) inAttesa += 1;
    statoPerProdotto.set(pid, (statoPerProdotto.get(pid) ?? true) && !pendente);
  }
  esito.inAttesa = inAttesa;
  esito.prodottiFatti = [...statoPerProdotto.values()].filter(Boolean).length;

  await db.from('pt_scan_runs').update({ products_done: esito.prodottiFatti }).eq('id', input.runId);
  await addOffersFound(db, input.runId, esito.offerte);
  await refreshRunStatus(db, input.runId);

  return esito;
}

async function segnaTask(
  db: SupabaseClient,
  ids: string[],
  status: 'completato' | 'errore',
  errorMessage?: string,
): Promise<void> {
  await db
    .from('pt_scan_tasks')
    .update({ status, error_message: errorMessage ?? null, completed_at: new Date().toISOString() })
    .in('id', ids);
}
