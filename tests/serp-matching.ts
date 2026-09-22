/**
 * Verifica del matching su dati REALI.
 *
 * Il feed e i risultati della SERP qui sotto sono quelli veri del catalogo
 * Venezianico e della ricerca su Google, raccolti mentre si indagava una
 * scansione che non trovava nulla. Restano come test perche' descrivono i tre
 * comportamenti che contano:
 *
 *   1. i venditori dello stesso articolo vengono riconosciuti;
 *   2. il rumore che arriva cercando il solo EAN viene scartato;
 *   3. una variante diversa dello stesso modello NON viene confusa.
 *
 * Il punto 2 e' la ragione per cui `buildSearchQuery` non usa piu' il solo
 * codice EAN: su Google un numero isolato porta ammorbidenti e shampoo.
 *
 * Esecuzione: `npm test`
 */
import { parseFeedXml } from '../netlify/functions/utils/feed';
import { buildSearchQuery, buildGtinQuery, scoreMatch } from '../netlify/functions/utils/matching';
import { filtraUrlProdotto } from '../netlify/functions/utils/sitemap-filter';

let failed = 0;
const eq = (label: string, condizione: boolean) => {
  if (condizione) console.log(`ok   ${label}`);
  else {
    failed += 1;
    console.log(`FAIL ${label}`);
  }
};

// --- Estratto reale del feed Channable di Venezianico ------------------------
const FEED = `<?xml version='1.0' encoding='utf-8'?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>
<item>
  <title>Orologio Automatico Arsenale 37 - 6121503c</title>
  <link>https://it.venezianico.com/products/arsenale-37-6121503c</link>
  <g:id>15610151174476</g:id>
  <g:gtin>8056590473955</g:gtin>
  <g:mpn>6121503C</g:mpn>
  <g:brand>Venezianico</g:brand>
  <g:price>850.00 EUR</g:price>
  <g:sale_price>850.00 EUR</g:sale_price>
  <g:availability>in_stock</g:availability>
  <g:product_type>Orologi automatici</g:product_type>
</item>
</channel></rss>`;

const righe = parseFeedXml(FEED);
eq('feed reale interpretato', righe.length === 1);

const p = righe[0];
const subject = { title: p.title, brand: p.brand, gtin: p.gtin, mpn: p.mpn, sku: p.sku, price: p.price };

eq('marca letta', p.brand === 'Venezianico');
eq('codice modello letto', p.mpn === '6121503C');
eq('EAN validato', p.gtin === '8056590473955');
eq('prezzo letto', p.price === 850);

// --- La query: brand + modello + titolo, mai il solo EAN --------------------
const query = buildSearchQuery(subject);
eq('query contiene la marca', query.includes('Venezianico'));
eq('query contiene il codice modello', query.toLowerCase().includes('6121503c'));
eq('query NON e\' il solo EAN', query !== p.gtin && !query.startsWith('80565904'));
eq('EAN disponibile come ricerca separata', buildGtinQuery(subject) === '8056590473955');

// --- Venditori veri trovati con la query principale -------------------------
const VENDITORI = [
  { dominio: 'www.orologeriamajer.it', titolo: 'Venezianico Arsenale 37 6121503C', prezzo: 850 },
  {
    dominio: 'www.clessidrajewels.com',
    titolo: 'Orologio Venezianico - Arsenale 37 Viola - 6121503C',
    prezzo: 807.5,
  },
  { dominio: 'www.hodinky-365.it', titolo: 'Venezianico Arsenale 37 Automatic 6121503C', prezzo: 850 },
];

for (const v of VENDITORI) {
  const verdetto = scoreMatch(subject, { title: v.titolo, domain: v.dominio, price: v.prezzo }, 'serp');
  eq(`venditore riconosciuto: ${v.dominio} (${(verdetto.score * 100).toFixed(0)}%)`, verdetto.accepted);
}

// --- Rumore reale restituito cercando il solo EAN ---------------------------
const RUMORE = [
  { dominio: 'www.ebay.it', titolo: '3 PZ LUXURY AMMORBIDENTE PROFUMATO SUPERCONCENTRATO TIFFANY 900ML', prezzo: 24.9 },
  { dominio: 'www.douglas.it', titolo: 'Conditioner Balsamo capelli', prezzo: 23.29 },
  { dominio: 'www.prezzifarmaco.it', titolo: 'Gandia glitter w black 36 - Confronta Prezzi', prezzo: 39 },
];

for (const r of RUMORE) {
  const verdetto = scoreMatch(subject, { title: r.titolo, domain: r.dominio, price: r.prezzo }, 'serp');
  eq(`rumore scartato: ${r.titolo.slice(0, 30)}…`, !verdetto.accepted);
}

// --- Una variante diversa non deve essere confusa ---------------------------
// 6121501C e' lo stesso modello in un altro colore: prezzo identico, titolo
// quasi uguale. Confonderli falserebbe il confronto su entrambi.
const altraVariante = scoreMatch(
  subject,
  { title: 'Arsenale 37 - 6121501C', domain: 'altro.it', price: 850 },
  'serp',
);
eq(
  `variante diversa non confusa (${(altraVariante.score * 100).toFixed(0)}%)`,
  !altraVariante.accepted,
);

// --- Filtro delle sitemap ---------------------------------------------------
const filtro = filtraUrlProdotto(
  [
    'https://it.venezianico.com/products/arsenale-37-6121503c',
    'https://it.venezianico.com/products/arsenale-40-6221501c',
    'https://it.venezianico.com/collections/arsenale',
    'https://it.venezianico.com/blog/storia-di-venezia',
    'https://it.venezianico.com/pages/chi-siamo',
    'https://it.venezianico.com/cart',
    'https://it.venezianico.com/assets/logo.png',
    'https://it.venezianico.com/products/arsenale-37-6121503c',
  ],
  { include: [], exclude: [] },
);

eq('sitemap: tiene solo le schede prodotto', filtro.urls.length === 2);
eq('sitemap: scarta il duplicato', filtro.scartate.perDuplicato === 1);
eq('sitemap: scarta i file', filtro.scartate.perEstensione === 1);

const conRegola = filtraUrlProdotto(
  ['https://x.it/shop/a', 'https://x.it/negozio/b'],
  { include: ['/negozio/'], exclude: [] },
);
eq('sitemap: la regola esplicita del cliente comanda', conRegola.urls.length === 1);

console.log(failed === 0 ? '\nMATCHING SU DATI REALI: CONTROLLI SUPERATI' : `\nMATCHING: ${failed} CONTROLLI FALLITI`);
process.exit(failed === 0 ? 0 : 1);
