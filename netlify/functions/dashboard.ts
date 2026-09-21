/**
 * GET /api/dashboard?days=30
 *
 * Sintesi per la home dell'app: KPI di posizionamento, andamento dell'indice
 * prezzi, classifica dei competitor e ultimi alert.
 */
import type { Handler } from '@netlify/functions';
import { ok } from './utils/http';
import { authed } from './utils/guard';
import { supabaseAdmin } from './utils/supabase-admin';
import { comparePrices, round2, type PricePosition } from './utils/pricing';
import { loadLatestPrices } from './utils/price-queries';
import { loadScanSettings } from './utils/scan-settings';

interface CompetitorStat {
  domain: string;
  label: string | null;
  productsMatched: number;
  cheaperThanUs: number;
  moreExpensive: number;
  avgDeltaPct: number | null;
}

export const handler: Handler = authed(['GET'], async (event, session, headers) => {
  const days = Math.min(Math.max(Number(event.queryStringParameters?.days ?? 30), 7), 180);
  const db = supabaseAdmin();
  const settings = await loadScanSettings(db, session.clientId);

  const [{ data: products }, { data: competitorRows }, { data: alerts }, { data: lastRun }] =
    await Promise.all([
      db
        .from('pt_products')
        .select('id, own_price')
        .eq('client_id', session.clientId)
        .eq('is_active', true),
      db
        .from('pt_competitors')
        .select('domain, label, is_own')
        .eq('client_id', session.clientId),
      db
        .from('pt_alerts')
        .select('id, kind, domain, message, delta_pct, created_at, is_read, product_id')
        .eq('client_id', session.clientId)
        .order('created_at', { ascending: false })
        .limit(10),
      db
        .from('pt_scan_runs')
        .select('id, status, started_at, finished_at, products_total, products_done, offers_found')
        .eq('client_id', session.clientId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const productRows = products ?? [];
  const priceMap = await loadLatestPrices(
    session.clientId,
    productRows.map((p) => p.id as string),
  );

  const labelByDomain = new Map(
    (competitorRows ?? []).map((c) => [c.domain as string, (c.label as string | null) ?? null]),
  );
  const ownDomains = new Set(
    (competitorRows ?? []).filter((c) => c.is_own).map((c) => c.domain as string),
  );

  // --- KPI di posizionamento -------------------------------------------------
  const distribution: Record<PricePosition, number> = {
    migliore: 0,
    allineato: 0,
    caro: 0,
    sconosciuto: 0,
  };

  const deltas: number[] = [];
  let monitored = 0;

  // --- Statistiche per competitor -------------------------------------------
  const stats = new Map<string, { matched: number; cheaper: number; pricier: number; deltas: number[] }>();

  for (const product of productRows) {
    const competitors = (priceMap.get(product.id as string) ?? []).filter(
      (c) => !ownDomains.has(c.domain),
    );
    const ownPrice = product.own_price !== null ? Number(product.own_price) : null;

    const comparison = comparePrices(ownPrice, competitors, Number(settings.undercut_threshold));
    distribution[comparison.position] += 1;

    if (competitors.length > 0) monitored += 1;
    if (comparison.deltaVsMinPct !== null) deltas.push(comparison.deltaVsMinPct);

    for (const competitor of competitors) {
      const entry = stats.get(competitor.domain) ?? { matched: 0, cheaper: 0, pricier: 0, deltas: [] };
      entry.matched += 1;

      if (ownPrice && ownPrice > 0) {
        if (competitor.price < ownPrice) entry.cheaper += 1;
        else if (competitor.price > ownPrice) entry.pricier += 1;
        // Delta del competitor rispetto a noi: negativo = costa meno di noi.
        entry.deltas.push(((competitor.price - ownPrice) / ownPrice) * 100);
      }

      stats.set(competitor.domain, entry);
    }
  }

  const competitors: CompetitorStat[] = [...stats.entries()]
    .map(([domain, entry]) => ({
      domain,
      label: labelByDomain.get(domain) ?? null,
      productsMatched: entry.matched,
      cheaperThanUs: entry.cheaper,
      moreExpensive: entry.pricier,
      avgDeltaPct: entry.deltas.length
        ? round2(entry.deltas.reduce((sum, d) => sum + d, 0) / entry.deltas.length)
        : null,
    }))
    .sort((a, b) => b.productsMatched - a.productsMatched)
    .slice(0, 12);

  // --- Andamento storico (aggregato nel database) ---------------------------
  const { data: series, error: seriesError } = await db.rpc('pt_price_index', {
    p_client_id: session.clientId,
    p_days: days,
  });

  if (seriesError) {
    console.error('[dashboard] pt_price_index non disponibile:', seriesError.message);
  }

  const { count: unreadAlerts } = await db
    .from('pt_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', session.clientId)
    .eq('is_read', false);

  return ok(
    {
      kpi: {
        productsTotal: productRows.length,
        productsMonitored: monitored,
        distribution,
        avgDeltaVsMinPct: deltas.length
          ? round2(deltas.reduce((sum, d) => sum + d, 0) / deltas.length)
          : null,
        unreadAlerts: unreadAlerts ?? 0,
        competitorsTracked: stats.size,
      },
      series: series ?? [],
      competitors,
      alerts: alerts ?? [],
      lastRun: lastRun ?? null,
      currency: settings.currency,
    },
    headers,
  );
});
