/** Tipi condivisi con le Netlify Functions. */

export type PricePosition = 'migliore' | 'allineato' | 'caro' | 'sconosciuto';

export interface PriceComparison {
  ownPrice: number | null;
  competitorCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  cheapestDomain: string | null;
  rank: number | null;
  deltaVsMinPct: number | null;
  deltaVsAvgPct: number | null;
  position: PricePosition;
}

export interface Product {
  id: string;
  sku: string;
  gtin: string | null;
  mpn?: string | null;
  brand: string | null;
  title: string;
  category: string | null;
  product_url: string | null;
  image_url: string | null;
  own_price: number | null;
  own_list_price?: number | null;
  own_availability: string | null;
  currency: string;
  own_price_checked_at: string | null;
  google_product_id: string | null;
}

export interface CatalogItem extends Product {
  comparison: PriceComparison;
}

export interface Match {
  id: string;
  domain: string;
  seller_name: string | null;
  offer_url: string;
  offer_title: string | null;
  match_method: 'gtin' | 'mpn' | 'google_shopping' | 'serp' | 'ai' | 'manual';
  confidence: number;
  status: 'auto' | 'confermato' | 'escluso';
  last_seen_at: string;
}

export interface HistoryPoint {
  day: string;
  /** null = il nostro prezzo. */
  domain: string | null;
  price: number;
}

export interface Competitor {
  id: string;
  domain: string;
  label: string | null;
  is_own: boolean;
  is_active: boolean;
  created_at: string;
}

export interface CompetitorStat {
  domain: string;
  label: string | null;
  productsMatched: number;
  cheaperThanUs: number;
  moreExpensive: number;
  avgDeltaPct: number | null;
}

export interface Settings {
  client_id: string;
  own_domain: string | null;
  catalog_source: 'feed' | 'sitemap' | 'csv' | 'manual';
  catalog_feed_url: string | null;
  location_code: number;
  language_code: string;
  currency: string;
  undercut_threshold: number;
  overprice_threshold: number;
  auto_scan_enabled: boolean;
  max_products_per_scan: number;
  search_source: 'serp' | 'shopping' | 'entrambe';
  search_gtin_pass: boolean;
  ai_match_enabled: boolean;
  serp_page_prices: boolean;
}

export interface Alert {
  id: string;
  kind: 'sottoprezzo' | 'sovrapprezzo' | 'nuovo_competitor' | 'non_disponibile';
  domain: string | null;
  message: string;
  own_price: number | null;
  competitor_price: number | null;
  delta_pct: number | null;
  is_read: boolean;
  created_at: string;
  product_id: string;
}

export interface ScanRun {
  id: string;
  triggered_by: 'manuale' | 'pianificata';
  status: 'in_corso' | 'completata' | 'parziale' | 'errore';
  products_total: number;
  products_done: number;
  offers_found: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  pendingTasks?: number;
  search_source?: 'serp' | 'shopping' | 'entrambe' | null;
}

export interface PriceIndexPoint {
  day: string;
  own_avg: number | null;
  market_min_avg: number | null;
  market_avg: number | null;
  products: number;
}

export interface DashboardData {
  kpi: {
    productsTotal: number;
    productsMonitored: number;
    distribution: Record<PricePosition, number>;
    avgDeltaVsMinPct: number | null;
    unreadAlerts: number;
    competitorsTracked: number;
  };
  series: PriceIndexPoint[];
  competitors: CompetitorStat[];
  alerts: Alert[];
  lastRun: ScanRun | null;
  currency: string;
}
