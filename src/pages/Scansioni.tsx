/**
 * Scansioni - avvio, raccolta dei risultati e aggiornamento dei prezzi propri.
 *
 * Tutte e tre le operazioni sono cicli guidati dal browser: ogni chiamata
 * alle Netlify Functions lavora su un lotto e dice quanto resta, il browser
 * ripete finche' non ha finito. Cosi' nessuna singola richiesta si avvicina
 * ai ~10 secondi della piattaforma, e l'utente vede l'avanzamento.
 *
 * Gli endpoint Google Shopping di DataForSEO sono asincroni: "Avvia
 * scansione" accoda le richieste, i risultati arrivano dopo via postback
 * oppure con "Raccogli risultati".
 */
import { AlertTriangle, DownloadCloud, Radar, RefreshCw } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { useJob, verificaAnnullamento } from '../lib/useJob';
import { Badge, Card, EmptyState, ErrorBanner, LoadingBlock } from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import type { ScanRun } from '../lib/types';

interface RunsResponse {
  runs: ScanRun[];
}

const STATUS_TONE: Record<ScanRun['status'], 'neutro' | 'positivo' | 'attenzione' | 'critico' | 'info'> = {
  in_corso: 'info',
  completata: 'positivo',
  parziale: 'attenzione',
  errore: 'critico',
};

const STATUS_LABEL: Record<ScanRun['status'], string> = {
  in_corso: 'In corso',
  completata: 'Completata',
  parziale: 'Parziale',
  errore: 'Errore',
};

/** Tetto sui giri, per non lasciare un ciclo aperto se qualcosa non torna. */
const MAX_GIRI = 400;

