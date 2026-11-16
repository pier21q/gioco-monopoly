# INTERFACCE — contratti condivisi del Monopoly online

Questo documento è la fonte di verità per tutto ciò che attraversa un confine
tra moduli: forma dello stato, API del motore, protocollo WebSocket, moduli del
client e dati statici. Chi modifica un contratto aggiorna prima questo file.

Indice

0. Convenzioni generali (moduli, denaro, codici stanza, identificatori)
1. Stato di partita (`StatoPartita`) in JSON
2. API del motore (`server/gioco/motore.js`, `scambi.js`, `bancarotta.js`)
3. Protocollo WebSocket e rotte HTTP (`server/index.js`, `stanze.js`, `protocollo.js`)
4. Moduli del client (`client/`)
5. Dati statici condivisi (`tabellone.js`, `carte.js`)
6. Eventi di gioco
7. Codici di errore
8. Regole implementate e semplificazioni dichiarate

---

## 0. Convenzioni generali

### 0.1 Tecnologie e sistema di moduli

| Ambito | Scelta |
|---|---|
| Runtime server | Node.js **>= 20**, nessun transpiler, nessun bundler |
| Moduli server | **CommonJS** (`'use strict'`, `require`, `module.exports`). In `package.json` **non** c'è `"type": "module"`. |
| Dipendenze | **una sola**: `ws` (WebSocket). File statici serviti con il modulo nativo `http`. |
| Client | HTML + CSS + JavaScript puro, **ES module nel browser** (`<script type="module">`), nessun build step |
| Test | `node:test` + `node:assert/strict`, file `tests/*.test.js`, comando `npm test` (= `node --test`, che li trova da solo) |
| Avvio | `npm start` (= `node server/index.js`) |

Variabili d'ambiente lette dal server (nessuna è un segreto; non serve `.env`; il file di `SALVATAGGIO` invece contiene i token di sessione ed è escluso da git):

| Variabile | Default | Significato |
|---|---|---|
| `PORT` | `3000` | porta HTTP/WebSocket |
| `HOST` | `0.0.0.0` | interfaccia di ascolto |
| `PUBLIC_URL` | l'host con cui il browser ha raggiunto il server | base del link condiviso (es. dietro un tunnel/proxy) |
| `ORIGINE_LIBERA` | non impostata | con `1` disattiva il controllo dell'`Origin` sul WebSocket (§3.5), utile solo dietro proxy che riscrivono l'host |
| `PROXY_FIDATO` | `1` su Render (variabile `RENDER`), altrimenti spenta | con `1` il server crede a `X-Forwarded-For`/`-Host`/`-Proto`; `0` la spegne anche su Render |
| `SALVATAGGIO` | `.partite/partite.json` | file del salvataggio delle partite (`server/salvataggio.js`); `0` lo disattiva |

Se in futuro servissero segreti vanno in `.env` (già in `.gitignore`) e nel
repository entra solo `.env.example` con valori finti.

### 0.2 Struttura delle cartelle

```
package.json
INTERFACCE.md
server/
  index.js            avvio: http statico + WebSocket, smista i messaggi
  stanze.js           stanze (lobby, giocatori, token, stato di partita)
  protocollo.js       costanti, tipi di messaggio, validazione, codici errore
  gioco/
    motore.js         creaPartita / applicaAzione: regole del gioco, funzione pura
    scambi.js         proposta/accettazione scambi (usato dal motore)
    bancarotta.js     liquidazione e trasferimento beni (usato dal motore)
    tabellone.js      [claude-2] CASELLE, GRUPPI e costanti (dati puri)
    carte.js          [claude-2] PROBABILITA, IMPREVISTI (dati puri)
client/               [claude-2] web root servito su /
  index.html
  css/…
  js/app.js (entry + creaStore)  rete.js  lobby.js  tabellone.js  pannelli.js  dialoghi.js
tests/
```

### 0.3 Denaro

* Tutti gli importi sono **numeri interi in euro** (`Number`, mai stringhe, mai
  decimali, mai simboli). Esempio: `1500`, non `"1.500 €"` né `1500.0`.
* Il server non arrotonda mai a metà: ogni valore di regolamento è già intero
  (ipoteca = prezzo/2 è intero per tutte le caselle; interesse di disipoteca =
  ipoteca + 10% arrotondato per eccesso con `Math.ceil`).
* Un importo negativo in un **effetto carta** (`denaro`) significa "paga".
  In ogni altro punto (stato, azioni, eventi) gli importi sono sempre >= 0 e la
  direzione è data dai campi `daId`/`aId`.
* La formattazione (`1.500 €`) è compito esclusivo del client.

### 0.4 Codici stanza

* **6 caratteri maiuscoli**, generati dall'alfabeto
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (senza `I`, `O`, `0`, `1` per evitare
  ambiguità a voce). Esempio: `K7PQ2M`.
* Validazione in ingresso: regex `^[A-Z0-9]{6}$` dopo `trim()` e
  `toUpperCase()`; il server normalizza, il client può accettare minuscole.
* Il link condiviso è `PUBLIC_URL + '/?stanza=' + codice`, es.
  `http://localhost:3000/?stanza=K7PQ2M`.

### 0.5 Identificatori, tempi, colori, nomi

| Cosa | Formato | Esempio |
|---|---|---|
| `giocatoreId` | 8 caratteri `[a-z0-9]`, generato dal server, pubblico | `"a7k2x9pq"` |
| `token` | 32 caratteri hex, generato dal server, **segreto** del singolo client, mai nello stato | `"3f1a…"` |
| `scambio.id` | `"s" + contatore` per partita | `"s3"` |
| Timestamp | millisecondi Unix (`Date.now()`) | `1763204073000` |
| Indice casella | intero 0–39, Via = 0, senso orario | `11` |
| `colore` | stringa `#rrggbb` minuscola | `"#d62828"` |
| `nome` | 1–16 caratteri dopo `trim()`, unico nella stanza (case-insensitive) | `"Anna"` |

Palette consigliata per i giocatori (il server accetta qualunque `#rrggbb`
ma rifiuta un colore già preso nella stanza; se il colore manca ne assegna uno
libero da questa lista in ordine):

```
#d62828 rosso · #1d4ed8 blu · #1e8e3e verde · #f28c28 arancione
#7c3aed viola · #0891b2 azzurro · #db2777 rosa · #a16207 ocra
```

Esportata da `server/protocollo.js` come `COLORI_GIOCATORE`.

---

## 1. Stato di partita (`StatoPartita`)

Un unico oggetto JSON-serializzabile descrive **tutto** ciò che il client deve
sapere. Lo stesso shape è usato in lobby (campi di gioco a valori neutri) e in
partita. Il server invia sempre lo stato completo (non diff); il client
sostituisce il proprio.

```json
{
  "versione": 42,
  "codice": "K7PQ2M",
  "hostId": "a7k2x9pq",
  "fase": "mossa",
  "creataIl": 1763204073000,
  "aggiornataIl": 1763204099000,

  "giocatori": [
    {
      "id": "a7k2x9pq",
      "nome": "Anna",
      "colore": "#d62828",
      "denaro": 1340,
      "posizione": 11,
      "inPrigione": false,
      "turniInPrigione": 0,
      "cartePrigione": 1,
      "connesso": true,
      "fallito": false
    },
    {
      "id": "b3m8w1zt",
      "nome": "Bruno",
      "colore": "#1d4ed8",
      "denaro": 1500,
      "posizione": 0,
      "inPrigione": false,
      "turniInPrigione": 0,
      "cartePrigione": 0,
      "connesso": false,
      "fallito": false
    }
  ],

  "turno": {
    "giocatoreId": "a7k2x9pq",
    "numero": 7,
    "doppiConsecutivi": 0
  },
  "dadi": [5, 6],

  "proprieta": {
    "1":  { "proprietario": "a7k2x9pq", "caseCostruite": 2, "ipotecata": false },
    "3":  { "proprietario": "a7k2x9pq", "caseCostruite": 2, "ipotecata": false },
    "5":  { "proprietario": null,       "caseCostruite": 0, "ipotecata": false },
    "6":  { "proprietario": "b3m8w1zt", "caseCostruite": 0, "ipotecata": true  },
    "…":  "una voce per ciascuna delle 28 caselle acquistabili"
  },
  "caseDisponibili": 28,
  "alberghiDisponibili": 12,

  "asta": null,
  "scambio": null,
  "debito": null,

  "mazzi": { "probabilita": ["P03", "P11", "P01"], "imprevisti": ["I07", "I02"] },

  "log": [
    {
      "t": 1763204099000,
      "tipo": "affitto",
      "giocatoreId": "a7k2x9pq",
      "testo": "Anna paga 50 € a Bruno per Via Accademia",
      "dati": { "daId": "a7k2x9pq", "aId": "b3m8w1zt", "casella": 11, "importo": 50 }
    }
  ],
  "vincitoreId": null
}
```

### 1.1 Campi di testa

| Campo | Tipo | Note |
|---|---|---|
| `versione` | intero | parte da 0, +1 a ogni `applicaAzione` riuscita e a ogni cambio in lobby. Il client ignora stati con versione < quella corrente. |
| `codice` | stringa | codice stanza (§0.4) |
| `hostId` | `giocatoreId` | chi può avviare la partita. Se l'host esce in lobby, passa al primo giocatore rimasto. |
| `fase` | enum | vedi §1.2 |
| `creataIl`, `aggiornataIl` | timestamp | |
| `vincitoreId` | `giocatoreId` \| `null` | valorizzato solo in `finePartita` |

### 1.2 Fasi

