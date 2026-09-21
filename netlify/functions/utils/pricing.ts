/**
 * Calcoli di posizionamento prezzo, condivisi fra catalogo e dashboard.
 * Stessa formula ovunque: la dashboard e la scheda prodotto non devono mai
 * raccontare due storie diverse sullo stesso articolo.
 */

export interface CompetitorPrice {
  domain: string;
  price: number;
  availability?: string | null;
  capturedAt?: string | null;
}

export type PricePosition = 'migliore' | 'allineato' | 'caro' | 'sconosciuto';

export interface PriceComparison {
  ownPrice: number | null;
  competitorCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  cheapestDomain: string | null;
  /** 1 = siamo i piu' economici. null se non abbiamo un nostro prezzo. */
  rank: number | null;
  /** Scostamento % del nostro prezzo rispetto al minimo di mercato. */
  deltaVsMinPct: number | null;
  /** Scostamento % del nostro prezzo rispetto alla media di mercato. */
  deltaVsAvgPct: number | null;
  position: PricePosition;
}

/**
 * `tolerancePct` definisce la fascia "allineato": entro questa distanza dal
 * minimo di mercato non consideriamo il prodotto fuori prezzo.
 */
export function comparePrices(
  ownPrice: number | null,
  competitors: CompetitorPrice[],
  tolerancePct = 2,
): PriceComparison {
  const prices = competitors.map((c) => c.price).filter((p) => p > 0);

  if (prices.length === 0) {
    return {
      ownPrice,
      competitorCount: 0,
      minPrice: null,
      maxPrice: null,
      avgPrice: null,
      cheapestDomain: null,
      rank: null,
      deltaVsMinPct: null,
      deltaVsAvgPct: null,
      position: 'sconosciuto',
    };
  }

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = round2(prices.reduce((sum, p) => sum + p, 0) / prices.length);
  const cheapest = competitors.find((c) => c.price === minPrice) ?? null;

  if (!ownPrice || ownPrice <= 0) {
    return {
      ownPrice,
      competitorCount: prices.length,
      minPrice,
      maxPrice,
      avgPrice,
      cheapestDomain: cheapest?.domain ?? null,
      rank: null,
      deltaVsMinPct: null,
      deltaVsAvgPct: null,
      position: 'sconosciuto',
    };
  }

  // Quanti competitor costano meno di noi (+1 = la nostra posizione).
  const rank = prices.filter((p) => p < ownPrice).length + 1;
  const deltaVsMinPct = round2(((ownPrice - minPrice) / minPrice) * 100);
  const deltaVsAvgPct = round2(((ownPrice - avgPrice) / avgPrice) * 100);

  const position: PricePosition =
    rank === 1 ? 'migliore' : deltaVsMinPct <= tolerancePct ? 'allineato' : 'caro';

  return {
    ownPrice,
    competitorCount: prices.length,
    minPrice,
    maxPrice,
    avgPrice,
    cheapestDomain: cheapest?.domain ?? null,
    rank,
    deltaVsMinPct,
    deltaVsAvgPct,
    position,
  };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
