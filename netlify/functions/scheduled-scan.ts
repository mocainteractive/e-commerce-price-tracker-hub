/**
 * Netlify Scheduled Function - ogni 10 minuti (vedi netlify.toml).
 *
 * Anche questa funzione ha ~10 secondi, quindi NON prova a fare tutto in
 * un'esecuzione: lavora per un budget di tempo e si ferma. La frequenza alta
 * compensa: in un giorno ci sono 144 esecuzioni.
 *
 * A ogni esecuzione, per ogni cliente con la scansione automatica attiva:
 *   1. raccoglie i task Google Shopping rimasti in sospeso (riserva del
 *      postback);
 *   2. alle 06 UTC, se oggi non e' ancora partita, crea la scansione del
 *      giorno con la fonte scelta nelle impostazioni;
 *   3. per le scansioni SERP aperte: accoda le ricerche che mancano e
 *      raccoglie quelle pronte, con le stesse regole della scansione manuale
 *      (scheda del venditore, AI).
 */
import type { Handler } from '@netlify/functions';
import { supabaseAdmin } from './utils/supabase-admin';
import { loadDataForSeoCredentials, resolveAiCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { collectPendingTasks, enqueueBatch } from './utils/scan-runner';
import { loadScanSettings, type FullScanSettings } from './utils/scan-settings';
import {
  createRun,
  refreshRunStatus,
  type RunRow,
  type RunSource,
} from './utils/scan-processing';
import { accodaRicerche, contaProdottiAccodati, raccogliRicerche } from './utils/serp-tasks';

/** Budget complessivo: sotto il limite della piattaforma, con margine. */
const BUDGET_MS = 8500;
/** Ora UTC in cui parte la scansione del giorno. */
const ORA_AVVIO_UTC = 6;

export const handler: Handler = async () => {
  const startedAt = Date.now();
  const db = supabaseAdmin();
  const timeLeft = () => BUDGET_MS - (Date.now() - startedAt);

  const { data: clients, error } = await db
    .from('pt_settings')
    .select('client_id')
    .eq('auto_scan_enabled', true);

  if (error) {
    console.error('[scheduled] Lettura clienti fallita:', error.message);
    return { statusCode: 500, body: 'errore' };
  }

  const report: Array<Record<string, unknown>> = [];

  for (const row of clients ?? []) {
    if (timeLeft() < 2000) {
      report.push({ skipped: 'budget di tempo esaurito' });
      break;
    }

    const clientId = row.client_id as string;

    try {
      const settings = await loadScanSettings(db, clientId);
      const credentials = await loadDataForSeoCredentials(clientId);
      const dfs = new DataForSeoClient(credentials.login, credentials.password);
      const esito: Record<string, unknown> = { clientId };

      // 1. Chiudi i task Google Shopping rimasti aperti.
      const collected = await collectPendingTasks(db, dfs, clientId, settings);
      if (collected.processed > 0) esito.collected = collected;

      // 2. Scansione del giorno.
      let runs = await loadOpenRuns(db, clientId);
      if (runs.length === 0 && oraDiAvvio() && !(await giaAvviataOggi(db, clientId))) {
        esito.nuovaRun = await avviaScansioneDelGiorno(db, dfs, clientId, settings, timeLeft);
        runs = await loadOpenRuns(db, clientId);
      }

      // 3. Avanza le scansioni SERP aperte.
      for (const run of runs) {
        const source: RunSource = run.search_source ?? 'serp';
        if (source === 'shopping') continue;
        if (timeLeft() < 3000) break;
        esito[`run_${run.id.slice(0, 8)}`] = await avanzaRunSerp(db, dfs, run, settings, timeLeft);
      }

      report.push(esito);
    } catch (err) {
      // Un cliente mal configurato non deve bloccare gli altri.
      console.error(`[scheduled] Cliente ${clientId} saltato:`, (err as Error).message);
      report.push({ clientId, error: (err as Error).message });
    }
  }

  console.info('[scheduled] Esecuzione completata:', JSON.stringify(report));
  return { statusCode: 200, body: JSON.stringify({ clienti: report.length, report }) };
};

function oraDiAvvio(): boolean {
  return new Date().getUTCHours() === ORA_AVVIO_UTC;
}

async function giaAvviataOggi(db: ReturnType<typeof supabaseAdmin>, clientId: string): Promise<boolean> {
  const oggi = new Date();
  oggi.setUTCHours(0, 0, 0, 0);
  const { data } = await db
    .from('pt_scan_runs')
    .select('id')
    .eq('client_id', clientId)
    .eq('triggered_by', 'pianificata')
    .gte('started_at', oggi.toISOString())
    .limit(1);
  return Boolean(data && data.length > 0);
}

async function loadOpenRuns(db: ReturnType<typeof supabaseAdmin>, clientId: string): Promise<RunRow[]> {
  const base = 'id, client_id, status, products_total, products_done, started_at';
  const full = await db
    .from('pt_scan_runs')
    .select(`${base}, search_source`)
    .eq('client_id', clientId)
    .eq('status', 'in_corso')
    .order('started_at', { ascending: true });
  if (!full.error) return (full.data ?? []) as RunRow[];

  const { data } = await db
    .from('pt_scan_runs')
    .select(base)
    .eq('client_id', clientId)
    .eq('status', 'in_corso')
    .order('started_at', { ascending: true });
  return ((data ?? []) as Array<Omit<RunRow, 'search_source'>>).map((r) => ({ ...r, search_source: null }));
}

async function avviaScansioneDelGiorno(
  db: ReturnType<typeof supabaseAdmin>,
  dfs: DataForSeoClient,
  clientId: string,
  settings: FullScanSettings,
  timeLeft: () => number,
): Promise<Record<string, unknown>> {
  const { count } = await db
    .from('pt_products')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('is_active', true);

  const productsTotal = Math.min(count ?? 0, settings.max_products_per_scan);
  if (productsTotal === 0) return { skipped: 'catalogo vuoto' };

  const runId = await createRun(db, {
    clientId,
    triggeredBy: 'pianificata',
    triggeredByUser: null,
    productsTotal,
    searchSource: settings.search_source,
  });

  // Google Shopping: accoda finche' c'e' tempo. Il resto lo riprende
  // l'esecuzione successiva tramite i task in sospeso.
  let tasks = 0;
  let offset = 0;
  if (settings.search_source !== 'serp') {
    while (offset < productsTotal && timeLeft() > 2500) {
      const batch = await enqueueBatch(db, dfs, { clientId, runId, settings, offset });
      if (batch.enqueued === 0) break;
      offset = batch.nextOffset;
      tasks += batch.tasksCreated;
    }
  }

  return { runId, productsTotal, fonte: settings.search_source, accodatiShopping: offset, tasks };
}

/**
 * Fa avanzare una run SERP: accoda le ricerche che mancano, poi raccoglie
 * quelle pronte finche' resta tempo. I task SERP sono quelli in
 * `pt_scan_tasks` con endpoint 'serp'.
 */
async function avanzaRunSerp(
  db: ReturnType<typeof supabaseAdmin>,
  dfs: DataForSeoClient,
  run: RunRow,
  settings: FullScanSettings,
  timeLeft: () => number,
): Promise<Record<string, unknown>> {
  const esito: Record<string, unknown> = {};

  // Accodamento: un lotto per esecuzione basta (50 prodotti ogni 10 minuti).
  const accodati = await contaProdottiAccodati(db, run.id);
  if (accodati < run.products_total && timeLeft() > 3000) {
    const post = await accodaRicerche(db, dfs, {
      clientId: run.client_id,
      runId: run.id,
      settings,
      productsTotal: run.products_total,
      priority: 1,
    });
    esito.accodati = `${post.prossimoOffset}/${run.products_total}`;
  }

  if (timeLeft() < 3500) {
    await refreshRunStatus(db, run.id);
    return esito;
  }

  const ai = settings.ai_match_enabled ? await resolveAiCredentials(run.client_id, null) : null;
  const raccolta = await raccogliRicerche(db, dfs, {
    clientId: run.client_id,
    runId: run.id,
    settings,
    ai,
    deadline: Date.now() + timeLeft() - 500,
  });

  esito.elaborati = raccolta.elaborati;
  esito.offerte = raccolta.offerte;
  esito.cursore = `${raccolta.prodottiFatti}/${run.products_total}`;
  esito.inAttesa = raccolta.inAttesa;
  return esito;
}
