/**
 * Esecuzione di operazioni lunghe orchestrate dal browser.
 *
 * Le Netlify Functions hanno ~10 secondi; un import o una scansione ne
 * richiedono molti di piu'. La soluzione non e' chiedere piu' tempo alla
 * piattaforma, ma spezzare il lavoro: ogni chiamata fa un lotto e il browser,
 * che tempo ne ha, scorre finche' non ha finito.
 *
 * Questo hook tiene lo stato di quel ciclo: fase corrente, avanzamento,
 * diario di quello che e' successo, annullamento.
 */
import { useCallback, useRef, useState } from 'react';
import { ApiError } from './api';

export interface JobContext {
  /** Cambia l'etichetta della fase corrente. */
  fase: (label: string) => void;
  /** Aggiorna la barra di avanzamento. `total` null = indeterminato. */
  avanzamento: (done: number, total: number | null) => void;
  /** Aggiunge una riga al diario mostrato all'utente. */
  nota: (line: string) => void;
  /** True se l'utente ha annullato: da controllare a ogni giro. */
  annullato: () => boolean;
}

export interface JobState {
  running: boolean;
  label: string;
  done: number;
  total: number | null;
  log: string[];
  error: string | null;
  result: string | null;
}

const STATO_INIZIALE: JobState = {
  running: false,
  label: '',
  done: 0,
  total: null,
  log: [],
  error: null,
  result: null,
};

export class JobAnnullato extends Error {
  constructor() {
    super('Operazione annullata');
    this.name = 'JobAnnullato';
  }
}

export function useJob() {
  const [state, setState] = useState<JobState>(STATO_INIZIALE);
  const cancelled = useRef(false);
  const running = useRef(false);

  const run = useCallback(async (fn: (ctx: JobContext) => Promise<string>) => {
    if (running.current) return; // niente doppi avvii
    running.current = true;
    cancelled.current = false;

    setState({ ...STATO_INIZIALE, running: true, label: 'Avvio…' });

    const ctx: JobContext = {
      fase: (label) => setState((s) => ({ ...s, label })),
      avanzamento: (done, total) => setState((s) => ({ ...s, done, total })),
      nota: (line) => setState((s) => ({ ...s, log: [...s.log, line] })),
      annullato: () => cancelled.current,
    };

    try {
      const result = await fn(ctx);
      setState((s) => ({ ...s, running: false, label: '', result }));
    } catch (err) {
      const message =
        err instanceof JobAnnullato
          ? 'Operazione annullata.'
          : err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Errore imprevisto';
      setState((s) => ({ ...s, running: false, label: '', error: message }));
    } finally {
      running.current = false;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  const reset = useCallback(() => setState(STATO_INIZIALE), []);

  return { state, run, cancel, reset };
}

/** Interrompe il ciclo se l'utente ha premuto Annulla. */
export function verificaAnnullamento(ctx: JobContext): void {
  if (ctx.annullato()) throw new JobAnnullato();
}

/** Divide un elenco in lotti della dimensione indicata. */
export function aLotti<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
