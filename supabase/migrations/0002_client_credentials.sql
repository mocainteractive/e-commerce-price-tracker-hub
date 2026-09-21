-- =============================================================================
-- pt_client_credentials
--
-- Copia server-side delle `configurations` che l'Hub consegna all'app quando
-- valida il launch token (lo stesso canale usato dalle altre app Moca).
--
-- Perche' serve conservarle:
--   il postback di DataForSEO e la scansione pianificata girano SENZA un utente
--   collegato, quindi senza launch token. Senza questa copia non potrebbero
--   recuperare le credenziali del cliente e i risultati andrebbero persi.
--
-- Il contenuto e' cifrato con AES-256-GCM (vedi netlify/functions/utils/crypto.ts):
-- in chiaro non c'e' mai nulla, nemmeno per chi legge il database.
-- =============================================================================

create table if not exists pt_client_credentials (
  client_id   uuid primary key references clients (id) on delete cascade,

  -- Blob cifrato `iv.tag.ciphertext` con l'intera mappa delle configurazioni.
  payload     text not null,
  -- Sole chiavi presenti (non i valori): permette di mostrare in UI cosa manca
  -- senza decifrare nulla.
  config_keys text[] not null default '{}',

  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null
);

comment on table pt_client_credentials is
  'Configurazioni cliente ricevute da Moca Hub, cifrate a riposo. Solo service_role.';

-- RLS attiva e NESSUNA policy: la tabella e' irraggiungibile da qualunque
-- utente autenticato. Ci accedono unicamente le Netlify Functions con la
-- service_role, che bypassa la RLS.
alter table pt_client_credentials enable row level security;

revoke all on pt_client_credentials from anon, authenticated;
