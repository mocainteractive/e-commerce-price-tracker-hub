/**
 * Diagnostica della ricerca su un singolo prodotto.
 *
 * Mostra esattamente cosa succede: la query inviata a Google, i risultati
 * tornati, e per ciascuno il punteggio di somiglianza e il motivo per cui e'
 * stato tenuto o scartato.
 *
 * Esiste perche' "la scansione non ha trovato nulla" non e' una diagnosi.
 * Con un motore di matching serve vedere i numeri: senza, si tira a indovinare
 * quale delle dieci cause possibili sia quella vera.
 */
import { useState } from 'react';
import { CheckCircle2, Search, XCircle } from 'lucide-react';
import { apiPost, ApiError } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { Badge, Card, ErrorBanner, Spinner } from './ui';
import { formatPrice } from '../lib/format';

interface Candidato {
  posizione: number | null;
  dominio: string | null;
  titolo: string;
  url: string | null;
  prezzo: number | null;
  valuta: string | null;
  punteggio: number | null;
  metodo: string | null;
  accettato: boolean;
  motivo: string;
}

interface QueryDiagnostica {
  query: string;
  tipo: 'principale' | 'ean';
  risultatiTotali: number;
  conPrezzo: number;
  candidati: Candidato[];
  errore?: string;
}

interface Risposta {
  diagnostica: {
    titolo: string;
    brand: string | null;
    gtin: string | null;
    mpn: string | null;
    nostroPrezzo: number | null;
    query: QueryDiagnostica[];
    offerteSalvate: number;
    dominiEsclusi: string[];
  };
  impostazioni: { paese: number; lingua: string; sogliaMatch: number };
  salvato: boolean;
}

const METODI: Record<string, string> = {
  gtin: 'Codice EAN',
  mpn: 'Codice produttore',
  google_shopping: 'Google Shopping',
  serp: 'Somiglianza',
  manual: 'Manuale',
};

export function DiagnosticaRicerca({ productId, onSaved }: { productId: string; onSaved: () => void }) {
  const { requestContext, canWrite } = useMoca();
  const [dati, setDati] = useState<Risposta | null>(null);
  const [caricamento, setCaricamento] = useState<'prova' | 'salva' | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  const esegui = async (salva: boolean) => {
    setCaricamento(salva ? 'salva' : 'prova');
    setErrore(null);
    try {
      const risposta = await apiPost<Risposta>(requestContext, 'scan-debug', {
        productId,
        salva,
        cercaAncheEan: true,
      });
      setDati(risposta);
      if (salva) onSaved();
    } catch (err) {
      setErrore(err instanceof ApiError ? err.message : 'Diagnostica non riuscita');
    } finally {
      setCaricamento(null);
    }
  };

  return (
    <Card
      title="Diagnostica della ricerca"
      action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => esegui(false)}
            disabled={caricamento !== null}
            className="moca-btn-secondary text-sm"
          >
            {caricamento === 'prova' ? <Spinner size={14} /> : <Search size={14} />}
            Prova la ricerca
          </button>
          {canWrite && dati && (
            <button
              onClick={() => esegui(true)}
              disabled={caricamento !== null}
              className="moca-btn-primary text-sm"
            >
              Salva le offerte trovate
            </button>
          )}
        </div>
      }
    >
      {errore && <ErrorBanner message={errore} />}

      {!dati && !errore && (
        <p className="text-sm text-moca-gray">
          Esegue la ricerca su questo prodotto senza salvare nulla, e mostra cosa
          torna da Google: la query inviata, i risultati, e per ognuno il punteggio
          di somiglianza con il motivo per cui viene tenuto o scartato.
        </p>
      )}

      {dati && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-4 text-xs text-moca-gray">
            <span>
              Identificativi: {dati.diagnostica.brand ?? 'marca assente'} ·{' '}
              {dati.diagnostica.mpn ? `MPN ${dati.diagnostica.mpn}` : 'MPN assente'} ·{' '}
              {dati.diagnostica.gtin ? `EAN ${dati.diagnostica.gtin}` : 'EAN assente'}
            </span>
            <span>Soglia di accettazione: {(dati.impostazioni.sogliaMatch * 100).toFixed(0)}%</span>
            {dati.salvato && (
              <span className="text-success">
                {dati.diagnostica.offerteSalvate} offerte salvate
              </span>
            )}
          </div>

          {dati.diagnostica.query.map((q, indice) => (
            <div key={indice} className="rounded-xl border border-gray-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-moca-gray">
                    {q.tipo === 'ean' ? 'Ricerca sul codice EAN' : 'Ricerca principale'}
                  </p>
                  <p className="font-mono text-sm text-moca-black break-words">{q.query || '(vuota)'}</p>
                </div>
                <div className="text-xs text-moca-gray tabular-nums shrink-0">
                  {q.risultatiTotali} risultati · {q.conPrezzo} con prezzo ·{' '}
                  {q.candidati.filter((c) => c.accettato).length} accettati
                </div>
              </div>

              {q.errore && <ErrorBanner message={q.errore} />}

              {q.candidati.length > 0 && (
                <ul className="divide-y divide-gray-100">
                  {q.candidati.map((c, i) => (
                    <li key={i} className="py-2.5 flex items-start gap-3">
                      {c.accettato ? (
                        <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
                      ) : (
                        <XCircle size={16} className="text-moca-gray shrink-0 mt-0.5" />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-moca-black">
                            {c.dominio ?? 'dominio ignoto'}
                          </span>
                          {c.posizione !== null && (
                            <span className="text-xs text-moca-gray">posizione {c.posizione}</span>
                          )}
                          {c.prezzo !== null && (
                            <Badge tone="info">{formatPrice(c.prezzo, c.valuta ?? 'EUR')}</Badge>
                          )}
                          {c.punteggio !== null && (
                            <Badge tone={c.accettato ? 'positivo' : 'neutro'}>
                              {(c.punteggio * 100).toFixed(0)}%
                              {c.metodo ? ` · ${METODI[c.metodo] ?? c.metodo}` : ''}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-moca-black line-clamp-1">{c.titolo}</p>
                        <p className="mt-0.5 text-xs text-moca-gray">{c.motivo}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {q.candidati.length === 0 && !q.errore && (
                <p className="text-sm text-moca-gray">Nessun risultato da valutare.</p>
              )}
            </div>
          ))}

          {dati.diagnostica.dominiEsclusi.length > 0 && (
            <p className="text-xs text-moca-gray">
              Domini ignorati perche' tuoi o esclusi a mano:{' '}
              {dati.diagnostica.dominiEsclusi.join(', ')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
