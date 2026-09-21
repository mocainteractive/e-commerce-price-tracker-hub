/**
 * Import del catalogo cliente.
 *
 * Tre sorgenti supportate:
 *   * `feed`    - feed Google Merchant (RSS 2.0 con namespace g:, o Atom).
 *                 E' la via migliore: ha gia' GTIN, MPN, brand e prezzo.
 *   * `csv`     - export manuale, con mappatura automatica delle intestazioni.
 *   * `sitemap` - sitemap XML + estrazione JSON-LD dalle pagine prodotto.
 *                 Fallback per chi non espone un feed.
 */
import { XMLParser } from 'fast-xml-parser';
import { extractProductFromUrl, parsePrice, normalizeAvailability } from './product-extract';
import { normalizeGtin } from './matching';

export interface CatalogRow {
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  title: string;
  category: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // `g:gtin` -> `gtin`
  trimValues: true,
  parseTagValue: false, // i prezzi li normalizziamo noi
});

async function fetchText(url: string, timeoutMs = 25_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MocaPriceTracker/1.0 (+https://mocainteractive.com)' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Feed Google Merchant
// -----------------------------------------------------------------------------

export async function importFromFeed(feedUrl: string, limit: number): Promise<CatalogRow[]> {
  const xml = await fetchText(feedUrl);
  const doc = parser.parse(xml) as Record<string, any>;

  const items: any[] = asArray(doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.channel?.item);
  if (items.length === 0) {
    throw new Error('Nessun prodotto trovato nel feed: verifica che sia un feed Google Merchant');
  }

  const rows: CatalogRow[] = [];
  for (const item of items.slice(0, limit)) {
    const title = text(item.title);
    if (!title) continue;

    // Atom usa <link href="...">, RSS usa <link>...</link>.
    const link = text(item.link) ?? text(item.link?.['@_href']) ?? text(item.product_link);

    rows.push({
      sku: text(item.id) ?? text(item.sku) ?? null,
      gtin: normalizeGtin(text(item.gtin) ?? text(item.ean)),
      mpn: text(item.mpn) ?? null,
      brand: text(item.brand) ?? null,
      title,
      category: text(item.product_type) ?? text(item.google_product_category) ?? null,
      productUrl: link,
      imageUrl: text(item.image_link) ?? text(item.additional_image_link) ?? null,
      price: parsePrice(text(item.sale_price) ?? text(item.price)),
      listPrice: parsePrice(text(item.price)),
      currency: currencyFrom(text(item.sale_price) ?? text(item.price)),
      availability: normalizeAvailability(text(item.availability)),
    });
  }

  return rows;
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

/** Intestazioni riconosciute, in italiano e in inglese. */
const CSV_ALIASES: Record<keyof CatalogRow, string[]> = {
  sku: ['sku', 'id', 'codice', 'codice_articolo', 'item_id', 'article'],
  gtin: ['gtin', 'ean', 'barcode', 'upc', 'codice_ean'],
  mpn: ['mpn', 'part_number', 'codice_produttore'],
  brand: ['brand', 'marca', 'marchio', 'produttore', 'manufacturer'],
  title: ['title', 'titolo', 'nome', 'name', 'prodotto', 'descrizione_breve'],
  category: ['category', 'categoria', 'product_type'],
  productUrl: ['url', 'link', 'product_url', 'pagina'],
  imageUrl: ['image', 'image_link', 'immagine', 'image_url'],
  price: ['price', 'prezzo', 'sale_price', 'prezzo_vendita'],
  listPrice: ['list_price', 'prezzo_listino', 'regular_price'],
  currency: ['currency', 'valuta'],
  availability: ['availability', 'disponibilita', 'stock'],
};

export function importFromCsv(content: string, limit: number): CatalogRow[] {
  const table = parseCsv(content);
  if (table.length < 2) throw new Error('Il CSV non contiene righe di dati');

  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const indexOf = (field: keyof CatalogRow): number =>
    header.findIndex((h) => CSV_ALIASES[field].includes(h));

  const columns = Object.fromEntries(
    (Object.keys(CSV_ALIASES) as Array<keyof CatalogRow>).map((f) => [f, indexOf(f)]),
  ) as Record<keyof CatalogRow, number>;

  if (columns.title < 0) {
    throw new Error('Colonna del nome prodotto non trovata: attesa una tra "title", "titolo", "nome"');
  }

  const cell = (row: string[], field: keyof CatalogRow): string | null => {
    const index = columns[field];
    if (index < 0) return null;
    const value = row[index]?.trim();
    return value ? value : null;
  };

  const rows: CatalogRow[] = [];
  for (const row of table.slice(1, limit + 1)) {
    const title = cell(row, 'title');
    if (!title) continue;

    rows.push({
      sku: cell(row, 'sku'),
      gtin: normalizeGtin(cell(row, 'gtin')),
      mpn: cell(row, 'mpn'),
      brand: cell(row, 'brand'),
      title,
      category: cell(row, 'category'),
      productUrl: cell(row, 'productUrl'),
      imageUrl: cell(row, 'imageUrl'),
      price: parsePrice(cell(row, 'price')),
      listPrice: parsePrice(cell(row, 'listPrice')),
      currency: cell(row, 'currency'),
      availability: normalizeAvailability(cell(row, 'availability')),
    });
  }

  return rows;
}

/** Parser CSV conforme a RFC 4180 (virgolette, campi multilinea, `;` o `,`). */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, '');
  // Il delimitatore si deduce dalla prima riga: gli export italiani usano `;`.
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

// -----------------------------------------------------------------------------
// Sitemap + scraping delle pagine prodotto
// -----------------------------------------------------------------------------

/** Estrae le URL da una sitemap, seguendo anche gli indici di sitemap. */
export async function collectSitemapUrls(
  sitemapUrl: string,
  limit: number,
  depth = 0,
): Promise<string[]> {
  if (depth > 2) return [];

  const xml = await fetchText(sitemapUrl);
  const doc = parser.parse(xml) as Record<string, any>;

  const nested = asArray(doc?.sitemapindex?.sitemap);
  if (nested.length > 0) {
    const urls: string[] = [];
    for (const entry of nested) {
      if (urls.length >= limit) break;
      const loc = text(entry.loc);
      if (!loc) continue;
      urls.push(...(await collectSitemapUrls(loc, limit - urls.length, depth + 1)));
    }
    return urls;
  }

  return asArray(doc?.urlset?.url)
    .map((entry: any) => text(entry.loc))
    .filter((loc): loc is string => Boolean(loc))
    .slice(0, limit);
}

/**
 * Scarica le pagine prodotto e ne estrae i dati strutturati.
 * Concorrenza limitata per non martellare il sito del cliente.
 */
export async function importFromSitemap(
  sitemapUrl: string,
  limit: number,
  concurrency = 4,
): Promise<CatalogRow[]> {
  const urls = await collectSitemapUrls(sitemapUrl, limit);
  if (urls.length === 0) throw new Error('Nessuna URL trovata nella sitemap');

  const rows: CatalogRow[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const extracted = await Promise.all(batch.map((url) => extractProductFromUrl(url)));

    batch.forEach((url, index) => {
      const product = extracted[index];
      // Senza titolo o senza prezzo non e' una pagina prodotto.
      if (!product?.title || product.price === null) return;

      rows.push({
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
      });
    });
  }

  return rows;
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

function asArray(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    return inner !== undefined ? text(inner) : null;
  }
  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

/** Nei feed Merchant il prezzo e' "89.90 EUR": isola la valuta. */
function currencyFrom(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\b([A-Z]{3})\b/);
  return match ? match[1] : null;
}
