/**
 * Hook di lettura per le Netlify Functions dell'app.
 * Gestisce stato di caricamento, errore e ricarica, e ignora le risposte
 * di richieste ormai superate (l'utente puo' cambiare filtro rapidamente).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, ApiError } from './api';
import { useMoca } from './MocaProvider';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useApiGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): ApiState<T> {
  const { token } = useMoca();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Serializzato: evita di rieseguire l'effetto a ogni render per un oggetto
  // nuovo ma identico nel contenuto.
  const paramsKey = JSON.stringify(params);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const result = await apiGet<T>(token, path, JSON.parse(paramsKey));
      if (currentRequest === requestId.current) setData(result);
    } catch (err) {
      if (currentRequest !== requestId.current) return;
      setError(err instanceof ApiError ? err.message : 'Errore di rete');
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [token, path, paramsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}