| `fase` | Significato | Azioni ammesse (chi) |
|---|---|---|
| `lobby` | partita non iniziata; `turno.giocatoreId` è `null`, `dadi` è `null`, denaro 0 | nessuna azione di gioco; messaggi `entraStanza`, `avviaPartita`, `esciStanza` |
| `daLanciare` | il giocatore di turno deve lanciare (o, se in prigione, scegliere come uscire) | `lanciaDadi`, `pagaCauzione`, `usaCartaPrigione` (turno) · gestione (§2.4) |
| `mossa` | lancio fatto e casella risolta; il giocatore può gestire proprietà e poi chiudere il turno | `finisciTurno` (turno) · gestione |
| `daDecidereAcquisto` | il giocatore di turno è su una casella libera | `compra`, `rifiutaAcquisto` (turno) · gestione |
| `asta` | asta in corso per `asta.casella` | `offertaAsta`, `passaAsta` (ogni partecipante) · `vendiCasa`, `ipoteca` (tutti) |
| `debito` | `debito.giocatoreId` deve pagare `debito.importo` e non ha liquidità | `vendiCasa`, `ipoteca`, `dichiaraBancarotta` (debitore) · `proponiScambio` (chiunque: anche il creditore può offrire uno scambio al debitore) · `accettaScambio`/`rifiutaScambio` (destinatario) |
| `finePartita` | resta un solo giocatore non fallito | nessuna |

In ogni fase di gioco (non in `lobby` né in `finePartita`) ogni giocatore non
fallito può inoltre inviare `abbandona` (§2.4).

Con un **doppio** (e senza finire in prigione) la fase torna a `daLanciare`
per lo stesso giocatore, con `turno.doppiConsecutivi` incrementato; al terzo
doppio consecutivo il giocatore va in prigione e la fase è `mossa`.

### 1.3 Giocatori

Array **nell'ordine di turno** (fissato all'avvio; con `opzioni.ordineCasuale`
viene mescolato). Il turno passa al prossimo giocatore con `fallito: false`.

| Campo | Tipo | Note |
|---|---|---|
| `id` | `giocatoreId` | |
| `nome` | stringa | |
| `colore` | `#rrggbb` | |
| `denaro` | intero >= 0 | può scendere a 0 ma mai sotto: se manca liquidità si entra in `debito` |
| `posizione` | 0–39 | in prigione è sempre `10` |
| `inPrigione` | bool | |
| `turniInPrigione` | 0–3 | tentativi di lancio falliti in prigione; al terzo si paga 50 e si esce |
| `cartePrigione` | 0–2 | carte "Uscite gratis di prigione" possedute (una per mazzo) |
| `connesso` | bool | socket attivo; chi è disconnesso resta in partita e può riconnettersi col token |
| `fallito` | bool | eliminato; non ha più beni né turni |

### 1.4 Turno e dadi

```json
"turno": { "giocatoreId": "a7k2x9pq", "numero": 7, "doppiConsecutivi": 0, "soste": ["marrone"] },
"dadi": [5, 6]
```

* `turno.soste` elenca i gruppi colore delle caselle `proprieta` su cui la
  pedina di turno si è fermata in questo turno (anche prima di un doppio).
  Riparte vuoto a ogni cambio di turno; serve alla regola `'sosta'` (§2.4).

* `turno.numero` parte da 1 e cresce a ogni `finisciTurno` (o fine turno
  automatica dopo prigione / bancarotta).
* `dadi` è l'ultimo lancio `[d1, d2]` (ciascuno 1–6) o `null` prima del primo
  lancio della partita. Non viene azzerato a fine turno: il client lo usa per
  mostrare l'ultimo lancio.

### 1.5 Proprietà

Oggetto indicizzato per **indice di casella come stringa** (JSON non ha chiavi
numeriche). Contiene **sempre tutte e 28** le caselle acquistabili (22
proprietà, 4 stazioni, 2 società), anche quando nessuno le possiede: il client
non deve gestire voci mancanti.

| Campo | Tipo | Note |
|---|---|---|
| `proprietario` | `giocatoreId` \| `null` | `null` = banca |
| `caseCostruite` | 0–5 | **5 = albergo**. Coincide con l'indice di `CASELLE[i].affitti`. Sempre 0 per stazioni e società. |
| `ipotecata` | bool | se vera non si incassa affitto e non si costruisce nel gruppo |

`caseDisponibili` (max 32) e `alberghiDisponibili` (max 12) sono le scorte
della banca.

### 1.6 Asta

`null` fuori dalla fase `asta`.

```json
"asta": {
  "casella": 39,
  "offertaMassima": 120,
  "migliorOfferenteId": "b3m8w1zt",
  "partecipanti": ["a7k2x9pq", "b3m8w1zt", "c9r4n2vd"],
  "passati": ["c9r4n2vd"],
  "incrementoMinimo": 1,
  "iniziataIl": 1763204080000
}
```

* Asta all'inglese libera: chiunque in `partecipanti` e non in `passati` può
  offrire un importo `>= offertaMassima + incrementoMinimo` e `<=` del proprio
  denaro. Il miglior offerente non può passare.
* Partecipano tutti i giocatori non falliti, incluso chi ha rifiutato
  l'acquisto. `partecipanti` è nell'ordine dei giocatori.
* Termina quando tutti tranne il miglior offerente hanno passato (la proprietà
  va a lui per `offertaMassima`), oppure quando tutti hanno passato senza
  offerte (resta alla banca). Poi la fase torna a `mossa` del giocatore di
  turno.

### 1.7 Scambio

`null` se nessuna proposta è pendente. **Al massimo uno** alla volta per partita.

```json
"scambio": {
  "id": "s3",
  "daId": "a7k2x9pq",
  "aId": "b3m8w1zt",
  "offre":  { "denaro": 100, "proprieta": [1, 3], "cartePrigione": 0 },
  "chiede": { "denaro": 0,   "proprieta": [6],    "cartePrigione": 1 },
  "propostoIl": 1763204090000
}
```

* `proprieta` sono indici di casella (numeri). Si possono scambiare solo
  caselle **senza costruzioni** (`caseCostruite === 0`). Le ipotecate sì: chi
  le riceve paga subito alla banca il 10% del valore d'ipoteca (interesse).
* Almeno una delle due parti deve offrire qualcosa; non si può scambiare con
  sé stessi né con un fallito.

### 1.8 Debito

`null` fuori dalla fase `debito`.

```json
"debito": {
  "giocatoreId": "a7k2x9pq",
  "creditoreId": "b3m8w1zt",
  "importo": 350,
  "motivo": "affitto",
  "faseDopo": "mossa"
}
```

* `creditoreId` `null` = banca (tasse, carte, cauzione).
* `motivo` ∈ `affitto` · `tassa` · `carta` · `cauzione` · `pagaATutti` ·
  `interesseScambio` · `interesseBancarotta` (10% sulle ipotecate ricevute
  dal creditore di una bancarotta). Con `motivo: 'affitto'`/`'tassa'` c'è
  anche `casella`.
