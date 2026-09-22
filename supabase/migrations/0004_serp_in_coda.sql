-- =============================================================================
-- Ricerche SERP in coda
--
-- Contesto: la ricerca organica "live" di DataForSEO impiega spesso 5-8
-- secondi. Dentro una Netlify Function da 10 secondi, dopo le letture sul
-- database restavano 4-5 secondi e meta' delle ricerche andava in timeout.
--
-- La modalita' a coda (task_post -> task_get) risolve alla radice: accodare
-- e' immediato, i risultati arrivano in uno o due minuti e si raccolgono a
-- lotti. I task SERP finiscono nella stessa tabella dei task Google Shopping.
-- =============================================================================

alter table pt_scan_tasks drop constraint if exists pt_scan_tasks_endpoint_check;
alter table pt_scan_tasks
  add constraint pt_scan_tasks_endpoint_check
  check (endpoint in ('products', 'sellers', 'serp'));

-- Per un prodotto possono esserci due ricerche: quella principale e quella
-- sul solo EAN. Il tipo serve a rimetterle insieme quando si raccolgono.
alter table pt_scan_tasks
  add column if not exists query_type text
    check (query_type in ('principale', 'ean'));

-- La query inviata, per la diagnostica.
alter table pt_scan_tasks
  add column if not exists query text;
