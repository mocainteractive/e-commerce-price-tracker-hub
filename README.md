# Price Tracker, app integrata Moca Hub

Monitoraggio dei prezzi e-commerce: individua gli stessi prodotti del catalogo
del cliente sugli altri siti, ne rileva i prezzi nel tempo e mostra gli
scostamenti. Stessa logica di un Minderest o di un Prisync, costruita sulle
**Merchant API** e sulle **SERP API** di DataForSEO.

App satellite dell'ecosistema Moca: l'Hub e' l'Identity Provider e il
Configuration Manager, l'app non gestisce utenti ne' conserva API key.

---

## COSA FA

- **Importa il catalogo** del cliente da feed Google Merchant, CSV o sitemap
  (con estrazione dei dati strutturati dalle pagine prodotto).
- **Trova lo stesso prodotto** sugli altri e-commerce tramite Google Shopping,
  con una gerarchia di affidabilita': GTIN/EAN, poi MPN/SKU, poi somiglianza di
  titolo, brand e prezzo.
- **Registra lo storico** di ogni prezzo rilevato, una fotografia al giorno per
  prodotto e per venditore.
- **Confronta** il prezzo del cliente con il minimo, la media e il massimo di
  mercato, e assegna a ogni prodotto uno stato: prezzo migliore, allineato o
  fuori prezzo.
- **Avvisa** quando un competitor scende sotto una soglia o quando il cliente
  diventa il venditore piu' caro.
- **Scansione automatica** giornaliera per i clienti che la attivano.

---

## ARCHITETTURA

```
Browser (React 18 + Vite + Tailwind)
   │  Authorization: Bearer <JWT applicativo>
   ▼
Netlify Functions  ──►  DataForSEO (Merchant API, SERP API)
   │                    credenziali lette da Supabase, mai nel browser
   ▼
Supabase (stessa istanza dell'Hub, tabelle con prefisso pt_, RLS per client_id)
```

### Autenticazione, e perche' si discosta dallo scaffold

Il flusso Moca standard valida il launch token **nel browser** e riceve in
risposta le `configurations` del cliente, cioe' le API key in chiaro.

Qui la validazione avviene **lato server**, in `netlify/functions/auth-session.ts`:

1. il browser passa il `moca_token` a `/api/auth-session`;
2. la function chiama `POST <hub>/api/validate-launch-token` (stesso contratto
   documentato: token monouso, TTL 5 minuti);
3. le credenziali DataForSEO restano server-side, lette da `configurations`;
4. al browser torna solo un **JWT applicativo** firmato HS256 (8 ore), che
   autentica in modo verificabile tutte le chiamate successive.

Due motivi, entrambi vincolanti:

- **Le chiavi non entrano nel browser.** La skill `moca-auth-token` chiede che
  le chiamate sensibili passino da una Netlify Function invece di partire dal
  frontend: qui le chiavi non raggiungono proprio il client.
- **Niente IDOR.** Il launch token e' monouso: dopo l'avvio non puo' piu'
  autenticare nulla. Senza un'identita' verificabile il backend dovrebbe fidarsi
  del `client_id` inviato dal browser e, poiche' la `service_role` bypassa la
  RLS, chiunque potrebbe leggere i dati di un altro cliente. La skill
  `moca-netlify-functions` prevede esplicitamente questa via: *"valida il
  moca_token lato funzione"*.

Ogni endpoint autenticato passa da `utils/guard.ts`: CORS con allow-list → JWT
verificato → assegnazione utente/cliente ricontrollata su `user_clients` (per
intercettare le revoche avvenute durante le 8 ore di sessione).

### Il flusso di scansione

Gli endpoint Google Shopping di DataForSEO **non hanno modalita' live**: sono
`task_post` → `task_get`. Da qui la forma asincrona:

1. `scan-start` sceglie l'endpoint piu' economico per ogni prodotto:
   `sellers` se il `product_id` di Google e' gia' noto e recente (30 giorni),
   altrimenti `products` per risolverlo;
2. i task vengono creati con un `postback_url` verso `dataforseo-postback`;
3. quando un task e' pronto, DataForSEO chiama il postback, che scrive match,
   snapshot di prezzo ed eventuali avvisi;
4. `scan-collect` fa la stessa cosa in polling, come riserva se il postback non
   arriva (URL pubblica non configurata, deploy in corso, rete);
5. `scheduled-scan` gira ogni giorno alle 06:00 UTC: prima chiude i task rimasti
   aperti, poi avvia le scansioni automatiche.

L'elaborazione e' idempotente: lo stesso task consegnato due volte non duplica
nulla.

---

## STRUTTURA

