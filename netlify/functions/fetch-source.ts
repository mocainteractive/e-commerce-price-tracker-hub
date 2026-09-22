/**
 * POST /api/fetch-source
 *
 * Proxy di sola lettura per feed e sitemap.
 *
 * Il browser prova sempre prima a scaricare da solo: se la sorgente espone
 * CORS, il download non passa da qui e non ha alcun limite di dimensione o
 * durata. Questa funzione serve solo ai feed che CORS non ce l'hanno, ed e'
 * l'unico punto in cui la durata e' vincolata dai 10 secondi di Netlify.
 *
 * Restituisce dati gia' interpretati (righe di catalogo o URL di sitemap),
 * non il documento grezzo: trasferire un feed da qualche megabyte al browser
 * per poi rimandarlo indietro sarebbe solo spreco.
 *
 * La risposta di una funzione non puo' superare i 6 MB: per questo esiste un
 * tetto di righe, ma quando scatta viene detto (`total`, `truncated`), cosi'
 * l'import puo' avvisare invece di far sparire prodotti in silenzio.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca } from './utils/moca-context';
import { fetchText } from './utils/remote-fetch';
import { parseFeedXml, parseSitemapXml, importFromCsv } from './utils/feed';

interface RequestBody {
  url: string;
  kind: 'feed' | 'sitemap' | 'csv';
  limit?: number;
}

/** Circa 450 byte a riga: 12.000 righe restano sotto i 6 MB di risposta. */
export const MAX_ROWS = 12000;

export const handler: Handler = withMoca(['POST'], async (event, _moca, headers) => {
  const body = parseBody<RequestBody>(event);
  if (!body.url) throw new HttpError(400, 'URL mancante');

  const limit = Math.min(Math.max(Number(body.limit) || MAX_ROWS, 1), MAX_ROWS);
  const fetched = await fetchText(body.url);

  try {
    if (body.kind === 'sitemap') {
      const { urls, nested } = parseSitemapXml(fetched.body);
      return ok({ kind: 'sitemap', urls, nested, elapsedMs: fetched.elapsedMs }, headers);
    }

    const all = body.kind === 'csv' ? importFromCsv(fetched.body) : parseFeedXml(fetched.body);
    const rows = all.slice(0, limit);

    return ok(
      {
        kind: body.kind === 'csv' ? 'csv' : 'feed',
        rows,
        total: all.length,
        truncated: all.length > rows.length,
        elapsedMs: fetched.elapsedMs,
      },
      headers,
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;

    // Il download e' andato a buon fine: il problema e' il contenuto.
    // Mostrare l'inizio della risposta fa capire subito se la sorgente ha
    // restituito una pagina di errore HTML invece del feed.
    const preview = fetched.body.trim().slice(0, 160).replace(/\s+/g, ' ');
    throw new HttpError(
      422,
      `${(err as Error).message}. La sorgente ha risposto con ${fetched.contentType ?? 'tipo sconosciuto'} e inizia con: "${preview}"`,
      'SOURCE_NOT_PARSABLE',
    );
  }
});
