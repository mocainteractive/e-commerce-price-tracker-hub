/**
 * GET /api/health
 *
 * Diagnostica di configurazione. Risponde SEMPRE 200, anche quando qualcosa
 * non va: serve proprio a dire cosa manca invece di lasciare un "Errore
 * interno del server" senza spiegazione.
 *
 * Non restituisce mai valori di chiavi o segreti: solo booleani, il nome
 * dell'host Supabase e l'esito delle verifiche.
 */
import type { Handler } from '@netlify/functions';
import { json, withHttp } from './utils/http';
import { normalizeSupabaseUrl, supabaseAdmin } from './utils/supabase-admin';

interface Check {
  ok: boolean;
  dettaglio: string;
}

export const handler: Handler = withHttp(['GET'], async (_event, headers) => {
  const checks: Record<string, Check> = {};

  // --- Variabili d'ambiente --------------------------------------------------
  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let supabaseHost: string | null = null;

  if (!rawUrl) {
    checks.supabase_url = { ok: false, dettaglio: 'SUPABASE_URL non impostata su Netlify' };
  } else {
    try {
      supabaseHost = new URL(normalizeSupabaseUrl(rawUrl)).host;
      const hadScheme = /^https?:\/\//i.test(rawUrl.trim());
      checks.supabase_url = {
        ok: true,
        dettaglio: hadScheme
          ? `host ${supabaseHost}`
          : `host ${supabaseHost} (schema https:// aggiunto automaticamente: correggi il valore su Netlify)`,
      };
    } catch (err) {
      checks.supabase_url = {
        ok: false,
        dettaglio: `SUPABASE_URL non valida (${(err as Error).message}). Attesa: https://<project-ref>.supabase.co`,
      };
    }
  }

  checks.supabase_service_key = serviceKey
    ? { ok: true, dettaglio: `impostata (${serviceKey.length} caratteri)` }
    : { ok: false, dettaglio: 'SUPABASE_SERVICE_ROLE_KEY non impostata su Netlify' };

  checks.postback_secret = process.env.DATAFORSEO_POSTBACK_SECRET
    ? { ok: true, dettaglio: 'impostato' }
    : {
        ok: false,
        dettaglio:
          'DATAFORSEO_POSTBACK_SECRET non impostato: le scansioni funzionano ma i risultati vanno raccolti a mano',
      };

  checks.app_public_url = process.env.APP_PUBLIC_URL
    ? { ok: true, dettaglio: process.env.APP_PUBLIC_URL }
    : { ok: false, dettaglio: 'APP_PUBLIC_URL non impostata: il postback non puo\' essere costruito' };

  // --- Raggiungibilita' del database e presenza delle tabelle ---------------
  if (checks.supabase_url.ok && checks.supabase_service_key.ok) {
    for (const table of ['pt_settings', 'pt_products', 'pt_price_snapshots', 'configurations']) {
      checks[`tabella_${table}`] = await probeTable(table);
    }
    checks.funzione_pt_price_index = await probeRpc();
  }

  const blocking = ['supabase_url', 'supabase_service_key'];
  const pronto = blocking.every((key) => checks[key]?.ok);

  return json(
    200,
    {
      success: true,
      pronto,
      riepilogo: pronto
        ? 'Configurazione di base corretta.'
        : 'Configurazione incompleta: correggi le voci con ok = false nelle variabili d\'ambiente di Netlify.',
      checks,
      versione: process.env.COMMIT_REF?.slice(0, 7) ?? 'sconosciuta',
    },
    headers,
  );
});

async function probeTable(table: string): Promise<Check> {
  try {
    const { error } = await supabaseAdmin().from(table).select('*', { head: true, count: 'exact' }).limit(1);

    if (error) {
      // 42P01 = relazione inesistente: la migration non e' stata eseguita.
      const missing = error.code === '42P01' || /does not exist/i.test(error.message);
      return {
        ok: false,
        dettaglio: missing
          ? `tabella assente: esegui supabase/migrations/0001_price_tracker.sql`
          : `errore: ${error.message}`,
      };
    }
    return { ok: true, dettaglio: 'raggiungibile' };
  } catch (err) {
    return { ok: false, dettaglio: `non raggiungibile: ${(err as Error).message}` };
  }
}

async function probeRpc(): Promise<Check> {
  try {
    const { error } = await supabaseAdmin().rpc('pt_price_index', {
      p_client_id: '00000000-0000-0000-0000-000000000000',
      p_days: 1,
    });
    if (error) {
      return { ok: false, dettaglio: `non disponibile: ${error.message}` };
    }
    return { ok: true, dettaglio: 'disponibile' };
  } catch (err) {
    return { ok: false, dettaglio: `non disponibile: ${(err as Error).message}` };
  }
}
