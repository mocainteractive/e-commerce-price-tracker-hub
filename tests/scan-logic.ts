/**
 * Controlli sulla logica della scansione e dell'import che la review sul
 * campo ha trovato rotta. Ogni blocco descrive il guasto che copre.
 *
 * Esecuzione: `npm test`
 */
import { computeRunStatus } from '../netlify/functions/utils/scan-processing';
import { extractProductFromHtml } from '../netlify/functions/utils/product-extract';
import { scoreMatch } from '../netlify/functions/utils/matching';
import { isPrivateHost } from '../netlify/functions/utils/remote-fetch';
import { parseFeedXml } from '../netlify/functions/utils/feed';
import { parseVerdicts } from '../netlify/functions/utils/ai-match';

let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.log(`FAIL ${label}: atteso ${JSON.stringify(expected)}, ottenuto ${JSON.stringify(actual)}`);
  } else console.log(`ok   ${label}`);
};

// --- 1. Una run SERP (senza task) deve chiudersi quando il cursore arriva
//        in fondo. Prima restava "in corso" per sempre e bloccava l'app.
const adesso = Date.parse('2026-09-22T10:00:00Z');
const avvio = '2026-09-22T09:55:00Z';

const serpFinita = computeRunStatus({ productsTotal: 78, productsDone: 78, tasks: [], startedAt: avvio, searchSource: 'serp', now: adesso });
eq('run SERP completata al termine del cursore', [serpFinita.status, serpFinita.finished, serpFinita.productsDone], ['completata', true, 78]);

const serpAMeta = computeRunStatus({ productsTotal: 78, productsDone: 40, tasks: [], startedAt: avvio, searchSource: 'serp', now: adesso });
eq('run SERP a meta\' resta in corso', [serpAMeta.status, serpAMeta.finished], ['in_corso', false]);

const serpVecchia = computeRunStatus({ productsTotal: 78, productsDone: 40, tasks: [], startedAt: '2026-09-22T06:00:00Z', searchSource: 'serp', now: adesso });
eq('run SERP abbandonata da oltre 2 ore diventa parziale', [serpVecchia.status, serpVecchia.finished], ['parziale', true]);

// Senza fonte dichiarata (migration 0003 assente) si deduce dai task.
const senzaFonte = computeRunStatus({ productsTotal: 78, productsDone: 78, tasks: [], startedAt: avvio, now: adesso });
eq('run senza fonte e senza task chiusa come SERP', senzaFonte.status, 'completata');

// --- Shopping: conta solo lo stato dei task, non il cursore.
const shoppingAperta = computeRunStatus({
  productsTotal: 10, productsDone: 0, searchSource: 'shopping', startedAt: avvio, now: adesso,
  tasks: [{ status: 'completato' }, { status: 'in_attesa' }],
});
eq('run Shopping con task in attesa resta in corso', [shoppingAperta.status, shoppingAperta.productsDone], ['in_corso', 1]);

const shoppingChiusa = computeRunStatus({
  productsTotal: 10, productsDone: 0, searchSource: 'shopping', startedAt: avvio, now: adesso,
  tasks: [{ status: 'completato' }, { status: 'errore' }],
});
eq('run Shopping con un errore diventa parziale', [shoppingChiusa.status, shoppingChiusa.errorMessage], ['parziale', '1 prodotti non elaborati']);

const shoppingTuttiFalliti = computeRunStatus({
  productsTotal: 2, productsDone: 0, searchSource: 'shopping', startedAt: avvio, now: adesso,
  tasks: [{ status: 'errore' }, { status: 'errore' }],
});
eq('run Shopping con tutti i task falliti e\' in errore', shoppingTuttiFalliti.status, 'errore');

// --- SERP in coda: la run ha task 'serp'; chiude quando i prodotti sono
//     tutti conclusi e nessun task e' in attesa.
const serpInCoda = computeRunStatus({
  productsTotal: 3, productsDone: 2, searchSource: 'serp', startedAt: avvio, now: adesso,
  tasks: [{ status: 'completato' }, { status: 'completato' }, { status: 'in_attesa' }],
});
eq('run SERP in coda con ricerche in attesa resta in corso', serpInCoda.status, 'in_corso');

const serpInCodaFinita = computeRunStatus({
  productsTotal: 3, productsDone: 3, searchSource: 'serp', startedAt: avvio, now: adesso,
  tasks: [{ status: 'completato' }, { status: 'completato' }, { status: 'errore' }],
});
eq('run SERP in coda conclusa con una ricerca fallita e\' parziale', serpInCodaFinita.status, 'parziale');

// --- Entrambe: servono sia il cursore SERP sia i task chiusi.
const entrambeMeta = computeRunStatus({
  productsTotal: 5, productsDone: 5, searchSource: 'entrambe', startedAt: avvio, now: adesso,
  tasks: [{ status: 'in_attesa' }],
});
eq('run Entrambe con SERP finita ma task aperti resta in corso', entrambeMeta.status, 'in_corso');

