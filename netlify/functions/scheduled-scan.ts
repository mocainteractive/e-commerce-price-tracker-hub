/**
 * Netlify Scheduled Function - ogni giorno alle 06:00 UTC (vedi netlify.toml).
 *
 * Due compiti, in quest'ordine:
 *   1. raccoglie i task rimasti in sospeso dal giorno prima (se il postback
 *      non e' arrivato, i risultati sarebbero persi);
 *   2. avvia una nuova scansione per i clienti con `auto_scan_enabled`.
 *
 * Non ha sessione utente: e' invocata dalla piattaforma. Per questo NON accetta
 * parametri dall'esterno e opera solo sui clienti letti dal database.
 */
import type { Handler } from '@netlify/functions';
import { supabaseAdmin } from './utils/supabase-admin';
import { loadDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { collectPendingTasks, startScan } from './utils/scan-runner';
import { loadScanSettings } from './utils/scan-settings';

export const handler: Handler = async () => {
  const db = supabaseAdmin();

  const { data: clients, error } = await db
    .from('pt_settings')
    .select('client_id, auto_scan_enabled')
    .eq('auto_scan_enabled', true);

  if (error) {
    console.error('[scheduled] Lettura clienti fallita:', error.message);
    return { statusCode: 500, body: 'errore' };
  }

  const report: Array<Record<string, unknown>> = [];

  for (const row of clients ?? []) {
    const clientId = row.client_id as string;

    try {
      const settings = await loadScanSettings(db, clientId);
      const credentials = await loadDataForSeoCredentials(clientId);
      const dfs = new DataForSeoClient(credentials.login, credentials.password);

      // 1. Chiudi quello che e' rimasto aperto.
      const collected = await collectPendingTasks(db, dfs, clientId, settings, { maxTasks: 60 });

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

      const started = await startScan(db, dfs, {
        clientId,
        settings,
        triggeredBy: 'pianificata',
      });

      report.push({ clientId, collected, started });
    } catch (err) {
      // Un cliente mal configurato non deve bloccare gli altri.
      console.error(`[scheduled] Cliente ${clientId} saltato:`, (err as Error).message);
      report.push({ clientId, error: (err as Error).message });
    }
  }

  console.info('[scheduled] Esecuzione completata:', JSON.stringify(report));
  return { statusCode: 200, body: JSON.stringify({ clients: report.length }) };
};