```
netlify/functions/
  auth-session.ts          scambio launch token -> JWT applicativo
  catalog.ts               elenco catalogo con posizionamento
  catalog-import.ts        import da feed / CSV / sitemap
  product-detail.ts        scheda prodotto, storico, azioni sui match
  dashboard.ts             KPI, serie storica, classifica competitor
  competitor via settings.ts
  settings.ts              impostazioni + gestione domini competitor
  alerts.ts                elenco avvisi e "segna come letto"
  scan-start.ts            avvio scansione
  scan-collect.ts          raccolta risultati (riserva del postback)
  dataforseo-postback.ts   callback pubblico, protetto da segreto condiviso
  own-price-refresh.ts     rilettura prezzi dal sito del cliente
  scheduled-scan.ts        esecuzione giornaliera
  utils/
    http.ts                CORS, risposte JSON, gestione errori
    session.ts             firma e verifica del JWT applicativo
    guard.ts               wrapper degli endpoint autenticati
    supabase-admin.ts      client service_role
    client-config.ts       lettura API key per cliente, autorizzazione
    dataforseo.ts          client Merchant API + SERP API
    matching.ts            motore di matching prodotto
    product-extract.ts     JSON-LD / microdata / Open Graph
    feed.ts                feed Merchant, CSV, sitemap
    pricing.ts             confronto e posizionamento prezzo
    price-queries.ts       letture sullo storico
    scan-runner.ts         avvio e raccolta di una scansione
    scan-processing.ts     risultati DataForSEO -> match, storico, avvisi
    scan-settings.ts       impostazioni con default

src/
  lib/       moca-sdk, MocaProvider, api, useApi, tipi, formattazione, palette
  components/ AppHeader, ui, PriceLineChart
  pages/     Dashboard, Catalogo, Prodotto, Competitor, Scansioni, Avvisi, Impostazioni

supabase/migrations/0001_price_tracker.sql
tests/unit-checks.ts
```

---

## SETUP

### 1. Supabase

Esegui la migration sull'istanza condivisa con l'Hub:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_price_tracker.sql
```

Crea le tabelle con prefisso `pt_`, le policy RLS basate su `user_clients` e la
funzione di aggregazione `pt_price_index` per la dashboard.

### 2. Configurazioni del cliente su Moca Hub

Un super_admin aggiunge, fra le `configurations` del cliente:

| Chiave | Valore |
|---|---|
| `DATAFORSEO_LOGIN` | login dell'account DataForSEO |
| `DATAFORSEO_PASSWORD` | password dell'account DataForSEO |

Senza queste chiavi l'app funziona in sola consultazione e la sezione Scansioni
lo segnala esplicitamente.

### 3. Variabili d'ambiente su Netlify

| Variabile | Dove | Note |
|---|---|---|
| `MOCA_HUB_URL` | server | URL dell'Hub |
| `VITE_MOCA_HUB_URL` | build | idem, per la schermata Accesso Negato |
| `APP_SESSION_SECRET` | server | `openssl rand -base64 48` |
| `SUPABASE_URL` | server | |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **mai** con prefisso `VITE_` |
| `DATAFORSEO_POSTBACK_SECRET` | server | `openssl rand -hex 32` |
| `APP_PUBLIC_URL` | server | URL pubblica, serve a costruire il postback |

### 4. Deploy e registrazione

Deploy su Netlify, poi un super_admin registra l'URL dell'app nel pannello
**Applicazioni** dell'Hub e assegna gli accessi.

### 5. Sviluppo locale

```bash
cp .env.example .env.local   # compila i valori
npm install
npm run netlify:dev          # funzioni + frontend insieme
```

Con `MOCA_ALLOW_MOCK=true` e `VITE_MOCA_ALLOW_MOCK=true` l'app parte senza
launch token usando una sessione fittizia. Il flag vale solo in locale: in
produzione `auth-session` rifiuta la richiesta mock.

---

## VERIFICHE

```bash
npm run typecheck   # tsc su frontend, funzioni e test
npm test            # controlli su matching, estrazione, feed, confronto prezzi
npm run build       # build di produzione
```

I test coprono la logica pura, cioe' le parti dove un errore silenzioso
costerebbe di piu': validazione GTIN, parsing dei prezzi nelle diverse
convenzioni locali, scoring dei match, estrazione JSON-LD, CSV con separatori e
campi quotati, calcolo del posizionamento.

---

## NOTE OPERATIVE

**Costo DataForSEO.** Ogni scansione consuma una richiesta per prodotto, piu'
una per ogni prodotto di cui va risolta l'identita' su Google Shopping. Il campo
*Prodotti per scansione* nelle impostazioni e' il tetto di sicurezza.

**Qualita' del confronto.** Dipende dai codici EAN: con il GTIN il match e'
certo, senza si scende alla somiglianza di titolo e la scheda prodotto mostra
la percentuale di affidabilita'. I match si possono confermare o escludere a
mano, e l'esclusione viene rispettata dalle scansioni successive.

**Copertura.** Google Shopping non copre tutti i venditori di tutti i mercati.
I domini importanti per il cliente si possono aggiungere a mano dalla sezione
Competitor o dalla scheda prodotto.

**Palette dei grafici.** L'ordine dei colori in `src/lib/chart-palette.ts` non e'
arbitrario: e' stato verificato per banda di luminosita', soglia di croma,
separazione per daltonismo e contrasto su fondo bianco, e passa tutti i
controlli fino a 5 serie. Dalla sesta in poi si usa il grigio "Altri", mai un
colore generato al volo.
