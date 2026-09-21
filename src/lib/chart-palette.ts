/**
 * Palette dei grafici - colori brand Moca.
 *
 * L'ordine NON e' arbitrario: e' stato verificato con il validatore di palette
 * (banda di luminosita', soglia di croma, separazione per daltonismo protan /
 * deutan / tritan, contrasto su superficie bianca). Tutti i controlli passano
 * fino a 5 serie in quest'ordine esatto.
 *
 * Regole d'uso:
 *   * assegna i colori in ordine fisso, mai ciclando: la sesta serie e oltre
 *     confluiscono in "Altri" con il grigio neutro;
 *   * il colore segue l'entita' (il dominio), mai la sua posizione in
 *     classifica: filtrando l'elenco le serie non devono cambiare colore;
 *   * il nostro sito e' sempre rosso Moca, cosi' resta riconoscibile ovunque.
 */

export const OWN_COLOR = '#E52217'; // rosso Moca: sempre "noi"

export const SERIES_COLORS = [
  '#E52217', // rosso Moca
  '#5781FF', // blu
  '#118541', // verde
  '#551FC4', // viola
  '#DB5E29', // arancione
] as const;

/** Grigio riservato a "Altri" e ai riferimenti neutri: non e' una serie. */
export const OTHER_COLOR = '#484848';

export const MAX_SERIES = SERIES_COLORS.length;

/**
 * Assegna un colore stabile a ogni dominio.
 * L'ordine di `domains` determina l'assegnazione, quindi passalo sempre
 * ordinato in modo deterministico (alfabetico, o per numero di prodotti).
 */
export function buildColorMap(domains: string[], ownDomain?: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (ownDomain) map.set(ownDomain, OWN_COLOR);

  // Lo slot 0 e' il rosso, gia' riservato a "noi".
  let slot = ownDomain ? 1 : 0;

  for (const domain of domains) {
    if (map.has(domain)) continue;
    map.set(domain, slot < MAX_SERIES ? SERIES_COLORS[slot] : OTHER_COLOR);
    slot += 1;
  }

  return map;
}

/** Colori di stato: non sono mai riusati come colori di serie. */
export const STATUS_COLORS = {
  migliore: '#118541',
  allineato: '#5781FF',
  caro: '#E52217',
  sconosciuto: '#8A8A8A',
} as const;
