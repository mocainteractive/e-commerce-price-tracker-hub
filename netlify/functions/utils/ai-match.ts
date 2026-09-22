/**
 * Verifica AI dei match incerti.
 *
 * Il matching deterministico (EAN, codice, somiglianza del titolo) e' certo
 * agli estremi e cieco nel mezzo: "Nereide Verdigris 42mm" contro "Orologio
 * Venezianico Nereide Verdigris Ref. 4521549" e' lo stesso orologio, ma un
 * punteggio di somiglianza del 55% non lo sa. Una custodia o una variante di
 * colore possono invece superare la soglia solo perche' ripetono le parole
 * del titolo.
 *
 * Qui i candidati nella fascia incerta vengono sottoposti a Claude con i dati
 * del prodotto del cliente. La risposta e' un verdetto per candidato, con una
 * confidenza e una motivazione in italiano che finisce nella diagnostica.
 *
 * E' un passaggio facoltativo: senza chiave Anthropic fra le configurazioni
 * del cliente (ANTHROPIC_API_KEY sull'Hub) la scansione procede senza.
 */
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODEL_DEFAULT = 'claude-opus-5';

export interface AiSubject {
  title: string;
  brand: string | null;
  mpn: string | null;
  gtin: string | null;
  price: number | null;
  currency: string;
}

export interface AiCandidate {
  id: number;
  title: string;
  description: string | null;
  domain: string;
  price: number | null;
  currency: string | null;
}

export interface AiVerdict {
  id: number;
  stesso: boolean;
  /** 0..1 */
  confidenza: number;
  motivo: string;
}

export interface AiOptions {
  timeoutMs: number;
  model?: string | null;
}

const SYSTEM_PROMPT = `Sei un analista di prezzi per un e-commerce. Ricevi un prodotto del catalogo del cliente e alcuni risultati di ricerca trovati su Google. Per ogni risultato devi dire se vende ESATTAMENTE lo stesso prodotto: stesso modello, stessa variante (colore, taglia, capacita', versione), non un accessorio, non un ricambio, non una confezione multipla, non un prodotto compatibile.

Criteri:
- un codice modello o un riferimento identico nel titolo o nella descrizione e' un segnale forte;
- un prezzo lontano piu' del 40% dal prezzo del cliente suggerisce un articolo diverso, ma non basta da solo;
- se il titolo del risultato e' una pagina di categoria, di ricerca o di confronto prezzi, non e' un'offerta dello stesso prodotto;
- in caso di dubbio serio rispondi false.

Rispondi SOLO con un array JSON, senza testo attorno, con un oggetto per ogni risultato:
[{"id": <numero>, "stesso": true|false, "confidenza": <0..1>, "motivo": "<una frase in italiano, massimo 120 caratteri>"}]`;

export async function verificaCandidatiConAi(
  apiKey: string,
  subject: AiSubject,
  candidates: AiCandidate[],
  options: AiOptions,
): Promise<AiVerdict[]> {
  if (candidates.length === 0) return [];

  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: options.timeoutMs });

  const prodotto = [
    `Titolo: ${subject.title}`,
    `Marca: ${subject.brand ?? 'non nota'}`,
    `Codice modello: ${subject.mpn ?? 'non noto'}`,
    `EAN: ${subject.gtin ?? 'non noto'}`,
    `Prezzo del cliente: ${subject.price !== null ? `${subject.price} ${subject.currency}` : 'non noto'}`,
  ].join('\n');

  const risultati = candidates
    .map((c) =>
      [
        `id: ${c.id}`,
        `sito: ${c.domain}`,
        `titolo: ${c.title}`,
        `descrizione: ${(c.description ?? '').slice(0, 300) || 'assente'}`,
        `prezzo: ${c.price !== null ? `${c.price} ${c.currency ?? subject.currency}` : 'non mostrato'}`,
      ].join('\n'),
    )
    .join('\n\n');

  const response = await client.messages.create({
    model: options.model || AI_MODEL_DEFAULT,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: `PRODOTTO DEL CLIENTE\n${prodotto}\n\nRISULTATI DA VALUTARE\n${risultati}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') return [];

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return parseVerdicts(text, new Set(candidates.map((c) => c.id)));
}

/** Estrae l'array JSON dalla risposta, tollerando recinti di codice. */
export function parseVerdicts(text: string, validIds: Set<number>): AiVerdict[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const verdicts: AiVerdict[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.id);
    if (!validIds.has(id)) continue;
    const confidenza = Number(row.confidenza);
    verdicts.push({
      id,
      stesso: row.stesso === true,
      confidenza: Number.isFinite(confidenza) ? Math.min(Math.max(confidenza, 0), 1) : 0.5,
      motivo: String(row.motivo ?? '').slice(0, 160),
    });
  }
  return verdicts;
}
