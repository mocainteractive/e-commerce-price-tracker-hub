/**
 * Lettura delle impostazioni di scansione con i default applicati.
 * Un cliente appena creato non ha ancora una riga in `pt_settings`: qui si
 * decide una volta sola cosa succede in quel caso.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanSettings } from './scan-processing';

export type FullScanSettings = ScanSettings & { max_products_per_scan: number };

export const DEFAULT_SCAN_SETTINGS: FullScanSettings = {
  location_code: 2380, // Italia
  language_code: 'it',
  currency: 'EUR',
  undercut_threshold: 2,
  overprice_threshold: 5,
  max_products_per_scan: 200,
};

export async function loadScanSettings(
  db: SupabaseClient,
  clientId: string,
): Promise<FullScanSettings> {
  const { data } = await db
    .from('pt_settings')
    .select(
      'location_code, language_code, currency, undercut_threshold, overprice_threshold, max_products_per_scan',
    )
    .eq('client_id', clientId)
    .maybeSingle();

  if (!data) return { ...DEFAULT_SCAN_SETTINGS };

  return {
    location_code: data.location_code ?? DEFAULT_SCAN_SETTINGS.location_code,
    language_code: data.language_code ?? DEFAULT_SCAN_SETTINGS.language_code,
    currency: data.currency ?? DEFAULT_SCAN_SETTINGS.currency,
    undercut_threshold: Number(data.undercut_threshold ?? DEFAULT_SCAN_SETTINGS.undercut_threshold),
    overprice_threshold: Number(data.overprice_threshold ?? DEFAULT_SCAN_SETTINGS.overprice_threshold),
    max_products_per_scan:
      data.max_products_per_scan ?? DEFAULT_SCAN_SETTINGS.max_products_per_scan,
  };
}
