/**
 * GET  /api/settings  -> impostazioni + competitor del cliente
 * POST /api/settings  -> aggiorna impostazioni e/o competitor
 *
 * Il dominio del cliente viene sempre mantenuto anche in `pt_competitors`
 * con `is_own = true`: cosi' compare nei confronti come "noi" senza logica
 * speciale nelle query.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { authed } from './utils/guard';
import { requireWriteAccess } from './utils/session';
import { supabaseAdmin } from './utils/supabase-admin';
import { normalizeDomain } from './utils/matching';

interface SettingsPayload {
  own_domain?: string | null;
  catalog_source?: 'feed' | 'sitemap' | 'csv' | 'manual';
  catalog_feed_url?: string | null;
  location_code?: number;
  language_code?: string;
  currency?: string;
  undercut_threshold?: number;
  overprice_threshold?: number;
  auto_scan_enabled?: boolean;
  max_products_per_scan?: number;
}

interface RequestBody {
  settings?: SettingsPayload;
  addCompetitor?: { domain: string; label?: string };
  removeCompetitorId?: string;
}

export const handler: Handler = authed(['GET', 'POST'], async (event, session, headers) => {
  const db = supabaseAdmin();

  if (event.httpMethod === 'POST') {
    requireWriteAccess(session);
    const body = parseBody<RequestBody>(event);

    if (body.settings) {
      await updateSettings(session.clientId, body.settings);
    }
    if (body.addCompetitor) {
      await addCompetitor(session.clientId, body.addCompetitor);
    }
    if (body.removeCompetitorId) {
      const { error } = await db
        .from('pt_competitors')
        .delete()
        .eq('id', body.removeCompetitorId)
        .eq('client_id', session.clientId); // scoping esplicito: la RLS qui non opera
      if (error) throw new HttpError(500, 'Rimozione del competitor non riuscita');
    }
  }

  const [{ data: settings }, { data: competitors }] = await Promise.all([
    db.from('pt_settings').select('*').eq('client_id', session.clientId).maybeSingle(),
    db
      .from('pt_competitors')
      .select('id, domain, label, is_own, is_active, created_at')
      .eq('client_id', session.clientId)
      .order('is_own', { ascending: false })
      .order('domain'),
  ]);

  return ok({ settings: settings ?? defaultSettings(session.clientId), competitors: competitors ?? [] }, headers);
});

async function updateSettings(clientId: string, payload: SettingsPayload): Promise<void> {
  const db = supabaseAdmin();
  const patch: Record<string, unknown> = { client_id: clientId };

  if (payload.own_domain !== undefined) {
    const domain = payload.own_domain ? normalizeDomain(payload.own_domain) : null;
    if (payload.own_domain && !domain) {
      throw new HttpError(400, 'Dominio del cliente non valido');
    }
    patch.own_domain = domain;

    // Tieni allineata la riga "noi" fra i competitor monitorati.
    if (domain) {
      await db
        .from('pt_competitors')
        .upsert(
          { client_id: clientId, domain, label: 'Il tuo sito', is_own: true },
          { onConflict: 'client_id,domain' },
        );
    }
  }

  if (payload.catalog_source !== undefined) patch.catalog_source = payload.catalog_source;
  if (payload.catalog_feed_url !== undefined) patch.catalog_feed_url = payload.catalog_feed_url || null;
  if (payload.location_code !== undefined) patch.location_code = payload.location_code;
  if (payload.language_code !== undefined) patch.language_code = payload.language_code;
  if (payload.currency !== undefined) patch.currency = payload.currency;
  if (payload.auto_scan_enabled !== undefined) patch.auto_scan_enabled = payload.auto_scan_enabled;

  if (payload.undercut_threshold !== undefined) {
    patch.undercut_threshold = clamp(payload.undercut_threshold, 0, 100, 'Soglia sottoprezzo');
  }
  if (payload.overprice_threshold !== undefined) {
    patch.overprice_threshold = clamp(payload.overprice_threshold, 0, 100, 'Soglia sovrapprezzo');
  }
  if (payload.max_products_per_scan !== undefined) {
    patch.max_products_per_scan = clamp(payload.max_products_per_scan, 1, 2000, 'Prodotti per scansione');
  }

  const { error } = await db.from('pt_settings').upsert(patch, { onConflict: 'client_id' });
  if (error) {
    console.error('[settings] Upsert fallito:', error.message);
    throw new HttpError(500, 'Salvataggio delle impostazioni non riuscito');
  }
}

async function addCompetitor(clientId: string, input: { domain: string; label?: string }): Promise<void> {
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new HttpError(400, 'Dominio del competitor non valido');

  const { error } = await supabaseAdmin()
    .from('pt_competitors')
    .upsert(
      { client_id: clientId, domain, label: input.label?.trim() || null, is_own: false },
      { onConflict: 'client_id,domain' },
    );

  if (error) {
    console.error('[settings] Inserimento competitor fallito:', error.message);
    throw new HttpError(500, 'Aggiunta del competitor non riuscita');
  }
}

function clamp(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `${label}: valore fuori intervallo (${min}-${max})`);
  }
  return value;
}

function defaultSettings(clientId: string) {
  return {
    client_id: clientId,
    own_domain: null,
    catalog_source: 'feed',
    catalog_feed_url: null,
    location_code: 2380,
    language_code: 'it',
    currency: 'EUR',
    undercut_threshold: 2,
    overprice_threshold: 5,
    auto_scan_enabled: false,
    max_products_per_scan: 200,
  };
}
