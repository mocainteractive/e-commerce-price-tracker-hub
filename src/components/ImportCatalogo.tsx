/**
 * Import del catalogo, orchestrato dal browser.
 *
 * Strategia, in ordine di preferenza:
 *   1. **File locale** (CSV o XML): letto e interpretato nel browser. Nessuna
 *      rete, nessun limite di tempo ne' di righe, funziona anche con feed che
 *      il server non riesce a scaricare (24 MB generati in 90 secondi si
 *      leggono qui in due).
 *   2. **URL scaricata dal browser**: se la sorgente espone CORS, il download
 *      avviene qui, senza passare dalle funzioni e senza limiti di durata.
 *   3. **URL via proxy** (`/api/fetch-source`): solo se il browser non puo'
 *      per via del CORS. E' l'unico passaggio vincolato ai ~10 secondi, e ha
 *      un tetto di righe: quando scatta viene detto, mai in silenzio.
 *
 * Il salvataggio e' sempre a lotti da 200 righe verso `/api/catalog-save`,
 * cosi' nessuna singola chiamata rischia il timeout, qualunque sia la
 * dimensione del catalogo.
 */
import { useState } from 'react';
import { Download, FileUp, Link2, Upload } from 'lucide-react';
import { apiPost } from '../lib/api';
import { useMoca } from '../lib/MocaProvider';
import { aLotti, useJob, verificaAnnullamento, type JobContext } from '../lib/useJob';
import { Card } from './ui';
import { JobProgress } from './JobProgress';
import {
  importFromCsv,
  parseFeedXml,
  parseSitemapXml,
  type CatalogRow,
} from '../../netlify/functions/utils/feed';
import { filtraUrlProdotto } from '../../netlify/functions/utils/sitemap-filter';

/** Allineato a MAX_ROWS_PER_BATCH della funzione. */
const RIGHE_PER_LOTTO = 200;
/** Allineato a MAX_URLS_PER_CALL della funzione. */
const URL_PER_CHIAMATA = 5;
/** Pagine lette per ogni giro di import da sitemap: e' il percorso piu' lento. */
const PAGINE_PER_GIRO = 500;
/** URL raccolte dagli indici di sitemap: leggerle e' economico, filtrarle serve. */
const MAX_URL_RACCOLTE = 50000;

type Sorgente = 'feed' | 'sitemap' | 'file';
type Contesto = ReturnType<typeof useMoca>['requestContext'];

