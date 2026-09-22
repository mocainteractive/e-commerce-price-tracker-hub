# Price Tracker, app integrata Moca Hub

Monitoraggio dei prezzi e-commerce: individua gli stessi prodotti del catalogo
del cliente sugli altri siti, ne rileva i prezzi nel tempo e mostra gli
scostamenti. Stessa logica di un Minderest o di un Prisync, costruita sulle
**SERP API** e sulle **Merchant API** di DataForSEO, con una verifica AI dei
casi incerti affidata a Claude.

App satellite dell'ecosistema Moca: l'Hub e' l'Identity Provider e il
Configuration Manager, l'app non gestisce utenti ne' conserva API key.

---

## COSA FA

- **Importa il catalogo** del cliente da feed Google Merchant, CSV o sitemap
  (con estrazione dei dati strutturati dalle pagine prodotto).
- **Trova lo stesso prodotto** sugli altri e-commerce tramite la ricerca
  Google, con una gerarchia di affidabilita': GTIN/EAN, poi MPN/SKU, poi
  somiglianza di titolo, brand e prezzo, poi il parere dell'AI sui casi
  incerti.
- **Legge il prezzo dalla scheda del venditore** quando lo snippet di Google
  non lo mostra.
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
                        Netlify Functions  ──►  DataForSEO (SERP, Merchant)
                                │          ──►  Anthropic (verifica AI dei match)
                                │          ──►  schede dei venditori (prezzo)
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

**Le chiavi del cliente** arrivano dalla configurazione cliente su Moca Hub.
L'SDK le espone con `getConfig()` e il frontend le inoltra nel body alle
funzioni, come prescrive la guida: *"Le chiavi vengono passate dall'app
frontend che le ha ricevute dal Moca Hub"*. Non sono mai hardcodate e non
stanno nelle variabili d'ambiente del deploy: appartengono al cliente, non
all'app.

| Chiave sull'Hub | Serve a | Obbligatoria |
|---|---|---|
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | ricerche su Google e Google Shopping | si' |
| `ANTHROPIC_API_KEY` | verifica AI dei match incerti | no: senza, il passaggio viene saltato |
| `ANTHROPIC_MODEL` | modello Claude da usare, predefinito `claude-opus-5` | no |

Restano due percorsi senza browser, dove le chiavi non possono arrivare dal
frontend: il **postback di DataForSEO** e la **scansione pianificata**. Per
quelli `utils/client-config.ts` legge la tabella `configurations` dell'Hub con
la service_role, che e' la stessa fonte da cui l'Hub le consegna.

### Contesto e autorizzazione nelle functions

Ogni chiamata porta `client_id`, `user_id` e `role` (query string sulle GET,
body sulle POST). `utils/moca-context.ts` li legge e scarta gli identificativi
che non siano UUID; `utils/client-config.ts` poi:

* legge il **ruolo effettivo** dalla tabella `users` dell'Hub, ignorando quello
  dichiarato dal browser;
* rifiuta le richieste senza utente (fuori dallo sviluppo locale);
* per i ruoli non amministrativi verifica su `user_clients` che l'utente sia
  assegnato al cliente.

Quel controllo non e' decorativo: queste funzioni scrivono con la service_role,
che scavalca la RLS, quindi e' l'unica cosa che impedisce a un `client_id`
alterato di leggere i dati di un altro cliente. Prima il ruolo veniva creduto
sulla parola, e bastava dichiararsi `super_admin` per saltare ogni verifica.

Resta un limite strutturale, da tenere presente: la sessione non e' firmata,
quindi chi conosce lo UUID di un amministratore puo' ancora spacciarsi per lui.
La soluzione definitiva e' un token firmato dall'Hub, che l'SDK oggi non
fornisce.

### Tempi di esecuzione: il browser orchestra, le funzioni lavorano a lotti

Le Netlify Functions hanno circa **10 secondi**. Un import di qualche migliaio
di prodotti o una scansione su un catalogo intero ne richiedono molti di piu'.
La soluzione non e' chiedere piu' tempo alla piattaforma, ma spezzare il
lavoro: **ogni funzione fa un lotto e dice quanto resta**, e il browser, che
limiti di durata non ne ha, ripete finche' non ha finito, mostrando
l'avanzamento e permettendo di annullare.

