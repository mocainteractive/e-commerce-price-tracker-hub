/**
 * POST /api/scan-serp
 *
 * Ricerca dei prodotti sulla SERP organica, in coda su DataForSEO.
 *
 *   { runId, action: 'post' }     accoda le ricerche del prossimo lotto (50 prodotti)
 *   { runId, action: 'collect' }  raccoglie ed elabora i risultati pronti
 *
 * Il browser prima accoda tutto, poi raccoglie finche' non resta nulla in
 * attesa, aspettando qualche secondo fra un giro e l'altro. Ogni chiamata
 * sta nei 10 secondi della piattaforma: l'accodamento e' una sola richiesta,
 * la raccolta elabora i prodotti pronti finche' c'e' tempo e dice quanti ne
 * restano.
 *
 * Prima la ricerca era "live", con 4-5 secondi di margine: meta' delle
 * ricerche andava in timeout. Vedi utils/serp-tasks.ts.
 */
import type { Handler } from '@netlify/functions';
import { HttpError, ok, parseBody } from './utils/http';
import { withMoca, requireWriteAccess } from './utils/moca-context';
import { supabaseAdmin } from './utils/supabase-admin';
import { resolveAiCredentials, resolveDataForSeoCredentials } from './utils/client-config';
import { DataForSeoClient } from './utils/dataforseo';
import { loadScanSettings } from './utils/scan-settings';
import { accodaRicerche, raccogliRicerche } from './utils/serp-tasks';

/** Entro questo istante dall'avvio la raccolta deve aver finito di elaborare. */
const BUDGET_MS = 8000;

interface RequestBody {
  runId: string;
  action?: 'post' | 'collect';
}

export const handler: Handler = withMoca(['POST'], async (event, moca, headers) => {
  const avvio = Date.now();
  requireWriteAccess(moca);

  const body = parseBody<RequestBody>(event);
  if (!body.runId) throw new HttpError(400, 'Identificativo della scansione mancante');

  const db = supabaseAdmin();

  const { data: run } = await db
    .from('pt_scan_runs')
    .select('id, status, products_total, triggered_by')
    .eq('id', body.runId)
    .eq('client_id', moca.clientId)
    .maybeSingle();

  if (!run) throw new HttpError(404, 'Scansione non trovata');
  const total = run.products_total as number;

  if (run.status !== 'in_corso') {
    return ok({ closed: true, accodati: 0, elaborati: 0, offerte: 0, inAttesa: 0, prodottiFatti: total, remaining: 0, diagnostiche: [] }, headers);
  }

  const settings = await loadScanSettings(db, moca.clientId);
  const credentials = await resolveDataForSeoCredentials(moca.clientId, moca.dataForSeo);
  const dfs = new DataForSeoClient(credentials.login, credentials.password);

  if (body.action === 'post') {
    const esito = await accodaRicerche(db, dfs, {
      clientId: moca.clientId,
      runId: body.runId,
      settings,
      productsTotal: total,
      priority: 2,
    });
    return ok(
      {
        ...esito,
        remaining: Math.max(total - esito.prossimoOffset, 0),
        elapsedMs: Date.now() - avvio,
      },
      headers,
    );
  }

  const ai = settings.ai_match_enabled ? await resolveAiCredentials(moca.clientId, moca.ai) : null;
  const esito = await raccogliRicerche(db, dfs, {
    clientId: moca.clientId,
    runId: body.runId,
    settings,
    ai,
    deadline: avvio + BUDGET_MS,
  });

  return ok(
    {
      ...esito,
      remaining: Math.max(total - esito.prodottiFatti, 0),
      aiAttiva: ai !== null,
      elapsedMs: Date.now() - avvio,
    },
    headers,
  );
});