export function Scansioni() {
  const { requestContext, canWrite, hasDataForSeo } = useMoca();
  const { data, loading, error, reload } = useApiGet<RunsResponse>('scan-runs', { limit: 20 });
  const { state, run, cancel } = useJob();

  const activeRun = data?.runs.find((r) => r.status === 'in_corso');

  // --- Avvio scansione ------------------------------------------------------
  const avviaScansione = () =>
    run(async (ctx) => {
      ctx.fase('Creazione della scansione…');

      const inizio = await apiPost<{
        runId: string;
        productsTotal: number;
        fonte: 'serp' | 'shopping' | 'entrambe';
        tasksCreated: number;
        nextOffset: number;
        remaining: number;
        cercaAncheEan: boolean;
      }>(requestContext, 'scan-start', {});

      ctx.nota(`Scansione avviata su ${inizio.productsTotal} prodotti`);

      // --- SERP organica: sincrona, i prezzi si salvano subito -------------
      if (inizio.fonte === 'serp') {
        ctx.fase('Ricerca dei prodotti su Google…');
        let offset = 0;
        let offerte = 0;
        let senzaRisultati = 0;

        for (let giro = 0; giro < MAX_GIRI && offset < inizio.productsTotal; giro += 1) {
          verificaAnnullamento(ctx);

          const lotto = await apiPost<{
            analizzati: number;
            offerte: number;
            nextOffset: number;
            remaining: number;
            diagnostiche: Array<{
              titolo: string;
              query: string[];
              risultati: number;
              conPrezzo: number;
              accettati: number;
              offerteSalvate: number;
              errore: string | null;
            }>;
          }>(requestContext, 'scan-serp', {
            runId: inizio.runId,
            offset,
            cercaAncheEan: inizio.cercaAncheEan,
          });

          if (lotto.analizzati === 0) break;

          offset = lotto.nextOffset;
          offerte += lotto.offerte;
          ctx.avanzamento(offset, inizio.productsTotal);

          // Il diario spiega prodotto per prodotto cosa e' successo: e' quello
          // che permette di capire una scansione che non trova nulla.
          for (const d of lotto.diagnostiche) {
            if (d.offerteSalvate === 0) senzaRisultati += 1;
            ctx.nota(
              d.errore
                ? `${d.titolo}: ${d.errore}`
                : `${d.titolo}: ${d.risultati} risultati, ${d.conPrezzo} con prezzo, ${d.accettati} riconosciuti, ${d.offerteSalvate} salvati`,
            );
          }

          if (lotto.remaining === 0) break;
        }

        reload();
        return offerte === 0
          ? `Analizzati ${formatNumber(offset)} prodotti, nessuna offerta trovata. Apri un prodotto e usa "Prova la ricerca" per vedere cosa torna da Google.`
          : `Analizzati ${formatNumber(offset)} prodotti, ${formatNumber(offerte)} offerte salvate${senzaRisultati > 0 ? ` (${formatNumber(senzaRisultati)} senza riscontri)` : ''}.`;
      }

      // --- Google Shopping: asincrono, si accodano i task ------------------
      let offset = inizio.nextOffset;
      let tasks = inizio.tasksCreated;
      ctx.fase('Accodamento delle richieste su DataForSEO…');
      ctx.avanzamento(offset, inizio.productsTotal);

      for (let giro = 0; giro < MAX_GIRI && offset < inizio.productsTotal; giro += 1) {
        verificaAnnullamento(ctx);

        const lotto = await apiPost<{
          enqueued: number;
          tasksCreated: number;
          nextOffset: number;
          remaining: number;
          closed?: boolean;
        }>(requestContext, 'scan-enqueue', { runId: inizio.runId, offset });

        if (lotto.closed || lotto.enqueued === 0) break;

        offset = lotto.nextOffset;
        tasks += lotto.tasksCreated;
        ctx.avanzamento(offset, inizio.productsTotal);
      }

      reload();
      return `Accodati ${formatNumber(offset)} prodotti (${formatNumber(tasks)} richieste). I risultati arrivano entro pochi minuti: usa "Raccogli risultati" se non compaiono da soli.`;
    });

  // --- Raccolta risultati ---------------------------------------------------
  const raccogliRisultati = () =>
    run(async (ctx) => {
      ctx.fase('Raccolta dei risultati da DataForSEO…');

      let elaborati = 0;
      let offerte = 0;
      let restanti: number | null = null;

      for (let giro = 0; giro < MAX_GIRI; giro += 1) {
        verificaAnnullamento(ctx);

        const lotto = await apiPost<{ processed: number; offers: number; stillPending: number }>(
          requestContext,
          'scan-collect',
          { runId: activeRun?.id },
        );

        elaborati += lotto.processed;
        offerte += lotto.offers;

        if (restanti === null) restanti = lotto.stillPending + lotto.processed;
        ctx.avanzamento(elaborati, restanti);

        // Nessun progresso: i task restanti non sono ancora pronti.
        if (lotto.processed === 0) {
          if (lotto.stillPending > 0) {
            ctx.nota(
              `${lotto.stillPending} richieste non sono ancora pronte su DataForSEO: riprova fra qualche minuto.`,
            );
          }
          break;
        }
      }

      reload();
      return elaborati === 0
        ? 'Nessun risultato pronto al momento.'
        : `Elaborate ${formatNumber(elaborati)} richieste, ${formatNumber(offerte)} offerte salvate.`;
    });

  // --- Prezzi dal sito del cliente ------------------------------------------
  const aggiornaPrezzi = () =>
    run(async (ctx) => {
      ctx.fase('Lettura dei prezzi dal tuo sito…');

      const staleBefore = new Date().toISOString();
      let letti = 0;
      let aggiornati = 0;
      let invariati = 0;
      let falliti = 0;
      let totale: number | null = null;

      for (let giro = 0; giro < MAX_GIRI; giro += 1) {
        verificaAnnullamento(ctx);

        const lotto = await apiPost<{
          checked: number;
          updated: number;
          unchanged: number;
          failed: number;
          remaining: number;
        }>(requestContext, 'own-price-refresh', { staleBefore });

        if (lotto.checked === 0) break;

        letti += lotto.checked;
        aggiornati += lotto.updated;
        invariati += lotto.unchanged;
        falliti += lotto.failed;

        if (totale === null) totale = lotto.checked + lotto.remaining;
        ctx.avanzamento(letti, totale);

        if (lotto.remaining === 0) break;
      }

      reload();
      return letti === 0
        ? 'Nessun prodotto con URL da aggiornare.'
        : `${formatNumber(letti)} pagine lette: ${formatNumber(aggiornati)} prezzi aggiornati, ${formatNumber(invariati)} invariati, ${formatNumber(falliti)} non leggibili.`;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-moca-black">Scansioni</h2>
          <p className="text-sm text-moca-gray">
            Ricerca dei tuoi prodotti su Google Shopping e rilevazione dei prezzi dei venditori.
          </p>
        </div>

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button onClick={aggiornaPrezzi} disabled={state.running} className="moca-btn-secondary">
              <RefreshCw size={16} />
              Aggiorna i tuoi prezzi
            </button>

            <button onClick={raccogliRisultati} disabled={state.running} className="moca-btn-secondary">
              <DownloadCloud size={16} />
              Raccogli risultati
            </button>

            <button
              onClick={avviaScansione}
              disabled={state.running || !!activeRun}
              className="moca-btn-primary"
              title={activeRun ? 'Attendi il termine della scansione in corso' : undefined}
            >
              <Radar size={16} />
              Avvia scansione
            </button>
          </div>
        )}
      </div>

      {!hasDataForSeo && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4">
          <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-moca-black">Credenziali DataForSEO non configurate</p>
            <p className="mt-1 text-moca-gray">
              Un amministratore deve impostare <code>DATAFORSEO_LOGIN</code> e{' '}
              <code>DATAFORSEO_PASSWORD</code> fra le configurazioni del cliente su Moca Hub.
              Senza queste credenziali le scansioni non possono partire.
            </p>
          </div>
        </div>
      )}

      <JobProgress state={state} onCancel={cancel} />

      <Card title="Cronologia">
        {loading && <LoadingBlock />}
        {error && <ErrorBanner message={error} onRetry={reload} />}

        {data && !loading && data.runs.length === 0 && (
          <EmptyState
            icon={Radar}
            title="Nessuna scansione eseguita"
            description="Avvia la prima scansione per cercare i tuoi prodotti sugli altri e-commerce e rilevarne i prezzi."
          />
        )}

        {data && !loading && data.runs.length > 0 && (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-moca-gray border-b border-gray-200">
                  <th className="py-3 pr-4 font-semibold">Avvio</th>
                  <th className="py-3 pr-4 font-semibold">Tipo</th>
                  <th className="py-3 pr-4 font-semibold text-right">Prodotti</th>
                  <th className="py-3 pr-4 font-semibold text-right">Offerte trovate</th>
                  <th className="py-3 pr-4 font-semibold text-right">In attesa</th>
                  <th className="py-3 font-semibold">Stato</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((scanRun) => (
                  <tr key={scanRun.id} className="border-b border-gray-100">
                    <td className="py-3 pr-4">
                      <div>{formatDateTime(scanRun.started_at)}</div>
                      <div className="text-xs text-moca-gray">
                        {scanRun.finished_at
                          ? `conclusa ${formatRelative(scanRun.finished_at)}`
                          : 'in esecuzione'}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-moca-gray">
                      {scanRun.triggered_by === 'manuale' ? 'Manuale' : 'Pianificata'}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">
                      {formatNumber(scanRun.products_done)} / {formatNumber(scanRun.products_total)}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums">
                      {formatNumber(scanRun.offers_found)}
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-moca-gray">
                      {formatNumber(scanRun.pendingTasks ?? 0)}
                    </td>
                    <td className="py-3">
                      <Badge tone={STATUS_TONE[scanRun.status]}>{STATUS_LABEL[scanRun.status]}</Badge>
                      {scanRun.error_message && (
                        <p className="mt-1 text-xs text-moca-gray">{scanRun.error_message}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
