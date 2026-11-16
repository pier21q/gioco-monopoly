> **Documento storico.** Questa revisione è stata scritta durante lo sviluppo
> (fase 3 di 4), prima dell'integrazione: numeri di riga e problemi si
> riferiscono al codice di allora e quasi tutti sono stati risolti. Non usarla
> come descrizione del codice attuale; per quello vedi `README.md` e
> `INTERFACCE.md`.

# Revisione del codice — Monopoly online (fase 3 di 4)

Revisore: claude-2. Data: 15 novembre 2026. Commit di partenza: `a39b840`.

## 0. Ambito e metodo

Ho riletto per intero `INTERFACCE.md`, `package.json`, `server/` (`index.js`, `stanze.js`, `protocollo.js`, `gioco/{tabellone,carte,nucleo,motore,scambi,bancarotta,errori}.js`) e `client/` (`index.html`, `js/{app,rete,lobby,tabellone,pannelli}.js`, la parte infrastrutturale, scambio, asta, fine partita e toast di `js/dialoghi.js`, e le regole CSS su focus, contrasti, media query e pulsanti).

**Limiti dichiarati.** In questo ambiente non c'è `node` e non ho potuto avviare il server né il browser: tutto ciò che segue è **analisi statica** (lettura del codice e calcoli a mano, compresi i contrasti). I test esistenti (`tests/fondamenta.test.js`, `server/gioco/test/motore.test.js`) non sono stati né eseguiti né riletti nel dettaglio: sono fuori dal mio perimetro (`tests/` è di claude-1). Dove un'affermazione dipende dal comportamento di un browser o di una versione di Node, lo scrivo esplicitamente e lo metto nella checklist finale (§7). I numeri di riga si riferiscono ai file così come sono nel commit di partenza.

## 1. Sintesi

| Gravità | N. | Sono i problemi che… |
|---|---|---|
| Bloccante | 1 | rendono il gioco inutilizzabile in uno scenario normale (anche in quello della checklist) |
| Importante | 4 | tolgono robustezza o rovinano il flusso principale "creo la stanza e mando il link" |
| Minore | 34 | riguardano rifiniture, accessibilità, duplicazioni, documentazione |

**Giudizio complessivo.** Il motore è la parte migliore: regole, dati e protocollo sono coerenti con `INTERFACCE.md` e non ho trovato errori nelle regole del Monopoly né nei dati di `tabellone.js` e `carte.js` (§6; conformità a `INTERFACCE.md` in §5). Il server è difensivo (validazione, anti-flood, `try/catch` attorno ai gestori, token confrontati a tempo costante). I problemi veri stanno nella **gestione della sessione e delle disconnessioni** (B1, I1) e in alcuni punti dell'**esperienza d'ingresso** (I2, I3). Il client è accessibile in modo sopra la media (dialog nativi, `aria-disabled` con motivazione, roving tabindex, `prefers-reduced-motion`, `forced-colors`).

---

## 2. Bloccante

### B1 — Due schede dello stesso browser si rubano il giocatore e si buttano fuori a vicenda in loop

