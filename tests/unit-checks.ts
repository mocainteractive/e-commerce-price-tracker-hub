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
import { parseCsv, importFromCsv } from '../netlify/functions/utils/feed';
import { comparePrices } from '../netlify/functions/utils/pricing';
import { encryptJson, decryptJson } from '../netlify/functions/utils/crypto';

// La cifratura delle configurazioni deriva la chiave da APP_SESSION_SECRET.
process.env.APP_SESSION_SECRET = 'segreto-di-test-non-usare-in-produzione';

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

// --- cifratura delle configurazioni cliente ---
const configs = { DATAFORSEO_LOGIN: 'account@moca.it', DATAFORSEO_PASSWORD: 'p4ssw0rd-lungo' };
const cipher = encryptJson(configs);
eq('cifrato in 3 parti', cipher.split('.').length, 3);
eq('nessuna chiave in chiaro', cipher.includes('DATAFORSEO') || cipher.includes('p4ssw0rd'), false);
eq('roundtrip', decryptJson<typeof configs>(cipher), configs);
eq('nonce diverso a ogni cifratura', encryptJson(configs) === cipher, false);
eq('payload manomesso rifiutato', decryptJson(`${cipher.slice(0, -4)}AAAA`), null);
eq('payload malformato rifiutato', decryptJson('non-un-payload'), null);

process.env.APP_SESSION_SECRET = 'un-altro-segreto-completamente-diverso';
eq('chiave sbagliata non decifra', decryptJson(cipher), null);
process.env.APP_SESSION_SECRET = 'segreto-di-test-non-usare-in-produzione';
eq('chiave corretta decifra ancora', decryptJson<typeof configs>(cipher), configs);

console.log(failed === 0 ? '\nTUTTI I CONTROLLI SUPERATI' : `\n${failed} CONTROLLI FALLITI`);
process.exit(failed === 0 ? 0 : 1);
