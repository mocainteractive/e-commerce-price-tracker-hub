/**
 * Motore di matching prodotto.
 *
 * Il problema: lo stesso articolo compare sui vari e-commerce con titoli
 * diversi ("Sony WH-1000XM5 Nero" vs "Cuffie Sony WH1000XM5 wireless, black").
 * La gerarchia di affidabilita' e' sempre la stessa:
 *
 *   1. GTIN/EAN  -> identificatore globale, match certo
 *   2. MPN/SKU   -> codice produttore, match quasi certo
 *   3. Titolo + brand + prossimita' di prezzo -> match probabilistico
 *
 * Il punteggio finale (0..1) viene salvato in `pt_matches.confidence` e
 * mostrato in UI, cosi' l'utente puo' confermare o escludere i casi incerti.
 */

/** Soglia minima per considerare un candidato. Sotto questa, si scarta. */
export const MATCH_MIN_SCORE = 0.62;
/** Sopra questa soglia il match e' considerato affidabile senza revisione. */
export const MATCH_HIGH_SCORE = 0.8;

const STOPWORDS = new Set([
  // italiano
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'del',
  'della', 'dei', 'delle', 'con', 'per', 'in', 'su', 'e', 'ed', 'o', 'al',
  'alla', 'nuovo', 'nuova', 'originale', 'offerta', 'sconto', 'spedizione',
  'gratis', 'garanzia', 'italia', 'prezzo',
  // inglese
  'the', 'a', 'an', 'of', 'for', 'with', 'and', 'or', 'new', 'original',
  'free', 'shipping', 'sale', 'best',
]);

/** Minuscolo, senza accenti e senza punteggiatura. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Token che sembrano codici prodotto: contengono cifre oppure sono
 * alfanumerici lunghi (es. "wh1000xm5", "a2442", "mkgp3ty").
 */
export function extractCodeTokens(input: string): string[] {
  return tokenize(input).filter((t) => /\d/.test(t) && t.length >= 3);
}

/** Similarita' di Dice sugli insiemi di token: robusta a parole in piu'. */
export function tokenSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;

  return (2 * shared) / (setA.size + setB.size);
}

/** Valida la cifra di controllo di un GTIN-8/12/13/14. */
export function isValidGtin(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;

  const body = digits.slice(0, -1).split('').reverse().map(Number);
  const checkDigit = Number(digits.slice(-1));

  const sum = body.reduce((acc, digit, index) => acc + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!isValidGtin(digits)) return null;
  // UPC-A a 12 cifre e' un EAN-13 con lo zero iniziale: normalizziamo a 13.
  return digits.length === 12 ? `0${digits}` : digits;
}

/** Hostname senza `www.`, in minuscolo. Null se l'URL non e' valido. */
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Quanto i due prezzi sono compatibili con "stesso prodotto" (0..1).
 * Serve a scartare accessori e confezioni multiple che hanno titoli simili.
 */
export function priceProximity(reference: number | null, candidate: number | null): number {
  if (!reference || !candidate || reference <= 0 || candidate <= 0) return 0.5; // neutro
  const ratio = Math.min(reference, candidate) / Math.max(reference, candidate);
  if (ratio >= 0.85) return 1;
  if (ratio >= 0.6) return 0.75;
  if (ratio >= 0.4) return 0.4;
  return 0; // scarto di oltre il 60%: quasi certamente un altro articolo
}

export interface MatchSubject {
  title: string;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
  price?: number | null;
}

export interface MatchCandidate {
  title: string;
  description?: string | null;
  seller?: string | null;
  domain?: string | null;
  price?: number | null;
}

export type MatchMethod = 'gtin' | 'mpn' | 'google_shopping' | 'serp' | 'manual';

export interface MatchVerdict {
  score: number;
  method: MatchMethod;
  /** Motivazioni in italiano, mostrate in UI accanto al match. */
  reasons: string[];
  accepted: boolean;
}

/**
 * Confronta un prodotto del catalogo con un candidato trovato online.
 * `sourceMethod` distingue i candidati di Google Shopping da quelli SERP.
 */
