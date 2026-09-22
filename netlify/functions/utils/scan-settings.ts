/**
 * Lettura delle impostazioni di scansione con i default applicati.
 * Un cliente appena creato non ha ancora una riga in `pt_settings`: qui si
 * decide una volta sola cosa succede in quel caso.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanSettings } from './scan-processing';

export type SearchSource = 'serp' | 'shopping' | 'entrambe';

export type FullScanSettings = ScanSettings & {
  max_products_per_scan: number;
  /** Dove cercare i prezzi. Vedi supabase/migrations/0002. */
  search_source: SearchSource;
  /** Passata aggiuntiva sul solo EAN. */
  search_gtin_pass: boolean;
  /** Verifica AI dei match incerti (migration 0003). */
  ai_match_enabled: boolean;
  /** Lettura del prezzo dalla scheda del venditore quando lo snippet non lo mostra. */
  serp_page_prices: boolean;
};

export const DEFAULT_SCAN_SETTINGS: FullScanSettings = {
  location_code: 2380, // Italia
  language_code: 'it',
  currency: 'EUR',
  undercut_threshold: 2,
  overprice_threshold: 5,
  max_products_per_scan: 200,
  search_source: 'serp',
  search_gtin_pass: false,
  ai_match_enabled: true,
  serp_page_prices: true,
};

const BASE =
  'location_code, language_code, currency, undercut_threshold, overprice_threshold, max_products_per_scan';
const WITH_0002 = `${BASE}, search_source, search_gtin_pass`;
const WITH_0003 = `${WITH_0002}, ai_match_enabled, serp_page_prices`;

export async function loadScanSettings(
  db: SupabaseClient,
  clientId: string,
): Promise<FullScanSettings> {
  // Le migration possono non essere tutte applicate: si prova dalla piu'
  // completa alla piu' vecchia, invece di perdere anche paese, lingua e soglie.
  let data: Record<string, unknown> | null = null;
  for (const columns of [WITH_0003, WITH_0002, BASE]) {
    const result = await db.from('pt_settings').select(columns).eq('client_id', clientId).maybeSingle();
    if (!result.error) {
      data = result.data as Record<string, unknown> | null;
      break;
    }
    console.warn('[impostazioni] Colonne assenti, riprovo con meno campi:', result.error.message);
  }

  if (!data) return { ...DEFAULT_SCAN_SETTINGS };

  const bool = (key: keyof FullScanSettings): boolean =>
    typeof data?.[key] === 'boolean' ? (data[key] as boolean) : (DEFAULT_SCAN_SETTINGS[key] as boolean);

  return {
    location_code: (data.location_code as number) ?? DEFAULT_SCAN_SETTINGS.location_code,
    language_code: (data.language_code as string) ?? DEFAULT_SCAN_SETTINGS.language_code,
    currency: (data.currency as string) ?? DEFAULT_SCAN_SETTINGS.currency,
    undercut_threshold: Number(data.undercut_threshold ?? DEFAULT_SCAN_SETTINGS.undercut_threshold),
    overprice_threshold: Number(data.overprice_threshold ?? DEFAULT_SCAN_SETTINGS.overprice_threshold),
    max_products_per_scan:
      (data.max_products_per_scan as number) ?? DEFAULT_SCAN_SETTINGS.max_products_per_scan,
    search_source: (data.search_source as SearchSource) ?? DEFAULT_SCAN_SETTINGS.search_source,
    search_gtin_pass: bool('search_gtin_pass'),
    ai_match_enabled: bool('ai_match_enabled'),
    serp_page_prices: bool('serp_page_prices'),
  };
}