// --- 2. Microdata solo dentro il Product: il nome del sito in un breadcrumb
//        non deve diventare il titolo del prodotto (caso Pellizzari).
const paginaPellizzari = `<html><head>
<meta property="og:title" content="Pantaloni cropped blu a pois bianchi 5-8 anni"/>
<meta property="og:site_name" content="Pellizzari E-commerce"/>
<title>Pantaloni cropped blu a pois bianchi 5-8 anni | Pellizzari</title>
</head><body>
<div itemscope itemtype="http://schema.org/WebSite"><meta itemprop="name" content="Pellizzari E-commerce" /></div>
<ol itemscope itemtype="http://schema.org/BreadcrumbList"><li><span itemprop="name">Outlet</span></li></ol>
<div itemscope itemtype="http://schema.org/Product">
  <meta itemprop="sku" content="2815763" />
  <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
    <meta itemprop="price" content="17.70" /><meta itemprop="priceCurrency" content="EUR" />
  </div>
</div></body></html>`;

const estratto = extractProductFromHtml(paginaPellizzari);
eq('titolo da og:title, non dal microdata del sito', estratto.title, 'Pantaloni cropped blu a pois bianchi 5-8 anni');
eq('sku e prezzo dal microdata del Product', [estratto.sku, estratto.price, estratto.currency], ['2815763', 17.7, 'EUR']);

const brandAnnidato = extractProductFromHtml(
  '<html><head><meta property="og:title" content="Giubbino biker"></head><body><div itemscope itemtype="https://schema.org/Product"><div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><meta itemprop="name" content="Elsy"></div><meta itemprop="name" content="Giubbino biker blu"><meta itemprop="price" content="278.60"></div></body></html>',
);
eq('brand annidato nel microdata letto, titolo da og:title', [brandAnnidato.brand, brandAnnidato.title, brandAnnidato.price], ['Elsy', 'Giubbino biker', 278.6]);

const senzaProduct = extractProductFromHtml(
  '<html><head><title>Giacca blu | Negozio</title></head><body><span itemprop="name">Negozio</span></body></html>',
);
eq('senza Product il microdata viene ignorato e il title perde il suffisso', senzaProduct.title, 'Giacca blu');

// --- 3. Codici con spazi ("LIVIA 6608 374") riconosciuti nel testo del
//        candidato; codici corti no, per non combaciare per caso.
const conSpazi = scoreMatch(
  { title: 'Pantaloni cropped blu a pois bianchi', brand: 'Elsy', mpn: 'LIVIA 6608 374', price: 17.7 },
  { title: 'Elsy pantalone bambina art. LIVIA 6608 374 blu', price: 18 },
  'serp',
);
eq('codice con spazi riconosciuto', [conSpazi.method, conSpazi.accepted], ['mpn', true]);

const corto = scoreMatch(
  { title: 'Sedia', brand: 'Acme', mpn: 'A 12', price: 10 },
  { title: 'Tavolo a 12 posti', price: 300 },
  'serp',
);
eq('codice corto non combacia per caso', corto.method !== 'mpn', true);

// --- 4. Filtro SSRF: 0.0.0.0 e forme IPv6 bloccate, host pubblici no.
eq('0.0.0.0 bloccato', isPrivateHost('0.0.0.0'), true);
eq('::1 bloccato', isPrivateHost('[::1]'), true);
eq('IPv4 mappato in IPv6 bloccato', isPrivateHost('::ffff:127.0.0.1'), true);
eq('169.254 bloccato', isPrivateHost('169.254.169.254'), true);
eq('host pubblico ammesso', isPrivateHost('files.channable.com'), false);
eq('IP pubblico ammesso', isPrivateHost('8.8.8.8'), false);

// --- 5. Il parser del feed non tronca piu' di default.
const grande = `<rss><channel>${Array.from({ length: 6000 }, (_, i) => `<item><title>P${i}</title><g:price>1 EUR</g:price></item>`).join('')}</channel></rss>`;
eq('feed da 6000 righe letto per intero', parseFeedXml(grande).length, 6000);
eq('limite esplicito rispettato', parseFeedXml(grande, 10).length, 10);

// --- 6. Risposta dell'AI: JSON anche dentro recinti, id sconosciuti scartati.
const verdetti = parseVerdicts(
  'Ecco:\n```json\n[{"id":0,"stesso":true,"confidenza":0.9,"motivo":"Stesso codice 4521549"},{"id":7,"stesso":false,"confidenza":1,"motivo":"x"},{"id":1,"stesso":false,"confidenza":"alta","motivo":"Custodia"}]\n```',
  new Set([0, 1]),
);
eq('verdetti letti', verdetti.map((v) => [v.id, v.stesso, v.confidenza]), [[0, true, 0.9], [1, false, 0.5]]);
eq('risposta non JSON tollerata', parseVerdicts('non so', new Set([0])), []);

console.log(failed === 0 ? '\nLOGICA DI SCANSIONE: CONTROLLI SUPERATI' : `\nLOGICA DI SCANSIONE: ${failed} CONTROLLI FALLITI`);
process.exit(failed === 0 ? 0 : 1);
