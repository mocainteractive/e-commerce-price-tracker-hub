/**
 * Controlli sulla logica pura del backend: matching prodotto, estrazione dei
 * dati strutturati, parsing dei feed e confronto prezzi.
 *
 * Niente rete e niente database: sono le parti dove un errore silenzioso
 * costerebbe di piu' (un match sbagliato falsa tutto il confronto).
 *
 * Esecuzione: `npm test`
 */
import {
  isValidGtin,
  normalizeGtin,
  scoreMatch,
  buildSearchQuery,
  tokenSimilarity,
  normalizeDomain,
  priceProximity,
} from '../netlify/functions/utils/matching';
import { parsePrice, extractProductFromHtml } from '../netlify/functions/utils/product-extract';
import { parseCsv, importFromCsv, parseFeedXml, parseSitemapXml, deriveSku } from '../netlify/functions/utils/feed';
import { comparePrices } from '../netlify/functions/utils/pricing';
import { normalizeSupabaseUrl } from '../netlify/functions/utils/supabase-admin';

let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`FAIL ${label}: atteso ${JSON.stringify(expected)}, ottenuto ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${label}`);
};

// --- GTIN ---
eq('EAN13 valido', isValidGtin('4006381333931'), true);
eq('EAN13 errato', isValidGtin('4006381333932'), false);
eq('UPC12 -> EAN13', normalizeGtin('036000291452'), '0036000291452');
eq('GTIN sporco', normalizeGtin('EAN: 4006381333931'), '4006381333931');

// --- prezzi ---
eq('prezzo IT', parsePrice('1.234,56'), 1234.56);
eq('prezzo EN', parsePrice('1,234.56'), 1234.56);
eq('prezzo valuta', parsePrice('€ 89,90'), 89.9);
eq('prezzo semplice', parsePrice('349.00'), 349);
eq('prezzo vuoto', parsePrice(''), null);

// --- dominio ---
eq('dominio', normalizeDomain('https://www.Esempio.IT/prodotto/x?a=1'), 'esempio.it');

// --- similarita' ---
const sim = tokenSimilarity('Sony WH-1000XM5 Cuffie Wireless Nero', 'Cuffie Sony WH1000XM5 wireless black');
eq('similarita ragionevole', sim > 0.4 && sim < 1, true);

// --- prossimita' prezzo ---
eq('prezzi uguali', priceProximity(100, 100), 1);
eq('prezzi lontani', priceProximity(100, 20), 0);

// --- matching ---
const subject = { title: 'Sony WH-1000XM5 Cuffie Wireless', brand: 'Sony', gtin: '4006381333931', mpn: 'WH1000XM5B', sku: 'SNY-001', price: 349 };

const perGtin = scoreMatch(subject, { title: 'Sony cuffie EAN 4006381333931 promo', price: 340 });
eq('match per GTIN', [perGtin.method, perGtin.score], ['gtin', 1]);

const perMpn = scoreMatch(subject, { title: 'Cuffie WH1000XM5B Sony nere', price: 359 });
eq('match per MPN', perMpn.method, 'mpn');

const accessorio = scoreMatch(subject, { title: 'Custodia per cuffie Sony', price: 19 });
eq('accessorio scartato', accessorio.accepted, false);

const simile = scoreMatch(subject, { title: 'Sony Cuffie Wireless WH 1000 XM5 colore nero', price: 355 });
eq('prodotto simile accettato', simile.accepted, true);

eq('query da GTIN', buildSearchQuery(subject), '4006381333931');
eq('query senza GTIN', buildSearchQuery({ ...subject, gtin: null }), 'Sony WH1000XM5B WH-1000XM5 Cuffie Wireless');

