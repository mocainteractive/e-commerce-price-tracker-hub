/**
 * Scansione prezzi tramite la SERP organica di Google.
 *
 * Perche' questa e' la fonte principale
 * -------------------------------------
 * Gli endpoint Google Shopping di DataForSEO sono asincroni: si accodano i
 * task e si aspetta. La SERP organica e' **sincrona** e i suoi item portano
 * gia' il prezzo mostrato nello snippet, che gli e-commerce espongono quasi
 * sempre. Risultato: si vede subito se una scansione funziona, invece di
 * restare con "0 offerte trovate" senza sapere perche'.
 *
 * Ogni scansione produce una diagnostica completa (query inviata, risultati
 * grezzi, punteggio e motivo di scarto di ogni candidato): e' quella che
 * permette di capire un catalogo che non trova nulla, invece di indovinare.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataForSeoClient, OrganicItem } from './dataforseo';
import {
  buildGtinQuery,
  buildSearchQuery,
  normalizeDomain,
  scoreMatch,
  type MatchSubject,
  type MatchVerdict,
} from './matching';
import {
  persistOffers,
  type OfferCandidate,
  type ProductRow,
  type ScanSettings,
} from './scan-processing';

/** Esito della valutazione di un singolo risultato della SERP. */
export interface CandidatoDiagnostica {
  posizione: number | null;
  dominio: string | null;
  titolo: string;
  url: string | null;
  prezzo: number | null;
  valuta: string | null;
  punteggio: number | null;
  metodo: string | null;
  accettato: boolean;
  /** Perche' e' stato tenuto o scartato, in italiano. */
  motivo: string;
}

export interface QueryDiagnostica {
  query: string;
  tipo: 'principale' | 'ean';
  risultatiTotali: number;
  conPrezzo: number;
  candidati: CandidatoDiagnostica[];
  errore?: string;
}

export interface ProdottoDiagnostica {
  productId: string;
  titolo: string;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  nostroPrezzo: number | null;
  query: QueryDiagnostica[];
  offerteSalvate: number;
  dominiEsclusi: string[];
}

export interface SerpScanOptions {
  /** Se true non scrive nulla: serve alla diagnostica. */
  soloDiagnostica?: boolean;
  runId?: string | null;
  /** Aggiunge una seconda ricerca sul solo EAN. Costa una chiamata in piu'. */
  cercaAncheEan?: boolean;
}

/**
 * Analizza un prodotto. Non lancia: un prodotto problematico non deve
 * interrompere la scansione, e la diagnostica riporta comunque il motivo.
 */
export async function scansionaProdotto(
  db: SupabaseClient,
  dfs: DataForSeoClient,
  product: ProductRow,
  settings: ScanSettings,
  contesto: { ownDomains: Set<string>; excludedDomains: Set<string> },
  options: SerpScanOptions = {},
): Promise<ProdottoDiagnostica> {
  const subject: MatchSubject = {
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    mpn: product.mpn,
    sku: product.sku,
    price: product.own_price,
  };

  const diagnostica: ProdottoDiagnostica = {
    productId: product.id,
    titolo: product.title,
    brand: product.brand,
    gtin: product.gtin,
    mpn: product.mpn,
    nostroPrezzo: product.own_price,
    query: [],
    offerteSalvate: 0,
    dominiEsclusi: [...contesto.ownDomains, ...contesto.excludedDomains],
  };

  const ricerche: Array<{ query: string; tipo: 'principale' | 'ean' }> = [];

  const principale = buildSearchQuery(subject);
  if (principale) ricerche.push({ query: principale, tipo: 'principale' });

  if (options.cercaAncheEan) {
    const ean = buildGtinQuery(subject);
    if (ean) ricerche.push({ query: ean, tipo: 'ean' });
  }

  if (ricerche.length === 0) {
    diagnostica.query.push({
      query: '',
      tipo: 'principale',
      risultatiTotali: 0,
      conPrezzo: 0,
      candidati: [],
      errore: 'Prodotto senza titolo, marca o codice: impossibile costruire una ricerca',
    });
    return diagnostica;
  }

  const offerte = new Map<string, OfferCandidate>();

  for (const ricerca of ricerche) {
    const esito = await eseguiRicerca(dfs, ricerca, subject, settings, contesto);
    diagnostica.query.push(esito.diagnostica);

    for (const offerta of esito.offerte) {
      const esistente = offerte.get(offerta.domain);
      // A parita' di dominio teniamo l'offerta piu' bassa.
      if (!esistente || offerta.price < esistente.price) offerte.set(offerta.domain, offerta);
    }
  }

  if (!options.soloDiagnostica && offerte.size > 0) {
    diagnostica.offerteSalvate = await persistOffers(
      db,
      {
        runId: options.runId ?? null,
        source: 'serp_organica',
        defaultMatchMethod: 'serp',
        defaultConfidence: 0.7,
      },
      product,
      [...offerte.values()],
      settings,
    );
  }

  return diagnostica;
}

async function eseguiRicerca(
  dfs: DataForSeoClient,
  ricerca: { query: string; tipo: 'principale' | 'ean' },
  subject: MatchSubject,
  settings: ScanSettings,
  contesto: { ownDomains: Set<string>; excludedDomains: Set<string> },
): Promise<{ offerte: OfferCandidate[]; diagnostica: QueryDiagnostica }> {
  const diagnostica: QueryDiagnostica = {
    query: ricerca.query,
    tipo: ricerca.tipo,
    risultatiTotali: 0,
    conPrezzo: 0,
    candidati: [],
  };

  let risultato;
  try {
    risultato = await dfs.organicLive(ricerca.query, settings.location_code, settings.language_code);
  } catch (err) {
    diagnostica.errore = (err as Error).message;
    return { offerte: [], diagnostica };
  }

  const items = (risultato?.items ?? []).filter((i) => i.type === 'organic');
  diagnostica.risultatiTotali = items.length;

  if (items.length === 0) {
    diagnostica.errore = 'La ricerca non ha restituito risultati organici';
    return { offerte: [], diagnostica };
  }

  const offerte: OfferCandidate[] = [];

  for (const item of items) {
    const candidato = valuta(item, subject, contesto);
    diagnostica.candidati.push(candidato.diagnostica);
    if (candidato.diagnostica.prezzo !== null) diagnostica.conPrezzo += 1;
    if (candidato.offerta) offerte.push(candidato.offerta);
  }

  return { offerte, diagnostica };
}

