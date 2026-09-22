/**
 * Estrazione dei dati prodotto da una pagina e-commerce.
 *
 * Ordine di preferenza:
 *   1. JSON-LD schema.org/Product  -> praticamente tutti gli e-commerce moderni
 *   2. Microdata itemprop           -> piattaforme piu' datate
 *   3. Meta tag Open Graph / product
 *
 * Non usiamo un parser DOM: le pagine prodotto sono grandi e ci servono pochi
 * campi, quindi una scansione mirata e' piu' rapida e senza dipendenze.
 */

export interface ExtractedProduct {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: string | null;
  imageUrl: string | null;
}

const EMPTY: ExtractedProduct = {
  title: null,
  brand: null,
  gtin: null,
  mpn: null,
  sku: null,
  price: null,
  listPrice: null,
  currency: null,
  availability: null,
  imageUrl: null,
};

const USER_AGENT =
  'Mozilla/5.0 (compatible; MocaPriceTracker/1.0; +https://mocainteractive.com)';

export async function fetchHtml(url: string, timeoutMs = 6_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn(`[extract] ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[extract] Fetch fallito per ${url}:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractProductFromUrl(
  url: string,
  timeoutMs?: number,
): Promise<ExtractedProduct | null> {
  const html = await fetchHtml(url, timeoutMs);
  if (!html) return null;
  return extractProductFromHtml(html);
}

export function extractProductFromHtml(html: string): ExtractedProduct {
  const fromJsonLd = extractFromJsonLd(html);
  const fromMicrodata = extractFromMicrodata(html);
  const fromMeta = extractFromMeta(html);

  // Il JSON-LD ha la precedenza; gli altri riempiono solo i buchi.
  // Per il titolo, og:title viene prima del microdata: dentro un Product il
  // primo `itemprop="name"` e' spesso quello del brand annidato, e sui siti
  // senza JSON-LD ogni scheda prendeva il nome della marca come titolo.
  const titoloMeta: ExtractedProduct = { ...EMPTY, title: fromMeta.title };
  return mergeFirstNonNull(fromJsonLd, titoloMeta, fromMicrodata, fromMeta);
}

// -----------------------------------------------------------------------------
// JSON-LD
// -----------------------------------------------------------------------------

function extractFromJsonLd(html: string): ExtractedProduct {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];

  for (const block of blocks) {
    let parsed: unknown;
    try {
      // Alcuni CMS lasciano commenti HTML o CDATA dentro il blocco.
      const raw = block[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const product = findProductNode(parsed);
    if (product) return fromSchemaProduct(product);
  }

  return { ...EMPTY };
}

type JsonObject = Record<string, unknown>;

/** Cerca ricorsivamente un nodo con @type Product (anche dentro @graph). */
function findProductNode(node: unknown, depth = 0): JsonObject | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = node as JsonObject;
  const types = toArray(obj['@type']).map((t) => String(t).toLowerCase());
  if (types.some((t) => t === 'product' || t === 'productgroup')) return obj;

  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant']) {
    const found = findProductNode(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function fromSchemaProduct(product: JsonObject): ExtractedProduct {
  const offer = findOffer(product['offers']);

  return {
    title: str(product['name']),
    brand: str(unwrapName(product['brand'])),
    gtin:
      str(product['gtin13']) ??
      str(product['gtin']) ??
      str(product['gtin14']) ??
      str(product['gtin12']) ??
      str(product['gtin8']) ??
      str(product['ean']),
    mpn: str(product['mpn']),
    sku: str(product['sku']),
    price: num(offer?.['price'] ?? offer?.['lowPrice']),
    listPrice: num(offer?.['highPrice']),
    currency: str(offer?.['priceCurrency']),
    availability: normalizeAvailability(str(offer?.['availability'])),
    imageUrl: firstImage(product['image']),
  };
}

/** `offers` puo' essere un oggetto, un array o un AggregateOffer. */
function findOffer(offers: unknown): JsonObject | null {
  if (!offers || typeof offers !== 'object') return null;

  if (Array.isArray(offers)) {
    // Preferiamo la prima offerta con un prezzo valorizzato.
    const withPrice = offers.find(
      (o) => o && typeof o === 'object' && num((o as JsonObject)['price']) !== null,
    );
    return (withPrice ?? offers[0] ?? null) as JsonObject | null;
  }

  const obj = offers as JsonObject;
  if (obj['offers']) {
    const nested = findOffer(obj['offers']);
    // Un AggregateOffer puo' avere lowPrice ma non price: teniamo entrambi.
    if (nested && num(nested['price']) !== null) return { ...obj, ...nested };
  }
  return obj;
}

// -----------------------------------------------------------------------------
// Microdata & meta tag
// -----------------------------------------------------------------------------

/**
 * Microdata, ma solo dentro il blocco `itemtype=".../Product"`.
 *
 * Senza questo vincolo `itemprop="name"` prendeva il primo elemento della
 * pagina, che sui siti con breadcrumb o nome del negozio in microdata e' il
 * nome del sito: tutte le schede diventavano "Pellizzari E-commerce".
 * Se la pagina non dichiara un Product, il microdata non e' affidabile e si
 * passa ai meta tag.
 */
function extractFromMicrodata(html: string): ExtractedProduct {
  const scope = productScope(html);
  if (scope === null) return { ...EMPTY };

  const prop = (name: string): string | null => {
    const pattern = new RegExp(
      `<[^>]+itemprop=["']${name}["'][^>]*?(?:content|value)=["']([^"']+)["']`,
      'i',
    );
    const withContent = scope.match(pattern);
    if (withContent) return withContent[1];

    const inline = scope.match(
      new RegExp(`<([a-z]+)[^>]+itemprop=["']${name}["'][^>]*>([^<]{1,200})<\\/\\1>`, 'i'),
    );
    return inline ? inline[2].trim() : null;
  };

  // `itemprop="brand"` e' spesso un itemscope con il nome annidato.
  const brandAnnidato = scope.match(
    /itemprop=["']brand["'][^>]*>\s*<(?:meta|span)[^>]+itemprop=["']name["'][^>]*?(?:content=["']([^"']+)["']|>([^<]{1,100})<)/i,
  );

  return {
    ...EMPTY,
    title: prop('name'),
    brand: prop('brand') ?? brandAnnidato?.[1] ?? brandAnnidato?.[2]?.trim() ?? null,
    gtin: prop('gtin13') ?? prop('gtin') ?? prop('ean'),
    mpn: prop('mpn'),
    sku: prop('sku'),
    price: parsePrice(prop('price')),
    listPrice: null,
    currency: prop('priceCurrency'),
    availability: normalizeAvailability(prop('availability')),
    imageUrl: prop('image'),
  };
}

/** Porzione di HTML che inizia dall'itemscope Product, se c'e'. */
function productScope(html: string): string | null {
  const match = html.match(/itemtype=["']https?:\/\/schema\.org\/Product["']/i);
  if (!match || match.index === undefined) return null;
  // Dall'apertura del Product in avanti: i suoi itemprop vengono dopo.
  return html.slice(match.index);
}

/** "Pantaloni cropped | Pellizzari" -> "Pantaloni cropped". */
function stripSiteSuffix(title: string): string {
  return title.replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, '').trim() || title;
}

function extractFromMeta(html: string): ExtractedProduct {
  const meta = (name: string): string | null => {
    const match = html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
    );
    if (match) return match[1] || null;
    // Alcuni template invertono l'ordine degli attributi.
    const reversed = html.match(
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
    );
    return reversed ? reversed[1] || null : null;
  };

  const titleTag = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);

  return {
    ...EMPTY,
    title: meta('og:title') ?? (titleTag ? stripSiteSuffix(titleTag[1].trim()) : null),
    brand: meta('product:brand') ?? meta('og:brand'),
    gtin: meta('product:ean') ?? meta('product:gtin'),
    mpn: meta('product:mfr_part_no'),
    sku: meta('product:retailer_item_id'),
    price: parsePrice(meta('product:price:amount') ?? meta('og:price:amount')),
    listPrice: null,
    currency: meta('product:price:currency') ?? meta('og:price:currency'),
    availability: normalizeAvailability(meta('product:availability') ?? meta('og:availability')),
    imageUrl: meta('og:image'),
  };
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

/**
 * Converte un prezzo scritto in qualunque convenzione locale.
 * Casi gestiti: "1.234,56" (IT), "1,234.56" (EN), "1234.56", "€ 89,90".
 */
export function parsePrice(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (!raw) return null;

  const cleaned = String(raw).replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let normalized: string;
  if (lastComma > lastDot) {
    // La virgola e' il separatore decimale: i punti sono migliaia.
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned;
  }

  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

export function normalizeAvailability(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.includes('outofstock') || value.includes('out of stock') || value.includes('soldout')) {
    return 'non_disponibile';
  }
  if (value.includes('preorder')) return 'preordine';
  if (value.includes('backorder')) return 'ordinabile';
  if (value.includes('instock') || value.includes('in stock') || value.includes('available')) {
    return 'disponibile';
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unwrapName(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as JsonObject)['name'] ?? null;
  }
  if (Array.isArray(value)) return unwrapName(value[0]);
  return value;
}

function firstImage(value: unknown): string | null {
  const first = toArray(value)[0];
  if (!first) return null;
  if (typeof first === 'string') return first;
  if (typeof first === 'object') return str((first as JsonObject)['url']);
  return null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function num(value: unknown): number | null {
  return parsePrice(value as string | number | null);
}

function mergeFirstNonNull(...sources: ExtractedProduct[]): ExtractedProduct {
  const result: ExtractedProduct = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as Array<keyof ExtractedProduct>) {
    for (const source of sources) {
      if (source[key] !== null && source[key] !== undefined) {
        // @ts-expect-error assegnazione per chiave omogenea
        result[key] = source[key];
        break;
      }
    }
  }
  return result;
}