| Operazione | Per chiamata | Chi scorre |
|---|---|---|
| `catalog-save` | 200 prodotti | browser |
| `catalog-finalize` | 300 disattivazioni | browser |
| `extract-pages` | 5 pagine prodotto, in parallelo | browser |
| `scan-serp` | 1 prodotto, con scadenza a 8,5 s | browser |
| `scan-start` / `scan-enqueue` | 50 prodotti accodati (Shopping) | browser |
| `scan-collect` | 15 task raccolti | browser |
| `own-price-refresh` | 8 pagine in parallelo, 6 s ciascuna | browser |
| `scheduled-scan` | budget di 8,5 s, ogni 10 minuti | la pianificazione |

Ogni chiamata esterna ha un timeout proprio, sotto i 10 secondi: DataForSEO
(7 s), le schede dei venditori (2,5 s), l'AI (fino a 6 s, con il tempo che
resta). Senza, una richiesta lenta faceva uccidere la funzione dalla
piattaforma e il browser riceveva un 502 senza spiegazione.

**Dove possibile il lavoro non tocca proprio il server.** CSV e XML vengono
letti e interpretati nel browser, e per le URL il browser tenta prima il
download diretto, passando dal proxy `fetch-source` solo quando il CORS glielo
impedisce. Gli stessi parser (`utils/feed.ts`) girano da entrambe le parti:
una sola implementazione, nessuna possibilita' che divergano.

**Feed grandi o generati al volo.** Il proxy ha 8 secondi per tutto il
trasferimento, corpo compreso, e un tetto di 12.000 righe perche' la risposta
di una funzione non puo' superare i 6 MB. Quando uno dei due limiti scatta
l'import lo dice (e con l'import sostitutivo si ferma, per non disattivare i
prodotti che non ha ricevuto). La via giusta per questi feed e' il **file
caricato dal browser**, che non ha limiti: un feed da 24 MB e 17.000 prodotti
si legge in due secondi.

**Import da sitemap.** Una sitemap elenca anche categorie, blog e pagine
statiche: leggerle tutte sprecherebbe la parte piu' lenta dell'import. Le
schede prodotto vengono riconosciute automaticamente (segmenti tipici delle
piattaforme diffuse, esclusione di blog, carrello, pagine informative e file),
e la regola si puo' forzare indicando un frammento di URL. Si leggono 500
pagine per giro e l'import riprende dalle successive al giro dopo.

### Come vengono trovati i prezzi

**La fonte predefinita e' la SERP organica di Google**, non Google Shopping.
La scelta viene da una verifica sul campo, non da una preferenza:

* e' **sincrona**: al termine della scansione i prezzi sono gia' salvati.
  Con Google Shopping, che e' asincrono, "nessun risultato" e "risultato non
  ancora pronto" sono indistinguibili, ed e' esattamente il modo in cui una
  scansione puo' sembrare finita senza aver trovato niente;
* i suoi item **portano gia' il prezzo** mostrato nello snippet, che gli
  e-commerce espongono quasi sempre.

**La query non e' mai il solo codice EAN.** Sembrava la scelta ovvia ed era la
causa delle scansioni a vuoto: un numero isolato su Google porta pochi
risultati pertinenti e molti estranei, perche' i venditori raramente
pubblicano l'EAN nel testo. Misurato su un caso reale:

| Query | Risultato |
|---|---|
| `8056590473955` | 3 venditori giusti su 10, il resto ammorbidenti e shampoo |
| `Venezianico 6121503C Orologio Automatico Arsenale 37` | 4 venditori con prezzo |

La forma che funziona e' quella che userebbe una persona: marca, codice
modello e nome. L'EAN resta disponibile come **passata aggiuntiva**
facoltativa: quando un venditore lo pubblica davvero, il riconoscimento e'
certo.

Per ogni prodotto la scansione fa tre passaggi (`utils/serp-scan.ts`):

