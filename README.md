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
Moca Hub  ──launch token──►  Browser (React 18 + Vite + Tailwind)
                                │  moca-sdk.js: sessione + configurations
                                │  contesto cliente + chiavi nel body
                                ▼
                        Netlify Functions  ──►  DataForSEO (Merchant, SERP)
                                │
                                ▼
Supabase (stessa istanza dell'Hub, tabelle con prefisso pt_, RLS per client_id)
```

### Apertura dell'app e credenziali

Flusso ufficiale Moca (`docs/APP_INTEGRATION_GUIDE.md` dell'Hub), identico a
quello delle altre app satellite:

```
Utente clicca "Apri App" sull'Hub
   -> redirect a  <app>/?moca_token=...
   -> public/moca-sdk.js valida il token con l'Hub dal browser
        POST <hub>/api/validate-launch-token   (monouso, TTL 5 minuti)
   -> l'Hub restituisce client, user, application e `configurations`
   -> l'SDK salva la sessione in sessionStorage (8 ore)
   -> il frontend passa contesto e chiavi alle Netlify Functions dell'app
```

`public/moca-sdk.js` e' la copia dell'SDK ufficiale (`docs/moca-sdk/moca-sdk.js`
dell'Hub) e va aggiornata quando l'Hub lo aggiorna.

**Le credenziali DataForSEO** arrivano dalla configurazione cliente su Moca Hub
(`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`). L'SDK le espone con `getConfig()`
e il frontend le inoltra nel body alle funzioni, come prescrive la guida:
*"Le chiavi vengono passate dall'app frontend che le ha ricevute dal Moca Hub"*.
Non sono mai hardcodate e non stanno nelle variabili d'ambiente del deploy:
appartengono al cliente, non all'app.

Restano due percorsi senza browser, dove le chiavi non possono arrivare dal
frontend: il **postback di DataForSEO** e la **scansione pianificata**. Per
quelli `utils/client-config.ts` legge la tabella `configurations` dell'Hub con
la service_role, che e' la stessa fonte da cui l'Hub le consegna.

### Contesto e autorizzazione nelle functions

Ogni chiamata porta `client_id`, `user_id` e `role` (query string sulle GET,
body sulle POST). `utils/moca-context.ts` li legge, scarta un `client_id` che
non sia un UUID e verifica su `user_clients` che l'utente sia davvero assegnato
a quel cliente.

Quel controllo non e' decorativo: queste funzioni scrivono con la service_role,
che scavalca la RLS, quindi e' l'unica cosa che impedisce a un `client_id`
alterato di leggere i dati di un altro cliente. Se le tabelle dell'Hub non sono
raggiungibili il controllo viene saltato invece di bloccare l'app.

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
  health.ts                diagnostica della configurazione (/api/health)
  catalog.ts               elenco catalogo con posizionamento
  catalog-import.ts        import da feed / CSV / sitemap
  product-detail.ts        scheda prodotto, storico, azioni sui match
  dashboard.ts             KPI, serie storica, classifica competitor
  settings.ts              impostazioni + gestione domini competitor
  alerts.ts                elenco avvisi e "segna come letto"
  scan-start.ts            avvio scansione
  scan-collect.ts          raccolta risultati (riserva del postback)
  dataforseo-postback.ts   callback pubblico, protetto da segreto condiviso
  own-price-refresh.ts     rilettura prezzi dal sito del cliente
  scheduled-scan.ts        esecuzione giornaliera
  utils/
    http.ts                CORS, risposte JSON, gestione errori
    moca-context.ts        contesto Moca della richiesta + autorizzazione
    supabase-admin.ts      client service_role
    client-config.ts       risoluzione credenziali DataForSEO
    dataforseo.ts          client Merchant API + SERP API
    matching.ts            motore di matching prodotto
    product-extract.ts     JSON-LD / microdata / Open Graph
    feed.ts                feed Merchant, CSV, sitemap
    pricing.ts             confronto e posizionamento prezzo
    price-queries.ts       letture sullo storico
    scan-runner.ts         avvio e raccolta di una scansione
    scan-processing.ts     risultati DataForSEO -> match, storico, avvisi
    scan-settings.ts       impostazioni con default

public/moca-sdk.js         SDK ufficiale dell'Hub (copia da docs/moca-sdk/)

src/
  lib/       MocaProvider, moca-types, api, useApi, tipi, formattazione, palette
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

E' l'unico posto dove vanno inserite: l'app le riceve dall'Hub alla validazione
del launch token e non le chiede mai altrove. Vedi *Apertura dell'app e
credenziali*.

Senza queste chiavi l'app funziona in sola consultazione e la sezione Scansioni
lo segnala esplicitamente.

### 3. Variabili d'ambiente su Netlify

| Variabile | Dove | Note |
|---|---|---|
| `VITE_MOCA_HUB_URL` | build | URL dell'Hub. Gia' impostata in `netlify.toml` |
| `SUPABASE_URL` | server | istanza condivisa con l'Hub |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **mai** con prefisso `VITE_` |
| `DATAFORSEO_POSTBACK_SECRET` | server | `openssl rand -hex 32`, protegge il callback |
| `APP_PUBLIC_URL` | server | URL pubblica, serve a costruire il postback |

Nessuna di queste contiene chiavi di clienti: quelle stanno sull'Hub. Senza le
due variabili Supabase l'app si apre lo stesso, ma non puo' salvare lo storico
ne' eseguire le scansioni pianificate.

`SUPABASE_URL` va nella forma `https://<project-ref>.supabase.co`. Incollata
senza schema veniva rifiutata dal client Supabase e ogni endpoint rispondeva
con un errore generico: ora lo schema viene aggiunto in automatico e un valore
davvero malformato produce un messaggio che dice cosa correggere.

**Client Supabase e WebSocket.** Il costruttore di `RealtimeClient` risolve
sempre un WebSocket, anche quando il realtime non si usa. Le Netlify Functions
girano su Node 20, che non ha `globalThis.WebSocket`: senza accorgimenti
`createClient` lancia e **ogni** endpoint risponde 500.

`utils/supabase-admin.ts` passa quindi un transport esplicito. Non usa il
pacchetto `ws` di proposito: e' CommonJS con `require` dinamici e dentro il
bundle ESM delle functions si rompe con "Dynamic require of events is not
supported". Al suo posto c'e' una classe che il realtime non istanzia mai, e
che se venisse istanziata spiega il perche' invece di fallire in modo oscuro.
Il test `tests/supabase-client.ts` simula un runtime senza WebSocket globale e
verifica che il client si costruisca comunque.

La versione e' vincolata a `>=2.94.0 <2.110.0` (stessa fascia dell'Hub):
dalla 2.110 la libreria dichiara `engines: node >= 22`.

**Per verificare la configurazione** apri `/api/health`: elenca quali variabili
mancano, se le tabelle esistono e se la funzione di aggregazione e'
disponibile, senza mai mostrare valori di chiavi. Lo stesso esito compare in
cima all'app quando qualcosa non va.

### 4. Deploy e registrazione

Deploy su Netlify, poi un super_admin registra l'URL dell'app nel pannello
**Applicazioni** dell'Hub e assegna gli accessi.

### 5. Sviluppo locale

```bash
cp .env.example .env.local   # compila i valori
npm install
npm run netlify:dev          # funzioni + frontend insieme
```

Su `localhost` l'SDK entra automaticamente in Mock Mode e l'app parte senza
launch token. Le chiavi di test si mettono in `.env.local`
(`VITE_DEV_DATAFORSEO_LOGIN` e `VITE_DEV_DATAFORSEO_PASSWORD`) e non vanno
committate. Il Mock Mode e' interno all'SDK e non si attiva fuori da localhost.

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
