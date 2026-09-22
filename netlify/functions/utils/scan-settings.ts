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
};

export async function loadScanSettings(
  db: SupabaseClient,
  clientId: string,
): Promise<FullScanSettings> {
  const BASE =
    'location_code, language_code, currency, undercut_threshold, overprice_threshold, max_products_per_scan';

  let { data, error } = await db
    .from('pt_settings')
    .select(`${BASE}, search_source, search_gtin_pass`)
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    // La migration 0002 non e' stata eseguita: le colonne nuove non esistono.
    // Rileggiamo senza, invece di perdere anche paese, lingua e soglie.
    console.warn('[impostazioni] Colonne della migration 0002 assenti:', error.message);
    ({ data } = await db
      .from('pt_settings')
      .select(BASE)
      .eq('client_id', clientId)
      .maybeSingle());
  }

  if (!data) return { ...DEFAULT_SCAN_SETTINGS };

  return {
    location_code: data.location_code ?? DEFAULT_SCAN_SETTINGS.location_code,
    language_code: data.language_code ?? DEFAULT_SCAN_SETTINGS.language_code,
    currency: data.currency ?? DEFAULT_SCAN_SETTINGS.currency,
    undercut_threshold: Number(data.undercut_threshold ?? DEFAULT_SCAN_SETTINGS.undercut_threshold),
    overprice_threshold: Number(data.overprice_threshold ?? DEFAULT_SCAN_SETTINGS.overprice_threshold),
    max_products_per_scan:
      data.max_products_per_scan ?? DEFAULT_SCAN_SETTINGS.max_products_per_scan,
    // Le colonne possono mancare se la migration 0002 non e' stata eseguita:
    // in quel caso si usa il default invece di rompere la scansione.
    search_source:
      ((data as Record<string, unknown>).search_source as SearchSource) ??
      DEFAULT_SCAN_SETTINGS.search_source,
    search_gtin_pass:
      ((data as Record<string, unknown>).search_gtin_pass as boolean) ??
      DEFAULT_SCAN_SETTINGS.search_gtin_pass,
  };
}