* Se nasce un debito mentre un altro è già aperto (es. "ricevete 10 € da ogni
  giocatore" con più giocatori senza liquidità) finisce in
  `stato.debitiInAttesa` (stesso shape, senza `faseDopo`) e diventa il
  `debito` corrente quando il precedente si chiude. Un giocatore con un
  debito aperto o in coda paga i nuovi addebiti solo dopo (ordine garantito).
* Dopo **ogni** azione in fase `debito`, se `denaro >= importo` il motore salda
  automaticamente il debito (evento `debitoSaldato`) e passa a `faseDopo`.
* `dichiaraBancarotta` è ammessa solo in questa fase: i beni vanno al
  creditore (o alla banca), il giocatore diventa `fallito`.

### 1.9 Mazzi (solo server)

`mazzi.probabilita` e `mazzi.imprevisti` sono array di `id` carta nell'ordine
di pesca (si pesca in testa, si rimette in coda). Le carte `esciGratis`
escono dal mazzo finché il giocatore non le usa. **Il server rimuove `mazzi`
dallo stato inviato ai client** (`motore.statoPubblico`): il client non deve
dipendere da questo campo. In compenso `statoPubblico` aggiunge `azioni`:
`{ giocatoreId: [tipi] }` con il risultato di `azioniDisponibili` per ogni
giocatore, che il client usa per accendere i pulsanti senza ricopiare le
regole.

### 1.9 bis Campi aggiuntivi (fase 2)

| Campo | Tipo | Note |
|---|---|---|
| `debitiInAttesa` | `Debito[]` | coda dei debiti successivi (§1.8); di solito `[]` |
| `asteInAttesa` | `number[]` | caselle da mettere all'asta dopo una bancarotta verso la banca |
| `cartePrigioneDi` | `{ [idCarta]: giocatoreId }` | chi possiede le carte `esciGratis` (`P05`, `I08`): serve a rimetterle nel mazzo giusto |
| `asta.faseDopo` | fase | fase a cui si torna quando l'asta si chiude |

Il client può ignorarli; `statoPubblico` li lascia (non sono segreti).

### 1.10 Log

`log` contiene gli ultimi **200** eventi (§6) in ordine cronologico, stesso
shape dei messaggi `evento`. Serve a chi si riconnette per ricostruire la
cronaca. Per non spedire a ogni azione tutta la cronaca, nei messaggi `stato`
di aggiornamento il server include solo gli ultimi **30** eventi
(`LIMITI.LOG_BREVE`); il log completo arriva nello `stato` inviato a chi si
riconnette (§3.2). Il client ricuce i due (`unisciLog` in `app.js`), quindi
`StatoClient.partita.log` è sempre la cronaca intera.

---

## 2. API del motore

Il motore è una **funzione pura**: non ha stato interno, non muta gli input,
non fa I/O, non usa `Math.random` o `Date.now()` direttamente (vengono
iniettati). Questo lo rende testabile in modo deterministico.

```js
const motore = require('./server/gioco/motore');
```

### 2.1 `creaPartita(opzioni) → StatoPartita`

```js
const stato = motore.creaPartita({
  codice: 'K7PQ2M',                 // obbligatorio
  hostId: 'a7k2x9pq',               // obbligatorio
  giocatori: [                      // 2..6, nell'ordine di ingresso in stanza
    { id: 'a7k2x9pq', nome: 'Anna',  colore: '#d62828', connesso: true },
    { id: 'b3m8w1zt', nome: 'Bruno', colore: '#1d4ed8', connesso: true },
  ],
  random: Math.random,              // () => [0,1): mescola mazzi e ordine; default Math.random
  ora: Date.now,                    // () => timestamp; default Date.now
  opzioni: {
    denaroIniziale: 1500,           // default 1500
    ordineCasuale: true,            // default true: mescola l'ordine di turno
  },
});
```

Ritorna uno stato in fase `daLanciare`, `versione: 0`, `turno.numero: 1`,
tutte le proprietà alla banca, mazzi mescolati, un evento `partitaIniziata`
in `log`. Lancia `TypeError` se le opzioni sono malformate (meno di 2 o più di
6 giocatori, id duplicati).

### 2.2 `creaStatoLobby({ codice, hostId, giocatori, ora }) → StatoPartita`

Stesso shape di §1 ma `fase: 'lobby'`, `turno.giocatoreId: null`, `dadi:
null`, denaro 0, `proprieta` tutte alla banca, `log` con gli ingressi. Usato
da `stanze.js` finché la partita non è avviata.

### 2.3 `applicaAzione(stato, giocatoreId, azione, contesto?) → Risultato`

```js
const ris = motore.applicaAzione(stato, 'a7k2x9pq', { tipo: 'lanciaDadi' }, {
  random: Math.random,   // default Math.random
  ora: Date.now,         // default Date.now
});

if (ris.errore) {
  // { errore: { codice: 'NON_IL_TUO_TURNO', messaggio: 'Non è il tuo turno', dettagli?: {...} } }
} else {
  // { stato: StatoPartita, eventi: Evento[] }  — stato è un NUOVO oggetto, versione+1
}
```

Garanzie:

* `stato` in ingresso non viene mai mutato (clone profondo con
  `structuredClone`).
* In caso di errore non viene emesso alcun evento e lo stato non cambia.
* Ogni evento ritornato è anche appeso a `stato.log`.
* Le conseguenze automatiche (affitto, carta, prigione, passaggio di turno dopo
  prigione, saldo automatico del debito, fine partita) sono applicate nella
  stessa chiamata e producono eventi propri.
* `azione.tipo` deve essere uno dei valori di `motore.AZIONI` (sotto), altrimenti
  errore `AZIONE_NON_VALIDA`. Parametri in eccesso sono ignorati; parametri
  mancanti o del tipo sbagliato danno `PARAMETRI_NON_VALIDI`.

### 2.4 Elenco completo delle azioni

Legenda "chi": **T** = solo giocatore di turno · **D** = solo debitore ·
**P** = ogni partecipante all'asta · **X** = ogni giocatore non fallito.
"Gestione" = `costruisci`, `vendiCasa`, `ipoteca`, `disipoteca`,
`proponiScambio`; sono ammesse al giocatore di turno nelle fasi
`daLanciare`, `mossa`, `daDecidereAcquisto`, con le eccezioni indicate.

| `tipo` | Parametri | Chi | Fasi | Effetto | Errori tipici |
|---|---|---|---|---|---|
| `lanciaDadi` | — | T | `daLanciare` | Tira due dadi (`contesto.random`). Se libero: avanza, +200 se passa dal Via, risolve la casella (§8). Se in prigione: col doppio esce e avanza (senza secondo lancio); altrimenti `turniInPrigione+1`; al terzo fallimento paga 50 (o `debito`) e avanza. Doppio → `daLanciare` di nuovo; terzo doppio → prigione, fase `mossa`. | `FASE_ERRATA`, `NON_IL_TUO_TURNO` |
| `compra` | — | T | `daDecidereAcquisto` | Paga il prezzo di listino, diventa proprietario. Fase → `mossa` (o `daLanciare` se il lancio era doppio). | `FONDI_INSUFFICIENTI` |
| `rifiutaAcquisto` | — | T | `daDecidereAcquisto` | Avvia l'asta (`asta` valorizzata, fase `asta`). Se è l'unico giocatore non fallito la casella resta alla banca. | |
| `offertaAsta` | `importo` intero | P | `asta` | Offerta `>= offertaMassima + incrementoMinimo` e `<= denaro`. | `OFFERTA_BASSA`, `FONDI_INSUFFICIENTI`, `GIA_PASSATO` |
| `passaAsta` | — | P | `asta` | Esce dall'asta. Il miglior offerente non può passare. Chiude l'asta quando resta uno solo. | `MIGLIOR_OFFERENTE`, `GIA_PASSATO` |
| `costruisci` | `casella` | T | gestione | Costruisce una casa (o l'albergo se a 4 case) su `casella`. Richiede gruppo completo, nessuna ipoteca nel gruppo, costruzione uniforme (differenza max 1 nel gruppo), scorte in banca, denaro. Con `stato.regole.costruzione === 'sosta'` serve anche che la pedina si sia fermata in questo turno su una casella del gruppo: il gruppo è in `turno.soste`, oppure la pedina è sul gruppo e la fase è diversa da `daLanciare` (o `doppiConsecutivi > 0`). | `GRUPPO_INCOMPLETO`, `NON_SULLA_CASELLA`, `COSTRUZIONE_NON_UNIFORME`, `CASE_ESAURITE`, `ALBERGHI_ESAURITI`, `IPOTECATA`, `FONDI_INSUFFICIENTI`, `NON_EDIFICABILE` |
| `vendiCasa` | `casella` | T, D, P | gestione + `debito` + `asta` | Vende una casa alla banca a **metà** del `costoCasa`, rispettando l'uniformità. Un albergo torna a 4 case se la banca ne ha 4; altrimenti viene venduto **per intero** (`caseCostruite` → 0, ricavo `5 × costoCasa / 2`, nessuna casa restituita). | `NESSUNA_COSTRUZIONE`, `COSTRUZIONE_NON_UNIFORME` |
| `ipoteca` | `casella` | T, D, P | gestione + `debito` + `asta` | Incassa `CASELLE[i].ipoteca`; richiede `caseCostruite === 0` su **tutto il gruppo**. | `HA_COSTRUZIONI`, `GIA_IPOTECATA` |
| `disipoteca` | `casella` | T | gestione | Paga `ipoteca + ceil(10%)`, toglie l'ipoteca. | `NON_IPOTECATA`, `FONDI_INSUFFICIENTI` |
| `proponiScambio` | `aId`, `offre: {denaro, proprieta[], cartePrigione}`, `chiede: {…}` | X | tutte tranne `lobby`, `asta`, `finePartita` | Crea `stato.scambio`. Campi mancanti valgono 0 / `[]`. Il proponente deve possedere ciò che offre; il destinatario ciò che gli viene chiesto. | `SCAMBIO_IN_CORSO`, `PROPRIETA_NON_TUA`, `HA_COSTRUZIONI`, `SCAMBIO_VUOTO`, `GIOCATORE_NON_VALIDO` |
| `accettaScambio` | `scambioId` | destinatario | come sopra | Verifica di nuovo denaro e possessi, trasferisce tutto, applica l'interesse del 10% sulle ipotecate ricevute (se non pagabile → `debito` con `motivo: 'interesseScambio'`). `scambio` → `null`. | `SCAMBIO_NON_TROVATO`, `NON_DESTINATARIO`, `FONDI_INSUFFICIENTI` |
| `rifiutaScambio` | `scambioId` | destinatario **o** proponente (ritiro) | come sopra | `scambio` → `null`. | `SCAMBIO_NON_TROVATO`, `NON_COINVOLTO` |
| `pagaCauzione` | — | T | `daLanciare` (in prigione) | Paga 50, esce; resta in `daLanciare` per lanciare normalmente. | `NON_IN_PRIGIONE`, `FONDI_INSUFFICIENTI` |
| `usaCartaPrigione` | — | T | `daLanciare` (in prigione) | `cartePrigione-1`, la carta torna in coda al suo mazzo, esce; resta in `daLanciare`. | `NON_IN_PRIGIONE`, `NESSUNA_CARTA_PRIGIONE` |
| `finisciTurno` | — | T | `mossa` | Passa al prossimo giocatore non fallito, `turno.numero+1`, `doppiConsecutivi: 0`, fase `daLanciare`. Uno `scambio` pendente non blocca il cambio di turno (resta pendente). | `FASE_ERRATA` |
| `dichiaraBancarotta` | — | D | `debito` | Vede `server/gioco/bancarotta.js`: case vendute alla banca a metà prezzo, denaro e proprietà al creditore (o alla banca, che le libera dall'ipoteca e le rimette in vendita), carte prigione al creditore. `fallito: true`. Se resta un solo giocatore → `finePartita`. Se il fallito era di turno → passa il turno. | `FASE_ERRATA`, `NON_DEBITORE` |
| `abbandona` | — | X | tutte tranne `lobby`, `finePartita` | Uscita volontaria (e bancarotta d'ufficio di un debitore assente, §3.4). Stessa liquidazione di `dichiaraBancarotta`: verso il creditore se chi abbandona ha il debito aperto, altrimenti verso la banca (proprietà all'asta). Se partecipa a un'asta ne esce; se era il miglior offerente l'offerta viene azzerata. Evento `abbandono` seguito da `bancarotta`. | `GIOCATORE_FALLITO`, `FASE_ERRATA` |

Esempi di oggetto `azione`:

```json
{ "tipo": "lanciaDadi" }
{ "tipo": "offertaAsta", "importo": 150 }
{ "tipo": "costruisci", "casella": 1 }
{ "tipo": "proponiScambio", "aId": "b3m8w1zt",
  "offre":  { "denaro": 100, "proprieta": [1, 3], "cartePrigione": 0 },
  "chiede": { "denaro": 0, "proprieta": [6], "cartePrigione": 0 } }
{ "tipo": "accettaScambio", "scambioId": "s3" }
```

**Stato di avanzamento.** Tutte le 17 azioni (le 16 originali più
`abbandona`, aggiunta in fase di integrazione) sono implementate;
`NON_IMPLEMENTATO` non viene più restituito. Precisazioni:

* L'ordine dei controlli è: tipo → giocatore esistente → non fallito → fase
  `lobby`/`finePartita` → permesso (turno, fase, ruolo) → parametri → regola.
  Quindi `pagaCauzione` fuori di prigione dà `NON_IN_PRIGIONE`, un'azione di
  turno fatta da altri dà `NON_IL_TUO_TURNO`. I messaggi sono specifici
  (es. "Vicolo Corto costa 60 €, ma hai solo 40 €").
* `vendiCasa`/`ipoteca` da chi non è il debitore in fase `debito` →
  `NON_DEBITORE`; da chi non partecipa all'asta → `GIOCATORE_NON_VALIDO`.
* `rifiutaScambio` (rifiuto o ritiro) è ammesso anche durante un'asta.
* Negli scambi non si può cedere una casella se nel **suo gruppo** ci sono
  costruzioni (`HA_COSTRUZIONI`); carte prigione oltre quelle possedute →
  `NESSUNA_CARTA_PRIGIONE`; denaro oltre quello posseduto →
  `FONDI_INSUFFICIENTI`. I possessi si riverificano all'accettazione.
* Asta: l'offerta deve **superare** quella corrente, quindi i pareggi sono
  impossibili (vale l'offerta arrivata prima). Il miglior offerente può
  rilanciare su sé stesso. I giocatori disconnessi all'avvio dell'asta
  partono già in `passati`.

### 2.5 Altri export di `motore.js`

| Export | Descrizione |
|---|---|
| `AZIONI` | array frozen dei 17 `tipo` ammessi (nell'ordine della tabella §2.4) |
| `FASI` | array frozen delle 7 fasi |
| `azioniDisponibili(stato, giocatoreId) → string[]` | i `tipo` che `giocatoreId` può eseguire adesso (per abilitare i pulsanti del client). Non valuta i parametri. |
| `statoPubblico(stato) → StatoPartita` | copia senza `mazzi`, con `azioni` per giocatore (quella che va ai client) |
| `prossimoGiocatore(stato) → giocatoreId` | prossimo non fallito **e connesso** dopo il giocatore di turno (se nessun altro è connesso: il prossimo non fallito) |
| `gestisciDisconnessione(stato, giocatoreId, {random, ora}) → { stato, eventi }` | chiamata da `stanze.js` quando un disconnesso blocca la partita, dopo la tolleranza di §3.4: annulla il suo scambio pendente, lo fa passare all'asta (se non è il miglior offerente), se è di turno in `daDecidereAcquisto` apre l'asta, in `daLanciare`/`mossa` passa il turno. Un debito resta in attesa. Se non c'è nulla da fare ritorna lo stesso `stato` ed `eventi: []` (versione invariata). |
| `gestisciInattivita(stato, giocatoreId, {random, ora}) → { stato, eventi }` | come `gestisciDisconnessione`, per un giocatore collegato che non agisce in tempo (§3.4): **non** annulla gli scambi pendenti; in `daDecidereAcquisto` e `daLanciare`/`mossa` emette `turnoSaltato` con `motivo: 'inattivo'`. |
| `chiDeveAgire(stato) → string[]` | chi tiene ferma la partita adesso: il debitore, i partecipanti all'asta che non hanno passato (escluso il miglior offerente) o il giocatore di turno. |
| `calcolaAffitto(stato, casella, opz?) → { importo, moltiplicatore? }` | affitto corrente di una casella posseduta (società: usa `stato.dadi`) |
| `patrimonioLiquidabile(stato, giocatoreId)` | come in `bancarotta.js` |

Moduli interni aggiunti in `server/gioco/`: `nucleo.js` (pagamenti, debiti,
aste, turno: primitive mutanti usate su copie), `errori.js` (codici e
messaggi del motore, così il motore non dipende da `protocollo.js`). Test:
`tests/motore-regole.test.js`, eseguito da `npm test` insieme agli altri test di `tests/`.

### 2.6 `server/gioco/scambi.js`

Usato dal motore; esportato per i test.

| Funzione | Ritorna |
|---|---|
| `validaProposta(stato, daId, proposta) → { ok: true, scambio } \| { errore }` | normalizza `offre`/`chiede` e verifica possessi |
| `applicaScambio(stato, scambio, ora) → { stato, eventi }` | trasferisce denaro, proprietà, carte; gestisce l'interesse del 10% |

### 2.7 `server/gioco/bancarotta.js`

| Funzione | Ritorna |
|---|---|
| `liquida(stato, giocatoreId, creditoreId \| null, ora) → { stato, eventi }` | vende costruzioni, trasferisce beni, marca `fallito`, verifica fine partita |
| `patrimonioLiquidabile(stato, giocatoreId) → intero` | denaro + metà costruzioni + ipoteche ottenibili: usato per decidere se un debito è saldabile senza bancarotta |

---

## 3. Protocollo WebSocket e rotte HTTP

### 3.1 Trasporto

* Endpoint WebSocket: `ws://host:porta/ws` (`wss://` dietro HTTPS). Il client
  lo ricava da `location`: `(location.protocol === 'https:' ? 'wss' : 'ws') +
  '://' + location.host + '/ws'`.
* Ogni frame è **testo JSON** con un oggetto che ha sempre il campo `tipo`
  (stringa). Frame non JSON o senza `tipo` → `errore MESSAGGIO_NON_VALIDO`.
* Dimensione massima di un messaggio: 16 KiB (`LIMITI.MESSAGGIO_MAX_BYTE`);
  oltre, il server risponde `errore MESSAGGIO_NON_VALIDO`. Un frame oltre
  64 KiB (`LIMITI.FRAME_MAX_BYTE`) viene rifiutato dalla libreria, che chiude
  la connessione con codice 1009. Il server chiude la connessione (1008) dopo
  3 messaggi non validi consecutivi o dopo un flusso eccessivo di messaggi
  (più di 30 al secondo vengono scartati con `TROPPI_MESSAGGI`).
* All'handshake il server verifica l'intestazione `Origin` (§3.5).
* Il client può includere un campo opzionale `rif` (stringa, max 32) in
  qualunque messaggio: il server lo riporta uguale nell'eventuale `errore`.
* Il server invia nell'ordine: prima gli `evento` (uno per evento), poi lo
  `stato` che li riassume. Entrambi portano `versione`.

### 3.2 Messaggi client → server

| `tipo` | Campi | Risposta | Note |
|---|---|---|---|
| `creaStanza` | — | `stanzaCreata` al mittente | Non entra nella stanza: va seguito da `entraStanza`. `TROPPE_STANZE` oltre 5 stanze create dalla stessa connessione, 10 aperte dallo stesso indirizzo IP, o 200 aperte sul server tutte con giocatori dentro (se ce n'è una senza giocatori, la più vecchia viene chiusa per fare posto). |
| `entraStanza` | `codice`, `nome`, `colore?` | `entrato` al mittente, poi `evento giocatoreEntrato` + `stato` a tutti | Solo in fase `lobby`, max 6 giocatori. |
| `avviaPartita` | `regole?` | `evento partitaIniziata` + `stato` a tutti | Solo `hostId`, almeno 2 giocatori connessi. `regole.costruzione` è `'libera'` (predefinita) o `'sosta'`: finisce in `stato.regole`. |
| `azione` | `azione: { tipo, … }` (§2.4) | a tutti `evento`* + `stato`; al mittente `errore` se rifiutata | Il server ricava `giocatoreId` dal socket, mai dal messaggio. |
| `riconnetti` | `codice`, `token` | `entrato` + `stato` (con il log **completo**) al mittente; poi `evento connessione` + `stato` a tutti | Riassocia il socket al giocatore. Funziona anche in lobby. L'eventuale socket precedente dello stesso giocatore viene chiuso con codice `4001`. |
| `esciStanza` | — | `evento giocatoreUscito` + `stato` a tutti | Solo in `lobby`. In partita si esce con l'azione `abbandona` (§2.4); la semplice disconnessione lascia il giocatore in partita (`connesso: false`). |
| `ping` | — | `pong` | opzionale, keep-alive dal browser ogni 25 s |

Esempi:

```json
{ "tipo": "creaStanza" }
{ "tipo": "entraStanza", "codice": "K7PQ2M", "nome": "Anna", "colore": "#d62828" }
{ "tipo": "avviaPartita" }
{ "tipo": "azione", "rif": "a1", "azione": { "tipo": "lanciaDadi" } }
{ "tipo": "azione", "azione": { "tipo": "costruisci", "casella": 1 } }
{ "tipo": "riconnetti", "codice": "K7PQ2M", "token": "3f1a9c0e7b2d4f6a8c1e3b5d7f9a0c2e" }
```

### 3.3 Messaggi server → client

| `tipo` | Campi | Destinatari |
|---|---|---|
| `stanzaCreata` | `codice`, `link` | mittente di `creaStanza` |
| `entrato` | `giocatoreId`, `token`, `codice`, `link`, `hostId` | mittente di `entraStanza`/`riconnetti` |
| `stato` | `stato: StatoPartita` (senza `mazzi`), `versione` | tutti i giocatori della stanza |
| `evento` | `evento: Evento` (§6), `versione` | tutti i giocatori della stanza |
| `errore` | `codice` (§7), `messaggio`, `rif?`, `dettagli?` | solo il mittente |
| `pong` | — | mittente di `ping` |

Esempi:

```json
{ "tipo": "stanzaCreata", "codice": "K7PQ2M", "link": "http://localhost:3000/?stanza=K7PQ2M" }

{ "tipo": "entrato", "giocatoreId": "a7k2x9pq",
  "token": "3f1a9c0e7b2d4f6a8c1e3b5d7f9a0c2e",
  "codice": "K7PQ2M", "link": "http://localhost:3000/?stanza=K7PQ2M", "hostId": "a7k2x9pq" }

{ "tipo": "evento", "versione": 43,
  "evento": { "t": 1763204099000, "tipo": "dadi", "giocatoreId": "a7k2x9pq",
              "testo": "Anna lancia 5 e 6", "dati": { "dadi": [5, 6], "doppio": false } } }

{ "tipo": "stato", "versione": 43, "stato": { "versione": 43, "codice": "K7PQ2M", "…": "…" } }

{ "tipo": "errore", "codice": "NON_IL_TUO_TURNO", "messaggio": "Non è il tuo turno", "rif": "a1" }
```

### 3.4 Ciclo di vita della connessione

1. Il client apre `/ws`. Se in `sessionStorage` c'è una sessione
   (`{codice, giocatoreId, token}`) invia subito `riconnetti`; altrimenti
   mostra la lobby (con il codice precompilato se l'URL ha `?stanza=`).
   La sessione sta **solo** in `sessionStorage`: sopravvive al refresh ma non
   è condivisa fra schede, quindi ogni scheda è un giocatore distinto. Una
   copia dell'ultima sessione sta in `localStorage` (chiave
   `monopoly.ripresa`) ma non viene mai usata in automatico: se la scheda è
   stata chiusa, riaprendo il link compare il pulsante «Riprendi la partita»,
   che invia `riconnetti` solo su richiesta dell'utente.
2. Alla chiusura del socket il server marca il giocatore `connesso: false` e
   manda `evento connessione` + `stato` agli altri. In **lobby** il giocatore
   viene rimosso dopo 60 s senza riconnessione (timer per giocatore). In
   **partita** resta e può rientrare col token; se però tiene ferma la
   partita (`stanze.TEMPI`):
   * dopo **45 s** (`TOLLERANZA_DISCONNESSIONE_MS`) il server chiama
     `motore.gestisciDisconnessione`: il suo turno passa, all'asta passa, il
     suo scambio pendente è annullato;
   * se è il **debitore** in fase `debito`, dopo **3 minuti**
     (`BANCAROTTA_DISCONNESSO_MS`) il server esegue per lui `abbandona`
     (bancarotta d'ufficio).

   I timer partono quando il giocatore diventa "bloccante" (anche dopo la
   disconnessione: `stanze.sorvegliaDisconnessi` è richiamata a ogni cambio di
   stato), si annullano alla riconnessione e non scattano se nessun giocatore
   in gara è collegato (la partita aspetta).

   **Inattività dei collegati.** C'è anche un timer per stanza
   (`stanze.programmaInattivita`) per chi è collegato ma non agisce
   (`motore.chiDeveAgire`): 3 minuti per il turno
   (`INATTIVITA_TURNO_MS`), 60 s in asta (`INATTIVITA_ASTA_MS`), 5 minuti per
   un debito (`INATTIVITA_DEBITO_MS`). 30 s prima arriva a tutti un `evento`
   `avvisoInattivita` (`dati: { giocatori, secondi, debito }`, non entra nel
   log). Allo scadere: debito → `abbandona` per il debitore; altrimenti
   `motore.gestisciInattivita` per ognuno. Il timer riparte solo quando la
   partita va avanti (`stanza.progresso`), non a connessioni e riconnessioni;
   si ferma se nessuno in gara è collegato o dopo due giri interi di turni
   saltati senza azioni (`stanza.saltiInattivita`).
3. Una stanza viene eliminata quando nessuno ci è mai entrato da 2 minuti, è
   vuota da 10 minuti o inattiva da 2 ore,
   o quando la partita è in `finePartita` da 30 minuti. Ai socket ancora
   collegati arriva `errore STANZA_INESISTENTE` (senza `rif`) e poi la
   chiusura con codice `4002`; il client torna alla schermata iniziale.
4. Un socket appartiene al massimo a una stanza. `creaStanza`/`entraStanza` da
   un socket già in stanza → `errore GIA_IN_STANZA`.
5. Codici di chiusura WebSocket dedicati (`protocollo.CHIUSURE`):

   | Codice | Significato | Comportamento del client |
   |---|---|---|
   | `4001` `SOSTITUITO` | lo stesso giocatore (stesso token) si è collegato da un altro socket | **non** si riconnette da solo; mostra «Usa questa scheda» che richiama `conn.riprovaOra()` e reinvia `riconnetti` |
   | `4002` `STANZA_CHIUSA` | la stanza è stata eliminata | dimentica la sessione, torna al form, riapre una connessione pulita |
   | `1008`, `1009` | troppi messaggi non validi / frame troppo grande | non si riconnette da solo; pulsante «Riconnetti» |
   | `4000` | usato **dal client** per chiudere il proprio socket quando il browser va offline | riconnessione automatica normale |

### 3.5 Rotte HTTP (`server/index.js`)

| Metodo e percorso | Risposta |
|---|---|
| `GET /` | `client/index.html` |
| `GET /<file>` | file statico sotto `client/` (MIME per `.html .css .js .mjs .json .svg .png .jpg .webp .woff2 .ico`); percorsi con `..` → 403; non trovato → 404. Cache: `no-cache` in sviluppo. |
| `GET /dati/tabellone.js` | ES module **generato** dal CommonJS `server/gioco/tabellone.js`: una riga `export const NOME = <JSON>;` per ogni export JSON-serializzabile (funzioni escluse). Il client fa `import { CASELLE, GRUPPI } from '/dati/tabellone.js'`. |
| `GET /dati/carte.js` | idem per `server/gioco/carte.js`: `import { PROBABILITA, IMPREVISTI } from '/dati/carte.js'`. |
| `GET /salute` | `{ "ok": true, "stanze": 3, "versione": "0.1.0", "websocket": true }` |
| `GET /ws` con Upgrade | WebSocket. L'handshake è accettato solo se manca `Origin` (client non browser) o se il suo host coincide con `Host`, `PUBLIC_URL` o, dietro un proxy fidato (`PROXY_FIDATO=1`, oppure su Render), `X-Forwarded-Host` (`index.origineAmmessa`). Oltre 20 connessioni contemporanee dallo stesso indirizzo (`index.ipDi`: `X-Forwarded-For` dietro un proxy fidato, altrimenti l'indirizzo del socket) l'handshake è rifiutato con 429; un'origine non ammessa con 403; `ORIGINE_LIBERA=1` disattiva il controllo. |

Ogni risposta HTTP porta `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: same-origin` e una
`Content-Security-Policy` che ammette solo risorse della stessa origine
(`script-src 'self'`; `style-src 'self' 'unsafe-inline'` per gli attributi
`style` impostati dal client; `img-src 'self' data:`; `connect-src 'self' ws:
wss:`; `frame-ancestors 'none'`). Il client quindi **non può** usare script
inline né risorse esterne.

### 3.6 `server/stanze.js`

Registro in memoria delle stanze (nessuna persistenza in fase 1).

```js
const stanze = require('./stanze');
stanze.crea({ ora }) → Stanza                              // genera codice unico
stanze.trova(codice) → Stanza | undefined                  // codice normalizzato
stanze.entra(stanza, { nome, colore, socket, ora }) → { giocatore, token } | { errore }
stanze.riconnetti(codice, token, socket) → { stanza, giocatore } | { errore }
stanze.esci(stanza, giocatoreId) → void                    // solo in lobby
stanze.disconnetti(stanza, giocatoreId, { ora, random }) → { eventi }   // connesso=false + timer di §3.4
stanze.avvia(stanza, giocatoreId, { random, ora }) → { eventi } | { errore }
stanze.applica(stanza, giocatoreId, azione, { random, ora }) → { eventi } | { errore }
stanze.statoPerClient(stanza, { completo? }) → StatoPartita   // senza mazzi; log breve salvo completo: true
stanze.broadcast(stanza, messaggio) → void                 // a tutti i socket connessi
stanze.diffondiAggiornamento(stanza, eventi) → void        // prima gli `evento`, poi lo `stato` (log breve)
stanze.sorvegliaDisconnessi(stanza, { ora, random }) → void   // programma i timer dei disconnessi bloccanti
stanze.sbloccaDisconnesso(stanza, giocatoreId, { ora, random }) → void     // ciò che fa il timer dei 45 s
stanze.bancarottaDisconnesso(stanza, giocatoreId, { ora, random }) → void  // ciò che fa il timer dei 3 minuti
stanze.programmaInattivita(stanza, { ora, random }) → void   // timer d'inattività dei collegati (§3.4)
stanze.preavvisaInattivita(stanza, chiave, { ora }) → void   // evento avvisoInattivita, 30 s prima
stanze.scadutaInattivita(stanza, chiave, { ora, random }) → void   // ciò che fa il timer allo scadere
stanze.aperteDa(ip) → numero stanze aperte create da quell'indirizzo
stanze.liberaPosto() → boolean                             // chiude la stanza senza giocatori più vecchia
stanze.esporta() → object[]  /  stanze.importa(elenco, { ora }) → numero   // salvataggio su file (server/salvataggio.js)
stanze.pulisci({ ora }) → numero stanze rimosse            // chiamata da un timer in index.js
stanze.rimuovi(codice) → boolean                           // chiude la stanza (errore + chiusura 4002)
stanze.azzera() → void                                     // svuota il registro e annulla i timer (test)
stanze.generaCodice(random) → 'K7PQ2M'
stanze.tutte() → Stanza[]
stanze.TEMPI                                               // durate di §3.4 in millisecondi
```

`Stanza = { codice, hostId, creataIl, aggiornataIl, stato: StatoPartita,
giocatori: Map<giocatoreId, { id, nome, colore, token, connesso, socket }>,
timer: Map<'giocatoreId|nome', Timeout> }`.
I `token` e i `socket` **non** finiscono mai nello stato. I nomi sono unici
nella stanza ignorando maiuscole e segni diacritici (`protocollo.chiaveNome`).

### 3.7 `server/protocollo.js`

```js
const P = require('./protocollo');
P.MESSAGGI_CLIENT      // ['creaStanza','entraStanza','avviaPartita','azione','riconnetti','esciStanza','ping']
P.MESSAGGI_SERVER      // ['stanzaCreata','entrato','stato','evento','errore','pong']
P.ERRORI               // { NON_IL_TUO_TURNO: 'Non è il tuo turno', ... } (§7)
P.COLORI_GIOCATORE     // palette §0.5
P.LIMITI               // { MAX_GIOCATORI: 6, MIN_GIOCATORI: 2, NOME_MAX: 16, MESSAGGIO_MAX_BYTE: 16384, FRAME_MAX_BYTE: 65536,
                       //   LOG_MAX: 200, LOG_BREVE: 30, MAX_STANZE: 200, MAX_STANZE_PER_SOCKET: 5, MAX_STANZE_PER_IP: 10, MAX_CONNESSIONI_PER_IP: 20, MESSAGGI_AL_SECONDO_MAX: 30, … }
P.CHIUSURE             // { SOSTITUITO: 4001, STANZA_CHIUSA: 4002 } (§3.4)
P.chiaveNome(str) → 'anna'   // chiave di confronto dei nomi: minuscolo, senza diacritici
P.REGEX_CODICE         // /^[A-Z0-9]{6}$/
P.REGEX_COLORE         // /^#[0-9a-f]{6}$/
P.analizza(testo) → { ok: true, messaggio } | { ok: false, errore }   // JSON.parse + validazione shape per tipo
P.errore(codice, extra?) → { tipo: 'errore', codice, messaggio, ...extra }
P.normalizzaCodice(str) → 'K7PQ2M' | null
P.normalizzaNome(str) → 'Anna' | null   // NFC, senza caratteri invisibili (Cc, Cf, Co, Cn), spazi compressi
P.normalizzaColore(str) → '#d62828' | null
```

---

## 4. Moduli del client (`client/`, di claude-2)

Tutti ES module. Nessun framework. Ogni funzione `render` è **idempotente**:
può essere richiamata a ogni nuovo stato e aggiorna il DOM esistente senza
perdere focus o selezione quando possibile.

### 4.1 `index.html` — contenitori

```html
<body>
  <main id="app">
    <section id="lobby"     aria-labelledby="lobby-titolo"></section>
    <section id="tabellone" aria-label="Tabellone" hidden></section>
    <aside   id="pannelli"  aria-label="Giocatori e azioni" hidden></aside>
  </main>
  <div id="dialoghi"></div>                       <!-- contiene <dialog> nativi -->
  <div id="toast" role="status" aria-live="polite" aria-atomic="false"></div>
  <script type="module" src="/js/app.js"></script>
</body>
```

| Id | Contenuto | Visibile quando |
|---|---|---|
| `#lobby` | form crea/entra, elenco giocatori, scelta colore, pulsante avvia (host), copia link | nessuna stanza oppure `fase === 'lobby'` |
| `#tabellone` | le 40 caselle, pedine, segnaposti proprietà, case/alberghi, dadi | `fase !== 'lobby'` |
| `#pannelli` | giocatori (denaro, posizione, stato), le mie proprietà, pulsanti azione, cronaca eventi | `fase !== 'lobby'` |
| `#dialoghi` | finestre modali (`<dialog>`) aperte da `dialoghi.apri` | a richiesta |
| `#toast` | notifiche brevi non modali | a richiesta |

Gli asset usano percorsi **assoluti** (`/js/app.js`, `/css/base.css`) perché
l'URL può contenere `?stanza=…`.

### 4.2 `app.js` — `creaStore(iniziale?, gestori?)`

Lo store vive in `app.js` (esportato per i test e per gli altri moduli).
`gestori` collega lo store a rete e interfaccia (`invia`, `protocollo`,
`apriDialogo`, `chiudiDialogo`, `toast`, `altro`): sono iniettati, così lo
store resta utilizzabile da solo.

```js
import { creaStore } from '/js/app.js';
const store = creaStore();
store.getState()                      // → StatoClient
store.setState(parziale)              // merge superficiale + notifica
store.subscribe(fn) → annulla         // fn(stato, precedente) a ogni cambio
store.dispatch(azione)                // vedi sotto
```

`StatoClient`:

```json
{
  "connessione": "disconnesso | connessione | connesso | riconnessione",
  "io": { "giocatoreId": "a7k2x9pq", "token": "…", "codice": "K7PQ2M" },
  "partita": null,
  "eventi": [],
  "errore": null,
  "selezione": null,
  "dialogo": null,
  "lobby": { "codiceUrl": "K7PQ2M", "inAttesa": false, "ripresa": false, "link": "http://…/?stanza=K7PQ2M" },
  "preferenze": { "nome": "Anna", "colore": null }
}
```

* `io` è `null` finché non si riceve `entrato`; viene salvato **solo** in
  `sessionStorage` con chiave `monopoly.sessione` per la riconnessione dopo
  un refresh. La copia in `localStorage` (`monopoly.ripresa`) serve solo alla
  ripresa esplicita di §3.4: due schede non devono condividere la sessione.
* `partita` è l'ultimo `StatoPartita` ricevuto (o `null`), con il `log`
  ricucito a quello già noto (§1.10).
* `lobby` serve a `lobby.js`: codice letto da `?stanza=`, richiesta in corso,
  ripresa della sessione in corso, link ricevuto dal server.
* `preferenze` (nome e colore dell'ultima volta) sta in `localStorage` con
  chiave `monopoly.preferenze`. `colore: null` = nessuna scelta: il server
  assegna un colore libero.
* `eventi` sono gli ultimi 100 `Evento` ricevuti (per toast e cronaca).
* `selezione` è l'indice della casella evidenziata nel tabellone o `null`.

`dispatch(azione)` smista per `azione.tipo`:

| `azione.tipo` | Comportamento |
|---|---|
| uno dei 17 tipi di §2.4 | invia `{ tipo: 'azione', azione, rif }` al server. **Mai in coda**: se si è offline l'azione non parte e compare un avviso. |
| `creaStanza` `{ nome, colore }` | invia `creaStanza` e, ricevuto `stanzaCreata`, `entraStanza` con nome e colore |
| `entraStanza` `{ codice, nome, colore }` | invia `entraStanza` (senza `colore` se `null`); su `COLORE_OCCUPATO` riprova una volta senza colore |
| `avviaPartita`, `riconnetti`, `esciStanza` | invia il messaggio di protocollo corrispondente |
| `ui:seleziona` `{ indice }` | `selezione = indice` |
| `ui:apriDialogo` `{ dialogo, dati }` | `dialoghi.apri(dialogo, dati, dispatch)` |
| `ui:chiudiDialogo` | chiude il dialogo corrente |
| `ui:toast` `{ testo, livello }` | mostra un toast |
| `ui:errore` `{ errore }` / `ui:pulisciErrore` | imposta o azzera `errore` (validazione del form d'ingresso) |
| `ui:abbandonaSessione`, `ui:nuovaPartita` | dimentica la sessione e torna alla schermata iniziale |

Il `dispatch` passato ai moduli di rendering è sempre `store.dispatch`.

### 4.3 `rete.js` — `connetti(url, callbacks)`

```js
import * as rete from '/js/rete.js';
const conn = rete.connetti(url, {
  onApertura()            {},   // socket aperto (anche dopo una riconnessione)
  onMessaggio(msg)        {},   // oggetto già JSON.parse-ato (§3.3)
  onChiusura(evento)      {},   // CloseEvent
  onErrore(err)           {},
  onRiconnessione(n, ms)  {},   // tentativo n, prossimo tra ms
});
conn.invia(messaggio, { accoda? })  // JSON.stringify + send → true se inviato; se chiuso accoda (max 20, scadenza 2 min)
                                    // e invia alla riapertura, salvo accoda: false
conn.chiudi()              // chiusura volontaria, niente riconnessione
conn.stato()               // 'connessione' | 'connesso' | 'riconnessione' | 'chiuso'
conn.riprovaOra()          // riapre subito, anche dopo una chiusura definitiva
conn.inCoda()              // messaggi in attesa
```

Altri callback: `onStato(stato, { tentativo, prossimoTra, coda })`. Esporta
anche `CHIUSURE` (`{ SOSTITUITO: 4001, STANZA_CHIUSA: 4002 }`) e
`aggiornaIndicatore(elemento, stato, dettagli)`.

Riconnessione automatica con backoff esponenziale 1 s → 30 s (×2, con jitter
±20%), **tranne** dopo le chiusure definitive di §3.4 (1008, 1009, 4001,
4002): lì si riparte solo con `riprovaOra()`. Dopo la riapertura, `app.js`
reinvia `riconnetti` con il token salvato.
`rete.urlPredefinito()` ritorna l'URL del §3.1 a partire da `location`.

### 4.4 `tabellone.js` — `render(radice, stato, opzioni)` e `aggiorna(stato)`

```js
import * as tabellone from '/js/tabellone.js';
tabellone.render(document.getElementById('tabellone'), stato, {
  caselle: CASELLE,        // da /dati/tabellone.js
  gruppi: GRUPPI,
  mioId: 'a7k2x9pq',       // per evidenziare la mia pedina
  animazioni: true,        // false con prefers-reduced-motion
});
tabellone.aggiorna(stato); // aggiornamento incrementale: pedine, proprietari, case, ipoteche, dadi, turno
```

* `render` costruisce il DOM una sola volta (40 caselle in griglia 11×11,
  area centrale con dadi e mazzi). Chiamarlo di nuovo ricostruisce tutto.
* `aggiorna` muove le pedine da `posizione` precedente a quella nuova
  (percorrendo le caselle intermedie se `animazioni`), aggiorna il bordo colore
  del proprietario, il numero di case/albergo, la fascia "ipotecata" e la
  pedina evidenziata del giocatore di turno.
* Ogni casella è un `<button class="casella" data-indice="N">` con
  `aria-label` = nome + proprietario + affitto corrente, navigabile con
  Tab/freccette.
* **Evento DOM personalizzato** `casella-selezionata`: emesso sulla `radice`
  (con `bubbles: true`) al click/Enter/Space su una casella.

```js
radice.addEventListener('casella-selezionata', (e) => {
  e.detail.indice;   // numero 0–39
  e.detail.casella;  // l'oggetto CASELLE[indice] (comodità)
});
```

### 4.5 `pannelli.js` — `render(radice, stato, dispatch)`

Disegna in `#pannelli`: elenco giocatori (colore, nome, denaro, posizione,
prigione, connesso, fallito, evidenza del turno), le proprietà di ciascun
giocatore raggruppate per colore, i pulsanti azione **abilitati solo se
ammessi** (riproducendo lato client la tabella §2.4; il server resta
l'autorità), i dadi dell'ultimo lancio, la cronaca (`stato.log`) con
`aria-live="polite"`. I pulsanti chiamano `dispatch({ tipo: 'lanciaDadi' })`
ecc. Per le azioni con parametri aprono un dialogo (`ui:apriDialogo`).

### 4.6 `dialoghi.js` — `apri(tipo, dati, dispatch)`

```js
import * as dialoghi from '/js/dialoghi.js';
const d = dialoghi.apri('acquisto', {}, dispatch);
d.chiudi();
dialoghi.chiudiTutti();
dialoghi.toast('Anna compra Via Accademia', { livello: 'info', durata: 4000 });  // livello: info | successo | avviso | errore
```

I dialoghi leggono lo stato di gioco dall'ultimo `StatoClient` passato a
`dialoghi.aggiorna(statoClient, dispatch)` (lo fa `pannelli.render` a ogni
cambio): `dati` contiene quindi solo ciò che lo stato non dice. I dialoghi
"vivi" si ridisegnano a ogni nuovo stato e si chiudono da soli quando non
hanno più senso (asta finita, debito saldato, scambio risolto).

| `tipo` | `dati` | Azioni emesse |
|---|---|---|
| `acquisto` | `{}` | `compra` / `rifiutaAcquisto` |
| `asta` | `{}` | `offertaAsta {importo}` / `passaAsta` |
| `scambio` | `{}` (mostra la proposta pendente) oppure `{ nuovo: true, aId? }` (nuova proposta) | `proponiScambio` / `accettaScambio` / `rifiutaScambio` |
| `gestione` | `{ modalita: 'costruisci' \| 'vendi' \| 'ipoteca' \| 'disipoteca' }` | `costruisci` / `vendiCasa` / `ipoteca` / `disipoteca` |
| `costruzioni`, `ipoteca` | `{ indice?, modalita? }`: alias di `gestione` con la casella evidenziata | come `gestione` |
| `prigione` | `{}` | `lanciaDadi` / `pagaCauzione` / `usaCartaPrigione` |
| `debito` | `{}` | `vendiCasa` / `ipoteca` / `proponiScambio` / apre `bancarotta` |
| `bancarotta` | `{}` (conferma) | `dichiaraBancarotta` |
| `carta` | `{ mazzo, carta, chi? }` (sola lettura) | — |
| `dettaglioCasella` | `{ indice }` | eventuali azioni di gestione tramite `gestione` |
| `finePartita` | `{}` | — |
| `conferma` | `{ titolo, testo, conferma, annulla, pericolo?, azione? }` + `onConferma()` | `azione`, se presente (usato per `abbandona`) |

`toast(testo, { livello, durata, silenzioso })`: con `silenzioso: true` la
notifica è solo visiva (`aria-hidden`), per gli eventi che gli screen reader
sentono già dalla cronaca. Altri export usati da `pannelli.js`: `aperto()`,
`aggiorna()`, le utilità `euro`, `el`, `pulsante`, `motivoAzione`, …

Usa `<dialog>` nativo con `showModal()`, focus trap del browser, chiusura con
Esc, `aria-labelledby`. Un solo dialogo modale alla volta; aprirne un altro
chiude il precedente.

### 4.7 `lobby.js` — `render(radice, stato, dispatch)`

Disegna in `#lobby`: se `stato.partita` è `null` → due form ("Crea una
stanza" / "Entra con codice" con `codice` precompilato da `?stanza=`), nome e
colore; se in `lobby` → codice grande, pulsante "Copia link", elenco
giocatori con colori, "Avvia partita" (solo host, abilitato con >= 2
giocatori), "Esci". Emette `creaStanza`, `entraStanza {codice, nome, colore}`,
`avviaPartita`, `esciStanza`.

### 4.8 `app.js` — orchestrazione

Legge `?stanza=`, crea lo store, apre la rete, smista i messaggi in ingresso
(`entrato` → salva `io`; `stato` → `partita`; `evento` → `eventi` + toast
quando rilevante; `errore` → toast di errore), mostra/nasconde `#lobby`,
`#tabellone`, `#pannelli` in base a `fase`, e chiama i `render`.

---

## 5. Dati statici condivisi (di claude-2)

Entrambi i moduli sono **CommonJS puri**: nessuna dipendenza, nessuno stato,
oggetti congelati. Il server li rende disponibili al browser come ES module
generati (§3.5), quindi tutto ciò che deve arrivare al client deve essere
**JSON-serializzabile** (le funzioni di utilità restano solo lato server).

### 5.1 `server/gioco/tabellone.js`

```js
module.exports = {
  CASELLE,                    // array di 40 Casella, indice = posizione
  GRUPPI,                     // { marrone: { nome, colore, caselle: 2 }, celeste, rosa, arancione, rosso, giallo, verde, blu, stazione, societa }
  STIPENDIO_VIA,              // 200
  INDICE_VIA,                 // 0
  INDICE_PRIGIONE,            // 10
  INDICE_VAI_IN_PRIGIONE,     // 30
  CAUZIONE_PRIGIONE,          // 50
  AFFITTI_STAZIONE,           // [25, 50, 100, 200]
  MOLTIPLICATORI_SOCIETA,     // [4, 10]
  casella(indice),            // CASELLE[indice mod 40]
  indiciGruppo(gruppo),       // indici delle caselle del gruppo
  acquistabile(indice),       // tipo ∈ proprieta | stazione | societa
  prossimaCasellaDiTipo(daIndice, tipo),  // per le carte "più vicina"
};
```

`Casella` (tutti i campi sempre presenti, `null` dove non applicabile):

| Campo | Tipo | Note |
|---|---|---|
| `indice` | 0–39 | |
| `tipo` | `via` · `proprieta` · `stazione` · `societa` · `tassa` · `probabilita` · `imprevisti` · `prigione` · `parcheggio` · `vaiInPrigione` | |
| `nome` | stringa | nome italiano ufficiale |
| `gruppo` | chiave di `GRUPPI` \| `null` | stazioni → `'stazione'`, società → `'societa'` |
| `prezzo` | intero \| `null` | prezzo d'acquisto dalla banca |
| `affitti` | array \| `null` | `proprieta`: 6 valori `[0 case, 1, 2, 3, 4, albergo]` (indice = `caseCostruite`); `stazione`: 4 valori per 1–4 stazioni possedute; `societa`: `[4, 10]` moltiplicatori del tiro per 1–2 società |
| `costoCasa` | intero \| `null` | costo di una casa; l'albergo costa `costoCasa` in più delle 4 case |
| `importoTassa` | intero \| `null` | solo `tassa` (200 patrimoniale, 100 lusso) |
| `ipoteca` | intero \| `null` | valore d'ipoteca = `prezzo / 2` |

Esempi:

```json
{ "indice": 1,  "tipo": "proprieta", "nome": "Vicolo Corto", "gruppo": "marrone", "prezzo": 60,
  "affitti": [2, 10, 30, 90, 160, 250], "costoCasa": 50, "importoTassa": null, "ipoteca": 30 }
{ "indice": 5,  "tipo": "stazione",  "nome": "Stazione Sud", "gruppo": "stazione", "prezzo": 200,
  "affitti": [25, 50, 100, 200], "costoCasa": null, "importoTassa": null, "ipoteca": 100 }
{ "indice": 12, "tipo": "societa",   "nome": "Società Elettrica", "gruppo": "societa", "prezzo": 150,
  "affitti": [4, 10], "costoCasa": null, "importoTassa": null, "ipoteca": 75 }
{ "indice": 4,  "tipo": "tassa",     "nome": "Tassa patrimoniale", "gruppo": null, "prezzo": null,
  "affitti": null, "costoCasa": null, "importoTassa": 200, "ipoteca": null }
{ "indice": 30, "tipo": "vaiInPrigione", "nome": "In prigione!", "gruppo": null, "prezzo": null,
  "affitti": null, "costoCasa": null, "importoTassa": null, "ipoteca": null }
```

### 5.2 `server/gioco/carte.js`

```js
module.exports = {
  PROBABILITA,    // array di 16 Carta
  IMPREVISTI,     // array di 16 Carta
  TIPI_EFFETTO,   // array dei 10 valori ammessi per effetto.tipo
};
```

`Carta = { id, mazzo, testo, effetto }` con `id` `'P01'…'P16'` (Probabilità)
e `'I01'…'I16'` (Imprevisti), `mazzo` `'probabilita' | 'imprevisti'`, `testo`
la frase mostrata al giocatore, `effetto` un oggetto con `tipo` obbligatorio e
i parametri qui sotto. Ogni mazzo ha **esattamente una** carta `esciGratis`.

| `effetto.tipo` | Parametri | Semantica nel motore |
|---|---|---|
| `denaro` | `importo` intero (positivo riscuoti dalla banca, negativo paga alla banca) | `{ "tipo": "denaro", "importo": -50 }` |
| `vaiA` | `casella` 0–39, `incassaVia` bool | avanza **sempre in avanti** fino a `casella`; se `incassaVia` è vero **e** passa (o arriva) dal Via riscuote 200; poi risolve la casella (affitto/acquisto) |
| `vaiInPrigione` | — | posizione 10, `inPrigione: true`, niente 200, fine della mossa |
| `esciGratis` | — | `cartePrigione + 1`; la carta esce dal mazzo finché non viene usata |
| `indietro` | `passi` intero > 0 | arretra di `passi` senza passare dal Via; poi risolve la casella |
| `pagaPerCasa` | `perCasa`, `perAlbergo` interi | paga `perCasa × case + perAlbergo × alberghi` alla banca |
| `riscuotiDaTutti` | `importo` | ogni altro giocatore non fallito paga `importo` al pescante (chi non può → `debito` verso di lui) |
| `pagaATutti` | `importo` | il pescante paga `importo` a ogni altro giocatore non fallito |
| `vaiAllaStazionePiuVicina` | `moltiplicatoreAffitto` (2) | avanza alla prossima stazione (200 se passa dal Via); se posseduta paga l'affitto × moltiplicatore, se libera può comprarla |
| `vaiAllaSocietaPiuVicina` | `moltiplicatoreDadi` (10) | avanza alla prossima società; se posseduta tira i dadi e paga dadi × moltiplicatore, se libera può comprarla |

Esempi:

```json
{ "id": "P01", "mazzo": "probabilita", "testo": "Andate al Via!",
  "effetto": { "tipo": "vaiA", "casella": 0, "incassaVia": true } }
{ "id": "P05", "mazzo": "probabilita", "testo": "Uscite gratis di prigione. Potete conservare questa carta.",
  "effetto": { "tipo": "esciGratis" } }
{ "id": "I03", "mazzo": "imprevisti", "testo": "Fate tre passi indietro.",
  "effetto": { "tipo": "indietro", "passi": 3 } }
{ "id": "I07", "mazzo": "imprevisti", "testo": "Riparazioni: pagate 25 € per casa e 100 € per albergo.",
  "effetto": { "tipo": "pagaPerCasa", "perCasa": 25, "perAlbergo": 100 } }
{ "id": "I10", "mazzo": "imprevisti", "testo": "È il vostro compleanno: ogni giocatore vi dà 10 €.",
  "effetto": { "tipo": "riscuotiDaTutti", "importo": 10 } }
```

---

## 6. Eventi di gioco (`Evento`)

```json
{ "t": 1763204099000, "tipo": "affitto", "giocatoreId": "a7k2x9pq",
  "testo": "Anna paga 50 € a Bruno per Via Accademia", "dati": { "…": "…" } }
```

* `t` timestamp, `tipo` tra quelli sotto, `giocatoreId` il protagonista (può
  essere `null` per eventi di sistema), `testo` frase italiana pronta per la
  cronaca (il client può ignorarla e comporre la propria da `dati`).

| `tipo` | `dati` |
|---|---|
| `giocatoreEntrato` | `{ giocatoreId, nome, colore }` |
| `giocatoreUscito` | `{ giocatoreId }` |
| `connessione` | `{ giocatoreId, connesso }` |
| `partitaIniziata` | `{ ordine: [giocatoreId…], denaroIniziale }` |
| `turno` | `{ giocatoreId, numero }` |
| `turnoSaltato` | `{ giocatoreId, motivo: 'disconnesso' \| 'inattivo' }` |
| `avvisoInattivita` | `{ giocatori: string[], secondi, debito: bool }`: solo come `evento` del server 30 s prima dello scadere del tempo (§3.4), non entra nel log |
| `dadi` | `{ dadi: [d1, d2], doppio, inPrigione, doppiConsecutivi, perAffitto? }` (`perAffitto: true` per il lancio della carta "società più vicina") |
| `movimento` | `{ da, a, passi, passatoDalVia, causa: 'dadi' \| 'carta' }` (`passi` negativo per `indietro`) |
| `passaggioVia` | `{ importo }` |
| `acquisto` | `{ casella, prezzo, tramite: 'banca' \| 'asta' }` |
| `affitto` | `{ daId, aId, casella, importo, moltiplicatore?, dadi? }`; su casella ipotecata l'affitto non è dovuto: `importo: 0` e `ipotecata: true` |
| `abbandono` | `{ creditoreId \| null }` (sempre seguito da `bancarotta`) |
| `tassa` | `{ casella, importo }` |
| `carta` | `{ mazzo: 'probabilita' \| 'imprevisti', carta: { id, testo, effetto } }` |
| `pagamento` | `{ daId, aId \| null, importo, motivo }` (carte, cauzione, interessi, riparazioni) |
| `prigione` | `{ motivo: 'casella' \| 'carta' \| 'treDoppi' }` |
| `uscitaPrigione` | `{ modo: 'cauzione' \| 'carta' \| 'doppio' \| 'terzoTurno' }` |
| `astaInizio` | `{ casella, partecipanti }` |
| `astaOfferta` | `{ casella, importo }` |
| `astaPasso` | `{ casella }` |
| `astaFine` | `{ casella, vincitoreId \| null, importo }` |
| `costruzione` | `{ casella, caseCostruite, costo }` |
| `vendita` | `{ casella, caseCostruite, ricavo }` |
| `ipoteca` | `{ casella, importo }` |
| `disipoteca` | `{ casella, importo }` |
| `scambioProposto` | `{ scambio }` |
| `scambioAccettato` | `{ scambio }` |
| `scambioRifiutato` | `{ scambio, daId }` (`daId` = chi ha rifiutato o ritirato) |
| `debito` | `{ creditoreId \| null, importo, motivo }` |
| `debitoSaldato` | `{ creditoreId \| null, importo }` |
| `bancarotta` | `{ creditoreId \| null, proprieta: [indici], denaro }` |
| `finePartita` | `{ vincitoreId }` |

---

## 7. Codici di errore

Tutti in `protocollo.ERRORI` (codice → messaggio italiano predefinito). Il
motore ritorna `{ errore: { codice, messaggio, dettagli? } }`; il server lo
incapsula in un messaggio `errore`.

Protocollo e stanze:
`MESSAGGIO_NON_VALIDO` · `TIPO_SCONOSCIUTO` · `STANZA_INESISTENTE` ·
`STANZA_PIENA` · `PARTITA_INIZIATA` · `NOME_NON_VALIDO` · `NOME_OCCUPATO` ·
`COLORE_NON_VALIDO` · `COLORE_OCCUPATO` · `GIA_IN_STANZA` · `NON_IN_STANZA` ·
`NON_HOST` · `POCHI_GIOCATORI` · `TOKEN_NON_VALIDO` · `SOLO_IN_LOBBY` ·
`ERRORE_INTERNO` (eccezione nel motore o nel server: l'azione non è
applicata) · `TROPPI_MESSAGGI` (anti-flood, più di 30 messaggi al secondo) ·
`TROPPE_STANZE` (5 stanze create dalla stessa connessione, 10 aperte dallo
stesso indirizzo, o 200 aperte sul server tutte con giocatori dentro)

Motore:
`AZIONE_NON_VALIDA` · `PARAMETRI_NON_VALIDI` · `GIOCATORE_NON_VALIDO` ·
`GIOCATORE_FALLITO` · `NON_IL_TUO_TURNO` · `FASE_ERRATA` ·
`FONDI_INSUFFICIENTI` · `CASELLA_NON_VALIDA` · `PROPRIETA_NON_TUA` ·
`NON_EDIFICABILE` · `GRUPPO_INCOMPLETO` · `NON_SULLA_CASELLA` · `COSTRUZIONE_NON_UNIFORME` ·
`CASE_ESAURITE` · `ALBERGHI_ESAURITI` · `NESSUNA_COSTRUZIONE` ·
`HA_COSTRUZIONI` · `IPOTECATA` · `GIA_IPOTECATA` · `NON_IPOTECATA` ·
`OFFERTA_BASSA` · `GIA_PASSATO` · `MIGLIOR_OFFERENTE` · `SCAMBIO_IN_CORSO` ·
`SCAMBIO_NON_TROVATO` · `SCAMBIO_VUOTO` · `NON_DESTINATARIO` · `NON_COINVOLTO` ·
`NON_IN_PRIGIONE` · `NESSUNA_CARTA_PRIGIONE` · `NON_DEBITORE` ·
`NON_IMPLEMENTATO` (riservato: non viene più emesso, tutte le azioni sono
implementate)

---

## 8. Regole implementate e semplificazioni dichiarate

Regolamento ufficiale, con queste scelte esplicite:

1. **Stipendio**: 200 € ogni volta che si passa o si arriva sul Via, anche via
   carta `vaiA`; mai andando in prigione né con `indietro`.
2. **Parcheggio gratuito**: non succede nulla (nessun "piatto" di tasse).
3. **Affitti**: proprietà `affitti[caseCostruite]`; con gruppo completo e
   nessuna costruzione l'affitto base è **raddoppiato** (anche se un'altra
   casella del gruppo è ipotecata); stazioni per numero possedute (le
   ipotecate contano nel numero); società dadi × 4 (una) o × 10 (due). Niente
   affitto su casella ipotecata né al proprietario stesso. L'affitto si paga
   anche se il proprietario è disconnesso o in prigione. Carta "stazione più
   vicina": affitto × 2; "società più vicina": nuovo lancio × 10 (il nuovo
   lancio non cambia `stato.dadi`, è in `dati.dadi` dell'evento `affitto`).
4. **Costruzioni**: solo con gruppo completo e non ipotecato, uniformi
   (differenza max 1 casa tra le caselle del gruppo), limitate dalle scorte
   (32 case, 12 alberghi). Albergo = 4 case + `costoCasa`; costruirlo
   restituisce 4 case alla banca. Vendita a metà prezzo, sempre uniforme; se
   la banca non ha 4 case da restituire l'albergo si vende per intero.
   **Semplificazione**: costruire, vendere, ipotecare e riscattare si può
   solo nel proprio turno (oltre che durante un proprio debito o un'asta a cui
   si partecipa), non "in qualunque momento" come nel regolamento ufficiale.
5. **Ipoteca**: incassa `ipoteca` (= prezzo/2), richiede nessuna costruzione in
   tutto il gruppo; disipoteca a `ipoteca + ceil(10%)`.
6. **Prigione**: 3 tentativi con i dadi; esce col doppio (muove, nessun
   rilancio); al terzo tentativo fallito paga 50 e muove. Cauzione 50 o carta
   in qualunque momento del proprio `daLanciare`. In prigione si incassano
   affitti e si può gestire il patrimonio.
7. **Tre doppi** consecutivi → prigione.
8. **Asta** all'inglese libera (§1.6), incremento minimo 1 €.
9. **Scambi**: solo caselle senza costruzioni; ipotecate trasferibili con
   interesse immediato del 10% a carico di chi riceve; carte prigione
   scambiabili; una sola proposta pendente per partita.
10. **Debito e bancarotta**: non si va mai in negativo; si entra in `debito` e
    si liquida. Bancarotta verso un giocatore: tutto a lui (costruzioni
    vendute alla banca, incasso al creditore; ipotecate restano ipotecate e
    il creditore paga subito il 10% d'interesse alla banca; carte prigione al
    creditore). Bancarotta verso la banca: le proprietà tornano libere e senza
    ipoteca e vanno **all'asta una dopo l'altra** tra i giocatori rimasti
    (`asteInAttesa`); le carte prigione tornano nei mazzi. "Pagate 50 € a ogni
    giocatore" crea un addebito separato verso ciascuno: in caso di
    bancarotta il creditore è quello del debito aperto. Fine partita quando
    resta un solo giocatore non fallito.
11. **Carte**: `esciGratis` resta al giocatore e torna in coda al **suo** mazzo
    quando usata; le altre tornano in coda subito. I turni hanno un limite di
    tempo solo contro chi non gioca affatto (§3.4: 3 minuti, 60 s in asta,
    5 minuti per un debito).
12. **Disconnessioni e abbandono**: in partita il giocatore resta e può
    riconnettersi col token. Quando il turno passa, i disconnessi vengono
    **saltati** (evento `turnoSaltato`); se il disconnesso è già di turno,
    blocca un'asta o ha uno scambio pendente, dopo 45 s il server chiama
    `motore.gestisciDisconnessione`; un debitore assente da 3 minuti viene
    dichiarato in bancarotta d'ufficio (§3.4). Chi vuole lasciare la partita
    usa `abbandona`: equivale a una bancarotta volontaria.
13. **Prigione al terzo tentativo** senza liquidità: il giocatore esce, si
    muove e la cauzione diventa un `debito` (`motivo: 'cauzione'`) verso la
    banca; gli effetti della casella d'arrivo si applicano dopo.
