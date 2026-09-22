-- =============================================================================
-- Verifica AI dei match, prezzo dalla scheda del venditore, fonte della run
--
-- Contesto: la scansione sulla SERP organica trova i venditori, ma il
-- matching deterministico e' cieco nella fascia incerta (somiglianza fra il
-- 40% e l'80%) e lo snippet di Google non sempre mostra il prezzo. Due
-- passaggi in piu' risolvono la maggior parte dei casi: chiedere a Claude se
-- due schede sono lo stesso prodotto, e leggere il prezzo direttamente dalla
-- pagina del venditore.
--
-- La run registra anche la fonte usata, cosi' la scansione pianificata sa se
-- deve avanzare un cursore SERP o raccogliere task Google Shopping.
-- =============================================================================

alter table pt_settings
  add column if not exists ai_match_enabled boolean not null default true;

comment on column pt_settings.ai_match_enabled is
  'Sottopone a Claude i candidati incerti. Richiede ANTHROPIC_API_KEY fra le configurazioni del cliente sull''Hub.';

alter table pt_settings
  add column if not exists serp_page_prices boolean not null default true;

comment on column pt_settings.serp_page_prices is
  'Quando lo snippet di Google non mostra il prezzo, legge i dati strutturati della pagina del venditore.';

-- Fonte di ricerca della singola run. Il default copre le run gia' esistenti.
alter table pt_scan_runs
  add column if not exists search_source text not null default 'serp'
    check (search_source in ('serp', 'shopping', 'entrambe'));

-- Un match confermato dall'AI ha un metodo proprio, cosi' la scheda prodotto
-- lo distingue da un match per somiglianza.
alter table pt_matches drop constraint if exists pt_matches_match_method_check;
alter table pt_matches
  add constraint pt_matches_match_method_check
  check (match_method in ('gtin', 'mpn', 'google_shopping', 'serp', 'ai', 'manual'));
