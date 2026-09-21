/**
 * Scansioni - avvio manuale, cronologia e raccolta dei risultati.
 *
 * Nota sul flusso: gli endpoint Google Shopping di DataForSEO sono asincroni,
 * quindi "avvia scansione" accoda i task e ritorna subito. I risultati
 * arrivano via postback; il pulsante "Raccogli risultati" forza il recupero
 * quando il postback non e' configurato o non e' arrivato.
 */
import { useState } from 'react';
import { AlertTriangle, DownloadCloud, Radar, RefreshCw } from 'lucide-react';
import { useApiGet } from '../lib/useApi';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Badge, Card, EmptyState, ErrorBanner, LoadingBlock } from '../components/ui';
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

export function Scansioni() {
  const { requestContext, canWrite, hasDataForSeo } = useMoca();
  const { data, loading, error, reload } = useApiGet<RunsResponse>('scan-runs', { limit: 20 });

  const [busy, setBusy] = useState<'start' | 'collect' | 'prices' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (
    kind: 'start' | 'collect' | 'prices',
    path: string,
    body: Record<string, unknown>,
    describe: (result: Record<string, number>) => string,
  ) => {
    setBusy(kind);
    setActionError(null);
    setMessage(null);
    try {
      const result = await apiPost<Record<string, number>>(requestContext, path, body);
      setMessage(describe(result));
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Operazione non riuscita');
    } finally {
      setBusy(null);
    }
  };

  const activeRun = data?.runs.find((r) => r.status === 'in_corso');

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
            <button
              onClick={() =>
                run('prices', 'own-price-refresh', { limit: 20 }, (r) =>
                  `Prezzi rileggi dal tuo sito: ${formatNumber(r.updated)} aggiornati, ${formatNumber(r.unchanged)} invariati, ${formatNumber(r.failed)} non letti.`,
                )
              }
              disabled={busy !== null}
              className="moca-btn-secondary"
            >
              <RefreshCw size={16} className={busy === 'prices' ? 'animate-spin' : ''} />
              Aggiorna i tuoi prezzi
            </button>

            <button
              onClick={() =>
                run('collect', 'scan-collect', { runId: activeRun?.id }, (r) =>
                  `Elaborati ${formatNumber(r.processed)} task, ${formatNumber(r.offers)} offerte salvate. In attesa: ${formatNumber(r.stillPending)}.`,
                )
              }
              disabled={busy !== null}
              className="moca-btn-secondary"
            >
              <DownloadCloud size={16} className={busy === 'collect' ? 'animate-spin' : ''} />
              Raccogli risultati
            </button>

            <button
              onClick={() =>
                run('start', 'scan-start', {}, (r) =>
                  `Scansione avviata su ${formatNumber(r.productsQueued)} prodotti (${formatNumber(r.tasksCreated)} richieste create). I risultati arrivano entro pochi minuti.`,
                )
              }
              disabled={busy !== null || !!activeRun}
              className="moca-btn-primary"
              title={activeRun ? 'Attendi il termine della scansione in corso' : undefined}
            >
              <Radar size={16} className={busy === 'start' ? 'animate-spin' : ''} />
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

      {actionError && <ErrorBanner message={actionError} />}
      {message && (
        <div className="rounded-xl bg-success/10 p-4 text-sm text-moca-black">{message}</div>
      )}

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