1. **Ricerca e matching deterministico.** Il motore scarta il rumore (0% per
   gli articoli estranei) e distingue le varianti dello stesso modello: un
   `6121501C` non viene confuso con un `6121503C`, pur avendo titolo quasi
   identico e prezzo uguale. I codici con spazi ("LIVIA 6608 374") vengono
   riconosciuti anche nel testo compattato.
2. **Prezzo dalla scheda del venditore.** Per i risultati riconosciuti ma
   senza prezzo nello snippet, l'app apre la pagina (massimo 3 per ricerca,
   2,5 secondi) e legge i dati strutturati. Nessun costo aggiuntivo.
3. **Verifica AI dei casi incerti.** I candidati con somiglianza fra il 40% e
   l'80% e con un prezzo vengono sottoposti a Claude insieme ai dati del
   prodotto: un verdetto per candidato, con confidenza e motivazione. Chi
   viene confermato entra con metodo `ai`; chi viene scartato non entra piu'
   solo perche' ripete le parole del titolo. Il passaggio richiede
   `ANTHROPIC_API_KEY` sull'Hub e si disattiva dalle impostazioni.

Tutto questo sta in una scadenza comune: ogni passaggio riceve il tempo che
resta e, se non basta, viene saltato e annotato nella diagnostica.

### Capire una scansione che non trova nulla

`/api/scan-debug`, esposto nella scheda prodotto come **Prova la ricerca**,
esegue la ricerca senza salvare e mostra la query inviata, i risultati
tornati, e per ognuno il punteggio di somiglianza con il motivo per cui e'
stato tenuto o scartato, il prezzo letto dalla scheda e il verdetto dell'AI.

Esiste perche' "non ha trovato nulla" non e' una diagnosi: con un motore di
matching servono i numeri, altrimenti si tira a indovinare fra dieci cause
possibili. Anche il diario della scansione riporta, prodotto per prodotto,
quanti risultati sono arrivati, quanti avevano un prezzo e quanti sono stati
riconosciuti.

### Stato della scansione

Una run si chiude quando non resta lavoro: il cursore SERP ha raggiunto il
totale e non ci sono task Google Shopping in attesa (`computeRunStatus` in
`utils/scan-processing.ts`, coperta dai test). Una run aperta da oltre due ore
viene chiusa come parziale. Prima una run SERP non si chiudeva mai, perche' lo
stato veniva calcolato solo dai task Shopping: il pulsante restava disabilitato
e la pianificata saltava il cliente.

### Il flusso Google Shopping (fonte alternativa)

Gli endpoint Google Shopping di DataForSEO **non hanno modalita' live**: sono
`task_post` → `task_get`. Da qui la forma asincrona:

1. `scan-start` sceglie l'endpoint piu' economico per ogni prodotto:
   `sellers` se il `product_id` di Google e' gia' noto e recente (30 giorni),
   altrimenti `products` per risolverlo;
2. i task vengono creati con un `postback_url` verso `dataforseo-postback`;
3. quando un task e' pronto, DataForSEO chiama il postback, che scrive match,
   snapshot di prezzo ed eventuali avvisi;
4. `scan-collect` fa la stessa cosa in polling, come riserva se il postback non
   arriva (URL pubblica non configurata, deploy in corso, rete).

Con la fonte **Entrambe** la scansione fa la ricerca Google e accoda anche i
task Shopping. L'elaborazione e' idempotente: lo stesso task consegnato due
volte non duplica nulla.

### Scansione pianificata

`scheduled-scan` gira **ogni 10 minuti** con un budget di 8,5 secondi:
raccoglie i task Shopping in sospeso, alle 06 UTC crea la scansione del giorno
per i clienti che l'hanno attivata (con la fonte scelta nelle impostazioni),
poi fa avanzare le scansioni SERP aperte di qualche prodotto alla volta, con
le stesse regole della scansione manuale. In un giorno ci sono 144 esecuzioni:
bastano per il tetto predefinito di 200 prodotti.

---

## STRUTTURA

