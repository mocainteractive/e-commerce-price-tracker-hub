/**
 * Avanzamento di un'operazione a lotti: fase corrente, barra, diario.
 * Serve a rendere visibile un lavoro che puo' durare minuti.
 */
import { CheckCircle2, X } from 'lucide-react';
import { ErrorBanner, Spinner } from './ui';
import type { JobState } from '../lib/useJob';

export function JobProgress({ state, onCancel }: { state: JobState; onCancel?: () => void }) {
  if (!state.running && !state.error && !state.result) return null;

  const percent =
    state.total && state.total > 0 ? Math.min(Math.round((state.done / state.total) * 100), 100) : null;

  return (
    <div className="space-y-3">
      {state.running && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Spinner size={18} />
              <p className="text-sm font-medium text-moca-black truncate">{state.label}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-sm tabular-nums text-moca-gray">
                {state.total ? `${state.done} / ${state.total}` : state.done > 0 ? `${state.done}` : ''}
                {percent !== null && ` · ${percent}%`}
              </span>
              {onCancel && (
                <button onClick={onCancel} className="moca-btn-secondary !px-3 !py-1.5 text-xs">
                  <X size={14} />
                  Annulla
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full bg-moca-red transition-all ${
                percent === null ? 'animate-pulse w-1/3' : ''
              }`}
              style={percent !== null ? { width: `${percent}%` } : undefined}
            />
          </div>
        </div>
      )}

      {state.error && <ErrorBanner message={state.error} />}

      {state.result && !state.running && (
        <div className="flex items-start gap-3 rounded-xl bg-success/10 p-4">
          <CheckCircle2 size={20} className="text-success shrink-0 mt-0.5" />
          <p className="text-sm text-moca-black">{state.result}</p>
        </div>
      )}

      {state.log.length > 0 && (
        <details className="rounded-xl border border-gray-200 bg-white p-4" open={!!state.error}>
          <summary className="cursor-pointer text-sm font-medium text-moca-black">
            Dettaglio operazione ({state.log.length} passaggi)
          </summary>
          <ul className="mt-3 space-y-1 max-h-56 overflow-y-auto">
            {state.log.map((line, index) => (
              <li key={index} className="text-xs text-moca-gray font-mono">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
