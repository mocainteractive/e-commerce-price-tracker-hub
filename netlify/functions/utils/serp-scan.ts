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
 * Tre passaggi per prodotto, tutti con una scadenza comune (`deadline`):
 *   1. la ricerca su DataForSEO e il matching deterministico;
 *   2. per i candidati riconosciuti senza prezzo nello snippet, la lettura
 *      del prezzo dalla scheda del venditore (dati strutturati);
 *   3. per i candidati nella fascia incerta, la verifica AI.
 *
 * La scadenza esiste perche' tutto questo gira dentro una Netlify Function
 * da ~10 secondi: ogni passaggio riceve il tempo che resta e, se non basta,
 * viene saltato e annotato nella diagnostica invece di far morire la
 * funzione.
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
  MATCH_AI_LOW,
  MATCH_HIGH_SCORE,
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
import { fetchText } from './remote-fetch';
import { extractProductFromHtml } from './product-extract';
import { verificaCandidatiConAi, type AiCandidate } from './ai-match';
import type { AiCredentials } from './client-config';

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
  /** Il prezzo e' stato letto dalla scheda del venditore, non dallo snippet. */
  prezzoDaPagina?: boolean;
  /** Verdetto dell'AI, quando e' stata consultata. */
  ai?: { stesso: boolean; confidenza: number; motivo: string };
}

export interface QueryDiagnostica {
  query: string;
  tipo: 'principale' | 'ean';
  risultatiTotali: number;
  conPrezzo: number;
  candidati: CandidatoDiagnostica[];
  errore?: string;
  /** Quanti prezzi sono stati letti dalle schede dei venditori. */
  prezziDaPagina: number;
  /** Quanti candidati sono passati dall'AI. */
  aiVerificati: number;
  /** Passaggi saltati per mancanza di tempo o di configurazione. */
  note: string[];
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
  /** Istante (ms) entro cui bisogna aver finito. Senza, nessuna fretta. */
  deadline?: number;
  /** Credenziali per la verifica AI. Null = passaggio disattivato. */
  ai?: AiCredentials | null;
  /** Legge il prezzo dalla scheda del venditore quando lo snippet non lo ha. */
  pagePrices?: boolean;
  /**
   * Risultati gia' scaricati (ricerche in coda): per ogni tipo di ricerca gli
   * item della SERP oppure l'errore. Se presente, DataForSEO non viene
   * interrogato qui: e' il percorso delle scansioni.
   */
  risultati?: Partial<Record<'principale' | 'ean', OrganicItem[] | { errore: string }>>;
}

