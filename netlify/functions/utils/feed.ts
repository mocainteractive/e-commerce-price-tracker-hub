/**
 * Parsing delle sorgenti di catalogo.
 *
 * Qui dentro NON si fanno operazioni lunghe: le funzioni sono pure e
 * lavorano su testo gia' scaricato. Il motivo e' architetturale: le Netlify
 * Functions hanno ~10 secondi, mentre scaricare un feed e salvare centinaia
 * di prodotti puo' richiederne molti di piu'. Il lavoro pesante viene quindi
 * orchestrato dal browser, che non ha limiti di durata, e le funzioni si
 * limitano a un'unita' di lavoro breve ciascuna.
 *
 * Gli stessi parser girano sia nel browser (import CSV e XML locale) sia
 * nelle funzioni (proxy per i feed che non espongono CORS).
 */
import { XMLParser } from 'fast-xml-parser';
import { parsePrice, normalizeAvailability } from './product-extract';
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

// -----------------------------------------------------------------------------
// Feed Google Merchant (RSS 2.0 o Atom)
// -----------------------------------------------------------------------------

export function parseFeedXml(xml: string, limit = 5000): CatalogRow[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch (err) {
    throw new Error(`XML non valido: ${(err as Error).message}`);
  }

  const items: any[] = asArray(doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.channel?.item);
  if (items.length === 0) {
    throw new Error(
      'Nessun prodotto trovato: il documento non sembra un feed Google Merchant (atteso rss > channel > item)',
    );
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

  if (rows.length === 0) {
    throw new Error('Il feed contiene elementi ma nessuno ha un titolo valido');
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Sitemap
// -----------------------------------------------------------------------------

export interface SitemapResult {
  /** URL di pagina trovate in questo documento. */
  urls: string[];
  /** Sitemap annidate da scaricare a loro volta (indice di sitemap). */
  nested: string[];
}

export function parseSitemapXml(xml: string): SitemapResult {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch (err) {
    throw new Error(`XML non valido: ${(err as Error).message}`);
  }

  const nested = asArray(doc?.sitemapindex?.sitemap)
    .map((entry: any) => text(entry.loc))
    .filter((loc): loc is string => Boolean(loc));

  const urls = asArray(doc?.urlset?.url)
    .map((entry: any) => text(entry.loc))
    .filter((loc): loc is string => Boolean(loc));

  if (nested.length === 0 && urls.length === 0) {
    throw new Error('Nessuna URL trovata: il documento non sembra una sitemap XML');
  }

  return { urls, nested };
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

export function importFromCsv(content: string, limit = 5000): CatalogRow[] {
  const table = parseCsv(content);
  if (table.length < 2) throw new Error('Il CSV non contiene righe di dati');

  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const indexOf = (field: keyof CatalogRow): number =>
    header.findIndex((h) => CSV_ALIASES[field].includes(h));

  const columns = Object.fromEntries(
    (Object.keys(CSV_ALIASES) as Array<keyof CatalogRow>).map((f) => [f, indexOf(f)]),
  ) as Record<keyof CatalogRow, number>;

  if (columns.title < 0) {
    throw new Error(
      `Colonna del nome prodotto non trovata. Intestazioni lette: ${header.slice(0, 12).join(', ')}`,
    );
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

/**
 * SKU derivato quando la sorgente non lo espone.
 * Ordine: GTIN (stabile e globale) > MPN > slug del titolo.
 * Vive qui perche' serve identico nel browser e nelle funzioni.
 */
export function deriveSku(row: CatalogRow): string {
  if (row.gtin) return `ean-${row.gtin}`;
  if (row.mpn) return `mpn-${slug(row.mpn)}`;
  return slug(`${row.brand ?? ''} ${row.title}`).slice(0, 80) || `prod-${Date.now()}`;
}

function slug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