```
netlify/functions/
  health.ts                diagnostica della configurazione (/api/health)
  catalog.ts               elenco catalogo con posizionamento
  fetch-source.ts          proxy per feed e sitemap senza CORS
  extract-pages.ts         lettura dei dati strutturati, poche pagine per volta
  catalog-save.ts          salvataggio di un lotto di prodotti
  catalog-finalize.ts      istante server di inizio import + disattivazioni
  product-detail.ts        scheda prodotto, storico, azioni sui match
  dashboard.ts             KPI, serie storica, classifica competitor
  settings.ts              impostazioni + gestione domini competitor
  alerts.ts                elenco avvisi e "segna come letto"
  scan-serp.ts             ricerca sulla SERP organica, un prodotto per chiamata
  scan-debug.ts            diagnostica della ricerca su un singolo prodotto
  scan-start.ts            crea la scansione (e accoda Shopping, se scelto)
  scan-enqueue.ts          accoda i lotti Shopping successivi
  scan-collect.ts          raccolta risultati Shopping (riserva del postback)
  dataforseo-postback.ts   callback pubblico, protetto da segreto condiviso
  own-price-refresh.ts     rilettura prezzi dal sito del cliente
  scheduled-scan.ts        esecuzione ogni 10 minuti
  utils/
    http.ts                CORS, risposte JSON, gestione errori
    moca-context.ts        contesto Moca della richiesta
    client-config.ts       credenziali dall'Hub + autorizzazione
    supabase-admin.ts      client service_role
    dataforseo.ts          client SERP API + Merchant API, con timeout
    ai-match.ts            verifica AI dei match incerti (Anthropic SDK)
    matching.ts            motore di matching prodotto
    product-extract.ts     JSON-LD / microdata / Open Graph
    feed.ts                feed Merchant, CSV, sitemap
    pricing.ts             confronto e posizionamento prezzo
    price-queries.ts       letture sullo storico
    remote-fetch.ts        download esterni con budget di tempo e filtro SSRF
    serp-scan.ts           ricerca, prezzo dalla scheda, AI, diagnostica
    sitemap-filter.ts      riconoscimento delle pagine prodotto
    scan-runner.ts         accodamento e raccolta Shopping, a lotti
    scan-processing.ts     risultati -> match, storico, avvisi; stato della run
    scan-settings.ts       impostazioni con default

public/moca-sdk.js         SDK ufficiale dell'Hub (copia da docs/moca-sdk/)

src/
  lib/       MocaProvider, moca-types, api, useApi, useJob, tipi, formattazione, palette
  components/ AppHeader, ui, PriceLineChart, ImportCatalogo, JobProgress, StatoConfigurazione, DiagnosticaRicerca
  pages/     Dashboard, Catalogo, Prodotto, Competitor, Scansioni, Avvisi, Impostazioni

supabase/migrations/0001_price_tracker.sql
supabase/migrations/0002_serp_source_e_sitemap.sql
supabase/migrations/0003_ai_e_stato_run.sql
tests/unit-checks.ts        logica pura: matching, parser, prezzi
tests/supabase-client.ts    regressione sul client Supabase senza WebSocket
tests/serp-matching.ts      matching su feed e risultati di ricerca reali
tests/scan-logic.ts         stato della run, estrazione, codici, SSRF, AI
```

---

## SETUP

### 1. Supabase

