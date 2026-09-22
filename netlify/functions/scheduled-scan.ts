/**
 * Netlify Scheduled Function - ogni giorno alle 06:00 UTC (vedi netlify.toml).
 *
 * Due compiti, in quest'ordine:
 *   1. raccoglie i task rimasti in sospeso (se il postback non e' arrivato,
 *      i risultati sarebbero persi);
 *   2. avvia una nuova scansione per i clienti con `auto_scan_enabled`.
 *
 * Anche questa funzione ha ~10 secondi, quindi NON prova a fare tutto: lavora
 * per un budget di tempo e si ferma. Quello che resta viene ripreso dal
 * postback di DataForSEO, dall'esecuzione del giorno dopo, o dal pulsante
 * "Raccogli risultati" nella sezione Scansioni.
 */
import type { Handler } from '@netlify/functions';
import { supabaseAdmin } from './utils/supabase-admin';
import { loadDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { collectPendingTasks, enqueueBatch } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';

/** Budget complessivo: sotto il limite della piattaforma, con margine. */
const BUDGET_MS = 8000;

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

      // 1. Chiudi quello che e' rimasto aperto dal giorno prima.
      const collected = await collectPendingTasks(db, dfs, clientId, settings);

      // 2. Nuova scansione solo se non ce n'e' gia' una in corso.
      const { data: running } = await db
        .from('pt_scan_runs')
        .select('id')
        .eq('client_id', clientId)
        .eq('status', 'in_corso')
        .limit(1);

      if (running && running.length > 0) {
        report.push({ clientId, skipped: 'scansione gia in corso', collected });
        continue;
      }

      if (timeLeft() < 3000) {
        report.push({ clientId, collected, skipped: 'nuova scansione rimandata' });
        continue;
      }

      const { count } = await db
        .from('pt_products')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .eq('is_active', true);

      const productsTotal = Math.min(count ?? 0, settings.max_products_per_scan);
      if (productsTotal === 0) {
        report.push({ clientId, collected, skipped: 'catalogo vuoto' });
        continue;
      }

      const { data: run } = await db
        .from('pt_scan_runs')
        .insert({
          client_id: clientId,
          triggered_by: 'pianificata',
          products_total: productsTotal,
          status: 'in_corso',
        })
        .select('id')
        .single();

      if (!run) {
        report.push({ clientId, collected, error: 'creazione run fallita' });
        continue;
      }

      // Accoda finche' c'e' tempo. Il resto lo riprende il giorno dopo.
      let offset = 0;
      let tasks = 0;
      while (offset < productsTotal && timeLeft() > 2500) {
        const batch = await enqueueBatch(db, dfs, {
          clientId,
          runId: run.id as string,
          settings,
          offset,
        });
        if (batch.enqueued === 0) break;
        offset = batch.nextOffset;
        tasks += batch.tasksCreated;
      }

      report.push({ clientId, collected, runId: run.id, accodati: offset, tasks });
    } catch (err) {
      // Un cliente mal configurato non deve bloccare gli altri.
      console.error(`[scheduled] Cliente ${clientId} saltato:`, (err as Error).message);
      report.push({ clientId, error: (err as Error).message });
    }
  }

  console.info('[scheduled] Esecuzione completata:', JSON.stringify(report));
  return { statusCode: 200, body: JSON.stringify({ clienti: report.length }) };
};
