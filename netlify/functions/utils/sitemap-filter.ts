/**
 * Riconoscimento delle pagine prodotto dentro una sitemap.
 *
 * Una sitemap elenca tutto: categorie, blog, pagine informative, tag, filtri.
 * Scaricarle tutte significa sprecare la parte piu' lenta dell'import (una
 * richiesta di rete per pagina) su URL che non contengono un prodotto.
 *
 * Le regole sono euristiche perche' non esiste uno standard, ma coprono le
 * piattaforme diffuse. Restano sovrascrivibili dalle impostazioni del
 * cliente, perche' nessuna euristica indovina ogni sito.
 */

/** Segmenti tipici delle URL di scheda prodotto. */
const INDIZI_PRODOTTO = [
  '/products/', // Shopify
  '/product/', // WooCommerce
  '/prodotto/', // WooCommerce italiano
  '/prodotti/',
  '/p/',
  '/dp/', // Amazon
  '/item/',
  '/articolo/',
  '/shop/',
];

/** Sezioni che non contengono mai una scheda prodotto. */
const ESCLUSIONI = [
  '/blog',
  '/news',
  '/magazine',
  '/articoli',
  '/collections/', // Shopify: elenco, non scheda
  '/collection/',
  '/categoria',
  '/categorie',
  '/category',
  '/category/',
  '/tag/',
  '/tags/',
  '/brand/',
  '/marche',
  '/cart',
  '/carrello',
  '/checkout',
  '/account',
  '/login',
  '/search',
  '/ricerca',
  '/pages/',
  '/pagine/',
  '/policies/',
  '/informazioni',
  '/contatti',
  '/contact',
  '/faq',
  '/chi-siamo',
  '/about',
  '/privacy',
  '/cookie',
  '/termini',
  '/terms',
  '/sitemap',
  '/feed',
  '/wp-content/',
  '/wp-json/',
];

/** Estensioni di file che non sono pagine. */
const ESTENSIONI_NON_PAGINA = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|xml|json|css|js)(\?|$)/i;

export interface RegoleSitemap {
  /** Se valorizzato, una URL deve contenere almeno uno di questi frammenti. */
  include: string[];
  /** Frammenti che escludono la URL. Si sommano a quelli automatici. */
  exclude: string[];
}

export interface EsitoFiltro {
  urls: string[];
  /** Quante URL sono state scartate, per motivo. Serve al diario dell'import. */
  scartate: {
    totale: number;
    perEsclusione: number;
    perNonProdotto: number;
    perEstensione: number;
    perDuplicato: number;
  };
}

/**
 * Filtra le URL di una sitemap tenendo solo le probabili schede prodotto.
 *
 * Con `include` esplicito comanda quello e basta. Senza, si applica
 * l'euristica: prima si scartano le sezioni note, poi si tengono le URL che
 * hanno un indizio di prodotto; se nessuna ce l'ha (sito con URL piatte,
 * tipo `/nome-prodotto`), si tengono tutte quelle sopravvissute alle
 * esclusioni, perche' meglio qualche pagina in piu' che un import vuoto.
 */
export function filtraUrlProdotto(urls: string[], regole: RegoleSitemap): EsitoFiltro {
  const scartate = {
    totale: 0,
    perEsclusione: 0,
    perNonProdotto: 0,
    perEstensione: 0,
    perDuplicato: 0,
  };

  const viste = new Set<string>();
  const sopravvissute: string[] = [];

  const esclusioni = [...ESCLUSIONI, ...regole.exclude.map((p) => p.toLowerCase())];
  const include = regole.include.map((p) => p.toLowerCase()).filter(Boolean);

  for (const url of urls) {
    const normalizzata = url.trim();
    if (!normalizzata) continue;

    const minuscola = normalizzata.toLowerCase();

    if (viste.has(minuscola)) {
      scartate.perDuplicato += 1;
      continue;
    }
    viste.add(minuscola);

    if (ESTENSIONI_NON_PAGINA.test(minuscola)) {
      scartate.perEstensione += 1;
      continue;
    }

    // Con regole esplicite del cliente, decidono solo quelle.
    if (include.length > 0) {
      if (include.some((frammento) => minuscola.includes(frammento))) sopravvissute.push(normalizzata);
      else scartate.perNonProdotto += 1;
      continue;
    }

    if (esclusioni.some((frammento) => minuscola.includes(frammento))) {
      scartate.perEsclusione += 1;
      continue;
    }

    sopravvissute.push(normalizzata);
  }

  // Fra le sopravvissute, se qualcuna ha un indizio esplicito di prodotto
  // teniamo solo quelle: e' il segnale piu' affidabile che abbiamo.
  const conIndizio = sopravvissute.filter((url) =>
    INDIZI_PRODOTTO.some((indizio) => url.toLowerCase().includes(indizio)),
  );

  const finali = include.length === 0 && conIndizio.length > 0 ? conIndizio : sopravvissute;
  scartate.perNonProdotto += sopravvissute.length - finali.length;
  scartate.totale =
    scartate.perEsclusione + scartate.perNonProdotto + scartate.perEstensione + scartate.perDuplicato;

  return { urls: finali, scartate };
}