function valuta(
  item: OrganicItem,
  subject: MatchSubject,
  contesto: { ownDomains: Set<string>; excludedDomains: Set<string> },
): { offerta: OfferCandidate | null; diagnostica: CandidatoDiagnostica } {
  const dominio = normalizeDomain(item.domain ?? item.url);
  const prezzo = leggiPrezzo(item);

  const base: CandidatoDiagnostica = {
    posizione: item.rank_absolute ?? null,
    dominio,
    titolo: item.title ?? '',
    url: item.url ?? null,
    prezzo,
    valuta: item.price?.currency ?? null,
    punteggio: null,
    metodo: null,
    accettato: false,
    motivo: '',
  };

  if (!dominio) {
    return { offerta: null, diagnostica: { ...base, motivo: 'Dominio non riconoscibile' } };
  }
  if (contesto.ownDomains.has(dominio)) {
    return { offerta: null, diagnostica: { ...base, motivo: 'E\' il tuo sito' } };
  }
  if (contesto.excludedDomains.has(dominio)) {
    return { offerta: null, diagnostica: { ...base, motivo: 'Dominio escluso manualmente' } };
  }

  // Il matching si fa comunque, anche senza prezzo: sapere che il prodotto
  // e' stato riconosciuto ma lo snippet non mostrava il prezzo e' una
  // informazione diversa da "non l'abbiamo trovato".
  const verdetto: MatchVerdict = scoreMatch(
    subject,
    {
      title: item.title ?? '',
      description: item.description,
      domain: dominio,
      price: prezzo,
    },
    'serp',
  );

  const diagnostica: CandidatoDiagnostica = {
    ...base,
    punteggio: Number(verdetto.score.toFixed(3)),
    metodo: verdetto.method,
  };

  if (!verdetto.accepted) {
    return {
      offerta: null,
      diagnostica: { ...diagnostica, motivo: `Non e' lo stesso prodotto: ${verdetto.reasons.join(', ')}` },
    };
  }

  if (prezzo === null) {
    return {
      offerta: null,
      diagnostica: {
        ...diagnostica,
        motivo: 'Prodotto riconosciuto, ma lo snippet non mostrava il prezzo',
      },
    };
  }

  return {
    offerta: {
      domain: dominio,
      sellerName: item.website_name ?? dominio,
      offerUrl: pulisciUrl(item.url ?? ''),
      offerTitle: item.title ?? '',
      price: prezzo,
      shippingPrice: null,
      totalPrice: null,
      currency: item.price?.currency ?? subjectCurrency(subject),
      availability: null,
      condition: null,
      matchMethod: verdetto.method,
      confidence: verdetto.score,
    },
    diagnostica: {
      ...diagnostica,
      accettato: true,
      motivo: `Accettato: ${verdetto.reasons.join(', ')}`,
    },
  };
}

function leggiPrezzo(item: OrganicItem): number | null {
  const valore = item.price?.current ?? item.price?.regular ?? null;
  if (typeof valore !== 'number' || !Number.isFinite(valore) || valore <= 0) return null;
  // Un intervallo di prezzo ("da 20 a 50 €") non e' confrontabile.
  if (item.price?.is_price_range) return null;
  return Math.round(valore * 100) / 100;
}

function subjectCurrency(subject: MatchSubject): string {
  void subject;
  return 'EUR';
}

/** Toglie i parametri di tracciamento che Google aggiunge alle URL. */
function pulisciUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    for (const chiave of ['srsltid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign']) {
      parsed.searchParams.delete(chiave);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Domini del cliente e domini esclusi a mano, letti una volta per scansione. */
export async function caricaContestoDomini(
  db: SupabaseClient,
  clientId: string,
): Promise<{ ownDomains: Set<string>; excludedDomains: Set<string> }> {
  const [{ data: competitors }, { data: settings }] = await Promise.all([
    db.from('pt_competitors').select('domain, is_own').eq('client_id', clientId),
    db.from('pt_settings').select('own_domain').eq('client_id', clientId).maybeSingle(),
  ]);

  const ownDomains = new Set<string>();
  for (const row of competitors ?? []) {
    if (row.is_own) ownDomains.add(row.domain as string);
  }
  const proprio = normalizeDomain(settings?.own_domain ?? null);
  if (proprio) ownDomains.add(proprio);

  return { ownDomains, excludedDomains: new Set<string>() };
}

/**
 * Domini esclusi a mano per QUESTO prodotto.
 *
 * L'esclusione resta per prodotto e non per cliente: lo stesso venditore puo'
 * essere un competitor legittimo su un articolo e un falso positivo su un
 * altro (una custodia scambiata per l'apparecchio, per esempio).
 */
export async function caricaEsclusiProdotto(
  db: SupabaseClient,
  productId: string,
): Promise<Set<string>> {
  const { data } = await db
    .from('pt_matches')
    .select('domain')
    .eq('product_id', productId)
    .eq('status', 'escluso');

  return new Set((data ?? []).map((m) => m.domain as string));
}