export function ImportCatalogo({ onDone }: { onDone: () => void }) {
  const { requestContext } = useMoca();
  const { state, run, cancel, reset } = useJob();

  const [sorgente, setSorgente] = useState<Sorgente>('feed');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sostituisci, setSostituisci] = useState(false);
  const [includi, setIncludi] = useState('');
  const [escludi, setEscludi] = useState('');
  /** Da quale pagina riprendere l'import da sitemap: si avanza a ogni giro. */
  const [ripresa, setRipresa] = useState<{ url: string; offset: number; totale: number } | null>(null);

  const regoleInclude = includi.split(',').map((p) => p.trim()).filter(Boolean);
  const regoleEscludi = escludi.split(',').map((p) => p.trim()).filter(Boolean);

  const offsetSitemap = ripresa && ripresa.url === url.trim() ? ripresa.offset : 0;

  const avvia = () =>
    run(async (ctx) => {
      // L'istante di inizio lo fornisce il server: `updated_at` lo scrive il
      // database, e l'orologio del browser potrebbe essere avanti.
      let iniziatoAlle: string | null = null;
      if (sostituisci) {
        const inizio = await apiPost<{ startedAt: string }>(requestContext, 'catalog-finalize', { begin: true });
        iniziatoAlle = inizio.startedAt;
      }

      let righe: CatalogRow[];
      let seguito: string | null = null;

      if (sorgente === 'file') {
        righe = await daFile(file, ctx);
      } else if (sorgente === 'sitemap') {
        const esito = await daSitemap(url.trim(), requestContext, ctx, regoleInclude, regoleEscludi, offsetSitemap);
        righe = esito.righe;
        if (esito.prossimoOffset < esito.totale) {
          setRipresa({ url: url.trim(), offset: esito.prossimoOffset, totale: esito.totale });
          seguito = `Lette ${esito.prossimoOffset} pagine su ${esito.totale}: premi di nuovo Avvia import per proseguire con le successive.`;
        } else {
          setRipresa(null);
        }
        if (sostituisci && esito.prossimoOffset < esito.totale) {
          throw new Error(
            'Con "Disattiva i prodotti non presenti" l\'import da sitemap deve leggere tutte le pagine in un giro: togli la spunta oppure restringi la sitemap con le regole.',
          );
        }
      } else {
        righe = await daFeed(url.trim(), requestContext, ctx, sostituisci);
      }

      if (righe.length === 0) {
        throw new Error('Nessun prodotto valido trovato nella sorgente indicata');
      }

      const esito = await salva(righe, requestContext, ctx);

      let disattivati = 0;
      if (sostituisci && iniziatoAlle) {
        disattivati = await finalizza(iniziatoAlle, requestContext, ctx);
      }

      onDone();

      return [
        `${esito.salvati} prodotti importati`,
        `${esito.conGtin} con codice EAN`,
        esito.senzaPrezzo > 0 ? `${esito.senzaPrezzo} senza prezzo` : null,
        disattivati > 0 ? `${disattivati} disattivati perche' non piu' nel catalogo` : null,
        seguito,
      ]
        .filter(Boolean)
        .join(' · ');
    });

  const pronto =
    (sorgente === 'file' && file !== null) || (sorgente !== 'file' && url.trim().length > 0);

  return (
    <Card title="Importa il catalogo">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {[
            { value: 'feed' as const, label: 'Feed Google Merchant', icon: Link2 },
            { value: 'sitemap' as const, label: 'Sitemap del sito', icon: Link2 },
            { value: 'file' as const, label: 'File CSV o XML', icon: FileUp },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setSorgente(option.value);
                reset();
              }}
              disabled={state.running}
              className={`px-3 py-1.5 text-sm rounded-md border transition-colors inline-flex items-center gap-2 ${
                sorgente === option.value
                  ? 'bg-moca-red-light text-moca-red border-moca-red'
                  : 'text-moca-black border-gray-300 hover:bg-gray-100'
              }`}
            >
              <option.icon size={14} />
              {option.label}
            </button>
          ))}
        </div>

        {sorgente === 'file' ? (
          <div>
            <label className="moca-label" htmlFor="file-catalogo">
              File del catalogo
            </label>
            <input
              id="file-catalogo"
              type="file"
              accept=".csv,.xml,.txt,text/csv,text/xml,application/xml"
              disabled={state.running}
              className="moca-input"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-xs text-moca-gray">
              CSV (colonne: titolo, sku, ean, mpn, marca, prezzo, url, immagine) oppure
              feed XML salvato dal browser. Il file viene letto qui, senza passare dal
              server e senza limiti di righe: e' la via giusta per i feed grandi o
              generati al volo.
            </p>
          </div>
        ) : (
          <div>
            <label className="moca-label" htmlFor="url-sorgente">
              {sorgente === 'feed' ? 'URL del feed' : 'URL della sitemap'}
            </label>
            <input
              id="url-sorgente"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={state.running}
              placeholder={
                sorgente === 'feed'
                  ? 'https://www.esempio.it/feed-google-shopping.xml'
                  : 'https://www.esempio.it/sitemap-prodotti.xml'
              }
              className="moca-input"
            />
            <p className="mt-1 text-xs text-moca-gray">
              {sorgente === 'feed'
                ? 'Il browser prova a scaricarlo direttamente; se la sorgente non lo consente, passa dal server, che ha 10 secondi e un tetto di righe. Per i feed grandi usa il file.'
                : `Le pagine prodotto vengono lette a gruppi di ${URL_PER_CHIAMATA} per estrarne i dati strutturati. E' il metodo piu' lento: ${PAGINE_PER_GIRO} pagine per giro, riprendendo dalle successive al giro dopo.`}
            </p>
            {sorgente === 'sitemap' && offsetSitemap > 0 && ripresa && (
              <p className="mt-1 text-xs text-moca-black">
                Prossimo giro: dalla pagina {offsetSitemap + 1} di {ripresa.totale}.{' '}
                <button type="button" className="text-moca-red hover:underline" onClick={() => setRipresa(null)}>
                  Ricomincia dall'inizio
                </button>
              </p>
            )}
          </div>
        )}

        {sorgente === 'sitemap' && (
          <div className="grid gap-4 sm:grid-cols-2 rounded-xl bg-moca-bg p-4">
            <div>
              <label className="moca-label" htmlFor="sitemap-includi">
                Tieni solo le URL che contengono
              </label>
              <input
                id="sitemap-includi"
                type="text"
                value={includi}
                onChange={(event) => setIncludi(event.target.value)}
                disabled={state.running}
                placeholder="/products/, /prodotto/"
                className="moca-input"
              />
              <p className="mt-1 text-xs text-moca-gray">
                Separa con la virgola. Lasciando vuoto, le schede prodotto vengono
                riconosciute in automatico e si escludono blog, categorie, carrello
                e pagine informative.
              </p>
            </div>

            <div>
              <label className="moca-label" htmlFor="sitemap-escludi">
                Escludi anche le URL che contengono
              </label>
              <input
                id="sitemap-escludi"
                type="text"
                value={escludi}
                onChange={(event) => setEscludi(event.target.value)}
                disabled={state.running}
                placeholder="/outlet/, /usato/"
                className="moca-input"
              />
              <p className="mt-1 text-xs text-moca-gray">
                Si somma alle esclusioni automatiche.
              </p>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-moca-black">
          <input
            type="checkbox"
            checked={sostituisci}
            onChange={(event) => setSostituisci(event.target.checked)}
            disabled={state.running}
            className="rounded border-gray-300 text-moca-red focus:ring-moca-red"
          />
          Disattiva i prodotti non presenti in questo import
        </label>

        <JobProgress state={state} onCancel={cancel} />

        <div className="flex items-center gap-3">
          <button onClick={avvia} disabled={state.running || !pronto} className="moca-btn-primary">
            {state.running ? <Download size={16} className="animate-pulse" /> : <Upload size={16} />}
            {state.running ? 'Import in corso…' : offsetSitemap > 0 ? 'Prosegui import' : 'Avvia import'}
          </button>
        </div>
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Sorgenti
// -----------------------------------------------------------------------------

async function daFile(file: File | null, ctx: JobContext): Promise<CatalogRow[]> {
  if (!file) throw new Error('Nessun file selezionato');

  ctx.fase(`Lettura di ${file.name}…`);
  const testo = await file.text();
  ctx.nota(`File letto: ${(file.size / 1024).toFixed(0)} KB`);

  const sembraXml = testo.trimStart().startsWith('<');
  const avvio = Date.now();
  const righe = sembraXml ? parseFeedXml(testo) : importFromCsv(testo);

  ctx.nota(`${righe.length} prodotti interpretati dal ${sembraXml ? 'feed XML' : 'CSV'} in ${Date.now() - avvio} ms`);
  return righe;
}

async function daFeed(
  url: string,
  requestContext: Contesto,
  ctx: JobContext,
  sostituisci: boolean,
): Promise<CatalogRow[]> {
  ctx.fase('Scaricamento del feed…');

  // 1. Tentativo diretto dal browser: se la sorgente espone CORS non ci sono
  //    limiti di tempo ne' di dimensione.
  const diretto = await scaricaDalBrowser(url, ctx);
  if (diretto !== null) {
    const righe = parseFeedXml(diretto);
    ctx.nota(`${righe.length} prodotti interpretati`);
    return righe;
  }

  // 2. Fallback sul proxy: e' l'unico passaggio con il limite dei 10 secondi.
  ctx.fase('Scaricamento tramite il server…');
  const risposta = await apiPost<{ rows: CatalogRow[]; total: number; truncated: boolean; elapsedMs: number }>(
    requestContext,
    'fetch-source',
    { url, kind: 'feed' },
  );
  ctx.nota(`Server: ${risposta.rows.length} prodotti in ${risposta.elapsedMs} ms`);

  if (risposta.truncated) {
    const avviso = `Il feed contiene ${risposta.total} prodotti ma il server puo' trasferirne al massimo ${risposta.rows.length}. Per il catalogo completo salva il feed in un file e caricalo con "File CSV o XML".`;
    // Con l'import sostitutivo un catalogo parziale disattiverebbe tutto il resto.
    if (sostituisci) throw new Error(avviso);
    ctx.nota(`ATTENZIONE: ${avviso}`);
  }
  return risposta.rows;
}

async function daSitemap(
  url: string,
  requestContext: Contesto,
  ctx: JobContext,
  regoleInclude: string[],
  regoleEscludi: string[],
  offset: number,
): Promise<{ righe: CatalogRow[]; prossimoOffset: number; totale: number }> {
  ctx.fase('Lettura della sitemap…');

  const urls = await raccogliUrlSitemap(url, requestContext, ctx);
  if (urls.length === 0) throw new Error('Nessuna URL di pagina trovata nella sitemap');

  // Una sitemap contiene anche categorie, blog e pagine statiche: leggerle
  // tutte sprecherebbe la parte piu' lenta dell'import.
  const filtrate = filtraUrlProdotto(urls, { include: regoleInclude, exclude: regoleEscludi });

  ctx.nota(
    `${urls.length} URL nella sitemap, ${filtrate.urls.length} sembrano schede prodotto ` +
      `(${filtrate.scartate.perEsclusione} sezioni escluse, ${filtrate.scartate.perNonProdotto} non riconosciute, ` +
      `${filtrate.scartate.perEstensione} file, ${filtrate.scartate.perDuplicato} duplicate)`,
  );

  if (filtrate.urls.length === 0) {
    throw new Error(
      'Nessuna pagina prodotto riconosciuta nella sitemap. Indica un frammento di URL nelle regole (per esempio /products/) e riprova.',
    );
  }

  const inizio = Math.min(offset, filtrate.urls.length);
  const daLeggere = filtrate.urls.slice(inizio, inizio + PAGINE_PER_GIRO);
  if (inizio > 0) ctx.nota(`Riprendo dalla pagina ${inizio + 1}`);
  if (inizio + daLeggere.length < filtrate.urls.length) {
    ctx.nota(`${PAGINE_PER_GIRO} pagine per giro: le restanti ${filtrate.urls.length - inizio - daLeggere.length} al giro successivo`);
  }

  const righe: CatalogRow[] = [];
  const gruppi = aLotti(daLeggere, URL_PER_CHIAMATA);
  let lette = 0;

  ctx.fase('Lettura delle pagine prodotto…');
  ctx.avanzamento(0, daLeggere.length);

  for (const gruppo of gruppi) {
    verificaAnnullamento(ctx);

    const risposta = await apiPost<{ rows: CatalogRow[]; failed: number }>(
      requestContext,
      'extract-pages',
      { urls: gruppo },
    );

    righe.push(...risposta.rows);
    lette += gruppo.length;
    ctx.avanzamento(lette, daLeggere.length);
  }

  ctx.nota(`${righe.length} pagine prodotto valide su ${daLeggere.length} lette`);
  return { righe, prossimoOffset: inizio + daLeggere.length, totale: filtrate.urls.length };
}

/** Segue gli indici di sitemap, con un tetto di profondita'. */
async function raccogliUrlSitemap(
  url: string,
  requestContext: Contesto,
  ctx: JobContext,
  profondita = 0,
): Promise<string[]> {
  if (profondita > 2) return [];

  const diretto = await scaricaDalBrowser(url, ctx);

  let urls: string[];
  let nested: string[];

  if (diretto !== null) {
    ({ urls, nested } = parseSitemapXml(diretto));
  } else {
    const risposta = await apiPost<{ urls: string[]; nested: string[] }>(
      requestContext,
      'fetch-source',
      { url, kind: 'sitemap' },
    );
    urls = risposta.urls;
    nested = risposta.nested;
  }

  if (nested.length === 0) return urls;

  ctx.nota(`Indice di sitemap: ${nested.length} sotto-sitemap`);
  const raccolte: string[] = [...urls];

  for (const sotto of nested) {
    verificaAnnullamento(ctx);
    if (raccolte.length >= MAX_URL_RACCOLTE) break;
    raccolte.push(...(await raccogliUrlSitemap(sotto, requestContext, ctx, profondita + 1)));
  }

  return raccolte;
}

/**
 * Prova a scaricare direttamente dal browser.
 * Null quando il CORS lo impedisce: non e' un errore, e' il caso normale per
 * la maggior parte dei feed, e si prosegue dal proxy.
 */
async function scaricaDalBrowser(url: string, ctx: JobContext): Promise<string | null> {
  try {
    const risposta = await fetch(url, { mode: 'cors', redirect: 'follow' });
    if (!risposta.ok) {
      ctx.nota(`Download diretto: la sorgente ha risposto HTTP ${risposta.status}, riprovo dal server`);
      return null;
    }
    const testo = await risposta.text();
    if (testo.trim().length === 0) {
      ctx.nota('Download diretto: risposta vuota, riprovo dal server');
      return null;
    }
    ctx.nota(`Download diretto riuscito: ${(testo.length / 1024).toFixed(0)} KB`);
    return testo;
  } catch {
    ctx.nota('La sorgente non consente il download dal browser (CORS), passo dal server');
    return null;
  }
}

// -----------------------------------------------------------------------------
// Salvataggio
// -----------------------------------------------------------------------------

interface EsitoSalvataggio {
  salvati: number;
  conGtin: number;
  senzaPrezzo: number;
}

async function salva(
  righe: CatalogRow[],
  requestContext: Contesto,
  ctx: JobContext,
): Promise<EsitoSalvataggio> {
  const lotti = aLotti(righe, RIGHE_PER_LOTTO);
  const esito: EsitoSalvataggio = { salvati: 0, conGtin: 0, senzaPrezzo: 0 };

  ctx.fase('Salvataggio dei prodotti…');
  ctx.avanzamento(0, righe.length);

  for (const [indice, lotto] of lotti.entries()) {
    verificaAnnullamento(ctx);

    const risposta = await apiPost<{
      saved: number;
      withGtin: number;
      withoutPrice: number;
      snapshotError: string | null;
    }>(requestContext, 'catalog-save', { rows: lotto });

    esito.salvati += risposta.saved;
    esito.conGtin += risposta.withGtin;
    esito.senzaPrezzo += risposta.withoutPrice;

    if (risposta.snapshotError) {
      ctx.nota(`Lotto ${indice + 1}: storico prezzi non salvato (${risposta.snapshotError})`);
    }

    ctx.avanzamento(Math.min((indice + 1) * RIGHE_PER_LOTTO, righe.length), righe.length);
  }

  ctx.nota(`Salvataggio completato in ${lotti.length} lotti`);
  return esito;
}

async function finalizza(
  iniziatoAlle: string,
  requestContext: Contesto,
  ctx: JobContext,
): Promise<number> {
  ctx.fase("Disattivazione dei prodotti non piu' presenti…");

  let totale = 0;
  // La funzione lavora a blocchi e dice se ne restano: si ripete finche' no.
  for (let giro = 0; giro < 200; giro += 1) {
    verificaAnnullamento(ctx);

    const risposta = await apiPost<{ deactivated: number; remaining: number }>(
      requestContext,
      'catalog-finalize',
      { startedAt: iniziatoAlle },
    );

    totale += risposta.deactivated;
    ctx.avanzamento(totale, null);
    if (risposta.remaining === 0) break;
  }

  if (totale > 0) ctx.nota(`${totale} prodotti disattivati`);
  return totale;
}