// --- estrazione JSON-LD ---
const html = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"Frullatore X3","sku":"FR-X3","gtin13":"4006381333931","brand":{"@type":"Brand","name":"Acme"},"image":["https://x.it/a.jpg"],"offers":{"@type":"Offer","price":"129,90","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}]}
</script></head><body></body></html>`;
const extracted = extractProductFromHtml(html);
eq('JSON-LD titolo', extracted.title, 'Frullatore X3');
eq('JSON-LD prezzo', extracted.price, 129.9);
eq('JSON-LD brand', extracted.brand, 'Acme');
eq('JSON-LD disponibilita', extracted.availability, 'disponibile');
eq('JSON-LD gtin', extracted.gtin, '4006381333931');

// --- meta fallback ---
const metaHtml = `<html><head><meta property="og:title" content="Tostapane Z"><meta property="product:price:amount" content="49.90"><meta property="product:price:currency" content="EUR"></head></html>`;
const metaProduct = extractProductFromHtml(metaHtml);
eq('meta titolo', metaProduct.title, 'Tostapane Z');
eq('meta prezzo', metaProduct.price, 49.9);

// --- CSV ---
const csv = 'titolo;sku;ean;prezzo;marca\n"Frullatore, grande";FR-1;4006381333931;129,90;Acme\nTostapane;TO-1;;49,90;Acme';
eq('CSV righe', parseCsv(csv).length, 3);
const rows = importFromCsv(csv, 10);
eq('CSV prodotti', rows.length, 2);
eq('CSV virgola nel campo', rows[0].title, 'Frullatore, grande');
eq('CSV prezzo IT', rows[0].price, 129.9);
eq('CSV ean non valido scartato', rows[1].gtin, null);

// --- confronto prezzi ---
const cmp = comparePrices(100, [{ domain: 'a.it', price: 95 }, { domain: 'b.it', price: 110 }], 2);
eq('posizione', [cmp.rank, cmp.position, cmp.minPrice, cmp.cheapestDomain], [2, 'caro', 95, 'a.it']);
const best = comparePrices(90, [{ domain: 'a.it', price: 95 }], 2);
eq('migliore', best.position, 'migliore');
const allineato = comparePrices(96, [{ domain: 'a.it', price: 95 }], 2);
eq('allineato', allineato.position, 'allineato');

// --- feed Google Merchant (gli stessi parser girano anche nel browser) ---
const feedXml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
<item><g:id>A1</g:id><title>Frullatore X3</title><link>https://shop.it/p/a1</link>
<g:price>129.90 EUR</g:price><g:sale_price>119,90 EUR</g:sale_price>
<g:gtin>4006381333931</g:gtin><g:brand>Acme</g:brand><g:availability>in stock</g:availability>
<g:image_link>https://shop.it/a1.jpg</g:image_link></item>
<item><title>Senza prezzo</title><g:id>A2</g:id></item>
</channel></rss>`;

const feed = parseFeedXml(feedXml);
eq('feed: prodotti letti', feed.length, 2);
eq('feed: titolo', feed[0].title, 'Frullatore X3');
eq('feed: prezzo scontato vince', feed[0].price, 119.9);
eq('feed: prezzo di listino', feed[0].listPrice, 129.9);
eq('feed: valuta isolata', feed[0].currency, 'EUR');
eq('feed: ean validato', feed[0].gtin, '4006381333931');
eq('feed: disponibilita', feed[0].availability, 'disponibile');
eq('feed: prezzo mancante resta nullo', feed[1].price, null);

const nonFeed = (() => {
  try {
    parseFeedXml('<html><body>Errore 500</body></html>');
    return 'nessun errore';
  } catch (err) {
    return (err as Error).message.slice(0, 20);
  }
})();
eq('feed: documento non valido rifiutato', nonFeed, 'Nessun prodotto trov');

// --- sitemap ---
const sitemap = parseSitemapXml(
  '<urlset><url><loc>https://shop.it/p/1</loc></url><url><loc>https://shop.it/p/2</loc></url></urlset>',
);
eq('sitemap: url trovate', sitemap.urls.length, 2);
eq('sitemap: nessun indice', sitemap.nested.length, 0);

const indice = parseSitemapXml(
  '<sitemapindex><sitemap><loc>https://shop.it/s1.xml</loc></sitemap></sitemapindex>',
);
eq('sitemap: indice riconosciuto', indice.nested, ['https://shop.it/s1.xml']);

// --- SKU derivato: deve essere stabile fra browser e server ---
eq('sku da ean', deriveSku({ ...feed[0], sku: null }), 'ean-4006381333931');
eq(
  'sku da titolo',
  deriveSku({ ...feed[1], sku: null, gtin: null, mpn: null, brand: 'Acme' }),
  'acme-senza-prezzo',
);

// --- SUPABASE_URL: la forma sbagliata faceva fallire ogni endpoint con un
//     "Errore interno del server" senza spiegazione.
eq('url completa', normalizeSupabaseUrl('https://abc.supabase.co'), 'https://abc.supabase.co');
eq('slash finale', normalizeSupabaseUrl('https://abc.supabase.co/'), 'https://abc.supabase.co');
eq('senza schema', normalizeSupabaseUrl('abc.supabase.co'), 'https://abc.supabase.co');
eq('con spazi', normalizeSupabaseUrl('  https://abc.supabase.co  '), 'https://abc.supabase.co');

const rifiuta = (value: string): boolean => {
  try {
    normalizeSupabaseUrl(value);
    return false;
  } catch {
    return true;
  }
};
eq('rifiuta vuoto', rifiuta(''), true);
eq('rifiuta hostname senza punto', rifiuta('localhost'), true);

console.log(failed === 0 ? '\nTUTTI I CONTROLLI SUPERATI' : `\n${failed} CONTROLLI FALLITI`);
process.exit(failed === 0 ? 0 : 1);