/** Quante schede di venditori leggere per ricerca. */
const MAX_PAGINE_PER_RICERCA = 3;
/** Quanti candidati incerti sottoporre all'AI per ricerca. */
const MAX_CANDIDATI_AI = 5;

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
  const subject = soggettoDi(product);

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

  const ricerche = costruisciRicerche(subject, options.cercaAncheEan ?? false);

  // Con i risultati precaricati contano solo le ricerche davvero eseguite.
  const precaricati = options.risultati;
  const daValutare = precaricati ? ricerche.filter((r) => precaricati[r.tipo] !== undefined) : ricerche;

  if (ricerche.length === 0) {
    diagnostica.query.push({
      ...queryVuota('', 'principale'),
      errore: 'Prodotto senza titolo, marca o codice: impossibile costruire una ricerca',
    });
    return diagnostica;
  }

  const offerte = new Map<string, OfferCandidate>();

  for (const ricerca of daValutare) {
    const esito = await eseguiRicerca(dfs, ricerca, subject, product, settings, contesto, options);
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

export interface Ricerca {
  query: string;
  tipo: 'principale' | 'ean';
}

/** Le ricerche di un prodotto: principale (marca, codice, titolo) e, a richiesta, EAN. */
export function costruisciRicerche(subject: MatchSubject, cercaAncheEan: boolean): Ricerca[] {
  const ricerche: Ricerca[] = [];
  const principale = buildSearchQuery(subject);
  if (principale) ricerche.push({ query: principale, tipo: 'principale' });
  if (cercaAncheEan) {
    const ean = buildGtinQuery(subject);
    if (ean) ricerche.push({ query: ean, tipo: 'ean' });
  }
  return ricerche;
}

export function soggettoDi(product: ProductRow): MatchSubject {
  return {
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    mpn: product.mpn,
    sku: product.sku,
    price: product.own_price,
  };
}

function queryVuota(query: string, tipo: 'principale' | 'ean'): QueryDiagnostica {
  return {
    query,
    tipo,
    risultatiTotali: 0,
    conPrezzo: 0,
    candidati: [],
    prezziDaPagina: 0,
    aiVerificati: 0,
    note: [],
  };
}

/** Candidato in lavorazione: risultato grezzo, verdetto e diagnostica insieme. */
interface Candidato {
  item: OrganicItem;
  dominio: string;
  verdetto: MatchVerdict;
  diagnostica: CandidatoDiagnostica;
  /** Prezzo corrente, dallo snippet o dalla scheda. */
  prezzo: number | null;
  valuta: string | null;
}

async function eseguiRicerca(
  dfs: DataForSeoClient,
  ricerca: { query: string; tipo: 'principale' | 'ean' },
  subject: MatchSubject,
  product: ProductRow,
  settings: ScanSettings,
  contesto: { ownDomains: Set<string>; excludedDomains: Set<string> },
  options: SerpScanOptions,
): Promise<{ offerte: OfferCandidate[]; diagnostica: QueryDiagnostica }> {
  const diagnostica = queryVuota(ricerca.query, ricerca.tipo);
  const tempoResiduo = () => (options.deadline ?? Number.POSITIVE_INFINITY) - Date.now();

  // 1. Risultati: precaricati dalla coda, oppure ricerca live (diagnostica).
  let items: OrganicItem[];
  const precaricato = options.risultati?.[ricerca.tipo];

  if (precaricato !== undefined) {
    if (!Array.isArray(precaricato)) {
      diagnostica.errore = precaricato.errore;
      return { offerte: [], diagnostica };
    }
    items = precaricato.filter((i) => i.type === 'organic');
  } else {
    // Percorso live, usato solo da "Prova la ricerca": alla ricerca va quasi
    // tutto il tempo, i passaggi successivi si adattano a quel che resta.
    const timeoutRicerca = limita(tempoResiduo() - 800, 1500, 8000);
    try {
      const risultato = await dfs.organicLive(ricerca.query, settings.location_code, settings.language_code, 30, timeoutRicerca);
      items = (risultato?.items ?? []).filter((i) => i.type === 'organic');
    } catch (err) {
      diagnostica.errore = (err as Error).message;
      return { offerte: [], diagnostica };
    }
  }
  diagnostica.risultatiTotali = items.length;

  if (items.length === 0) {
    diagnostica.errore = 'La ricerca non ha restituito risultati organici';
    return { offerte: [], diagnostica };
  }

  const candidati: Candidato[] = [];
  const scartati: CandidatoDiagnostica[] = [];

  for (const item of items) {
    const esito = valuta(item, subject, contesto);
    if ('candidato' in esito) candidati.push(esito.candidato);
    else scartati.push(esito.diagnostica);
  }

  // 2. Prezzo dalla scheda del venditore, per chi e' riconosciuto (o quasi)
  //    ma non mostra il prezzo nello snippet.
  if (options.pagePrices !== false) {
    diagnostica.prezziDaPagina = await leggiPrezziDallePagine(candidati, tempoResiduo, diagnostica.note);
  }

  // 3. Verifica AI dei candidati nella fascia incerta.
  if (options.ai) {
    diagnostica.aiVerificati = await verificaConAi(candidati, subject, product, options.ai, tempoResiduo, diagnostica.note);
  } else {
    diagnostica.note.push('Verifica AI non attiva: manca ANTHROPIC_API_KEY fra le configurazioni del cliente');
  }

  // 4. Offerte finali.
  const offerte: OfferCandidate[] = [];
  for (const c of candidati) {
    c.diagnostica.prezzo = c.prezzo;
    c.diagnostica.valuta = c.valuta;
    if (c.prezzo !== null) diagnostica.conPrezzo += 1;

    if (!c.diagnostica.accettato) continue;
    if (c.prezzo === null) {
      c.diagnostica.accettato = false;
      c.diagnostica.motivo = `${c.diagnostica.motivo}. Prodotto riconosciuto, ma senza prezzo ne' nello snippet ne' nella scheda`;
      continue;
    }

    offerte.push({
      domain: c.dominio,
      sellerName: c.item.website_name ?? c.dominio,
      offerUrl: pulisciUrl(c.item.url ?? ''),
      offerTitle: c.item.title ?? '',
      price: c.prezzo,
      shippingPrice: null,
      totalPrice: null,
      currency: c.valuta ?? product.currency ?? settings.currency,
      availability: null,
      condition: null,
      matchMethod: c.diagnostica.metodo as OfferCandidate['matchMethod'],
      confidence: c.diagnostica.punteggio ?? c.verdetto.score,
    });
  }

  diagnostica.candidati = [...candidati.map((c) => c.diagnostica), ...scartati].sort(
    (a, b) => (a.posizione ?? 999) - (b.posizione ?? 999),
  );

  return { offerte, diagnostica };
}

/**
 * Valutazione deterministica di un risultato. I domini propri o esclusi non
 * diventano candidati: restano in diagnostica con il motivo.
 */
function valuta(
  item: OrganicItem,
  subject: MatchSubject,
  contesto: { ownDomains: Set<string>; excludedDomains: Set<string> },
): { candidato: Candidato } | { diagnostica: CandidatoDiagnostica } {
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

  if (!dominio) return { diagnostica: { ...base, motivo: 'Dominio non riconoscibile' } };
  if (contesto.ownDomains.has(dominio)) return { diagnostica: { ...base, motivo: 'E\' il tuo sito' } };
  if (contesto.excludedDomains.has(dominio)) {
    return { diagnostica: { ...base, motivo: 'Dominio escluso manualmente' } };
  }

  // Il matching si fa comunque, anche senza prezzo: sapere che il prodotto
  // e' stato riconosciuto ma lo snippet non mostrava il prezzo e' una
  // informazione diversa da "non l'abbiamo trovato".
  const verdetto = scoreMatch(
    subject,
    { title: item.title ?? '', description: item.description, domain: dominio, price: prezzo },
    'serp',
  );

  const diagnostica: CandidatoDiagnostica = {
    ...base,
    punteggio: Number(verdetto.score.toFixed(3)),
    metodo: verdetto.method,
    accettato: verdetto.accepted,
    motivo: verdetto.accepted
      ? `Accettato: ${verdetto.reasons.join(', ')}`
      : `Non e' lo stesso prodotto: ${verdetto.reasons.join(', ')}`,
  };

  return {
    candidato: { item, dominio, verdetto, diagnostica, prezzo, valuta: item.price?.currency ?? null },
  };
}

/** Chi merita la lettura della scheda: riconosciuto, o incerto ma con l'AI che potra' decidere. */
function meritaLaPagina(c: Candidato): boolean {
  return c.prezzo === null && Boolean(c.item.url) && c.verdetto.score >= MATCH_AI_LOW;
}

async function leggiPrezziDallePagine(
  candidati: Candidato[],
  tempoResiduo: () => number,
  note: string[],
): Promise<number> {
  const daLeggere = candidati.filter(meritaLaPagina).slice(0, MAX_PAGINE_PER_RICERCA);
  if (daLeggere.length === 0) return 0;

  // Almeno un secondo per l'AI dopo, e non piu' di 2,5 secondi qui.
  const budget = limita(tempoResiduo() - 1200, 0, 2500);
  if (budget < 700) {
    note.push(`Lettura delle schede saltata: tempo insufficiente (${daLeggere.length} da leggere)`);
    return 0;
  }

  const esiti = await Promise.all(
    daLeggere.map(async (c) => {
      try {
        const { body } = await fetchText(c.item.url as string, {
          budgetMs: budget,
          maxBytes: 3 * 1024 * 1024,
          accept: 'text/html,application/xhtml+xml',
        });
        const estratto = extractProductFromHtml(body);
        return estratto.price !== null ? { c, prezzo: estratto.price, valuta: estratto.currency } : null;
      } catch (err) {
        console.warn(`[serp] Scheda ${c.dominio} non leggibile: ${(err as Error).message}`);
        return null;
      }
    }),
  );

  let letti = 0;
  for (const esito of esiti) {
    if (!esito) continue;
    esito.c.prezzo = esito.prezzo;
    esito.c.valuta = esito.valuta ?? esito.c.valuta;
    esito.c.diagnostica.prezzoDaPagina = true;
    esito.c.diagnostica.motivo = `${esito.c.diagnostica.motivo} (prezzo letto dalla scheda)`;
    letti += 1;
  }
  return letti;
}

/** Nella fascia incerta e con un prezzo: e' li' che un verdetto cambia il risultato. */
function meritaLaVerificaAi(c: Candidato): boolean {
  if (c.verdetto.method === 'gtin' || c.verdetto.method === 'mpn') return false;
  if (c.prezzo === null) return false;
  return c.verdetto.score >= MATCH_AI_LOW && c.verdetto.score < MATCH_HIGH_SCORE;
}

async function verificaConAi(
  candidati: Candidato[],
  subject: MatchSubject,
  product: ProductRow,
  ai: AiCredentials,
  tempoResiduo: () => number,
  note: string[],
): Promise<number> {
  const incerti = candidati.filter(meritaLaVerificaAi).slice(0, MAX_CANDIDATI_AI);
  if (incerti.length === 0) return 0;

  const budget = limita(tempoResiduo() - 700, 0, 6000);
  if (budget < 1800) {
    note.push(`Verifica AI saltata: tempo insufficiente (${incerti.length} candidati incerti)`);
    return 0;
  }

  const richiesta: AiCandidate[] = incerti.map((c, id) => ({
    id,
    title: c.item.title ?? '',
    description: c.item.description ?? null,
    domain: c.dominio,
    price: c.prezzo,
    currency: c.valuta,
  }));

  let verdetti;
  try {
    verdetti = await verificaCandidatiConAi(
      ai.apiKey,
      {
        title: subject.title,
        brand: subject.brand ?? null,
        mpn: subject.mpn ?? null,
        gtin: subject.gtin ?? null,
        price: subject.price ?? null,
        currency: product.currency,
      },
      richiesta,
      { timeoutMs: budget, model: ai.model },
    );
  } catch (err) {
    note.push(`Verifica AI non riuscita: ${(err as Error).message.slice(0, 120)}`);
    return 0;
  }

  let verificati = 0;
  for (const verdetto of verdetti) {
    const c = incerti[verdetto.id];
    if (!c) continue;
    verificati += 1;

    c.diagnostica.ai = { stesso: verdetto.stesso, confidenza: verdetto.confidenza, motivo: verdetto.motivo };

    if (verdetto.stesso && verdetto.confidenza >= 0.6) {
      c.diagnostica.accettato = true;
      c.diagnostica.metodo = 'ai';
      c.diagnostica.punteggio = Number(verdetto.confidenza.toFixed(3));
      c.diagnostica.motivo = `Confermato dall'AI: ${verdetto.motivo}`;
    } else if (!verdetto.stesso) {
      c.diagnostica.accettato = false;
      c.diagnostica.motivo = `Scartato dall'AI: ${verdetto.motivo}`;
    }
    // "stesso" con confidenza bassa: resta il verdetto deterministico.
  }
  return verificati;
}

function leggiPrezzo(item: OrganicItem): number | null {
  const valore = item.price?.current ?? item.price?.regular ?? null;
  if (typeof valore !== 'number' || !Number.isFinite(valore) || valore <= 0) return null;
  // Un intervallo di prezzo ("da 20 a 50 €") non e' confrontabile.
  if (item.price?.is_price_range) return null;
  return Math.round(valore * 100) / 100;
}

function limita(valore: number, min: number, max: number): number {
  if (!Number.isFinite(valore)) return max;
  return Math.min(Math.max(valore, min), max);
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

/** Riassunto di una diagnostica prodotto, per il diario della scansione. */
export function riassumi(d: ProdottoDiagnostica) {
  const somma = (f: (q: QueryDiagnostica) => number) => d.query.reduce((sum, q) => sum + f(q), 0);
  return {
    titolo: d.titolo,
    query: d.query.map((q) => q.query),
    risultati: somma((q) => q.risultatiTotali),
    conPrezzo: somma((q) => q.conPrezzo),
    accettati: somma((q) => q.candidati.filter((c) => c.accettato).length),
    prezziDaPagina: somma((q) => q.prezziDaPagina),
    aiVerificati: somma((q) => q.aiVerificati),
    offerteSalvate: d.offerteSalvate,
    errore: d.query.find((q) => q.errore)?.errore ?? null,
  };
}