- **File**: `client/js/app.js:176-199` (`leggiSessione`/`salvaSessione`), `client/js/app.js:384` (`daRiprendere`), `client/js/app.js:753-757` (`onApertura`), `client/js/rete.js:37-40` (`CHIUSURE_DEFINITIVE`) e `:171-181` (gestore `close`), `server/stanze.js:186-188` (chiusura con codice 4000).
- **Descrizione.** La sessione `{codice, giocatoreId, token}` viene scritta sia in `sessionStorage` sia in `localStorage`, e `leggiSessione()` ripiega su `localStorage` quando `sessionStorage` è vuoto. Una **seconda scheda** (nuova scheda, link d'invito `?stanza=…`, "Duplica scheda") eredita quindi la sessione della prima. All'apertura invia `riconnetti` con lo stesso token; il server chiude il vecchio socket con codice **4000** (`stanze.js:187`); `rete.js` non considera 4000 una chiusura definitiva, quindi la prima scheda dopo ~1 s si riconnette, invia `riconnetti` e chiude a sua volta la seconda. Il backoff si azzera a ogni apertura riuscita (`rete.js:142`), quindi il ciclo continua all'infinito, con toast "Connessione persa" / "Connessione ripristinata" a ripetizione.
- **Impatto.** Con le schede dello stesso browser non si riescono a provare due giocatori: è proprio lo scenario della checklist finale. Per un utente reale: apre il link d'invito in una seconda scheda "per controllare" e rovina la partita a sé stesso. Nessun dato viene corrotto, ma la UI è inutilizzabile finché una delle due schede non viene chiusa.
- **Correzione proposta.**
  1. In `leggiSessione`/`salvaSessione`/`cancellaSessione` usare **solo `sessionStorage`** (persiste al refresh, non è condiviso tra schede). Se si vuole mantenere il recupero dopo la chiusura della scheda, salvare in `localStorage` con chiave `monopoly.sessione.<CODICE>` e riprenderla solo dopo un'azione esplicita ("Riprendi la partita in questa scheda").
  2. Nel server chiudere il vecchio socket con un codice **dedicato** (`4001`, "sostituito da un'altra connessione"), non 4000: il client usa già 4000 in `rete.js:288` per la chiusura volontaria offline, quindi marcare 4000 come definitivo romperebbe la gestione offline.
  3. In `rete.js` aggiungere `4001` a `CHIUSURE_DEFINITIVE` e, in `app.js`, mostrare un messaggio "Questa partita è stata aperta in un'altra scheda" con il pulsante "Usa questa scheda" (che chiama `conn.riprovaOra()` e reinvia `riconnetti`).
  4. Test: apri due schede sullo stesso link; deve restare attiva solo l'ultima e la prima deve fermarsi con il messaggio, senza loop.

---

## 3. Importante

### I1 — Il server non chiama mai `gestisciDisconnessione`: una disconnessione può bloccare la partita per tutti

- **File**: `server/stanze.js:224-236` (`disconnetti`) e `:91-100` (`sincronizzaConnessione`), `server/index.js:400-416` (gestore `close`), `server/gioco/motore.js:885-916` (`gestisciDisconnessione`, mai richiamata: `grep` su `server/` e `client/` la trova solo nel motore e nei test).
- **Descrizione.** Alla chiusura del socket il server si limita a mettere `connesso: false`. Il motore salta i disconnessi **solo quando il turno passa** (`nucleo.js:445-478`). Restano bloccate tre situazioni:
  - il disconnesso è **di turno** (`daLanciare`, `mossa`, `daDecidereAcquisto`): nessuno può agire al suo posto;
  - c'è un'**asta** in corso e il disconnesso non ha passato: l'asta non si chiude finché non torna (`nucleo.js:402-411` richiede che tutti i partecipanti non passati siano il miglior offerente);
  - il disconnesso è il **debitore** in fase `debito`: la partita aspetta per sempre (§1.8 lo prevede, ma senza alcuna via d'uscita).
  Inoltre in partita non esiste un modo di **abbandonare**: `esciStanza` vale solo in lobby (`stanze.js:203`) e la bancarotta solo con un debito aperto.
- **Impatto.** Un amico che chiude il portatile o perde la rete definitivamente tiene in ostaggio gli altri cinque. Con il browser riaperto nella stessa scheda il recupero funziona, quindi il danno è limitato a chi se ne va davvero, ma non c'è alcun rimedio.
- **Correzione proposta.**
  1. In `stanze.disconnetti` avviare un timer (es. 45 s, costante in `TEMPI`) per giocatore. Allo scadere, se il giocatore è ancora `connesso === false` e la partita è in corso, chiamare `motore.gestisciDisconnessione(stanza.stato, id, { random, ora })`, riallineare i flag `connesso` come fa `stanze.applica` (`stanze.js:303-307`), salvare lo stato e chiamare `diffondiAggiornamento`. Annullare il timer in `riconnetti` e quando la stanza viene chiusa (`pulisci`).
  2. Per il debito di un disconnesso: dopo una soglia più lunga (es. 3 minuti) far dichiarare la bancarotta d'ufficio (`bancarotta.liquidaInterno`) oppure dare all'host un'azione "Escludi giocatore".
  3. Aggiungere un'azione `abbandona` (bancarotta volontaria verso la banca, ammessa in qualsiasi fase) e un pulsante "Abbandona la partita" con conferma (esiste già il tipo di dialogo `conferma`, oggi inutilizzato).
  4. Aggiungere un test in `tests/` con orologio iniettato che simuli la disconnessione del giocatore di turno e verifichi il passaggio di turno.

### I2 — Il link da condividere è `http://localhost:3000/?stanza=…`, inutilizzabile per gli amici

- **File**: `server/index.js:197-208` (`baseLink`), `:497` e `:521-523` (messaggio di avvio), `client/js/lobby.js:502` e `:555-559` (`linkStanza`), `README.md` (3 righe, contiene solo la richiesta originale).
- **Descrizione.** Se chi crea la stanza apre `http://localhost:3000`, l'header `Host` è `localhost:3000` e il link generato (e mostrato in sala d'attesa) punta a `localhost`: sul computer di un amico è un indirizzo diverso. `PUBLIC_URL` risolve il problema, ma non lo dice nessuno: né l'avvio (stampa `http://localhost:…`), né l'interfaccia, né il README.
- **Impatto.** Va contro l'obiettivo centrale del progetto ("un link che condivido con gli amici"): al primo tentativo gli amici vedono "impossibile raggiungere il sito".
- **Correzione proposta.**
  1. All'avvio elencare gli indirizzi di rete locale (`os.networkInterfaces()`, solo IPv4 non interni) e stampare `Amici sulla stessa rete: http://192.168.x.y:3000`.
  2. In `aggiornaSala` (`lobby.js:487`): se `location.hostname` è `localhost`, `127.0.0.1` o `::1` e il link non viene da `PUBLIC_URL`, mostrare sotto il link un avviso `role="note"`: "Questo link funziona solo sul tuo computer. Apri il gioco dall'indirizzo di rete (192.168…) o con un tunnel (ngrok, cloudflared) e imposta `PUBLIC_URL`."
  3. Riscrivere `README.md`: `npm install`, `npm start`, variabili `PORT`/`HOST`/`PUBLIC_URL`, come condividere (LAN, tunnel, hosting), come lanciare i test. Il testo attuale è il prompt dell'utente in prima persona.

### I3 — Il colore predefinito viene sempre inviato: il secondo giocatore che entra riceve quasi sempre `COLORE_OCCUPATO`

- **File**: `client/js/lobby.js:185` (colore iniziale = rosso), `:306-307` e `:318-320` (si invia sempre il colore selezionato), `client/js/app.js:438`, `server/stanze.js:151-158`.
- **Descrizione.** Il form preseleziona il primo colore (rosso) e invia sempre `colore` nel messaggio. Il server, se il colore è già preso, risponde `COLORE_OCCUPATO` invece di assegnarne uno libero (lo farebbe solo se `colore` mancasse). Chi entra via link scrive il nome e preme "Entra": con il rosso già preso dal creatore ottiene un errore e deve scegliere a mano.
- **Impatto.** Attrito nel flusso principale per quasi ogni invitato; un utente poco attento pensa che "la stanza non funzioni".
- **Correzione proposta.** Inviare `colore: null` finché l'utente non tocca la scelta (la preferenza salvata in `monopoly.preferenze` conta come scelta). In alternativa, su `COLORE_OCCUPATO` riprovare automaticamente senza colore. Il server già gestisce il caso. Opzionale: includere nello stato di lobby la lista dei colori occupati e disabilitare quelle opzioni nel form.

### I4 — `npm test` non esegue i test del motore e dipende dal comportamento di `node --test <cartella>`

- **File**: `package.json:13`, `INTERFACCE.md` §2.5 (cita `node --test server/gioco/test/`).
- **Descrizione.** Lo script è `node --test tests/`: i circa 800 righe di test del motore in `server/gioco/test/motore.test.js` non vengono eseguiti da `npm test`. In più, dalle versioni recenti di Node (da verificare: ≥ 21) gli argomenti di `--test` sono interpretati come file/glob e una cartella nuda può non essere espansa come in Node 20.
- **Impatto.** `npm test` può dare un falso "tutto verde" senza toccare le regole, oppure fallire per un motivo di versione.
- **Correzione proposta.** `"test": "node --test"` (senza argomenti trova ricorsivamente `*.test.js` e le cartelle `test/`, quindi sia `tests/fondamenta.test.js` sia `server/gioco/test/motore.test.js`, su Node 20 e successivi). Se si vuole essere espliciti: `node --test tests/*.test.js server/gioco/test/*.test.js` (richiede shell con glob, funziona anche su npm/zsh/bash). **Da verificare su una macchina con Node.** Coordinarsi con claude-1, che possiede `tests/`.

---

## 4. Minore

### 4.1 Motore e regole

- **M1 — Albergo non vendibile se la banca ha meno di 4 case** (`motore.js:699-703`). Il debitore non può liquidare l'albergo, e `ipoteca` gli è vietata finché ci sono costruzioni nel gruppo (`motore.js:730`): può essere costretto alla bancarotta pur avendo patrimonio. Regola ufficiale: se mancano le case si vende l'albergo demolendo tutto sul terreno. *Correzione:* in `vendiCasa`, se `caseDisponibili < 4`, permettere la vendita completa (ricavo `5 × costoCasa / 2`, albergo restituito, nessuna casa restituita).
- **M2 — Evento `pagamento` con `importo: 0` per l'affitto non dovuto su ipotecata** (`motore.js:394-398`). Il testo è giusto, ma `dati.importo = 0` con `motivo: 'affitto'` è un uso improprio del tipo `pagamento` (non previsto in §6). *Correzione:* nuovo tipo `affittoNonDovuto` oppure `affitto` con `importo: 0` e `dati.motivo: 'ipotecata'`; documentarlo in §6.
- **M3 — `proponiScambio` è ammessa a chiunque durante il debito** (`motore.js:285-288`, e lo stesso nel client `dialoghi.js:277-286`), mentre la tabella di §1.2 dice "(debitore)". Il comportamento è migliore (il creditore può offrire uno scambio al debitore), quindi è `INTERFACCE.md` a essere indietro. *Correzione:* aggiornare §1.2.
- **M4 — Costruire, vendere, ipotecare e riscattare solo nel proprio turno** (`motore.js:249-251`, `:272-284`). È dichiarato in §2.4, ma il regolamento ufficiale consente di costruire e ipotecare in qualunque momento (tra un turno e l'altro). Non è un errore; va elencato tra le semplificazioni di §8.
- **M5 — `rifiutaScambio` ammesso durante l'asta dal motore (`motore.js:294-297`, §2.4), ma non dalla UI** (`dialoghi.js:277-286`: il blocco `fase !== 'asta'` copre anche rifiuto e ritiro). Il destinatario di uno scambio pendente non può rifiutarlo né il proponente ritirarlo mentre c'è un'asta. *Correzione:* in `azioniAmmesse` spostare `rifiutaScambio` fuori dal ramo `fase !== 'asta'`.
- **M6 — Regole duplicate nel client** (`dialoghi.js:187-230` `affittoAttuale`/`patrimonio`/`liquidabile`, `:237-288` `azioniAmmesse`, `:445-487` `pianoLiquidazione`). Replicano `calcolaAffitto`, `verificaPermesso` e `patrimonioLiquidabile`. M5 è già un caso di deriva. *Correzione:* far arrivare dal server `azioniDisponibili` (e l'affitto corrente) dentro lo stato pubblico, oppure estrarre in un modulo condiviso `regole.js` caricabile anche dal client, come già avviene per i dati.
- **M7 — Nome della casella 28.** `server/gioco/tabellone.js:125` la chiama "Acquedotto"; nell'edizione italiana è "Società Acqua Potabile" (verificare sulla scatola). Il client riconosce l'icona con `/acqu/i` (`client/js/tabellone.js:347`), che funzionerebbe anche con il nome ufficiale.
- **M8 — Congelamento solo superficiale dei dati** (`server/gioco/tabellone.js:139-140`): `CASELLE.forEach(Object.freeze)` non congela `affitti`; gli oggetti di `GRUPPI` (`:31-42`) non sono congelati. Un consumatore che muta per errore un array altera le regole per tutte le stanze. *Correzione:* congelare in profondità (es. `affitti: Object.freeze([...])` nei costruttori e un piccolo `profondo(freeze)`).
- **M9 — Codice morto o solo da test** nel motore: `scambi.normalizzaParte` e `scambi.applicaScambio` (`scambi.js:25-33`, `:204-219`: la validazione vera usa `leggiParte`), `bancarotta.liquida` (`bancarotta.js:139-149`), `motore.prossimoGiocatore`, codice d'errore `NON_IMPLEMENTATO` (`errori.js:44`, `protocollo.js:132`). Gli ultimi due esistono nel contratto, quindi basta una nota; per i primi tre valutare la rimozione. In `motore.js:181-185` i `void mazzi; void contatoreScambi;` si possono sostituire con una funzione `senza(obj, ...chiavi)`.

### 4.2 Server

- **M10 — Nessun limite al numero di stanze o di connessioni per indirizzo** (`index.js:268-272`, `stanze.js:107-121`). Ogni `creaStanza` crea una stanza in memoria, rimossa solo dopo 10 minuti. Se il server è esposto con un tunnel pubblico, uno script può riempirla. *Correzione:* tetto globale (es. 200 stanze) e per IP (es. 10 stanze aperte), `creaStanza` rifiutata con un codice nuovo (`TROPPE_STANZE`) oltre il limite.
- **M11 — Nessuna intestazione di sicurezza né controllo `Origin` sul WebSocket** (`index.js:60-69`, `:462`). Aggiungere `X-Frame-Options: DENY` (o `frame-ancestors 'none'`) e una CSP `default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'`. Lo `style-src 'unsafe-inline'` serve perché `lobby.js:103` usa `setAttribute('style', …)`; i `<script>` restano tutti esterni, quindi `script-src 'self'` è applicabile. Verificare l'`Origin` del WebSocket (`verifyClient`) contro l'host della richiesta, per evitare che un sito terzo usi i visitatori per creare stanze.
- **M12 — Nessun gestore globale di eccezioni** (`index.js`). Ho verificato che i gestori dei messaggi (`index.js:383-389`), la chiusura (`:405-411`), la pulizia (`:472-474`) e le richieste HTTP (`:135-143`) sono protetti, e non ho trovato un crash concreto; ma un errore in `wss.on('connection')` (`:463-467`) o in un timer futuro abbatterebbe tutte le stanze (stato solo in memoria). *Correzione:* `process.on('uncaughtException', …)` e `'unhandledRejection'` con log e proseguimento, avvolgere `collegaSocket` in `try/catch`.
- **M13 — Stanza chiusa dal server ma il client resta sul tabellone** (`stanze.js:366-368`; `app.js:562-610`). `pulisci` manda `STANZA_INESISTENTE` senza `rif`, azzera i socket ma non li chiude: il client mostra un toast, la UI resta in partita e ogni azione successiva dà `NON_IN_STANZA`. *Correzione:* chiudere i socket con un codice dedicato (4002) e, nel client, trattare `STANZA_INESISTENTE`/`NON_IN_STANZA` con `s.io` impostato come `tornaAllInizio()` più un messaggio.
- **M14 — Rimozione dalla lobby dopo 60–120 s, non 60 s** (`stanze.js:345-357` con `pulisci` ogni 60 s da `index.js:474`; §3.4 dice 60 s). *Correzione:* timer dedicato per giocatore, oppure aggiornare §3.4.
- **M15 — Ogni `stato` contiene il log completo (fino a 200 eventi)** (`stanze.js:84-85`, `:97`; `motore.js:181-186`). Ogni azione manda ~N giocatori × decine di KB, più ogni `evento` separato. Su LAN è invisibile, su rete mobile pesa. *Correzione:* inviare nello `stato` solo gli ultimi 30 eventi e il log intero solo a `riconnetti`/`entrato`.
- **M16 — Unicità del nome solo con `toLowerCase()`** (`stanze.js:148-149`): "Anna" e "Ánna", o un nome con caratteri simili, passano. Basso rischio (partite tra amici). *Correzione:* confrontare dopo `normalize('NFD')` senza segni diacritici.
- **M17 — Dimensione massima del messaggio**: §3.1 dice 16 KiB, il frame è limitato a 64 KiB dalla libreria e a 16 KiB da `analizza` (`protocollo.js:20`, `:27`). Il comportamento è corretto, ma il doc va allineato.

### 4.3 Client e accessibilità

- **M18 — Il contrasto di `.pulsante--primario` è 4,2:1** (`base.css:359-363`: testo `#fff` su `#1e8e3e`; calcolato a mano, luminanza del verde ≈ 0,20). Sotto il minimo AA di 4,5:1 per il testo normale (vale per "Copia link" e per ogni `.pulsante--primario` di dimensione normale; i `--grande` a 1,25 rem/peso 600 probabilmente contano come testo grande, soglia 3:1, ma dipende dal peso effettivo del font di sistema). `.btn--primario` usa invece `--colore-primario-forte` (6,6:1, `pannelli.css:41`). *Correzione:* in `base.css` usare `--colore-primario-forte` come sfondo.
- **M19 — Durante la partita non c'è nessun `<h1>`** (`client/index.html:57`: l'unico `h1` sta in `#lobby`, che viene nascosto). La gerarchia riparte da `h2`. *Correzione:* un `h1` visivamente nascosto nella barra, o rendere `.barra__marchio` un `h1` quando `data-vista !== 'lobby'`.
- **M20 — Annunci doppi per gli screen reader.** `toastPerEvento` (`app.js:277-339`) notifica `acquisto`, `astaInizio`, `astaFine`, `scambioAccettato`, `prigione`, `carta`, mentre la cronaca (`pannelli.js:240-243`, `aria-live="polite"`) legge gli stessi eventi; in lobby c'è un terzo `aria-live` sull'elenco giocatori (`lobby.js:468-474`). Il commento di `app.js:271-273` dichiara l'intenzione opposta. *Correzione:* togliere dai toast i tipi già coperti dalla cronaca, o `aria-live="off"` sulla cronaca quando il toast è attivo.
- **M21 — Doppio clic sui pulsanti d'azione.** I pulsanti non vengono disabilitati dopo l'invio (`pannelli.js:129-176`): "Lancia i dadi" cliccato due volte genera subito un toast d'errore `FASE_ERRATA` (il secondo invio arriva prima dello stato). *Correzione:* `aria-disabled` ottimistico fino al prossimo `stato` (o fino a 600 ms).
- **M22 — Coda offline di 20 messaggi con scadenza 2 minuti** (`rete.js:33-34`, `:212-225`, `:231-247`). Azioni cliccate offline vengono eseguite alla riconnessione, anche se il contesto è cambiato; il server le rifiuta, quindi nessun danno di stato, ma l'utente riceve una pioggia di toast. *Correzione:* non accodare le azioni di gioco (solo `riconnetti`), mostrare "Sei offline" e basta.
- **M23 — La connessione chiusa definitivamente (1008/1009) non ha un pulsante "Riprova"** (`rete.js:171-181`, `:329-350`): l'indicatore dice "Disconnesso" e l'utente deve ricaricare. *Correzione:* pulsante "Riconnetti" nella barra che chiama `conn.riprovaOra()`.
- **M24 — Possibile lampo del modulo d'ingresso dopo un refresh in stanza.** `entrato` imposta `lobby.ripresa = false` (`app.js:528-533`) prima che arrivi `stato`; `lobby.js:138-141` mostra per un istante la vista "ingresso". *Correzione:* tenere `ripresa` finché `partita` è `null` e `io` è valorizzato.
- **M25 — Formato dei soldi in quattro implementazioni**: `nucleo.js:50-52` (regex), `app.js:244-246` e `tabellone.js:233-235` (`toLocaleString('it-IT')`), `dialoghi.js:39-43` (regex, con il commento "punto delle migliaia anche sotto i 10.000"). Il commento suggerisce che `toLocaleString('it-IT')` non raggruppi i numeri a 4 cifre (comportamento di CLDR per l'italiano; **da verificare nel browser**): in quel caso `1500 €` nelle etichette del tabellone e nei toast e `1.500 €` nei pannelli. *Correzione:* una sola funzione `euro` in un modulo `util.js` usato da tutti.
- **M26 — Gestione dell'errore di caricamento dati poco visibile** (`app.js:376-377`): se `/dati/tabellone.js` non si carica, `CASELLE = []` e il tabellone non si disegna, senza messaggio all'utente (solo `console.error`). *Correzione:* messaggio in `#tabellone` con pulsante "Riprova".

### 4.4 Pulizia del codice

- **M27 — Tre costruttori di DOM con attributi diversi**: `lobby.js:96-114` (`classe`, `stile`), `dialoghi.js:49-67` (`class`, `style` oggetto, `text`), `tabellone.js:226-231`. Più due sistemi di pulsanti (`.pulsante` in `base.css:326` e `.btn` in `pannelli.css:75`) con token separati (`--colore-*` e `--pn-*`). *Correzione:* un modulo `dom.js` e una sola famiglia di pulsanti.
- **M28 — `testoSu` duplicato con costanti diverse** (`dialoghi.js:88-100` usa `#14323a` e 0,028; `tabellone.js:640-652` usa `#14231e` e 0,05). Può dare un colore di testo diverso sulla stessa pedina. Estrarre in un'unica funzione.
- **M29 — Palette dei gruppi duplicata e non coincidente**: `server/gioco/tabellone.js:31-42` (es. marrone `#8B4513`) contro `base.css:38-45` (`--gruppo-marrone: #8b5a2b`). I token CSS `--gruppo-*` sembrano inutilizzati dal tabellone, che legge `GRUPPI[...].colore`. Eliminare i token o farli usare.
- **M30 — `dialoghi.js` è un modulo da 1767 righe** che contiene utilità, regole, 13 dialoghi e toast, e `pannelli.js:26-30` ne importa le utilità. *Correzione:* spezzare in `util.js`, `regole-client.js`, `dialoghi/` (uno per tipo), `toast.js`.
- **M31 — Dialoghi non usati**: `TIPI.carta` (`dialoghi.js:1696`), `TIPI.conferma` (`:1677`) e gli alias `TIPI.costruzioni`/`TIPI.ipoteca` (`:1513`, `:1521`); `opzioni.onCasellaSelezionata` (`tabellone.js:1018-1020`); alias `getStato`/`sottoscrivi` "della fase 1" (`app.js:160-162`); `P.MESSAGGI_CLIENT/SERVER` e `P.REGEX_ID` (`protocollo.js`). (`conferma` serve per I1, punto 3.)
- **M32 — `casella-selezionata` gestito due volte**: `app.js:741-743` (aggiorna `selezione`) e `pannelli.js:807-813` (apre il dettaglio). Funziona, ma conviene decidere un solo proprietario.
- **M33 — `globalThis.monopoly = { store, conn }`** (`app.js:783`) espone store e connessione in console. Utile in sviluppo; limitarlo a `localhost` o a `?debug`.
- **M34 — `README.md`** contiene solo la richiesta originale in prima persona (vedi I2): mancano istruzioni di avvio, variabili d'ambiente, struttura del progetto e come eseguire i test. Il codice, invece, è commentato bene: ogni modulo ha una testata che spiega ruolo e contratti, e le funzioni non banali (es. `pianoLiquidazione`, `dialoghi.js:439-444`) hanno il loro commento; non ho trovato funzioni complesse senza spiegazione.

---

## 5. Conformità a `INTERFACCE.md`

Esito sintetico: **nomi, firme, tipi di azione, shape dello stato, id dei contenitori, evento `casella-selezionata` e messaggi del protocollo coincidono tra motore, server e client.** Differenze rilevate:

| Contratto | Esito | Dettaglio |
|---|---|---|
| 16 tipi di azione (§2.4) | ✅ | `motore.js:32-49` = `app.js:26-31`; i payload emessi da `dialoghi.js` (righe 954-1674) e `pannelli.js` coincidono (`casella`, `importo`, `scambioId`, `aId/offre/chiede`). |
| `creaPartita`, `creaStatoLobby`, `applicaAzione`, `azioniDisponibili`, `statoPubblico`, `prossimoGiocatore`, `gestisciDisconnessione`, `calcolaAffitto`, `patrimonioLiquidabile`, `AZIONI`, `FASI` (§2) | ✅ | Tutti presenti con le firme documentate. **`gestisciDisconnessione` non è chiamata dal server** (I1). |
| `scambi.validaProposta/applicaScambio`, `bancarotta.liquida/patrimonioLiquidabile` (§2.6-2.7) | ✅ | Presenti; il motore usa le varianti interne `eseguiScambio`/`liquidaInterno` (M9). `validaProposta` ritorna `{ ok: true, scambio }`, come da doc. |
| Shape `StatoPartita` (§1) | ✅ | Campi di testa, giocatori, turno, `proprieta` con tutte le 28 voci, `asta`, `scambio`, `debito` coincidono. Estensioni documentate in §1.9 bis; `contatoreScambi` è interno e `statoPubblico` lo toglie insieme ai `mazzi`. |
| Messaggi client→server e server→client (§3.2-3.3) | ✅ | `analizza` e i gestori di `index.js:267-347` coprono i 7 tipi; il server invia `stanzaCreata`, `entrato`, `stato`, `evento`, `errore`, `pong`. Prima gli `evento`, poi lo `stato` (`stanze.js:330-336`). `rif` è riportato negli errori. |
| Ciclo di vita connessione (§3.4) | ⚠️ | Rimozione in lobby 60–120 s (M14); la stanza chiusa non chiude i socket (M13); la disconnessione in partita non fa nulla di attivo (I1). |
| Limite messaggio 16 KiB (§3.1) | ⚠️ | Vedi M17. |
| Rotte HTTP e `/dati/*.js` (§3.5) | ✅ | `/salute` ha il campo extra `websocket`. I moduli generati escludono le funzioni. |
| Registro stanze (§3.6) | ✅ | `stanze.js` esporta tutto l'elenco più `diffondiAggiornamento`, `rimuovi`, `azzera`; `entra` ritorna anche `eventi`. |
| Contenitori `#lobby`, `#tabellone`, `#pannelli` (`aside`), `#dialoghi`, `#toast` (§4.1) | ✅ | `index.html:55-72`, con `role="status" aria-live="polite" aria-atomic="false"` su `#toast`. Id extra: `#connessione`, `#barra-stanza`, `#barra-azioni`. |
| Store e `dispatch` (§4.2) | ⚠️ | `creaStore(iniziale, gestori)` ha un secondo parametro; lo stato ha i campi `lobby` e `preferenze`; azioni extra `ui:errore`, `ui:pulisciErrore`, `ui:abbandonaSessione`, `ui:nuovaPartita`. `creaStanza` non viene inviato "così com'è" (§4.2) ma tradotto in `creaStanza` + `entraStanza` (`app.js:425-439`, `:511-521`). → aggiornare il doc. |
| `rete.connetti` (§4.3) | ✅ | Callback e metodi coincidono; aggiunti `onStato`, `riprovaOra`, `inCoda`. Backoff 1→30 s ×2 con jitter ±20 %, coda 20, ping 25 s: tutto come da doc. |
| `tabellone.render/aggiorna` e `casella-selezionata` (§4.4) | ✅ | `detail = { indice, casella }`, `bubbles: true`, emesso sulla radice (`tabellone.js:1014-1017`). Esiste anche `seleziona` e `distruggi`. |
| `pannelli.render` (§4.5) | ✅ | Riceve lo `StatoClient` (come fa `app.js:671`), `role="log"` con `aria-live` sulla cronaca. |
| `dialoghi.apri/chiudiTutti/toast` (§4.6) | ⚠️ | Firme giuste. **La tabella dei tipi è superata**: `pannelli.js` apre `gestione`, `bancarotta`, `scambio` con `{ nuovo: true }` e passa `{}` per acquisto/asta/debito/prigione (i dati si leggono dallo store via `aggiorna`); `costruzioni`/`ipoteca`/`carta`/`conferma` esistono ma non sono usati (M31). |
| `lobby.render` (§4.7) | ✅ | |
| Dati statici (§5) | ✅ | `Casella` e `Carta` come da doc; 40 caselle, 28 acquistabili, 16+16 carte, una `esciGratis` per mazzo (`P05`, `I08`). |
| Eventi (§6) | ✅ | Tutti i tipi sono emessi con i `dati` documentati; extra: `dadi.perAffitto` e l'uso di `pagamento` con importo 0 (M2). |
| Codici d'errore (§7) | ✅ | `protocollo.ERRORI` ⊇ `errori.ERRORI` ⊇ §7; `NON_IMPLEMENTATO` non è più emesso. |

---

## 6. Regole del Monopoly, dati e carte

### 6.1 Dati del tabellone (`server/gioco/tabellone.js`)

Controllate a mano tutte le 40 caselle contro l'edizione italiana: **nessuna discrepanza**.

| Verifica | Esito |
|---|---|
| Posizioni 0-39 e tipi (Probabilità 2/17/33, Imprevisti 7/22/36, tasse 4 e 38, prigione 10, parcheggio 20, "In prigione!" 30) | ✅ |
| Prezzi: 60/60, 100/100/120, 140/140/160, 180/180/200, 220/220/240, 260/260/280, 300/300/320, 350/400; stazioni 200; società 150 | ✅ |
| Affitti dei 22 terreni a 6 livelli (es. Vicolo Corto 2/10/30/90/160/250; Parco della Vittoria 50/200/600/1400/1700/2000) | ✅ |
| Costo casa: 50 (marrone, celeste), 100 (rosa, arancione), 150 (rosso, giallo), 200 (verde, blu) | ✅ |
| Stazioni 25/50/100/200; società ×4 / ×10; tasse 200 e 100; Via 200 | ✅ |
| Ipoteca = prezzo/2, sempre intera (il più basso dispari è 350/2 = 175) | ✅ |
| Conteggi: 22 terreni + 4 stazioni + 2 società = 28; scorte 32 case e 12 alberghi (`nucleo.js:29-30`) | ✅ |
| Nome casella 28 ("Acquedotto") | ⚠️ M7 |

### 6.2 Carte (`server/gioco/carte.js`)

16 Probabilità + 16 Imprevisti, id `P01`-`P16` / `I01`-`I16`, una sola `esciGratis` per mazzo (`P05`, `I08`), `indietro` con `passi`, `vaiA` con `incassaVia`. Indici usati: Via 0, Via Accademia 11, Largo Colombo 24, Stazione Nord 25, Parco della Vittoria 39: tutti corretti. Riparazioni 40/115 (Probabilità) e 25/100 (Imprevisti). Le due carte "stazione più vicina" identiche (`I05`/`I06`) sono volute. Da ogni casella Probabilità/Imprevisti i movimenti sono corretti: da 36 la stazione più vicina è la 5 (passa dal Via), "tre passi indietro" da 36 finisce su Probabilità 33 e pesca una seconda carta (gestito da `risolviCasella` → `pescaCarta`).

### 6.3 Regole nel motore

| Regola | Esito | Note |
|---|---|---|
| 200 € al Via | ✅ | `avanza` (`motore.js:325-338`) paga se `da + passi >= 40`, anche arrivando sul Via; non con `indietro`, non andando in prigione; con le carte `vaiA` solo se `incassaVia`. |
| Doppi | ✅ | Doppio → ancora `daLanciare` (`impostaFase`, `nucleo.js:223-228`); al terzo → prigione senza muovere (`motore.js:559-562`). Doppio da prigione: si esce e si muove senza rilanciare. |
| Prigione | ✅ | 3 tentativi, cauzione 50 o carta all'inizio del turno, al terzo fallimento paga 50 (o `debito`) e muove (`motore.js:529-552`). Si incassano affitti. |
| Affitti | ✅ | Gruppo completo senza case ×2 (`nucleo.js:197`), case/albergo da tabella, stazioni per numero (ipotecate incluse), società dadi ×4/×10, carte ×2 e ×10 con nuovo lancio, nessun affitto su ipotecata o a sé stessi. |
| Costruzioni | ✅ | Gruppo completo, nessuna ipoteca nel gruppo, uniformità, scorte 32/12, albergo = 4 case restituite, vendita a metà (`motore.js:628-718`). Eccezione: M1. |
| Ipoteche | ✅ | Nessuna costruzione nel gruppo; riscatto `ipoteca + ceil(10 %)` (`nucleo.js:173-181`). |
| Aste | ✅ | All'inglese, incremento 1, il miglior offerente non passa, chiusura corretta con 0 o 1 attivo (`nucleo.js:383-433`). I disconnessi partono già passati. |
| Scambi | ✅ | Solo caselle senza costruzioni nel gruppo, ipotecate con interesse 10 % (`scambi.js:189-193`), carte prigione, possessi ricontrollati all'accettazione, uno solo pendente. |
| Debiti e bancarotta | ✅ | Mai denaro negativo, debito con coda e saldo automatico (`nucleo.js:330-373`), bancarotta verso giocatore (beni, carte, interessi sulle ipotecate) o verso banca (aste in coda), turno passato, fine partita (`bancarotta.js:54-125`). Ho seguito a mano i casi: bancarotta del giocatore di turno con doppio, di un non-di-turno per "compleanno", con interessi non pagabili dal creditore: la fase finale è sempre corretta. |
| Carte | ✅ | Tutti i 10 tipi di effetto gestiti (`motore.js:434-484`); `esciGratis` esce dal mazzo e torna in coda al suo mazzo quando usata o a bancarotta verso la banca. |
| Immutabilità e atomicità | ✅ | `structuredClone` a ogni azione, nessun evento in caso di errore. |

Semplificazioni dichiarate e corrette: nessun piatto sul Parcheggio, costruzioni solo nel proprio turno (M4), un solo scambio pendente.

---

## 7. Checklist di verifiche manuali (più schede del browser)

> **Prima di cominciare.** Finché B1 non è risolto, le schede normali dello stesso browser condividono la sessione. Per provare più giocatori usa **finestre private diverse** (ognuna ha storage separato), **browser diversi** o **profili diversi**. Dopo la correzione di B1 bastano schede normali. Con 6 giocatori servono 6 finestre.
>
> Avvio: `npm install`, `npm start`, apri `http://localhost:3000`. Per provare da telefono/altro PC usa l'indirizzo di rete (vedi I2) e `PUBLIC_URL`.

### 7.1 Lobby e ingresso
- [ ] Crea una stanza: compare il codice a 6 caratteri e il link; "Copia link" mostra il toast; incolla il link e controlla che **non** sia `localhost` quando apri dall'IP di rete (I2).
- [ ] Seconda finestra: apri il link d'invito → il campo codice è precompilato; scrivi il nome e premi "Entra" **senza toccare il colore**: deve entrare (I3) — oggi riceve `COLORE_OCCUPATO`.
- [ ] Nome già usato (anche con maiuscole diverse) → errore accanto al campo, focus sul campo.
- [ ] Nome vuoto, nome di 17 caratteri, codice di 5 caratteri, codice inesistente → messaggi chiari, nessun crash.
- [ ] Entra con 6 giocatori; il 7° riceve "stanza piena" senza creare un giocatore fantasma.
- [ ] "Avvia partita" è visibile solo all'host, disabilitato con meno di 2 giocatori connessi.
- [ ] Un giocatore preme "Esci dalla stanza" in lobby: sparisce dall'elenco degli altri; se era l'host il ruolo passa al primo rimasto.
- [ ] Un giocatore chiude la scheda in lobby: compare "disconnesso", sparisce dopo 1-2 minuti.
- [ ] Refresh della pagina in lobby: "Bentornato!", poi si torna nella sala con lo stesso nome.
- [ ] Entra in una stanza già avviata (link vecchio) → "partita già cominciata".

### 7.2 Avvio, turno, dadi
- [ ] L'host avvia: tutti vedono tabellone e pannelli, ognuno con 1.500 €; l'ordine di turno è casuale e uguale per tutti.
- [ ] Solo il giocatore di turno può lanciare: gli altri vedono i pulsanti disabilitati con la spiegazione.
- [ ] Doppio clic veloce su "Lancia i dadi": nessuna doppia mossa (M21: compare un toast d'errore).
- [ ] Le pedine si muovono casella per casella; con "riduci animazioni" attivo scattano subito.
- [ ] Doppio → si rilancia; tre doppi di fila → prigione senza muovere.

### 7.3 Acquisto e aste
- [ ] Casella libera: si apre il dialogo "Compra / Metti all'asta" solo per il giocatore di turno.
- [ ] Senza fondi sufficienti "Compra" è disabilitato e spiega quanto manca.
- [ ] "Metti all'asta": tutti i giocatori non falliti vedono il dialogo; offerta sotto il minimo e sopra il proprio denaro → errore; il miglior offerente non può passare; rilancio su sé stesso ammesso.
- [ ] Tutti passano senza offerte → la casella resta alla banca; un solo offerente → vince al prezzo offerto.
- [ ] Chiudi con Esc il dialogo dell'asta: resta il pulsante "Fai un'offerta" negli avvisi.

### 7.4 Affitti e Via
- [ ] Passare dal Via incassa 200 €; arrivare esattamente sul Via incassa 200 €; andare in prigione non li incassa.
- [ ] Affitto base, raddoppiato con gruppo completo senza case, con 1-4 case, con albergo; nessun affitto su ipotecata.
- [ ] Stazioni: 25/50/100/200 in base al numero. Società: 4× e 10× i dadi.
- [ ] L'aria-label delle caselle riporta proprietario, costruzioni e affitto corrente.

### 7.5 Costruzioni e ipoteche
- [ ] Senza gruppo completo "Costruisci" è disabilitato con motivo.
- [ ] Costruzione uniforme (non si può mettere la 2ª casa prima che le altre abbiano la 1ª); 4 case + 1 = albergo; con 32 case/12 alberghi finiti compare l'errore giusto.
- [ ] Vendita a metà prezzo; vendita dell'albergo (torna a 4 case).
- [ ] Ipoteca vietata con costruzioni nel gruppo; riscatto costa ipoteca + 10 %.
- [ ] Nessuna costruzione se una proprietà del gruppo è ipotecata.

### 7.6 Scambi
- [ ] Proposta con denaro, proprietà e carta prigione; il destinatario vede il dialogo, accetta → trasferimento corretto per entrambi.
- [ ] Rifiuto, ritiro da parte del proponente, seconda proposta mentre una è pendente (errore).
- [ ] Proprietà con costruzioni nel gruppo non selezionabile.
- [ ] Scambio con proprietà ipotecata: chi riceve paga subito il 10 %.
- [ ] Scambio durante un'asta: proposta vietata; rifiuto/ritiro possibile (M5).
- [ ] Il debitore propone uno scambio per raccogliere denaro e il debito si salda da solo all'accettazione.

### 7.7 Prigione e carte
- [ ] Casella "In prigione!", carta "Andate in prigione", tre doppi: pedina in cella, turno finito.
- [ ] Dalla prigione: doppio esce e muove; cauzione 50 €; carta "Uscite gratis"; terzo tentativo fallito paga 50 € e muove; incassi gli affitti anche da dentro.
- [ ] Pesca tutte le 32 carte (suggerimento: ripetere finché non sono uscite): soldi, "vai a" con e senza passaggio dal Via, "tre passi indietro" su Probabilità, "stazione più vicina" ×2 di affitto, "società più vicina" con nuovo lancio ×10, riparazioni per casa/albergo, compleanno (gli altri pagano 10 €), "pagate 50 € a ogni giocatore".
- [ ] La carta "Uscite gratis" esce dal mazzo finché non viene usata e poi rientra.

### 7.8 Debiti, bancarotta, fine partita
- [ ] Senza liquidità si apre il dialogo debito con il piano di vendite/ipoteche; dopo aver raccolto abbastanza il debito si salda da solo.
- [ ] "Dichiara bancarotta" visibile solo al debitore: verso un giocatore (beni, denaro, carte; ipotecate con 10 % pagato dal creditore) e verso la banca (le proprietà vanno all'asta una per volta).
- [ ] "Pagate 50 € a ogni giocatore" con più creditori e poco denaro: i debiti arrivano in coda in ordine.
- [ ] Bancarotta del giocatore di turno: il turno passa al successivo; il fallito può solo guardare.
- [ ] Ultimo giocatore rimasto → "Partita finita", classifica, "Nuova partita" riporta alla lobby.

### 7.9 Rete e riconnessione
- [ ] Refresh a metà turno (anche durante acquisto, asta, debito): stessa vista, dialogo riaperto, cronaca ricostruita.
- [ ] Spegni il Wi-Fi 20 s e riaccendi: banner "Connessione persa", poi "Connessione ripristinata"; nessuna azione eseguita due volte (M22).
- [ ] Chiudi la scheda del giocatore **di turno** e osserva gli altri: oggi la partita resta ferma (I1). Dopo la correzione deve ripartire entro la tolleranza e il giocatore deve poter rientrare.
- [ ] Chiudi la scheda di un giocatore durante un'asta e durante un suo debito (I1).
- [ ] Apri la stessa partita in due schede dello stesso browser (B1): deve restare attiva una sola scheda, senza loop.
- [ ] Riavvia il server a partita in corso: il client mostra "La partita salvata non è più disponibile" e torna al form.
- [ ] Cancella `sessionStorage` **e** `localStorage` a metà partita e ricarica: non si rientra (corretto: token perso) e gli altri vedono il giocatore disconnesso. (Con il codice attuale, cancellando solo `sessionStorage` la sessione torna da `localStorage`: è lo stesso difetto di B1.)
- [ ] Lascia una stanza inattiva oltre i tempi di pulizia (o abbassa `TEMPI` in locale): il client esce in modo pulito (M13).

### 7.10 Accessibilità
- [ ] Solo tastiera: Tab parte da "Salta al contenuto"; la griglia del tabellone è un solo punto di sosta (frecce, Home, End, PagUp/PagDown, `[` e `]`); Invio/Spazio aprono il dettaglio.
- [ ] Dialoghi: il focus entra, non esce (Tab/Maiusc+Tab), Esc chiude (tranne quelli non annullabili) e il focus torna al pulsante che li ha aperti.
- [ ] VoiceOver/NVDA: etichette delle caselle e dei pulsanti disabilitati (leggono il motivo), annunci di toast e cronaca senza doppioni (M20), errori del form annunciati (`role="alert"`).
- [ ] Zoom 200 % e testo ingrandito: nessuna sovrapposizione, nessuno scroll orizzontale.
- [ ] Tema scuro, `prefers-reduced-motion`, alto contrasto (Windows) e stampa.
- [ ] Contrasti: strumento del browser su pulsante primario della lobby (M18), distintivi, testo tenue, bordo dei campi, colori giocatore con iniziale.
- [ ] Daltonismo: proprietari e ipoteche riconoscibili anche senza colore (iniziale nel gettone, tratteggio, timbro).

### 7.11 Responsività
- [ ] 1920, 1440, 1280, 1024, 768, 390 px (anche in orizzontale): il tabellone resta quadrato e leggibile, i pannelli passano a schede e cassetto azioni sotto i 64 rem.
- [ ] Su telefono i bersagli sono ≥ 44 px, la pedina si distingue, i nomi brevi sulle caselle sono leggibili.
- [ ] La tastiera su schermo non copre l'input dell'asta.

### 7.12 Sicurezza di base
- [ ] Nome `<img src=x onerror=alert(1)>` (troncato a 16 caratteri: prova anche `<b>x</b>`): mostrato come testo ovunque (lobby, pannelli, cronaca, tabellone, dialoghi).
- [ ] Dalla console: `monopoly.conn.invia({tipo:'azione', azione:{tipo:'lanciaDadi'}})` quando non è il tuo turno → errore, stato invariato; messaggio di 17 KiB, JSON non valido ×3 → connessione chiusa; azione con `casella: -1`, `importo: 1e308`, `aId` di un fallito → errori del motore, nessun crash del server.
- [ ] `curl --path-as-is http://localhost:3000/../server/index.js` e `curl --path-as-is http://localhost:3000/%2e%2e/package.json` → 403/404 (senza `--path-as-is` è curl a normalizzare il percorso); `curl localhost:3000/salute` risponde.
- [ ] Il token non compare mai in `stato` né nelle risposte degli altri giocatori (controllare le frame WebSocket negli strumenti di sviluppo).
