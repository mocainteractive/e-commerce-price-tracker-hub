-- =============================================================================
-- Fonte di ricerca e regole per le sitemap
--
-- Contesto: la prima versione cercava i prodotti solo su Google Shopping, con
-- una query composta dal solo codice EAN. Verificato sul campo, quella query
-- restituisce risultati estranei (un EAN isolato non compare quasi mai nel
-- testo dei venditori), e gli endpoint Shopping sono asincroni, quindi un
-- risultato vuoto non si distingue da un risultato non ancora pronto.
--
-- La SERP organica e' sincrona e i suoi risultati portano gia' il prezzo:
-- diventa la fonte predefinita, con Google Shopping come fonte aggiuntiva.
-- =============================================================================

alter table pt_settings
  add column if not exists search_source text not null default 'serp'
    check (search_source in ('serp', 'shopping', 'entrambe'));

comment on column pt_settings.search_source is
  'serp = SERP organica (sincrona, con prezzo); shopping = Google Shopping (asincrona); entrambe.';

-- Cercare anche il solo EAN come passata aggiuntiva: costa una chiamata in
-- piu' per prodotto, ma quando un venditore pubblica il codice il match e'
-- certo. Disattivata di default.
alter table pt_settings
  add column if not exists search_gtin_pass boolean not null default false;

-- -----------------------------------------------------------------------------
-- Regole per riconoscere le pagine prodotto in una sitemap
--
-- Una sitemap contiene anche categorie, blog, pagine statiche: senza filtro
-- si scaricherebbero centinaia di pagine inutili, e l'import da sitemap e' il
-- percorso piu' lento che abbiamo.
-- -----------------------------------------------------------------------------

alter table pt_settings
  add column if not exists sitemap_include_patterns text[] not null default '{}';

alter table pt_settings
  add column if not exists sitemap_exclude_patterns text[] not null default '{}';

comment on column pt_settings.sitemap_include_patterns is
  'Frammenti che una URL deve contenere per essere considerata una pagina prodotto. Vuoto = riconoscimento automatico.';
comment on column pt_settings.sitemap_exclude_patterns is
  'Frammenti che escludono una URL. Si sommano alle esclusioni automatiche (blog, categorie, carrello...).';

-- -----------------------------------------------------------------------------
-- pt_price_snapshots.source: la SERP organica e' una nuova origine
-- -----------------------------------------------------------------------------
comment on column pt_price_snapshots.source is
  'catalogo | sito_cliente | serp_organica | google_shopping | google_sellers';