export function scoreMatch(
  subject: MatchSubject,
  candidate: MatchCandidate,
  sourceMethod: 'google_shopping' | 'serp' = 'google_shopping',
): MatchVerdict {
  const haystack = normalizeText(
    [candidate.title, candidate.description ?? ''].filter(Boolean).join(' '),
  );
  const reasons: string[] = [];

  // 1. GTIN: se il codice compare nel candidato il match e' certo.
  const gtin = normalizeGtin(subject.gtin);
  if (gtin) {
    const compact = haystack.replace(/\s+/g, '');
    const withoutLeadingZero = gtin.replace(/^0+/, '');
    if (compact.includes(gtin) || compact.includes(withoutLeadingZero)) {
      return {
        score: 1,
        method: 'gtin',
        reasons: [`Codice EAN ${gtin} presente nell'annuncio`],
        accepted: true,
      };
    }
  }

  // 2. MPN / SKU: codice produttore nel titolo del candidato.
  const codes = [subject.mpn, subject.sku]
    .filter((c): c is string => Boolean(c && c.length >= 4))
    .map((c) => normalizeText(c).replace(/\s+/g, ''));

  const candidateCodes = extractCodeTokens(haystack).map((t) => t.replace(/\s+/g, ''));
  const codeHit = codes.find((code) => candidateCodes.some((c) => c === code || c.includes(code)));

  if (codeHit) {
    const proximity = priceProximity(subject.price ?? null, candidate.price ?? null);
    const score = Math.min(1, 0.9 + proximity * 0.1);
    return {
      score,
      method: 'mpn',
      reasons: [`Codice prodotto ${codeHit.toUpperCase()} presente nell'annuncio`],
      accepted: true,
    };
  }

  // 3. Match probabilistico: titolo + brand + prezzo.
  const titleSim = tokenSimilarity(subject.title, candidate.title);
  reasons.push(`Somiglianza titolo ${(titleSim * 100).toFixed(0)}%`);

  let brandScore = 0.5; // neutro se il brand non e' noto
  if (subject.brand) {
    const brand = normalizeText(subject.brand);
    const brandInTitle = brand.length > 1 && haystack.includes(brand);
    brandScore = brandInTitle ? 1 : 0;
    reasons.push(brandInTitle ? `Brand ${subject.brand} confermato` : `Brand ${subject.brand} non trovato`);
  }

  const proximity = priceProximity(subject.price ?? null, candidate.price ?? null);
  if (subject.price && candidate.price) {
    reasons.push(
      proximity >= 0.75
        ? 'Prezzo coerente con il nostro'
        : 'Prezzo molto diverso dal nostro',
    );
  }

  const score = Number((titleSim * 0.7 + brandScore * 0.18 + proximity * 0.12).toFixed(3));

  return {
    score,
    method: sourceMethod,
    reasons,
    accepted: score >= MATCH_MIN_SCORE,
  };
}

/**
 * Query di ricerca del prodotto sui motori.
 *
 * **Mai il solo codice EAN.** Sembrava la scelta ovvia (e' l'identificatore
 * piu' preciso) ed e' stata la causa di scansioni a vuoto: su Google un
 * numero isolato porta pochi risultati pertinenti e molti completamente
 * estranei, perche' i venditori raramente pubblicano l'EAN nel testo.
 *
 * Verificato sul campo con `Venezianico Arsenale 37 6121503C`, che trova
 * quattro venditori con prezzo, contro l'EAN `8056590473955` che nelle stesse
 * posizioni restituisce ammorbidenti e shampoo.
 *
 * La forma che funziona e' quella che userebbe una persona: marca, codice
 * modello e nome del prodotto.
 */
export function buildSearchQuery(subject: MatchSubject): string {
  const parts = [subject.brand, subject.mpn ?? subject.sku, subject.title]
    .filter((p): p is string => Boolean(p?.trim()))
    .map((p) => p.trim());

  if (parts.length === 0) return '';

  // Il titolo ripete spesso marca e codice: togliamo i doppioni ignorando
  // le maiuscole, mantenendo il primo modo in cui il termine compare.
  const visti = new Set<string>();
  const termini: string[] = [];

  for (const termine of parts.join(' ').split(/\s+/)) {
    const chiave = termine.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!chiave || visti.has(chiave)) continue;
    visti.add(chiave);
    termini.push(termine);
  }

  // Oltre una decina di parole la ricerca si restringe troppo.
  return termini.slice(0, 12).join(' ').slice(0, 700);
}

/**
 * Query alternativa sul solo EAN, usata come passata aggiuntiva.
 * Quando un venditore pubblica davvero il codice, il match e' certo: vale
 * la pena cercarlo, ma come integrazione, non come ricerca principale.
 */
export function buildGtinQuery(subject: MatchSubject): string | null {
  return normalizeGtin(subject.gtin);
}
