-- =============================================================================
-- Price Tracker - schema applicativo (app satellite Moca Hub)
--
-- Convenzioni:
--   * prefisso `pt_` per non collidere con le tabelle dell'Hub
--     (users, clients, user_clients, configurations, applications).
--   * ogni tabella e' scoped per `client_id` -> clients(id).
--   * RLS sempre attiva: un utente vede solo i clienti a cui e' assegnato
--     tramite `user_clients`; super_admin e manager vedono tutto.
--   * le Netlify Functions usano la service_role (che bypassa la RLS) e
--     applicano l'autorizzazione in codice a partire dal JWT di sessione.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Helper di autorizzazione riusati da tutte le policy
-- -----------------------------------------------------------------------------

-- Ruolo dell'utente corrente nell'Hub.
create or replace function pt_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

-- true se l'utente corrente puo' operare sul cliente indicato.
create or replace function pt_can_access_client(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(pt_current_role() in ('super_admin', 'manager'), false)
    or exists (
      select 1
      from public.user_clients uc
      where uc.user_id = auth.uid()
        and uc.client_id = target_client_id
    );
$$;

-- -----------------------------------------------------------------------------
-- pt_settings - configurazione del monitoraggio per cliente
-- -----------------------------------------------------------------------------
create table if not exists pt_settings (
  client_id           uuid primary key references clients (id) on delete cascade,

  -- Sito del cliente da cui estrarre il catalogo e i prezzi "nostri".
  own_domain          text,
  catalog_source      text not null default 'feed'
                        check (catalog_source in ('feed', 'sitemap', 'csv', 'manual')),
  catalog_feed_url    text,

  -- Mercato di riferimento per le query DataForSEO.
  location_code       integer not null default 2380,   -- Italia
  language_code       text    not null default 'it',
  currency            text    not null default 'EUR',

  -- Soglie di allerta (in punti percentuali rispetto al prezzo del cliente).
  undercut_threshold  numeric(6, 2) not null default 2.00,
  overprice_threshold numeric(6, 2) not null default 5.00,

  -- Scansione automatica giornaliera.
  auto_scan_enabled   boolean not null default false,
  max_products_per_scan integer not null default 200
                        check (max_products_per_scan between 1 and 2000),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table pt_settings is 'Configurazione del price tracking per singolo cliente Moca.';

-- -----------------------------------------------------------------------------
-- pt_competitors - domini monitorati
-- -----------------------------------------------------------------------------
create table if not exists pt_competitors (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients (id) on delete cascade,
  domain      text not null,
  label       text,
  -- true per il dominio del cliente stesso: serve a distinguere "noi" dagli altri.
  is_own      boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (client_id, domain)
);

create index if not exists pt_competitors_client_idx on pt_competitors (client_id) where is_active;

-- -----------------------------------------------------------------------------
-- pt_products - catalogo del cliente
-- -----------------------------------------------------------------------------
create table if not exists pt_products (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients (id) on delete cascade,

  -- Identificativi: il GTIN/EAN e' la chiave forte per il matching.
  -- `sku` e' la chiave del prodotto nel catalogo del cliente ed e' sempre
  -- valorizzata: se la sorgente non la fornisce viene derivata (vedi
  -- netlify/functions/catalog-import.ts). Serve come target di ON CONFLICT,
  -- che su un indice parziale non sarebbe utilizzabile da PostgREST.
  sku           text not null,
  gtin          text,
  mpn           text,
  brand         text,
  title         text not null,
  category      text,

  -- Dati dal sito del cliente.
  product_url   text,
  image_url     text,
  own_price     numeric(12, 2),
  own_list_price numeric(12, 2),
  own_availability text,
  currency      text not null default 'EUR',
  own_price_checked_at timestamptz,

  -- Google Shopping: risolto una volta e riusato per l'endpoint sellers.
  google_product_id text,
  google_product_resolved_at timestamptz,

  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Un prodotto e' identificato dallo SKU nel catalogo del cliente.
  unique (client_id, sku)
);

create index if not exists pt_products_client_gtin_idx
  on pt_products (client_id, gtin) where gtin is not null;
create index if not exists pt_products_client_active_idx
  on pt_products (client_id) where is_active;

-- -----------------------------------------------------------------------------
-- pt_matches - offerta di un competitor associata a un prodotto
-- -----------------------------------------------------------------------------
create table if not exists pt_matches (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients (id) on delete cascade,
  product_id    uuid not null references pt_products (id) on delete cascade,

  domain        text not null,
  seller_name   text,
  -- NOT NULL con default '': in Postgres i NULL sono distinti fra loro e
  -- renderebbero inefficace il vincolo di unicita' qui sotto.
  offer_url     text not null default '',
  offer_title   text,

  -- Come e' stato trovato: gtin (certo), mpn, google_shopping, serp, manual.
  match_method  text not null default 'google_shopping'
                  check (match_method in ('gtin', 'mpn', 'google_shopping', 'serp', 'manual')),
  -- 0..1, vedi netlify/functions/utils/matching.ts
  confidence    numeric(4, 3) not null default 0.000,
  -- Conferma umana: blocca la ri-valutazione automatica del match.
  status        text not null default 'auto'
                  check (status in ('auto', 'confermato', 'escluso')),

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (product_id, domain, offer_url)
);

create index if not exists pt_matches_product_idx on pt_matches (product_id);
create index if not exists pt_matches_client_domain_idx on pt_matches (client_id, domain);

-- -----------------------------------------------------------------------------
-- pt_price_snapshots - storico prezzi (serie temporale)
-- -----------------------------------------------------------------------------
create table if not exists pt_price_snapshots (
  id            bigserial primary key,
  client_id     uuid not null references clients (id) on delete cascade,
  product_id    uuid not null references pt_products (id) on delete cascade,
  match_id      uuid references pt_matches (id) on delete cascade,

  -- NULL per il prezzo del cliente stesso; altrimenti il dominio del competitor.
  domain        text,
  is_own        boolean not null default false,

  -- Colonne generate: servono come target di ON CONFLICT per l'upsert
  -- giornaliero (un indice su espressione non e' utilizzabile da PostgREST).
  domain_key    text generated always as (coalesce(domain, '__own__')) stored,
  captured_on   date generated always as ((timezone('UTC', captured_at))::date) stored,

  price         numeric(12, 2) not null,
  shipping_price numeric(12, 2),
  total_price   numeric(12, 2),
  currency      text not null default 'EUR',
  availability  text,
  condition     text,

  source        text not null default 'google_shopping',
  captured_at   timestamptz not null default now()
);

create index if not exists pt_snapshots_product_time_idx
  on pt_price_snapshots (product_id, captured_at desc);
create index if not exists pt_snapshots_client_time_idx
  on pt_price_snapshots (client_id, captured_at desc);
-- Una sola rilevazione per prodotto/dominio/giorno: evita duplicati su re-run.
create unique index if not exists pt_snapshots_daily_uidx
  on pt_price_snapshots (product_id, domain_key, captured_on);

-- -----------------------------------------------------------------------------
-- pt_scan_runs - esecuzioni di scansione
-- -----------------------------------------------------------------------------
create table if not exists pt_scan_runs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients (id) on delete cascade,
  triggered_by    text not null default 'manuale' check (triggered_by in ('manuale', 'pianificata')),
  triggered_by_user uuid references users (id) on delete set null,

  status          text not null default 'in_corso'
                    check (status in ('in_corso', 'completata', 'parziale', 'errore')),
  products_total  integer not null default 0,
  products_done   integer not null default 0,
  offers_found    integer not null default 0,
  error_message   text,

  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists pt_scan_runs_client_idx on pt_scan_runs (client_id, started_at desc);

-- -----------------------------------------------------------------------------
-- pt_scan_tasks - task DataForSEO in attesa di risultato
--
-- I Merchant endpoint di Google Shopping sono asincroni (task_post -> task_get):
-- qui teniamo traccia dei task in volo, sia per il postback sia per il polling.
-- -----------------------------------------------------------------------------
create table if not exists pt_scan_tasks (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients (id) on delete cascade,
  run_id          uuid not null references pt_scan_runs (id) on delete cascade,
  product_id      uuid not null references pt_products (id) on delete cascade,

  dfs_task_id     text not null,
  endpoint        text not null check (endpoint in ('products', 'sellers')),
  status          text not null default 'in_attesa'
                    check (status in ('in_attesa', 'completato', 'errore')),
  error_message   text,

  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (dfs_task_id)
);

create index if not exists pt_scan_tasks_pending_idx
  on pt_scan_tasks (run_id) where status = 'in_attesa';

-- -----------------------------------------------------------------------------
-- pt_alerts - scostamenti rilevati
-- -----------------------------------------------------------------------------
create table if not exists pt_alerts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients (id) on delete cascade,
  product_id    uuid not null references pt_products (id) on delete cascade,
  run_id        uuid references pt_scan_runs (id) on delete set null,

  kind          text not null check (kind in ('sottoprezzo', 'sovrapprezzo', 'nuovo_competitor', 'non_disponibile')),
  domain        text,
  own_price     numeric(12, 2),
  competitor_price numeric(12, 2),
  delta_pct     numeric(8, 2),
  message       text not null,

  is_read       boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists pt_alerts_client_idx on pt_alerts (client_id, created_at desc);
create index if not exists pt_alerts_unread_idx on pt_alerts (client_id) where not is_read;

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table pt_settings        enable row level security;
alter table pt_competitors     enable row level security;
alter table pt_products        enable row level security;
alter table pt_matches         enable row level security;
alter table pt_price_snapshots enable row level security;
alter table pt_scan_runs       enable row level security;
alter table pt_scan_tasks      enable row level security;
alter table pt_alerts          enable row level security;

-- Una policy `for all` per tabella: la visibilita' segue sempre `client_id`.
do $$
declare
  t text;
begin
  foreach t in array array[
    'pt_settings', 'pt_competitors', 'pt_products', 'pt_matches',
    'pt_price_snapshots', 'pt_scan_runs', 'pt_scan_tasks', 'pt_alerts'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_client_scope', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (pt_can_access_client(client_id))
         with check (pt_can_access_client(client_id))',
      t || '_client_scope', t
    );
  end loop;
end
$$;

-- =============================================================================
-- Trigger: updated_at
-- =============================================================================

create or replace function pt_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pt_settings_touch on pt_settings;
create trigger pt_settings_touch before update on pt_settings
  for each row execute function pt_touch_updated_at();

drop trigger if exists pt_products_touch on pt_products;
create trigger pt_products_touch before update on pt_products
  for each row execute function pt_touch_updated_at();

-- =============================================================================
-- Vista di sintesi: ultimo prezzo per prodotto/dominio
-- Alimenta dashboard e schede prodotto senza scandire tutto lo storico.
-- =============================================================================

create or replace view pt_latest_prices as
select distinct on (s.product_id, s.domain_key)
  s.client_id,
  s.product_id,
  s.domain,
  s.is_own,
  s.price,
  s.total_price,
  s.currency,
  s.availability,
  s.captured_at
from pt_price_snapshots s
order by s.product_id, s.domain_key, s.captured_at desc;

comment on view pt_latest_prices is 'Ultima rilevazione di prezzo per ogni coppia prodotto/dominio.';

-- =============================================================================
-- pt_price_index - serie storica giornaliera per la dashboard
--
-- Aggregare lato applicativo significherebbe scaricare decine di migliaia di
-- snapshot: l'aggregazione resta nel database. SECURITY INVOKER (default),
-- quindi la RLS continua ad applicarsi quando la chiama un utente.
-- =============================================================================

create or replace function pt_price_index(p_client_id uuid, p_days integer default 30)
returns table (
  day             date,
  own_avg         numeric,
  market_min_avg  numeric,
  market_avg      numeric,
  products        integer
)
language sql
stable
as $$
  with daily as (
    select
      s.captured_on as day,
      s.product_id,
      -- domain IS NULL = rilevazione del prezzo del cliente
      max(s.price) filter (where s.domain is null)     as own_price,
      min(s.price) filter (where s.domain is not null) as market_min,
      avg(s.price) filter (where s.domain is not null) as market_avg
    from pt_price_snapshots s
    where s.client_id = p_client_id
      and s.captured_on >= (current_date - greatest(p_days, 1))
    group by 1, 2
  )
  select
    d.day,
    round(avg(d.own_price), 2)    as own_avg,
    round(avg(d.market_min), 2)   as market_min_avg,
    round(avg(d.market_avg), 2)   as market_avg,
    count(*)::integer             as products
  from daily d
  where d.own_price is not null or d.market_min is not null
  group by d.day
  order by d.day;
$$;
