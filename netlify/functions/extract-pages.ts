/**
 * POST /api/extract-pages
 *
 * Legge i dati strutturati (JSON-LD, microdata, Open Graph) da un piccolo
 * gruppo di pagine prodotto.
 *
 * Il browser non puo' farlo da solo: le pagine di un e-commerce non espongono
 * CORS. Il lavoro resta quindi qui, ma spezzato: poche URL per chiamata, ed
 * e' il browser a scorrere l'elenco della sitemap chiamando questo endpoint
 * quante volte serve, mostrando l'avanzamento.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca } from './utils/moca-context';
import { extractProductFromHtml } from './utils/product-extract';
import { fetchText } from './utils/remote-fetch';
import { normalizeGtin } from './utils/matching';
import type { CatalogRow } from './utils/feed';

/** Poche per volta: ogni pagina e' una richiesta di rete verso il sito. */
export const MAX_URLS_PER_CALL = 5;
/** Budget per singola pagina: 5 pagine in parallelo stanno nei 10 secondi. */
const PAGE_BUDGET_MS = 7000;

interface RequestBody {
  urls: string[];
}

export const handler: Handler = withMoca(['POST'], async (event, _moca, headers) => {
  const body = parseBody<RequestBody>(event);
  const urls = (body.urls ?? []).filter((u) => typeof u === 'string' && u.length > 0);

  if (urls.length === 0) throw new HttpError(400, 'Nessuna URL da leggere');
  if (urls.length > MAX_URLS_PER_CALL) {
    throw new HttpError(400, `Massimo ${MAX_URLS_PER_CALL} URL per chiamata, ricevute ${urls.length}`);
  }

  // In parallelo: sono richieste indipendenti verso lo stesso sito.
  const results = await Promise.all(urls.map((url) => readPage(url)));

  return ok(
    {
      rows: results.filter((r): r is CatalogRow => r !== null),
      failed: results.filter((r) => r === null).length,
    },
    headers,
  );
});

/** Null quando la pagina non e' una scheda prodotto o non e' leggibile. */
async function readPage(url: string): Promise<CatalogRow | null> {
  try {
    const { body } = await fetchText(url, PAGE_BUDGET_MS);
    const product = extractProductFromHtml(body);

    // Senza titolo o senza prezzo non e' una pagina prodotto.
    if (!product.title || product.price === null) return null;

    return {
      sku: product.sku,
      gtin: normalizeGtin(product.gtin),
      mpn: product.mpn,
      brand: product.brand,
      title: product.title,
      category: null,
      productUrl: url,
      imageUrl: product.imageUrl,
      price: product.price,
      listPrice: product.listPrice,
      currency: product.currency,
      availability: product.availability,
    };
  } catch (err) {
    // Una pagina che non risponde non deve far fallire l'intero gruppo.
    console.warn(`[extract-pages] ${url}: ${(err as Error).message}`);
    return null;
  }
}