Esegui le migration sull'istanza condivisa con l'Hub:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_price_tracker.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_serp_source_e_sitemap.sql
psql "$DATABASE_URL" -f supabase/migrations/0003_ai_e_stato_run.sql
```

La prima crea le tabelle con prefisso `pt_`, le policy RLS basate su
`user_clients` e la funzione di aggregazione `pt_price_index` per la dashboard.
La seconda aggiunge la scelta della fonte di ricerca e le regole per le
sitemap. La terza aggiunge le impostazioni per l'AI e per il prezzo dalla
scheda, la fonte sulla run e il metodo di match `ai`. Senza le ultime due
l'app funziona comunque, usando i valori di default.

### 2. Configurazioni del cliente su Moca Hub

Un super_admin aggiunge, fra le `configurations` del cliente:

| Chiave | Valore |
|---|---|
| `DATAFORSEO_LOGIN` | login dell'account DataForSEO |
| `DATAFORSEO_PASSWORD` | password dell'account DataForSEO |
| `ANTHROPIC_API_KEY` | chiave Anthropic, facoltativa, per la verifica AI |
| `ANTHROPIC_MODEL` | facoltativa, modello Claude (predefinito `claude-opus-5`) |

E' l'unico posto dove vanno inserite: l'app le riceve dall'Hub alla validazione
del launch token e non le chiede mai altrove. Vedi *Apertura dell'app e
credenziali*.

Senza le chiavi DataForSEO l'app funziona in sola consultazione e la sezione
Scansioni lo segnala esplicitamente. Senza la chiave Anthropic la scansione
funziona con il solo matching deterministico, e lo dice nel diario.

### 3. Variabili d'ambiente su Netlify

| Variabile | Dove | Note |
|---|---|---|
| `VITE_MOCA_HUB_URL` | build | URL dell'Hub. Gia' impostata in `netlify.toml` |
| `SUPABASE_URL` | server | istanza condivisa con l'Hub |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **mai** con prefisso `VITE_` |
| `DATAFORSEO_POSTBACK_SECRET` | server | `openssl rand -hex 32`, protegge il callback |
| `APP_PUBLIC_URL` | server | URL pubblica, serve a costruire il postback |

Nessuna di queste contiene chiavi di clienti: quelle stanno sull'Hub. Senza le
due variabili Supabase l'app si apre ma nessun endpoint puo' lavorare.

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
(`VITE_DEV_DATAFORSEO_LOGIN`, `VITE_DEV_DATAFORSEO_PASSWORD`,
`VITE_DEV_ANTHROPIC_API_KEY`) e non vanno committate. Il Mock Mode e' interno
all'SDK e non si attiva fuori da localhost; le functions accettano un contesto
senza utente solo fuori da un deploy Netlify (o con `netlify dev`).

---

## VERIFICHE

```bash
npm run typecheck   # tsc su frontend, funzioni e test
npm test            # matching, estrazione, feed, prezzi, stato della run, AI
npm run build       # build di produzione
```

I test coprono la logica pura, cioe' le parti dove un errore silenzioso
costerebbe di piu': validazione GTIN, parsing dei prezzi nelle diverse
convenzioni locali, scoring dei match, estrazione JSON-LD e microdata, CSV
con separatori e campi quotati, calcolo del posizionamento, chiusura delle
run, filtro SSRF, lettura dei verdetti AI.

---

## NOTE OPERATIVE

**Costo DataForSEO.** Ogni scansione consuma una richiesta SERP per prodotto
(due con la passata EAN), piu', con Google Shopping, una per prodotto e una
per ogni prodotto di cui va risolta l'identita'. Il campo *Prodotti per
scansione* nelle impostazioni e' il tetto di sicurezza.

**Costo AI.** Solo i candidati nella fascia incerta (somiglianza 40-80%, con un
prezzo) passano da Claude, al massimo 5 per ricerca, in una sola chiamata
breve. Su un catalogo con EAN e codici modello la maggior parte dei prodotti
non ne ha bisogno.

**Qualita' del confronto.** Dipende dai codici EAN e MPN: con il GTIN il match
e' certo, senza si scende alla somiglianza di titolo (e all'AI) e la scheda
prodotto mostra la percentuale di affidabilita'. I match si possono confermare
o escludere a mano, e l'esclusione viene rispettata dalle scansioni
successive. Su cataloghi di moda senza codici (Pellizzari: 28 EAN su 17.000
prodotti) Google restituisce spesso solo il sito del cliente: e' un limite del
mercato, non del motore.

**Copertura.** La ricerca Google non copre tutti i venditori di tutti i
mercati. I domini importanti per il cliente si possono aggiungere a mano dalla
sezione Competitor o dalla scheda prodotto.

**Palette dei grafici.** L'ordine dei colori in `src/lib/chart-palette.ts` non e'
arbitrario: e' stato verificato per banda di luminosita', soglia di croma,
separazione per daltonismo e contrasto su fondo bianco, e passa tutti i
controlli fino a 5 serie. Dalla sesta in poi si usa il grigio "Altri", mai un
colore generato al volo.
