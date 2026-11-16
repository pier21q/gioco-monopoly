# Monopoly online

Monopoly multigiocatore da giocare nel browser, da 2 a 6 giocatori. Chi ospita
avvia il server, crea una stanza e manda il link agli amici: ognuno entra dal
proprio browser, senza installare nulla e senza registrarsi.

Il server tiene lo stato della partita e applica le regole; i browser mostrano
il tabellone e inviano le mosse. Le partite vivono in memoria e vengono
salvate ogni pochi secondi in `.partite/partite.json`: se riavvii il server sul
tuo computer, le partite ripartono da dove erano e ognuno rientra ricaricando
la pagina. Su Render gratuito il disco si azzera, quindi lì il salvataggio non
aiuta (vedi "Metterlo online").

## Requisiti

- [Node.js](https://nodejs.org/) 20 o successivo (comprende `npm`).
- Un browser recente (Chrome, Edge, Firefox, Safari) per ogni giocatore.

Il progetto ha una sola dipendenza, `ws`, per i WebSocket. Non ci sono passaggi
di build.

## Installazione

```bash
npm install
```

## Avvio

Su Mac basta un doppio clic su **Avvia Monopoly.command** nella cartella del
progetto: accende il gioco e apre il browser. Finché la finestra del Terminale
resta aperta il gioco è acceso; chiudila per spegnerlo. La prima volta macOS
può chiedere conferma: tasto destro sul file, poi **Apri**.

Da terminale:

```bash
npm start
```

All'avvio il server stampa gli indirizzi da cui è raggiungibile, per esempio:

```
Monopoly online v0.1.0 in ascolto sulla porta 3000
Su questo computer:        http://localhost:3000
Amici sulla stessa rete:   http://192.168.1.20:3000
```

Apri l'indirizzo nel browser, scrivi il tuo nome e premi **Crea una stanza**.
Per fermare il server premi `Ctrl+C`.

Di norma il server accetta connessioni da tutta la rete locale (`HOST=0.0.0.0`):
serve per giocare con gli amici sullo stesso Wi-Fi, ma su una rete pubblica
(bar, treno, albergo) chiunque su quella rete può aprire il gioco e creare
stanze. Lì avvialo con `HOST=127.0.0.1 npm start`: il server lo conferma
all'avvio e non stampa indirizzi di rete.

## Come condividere il link con gli amici

Nella sala d'attesa compaiono il codice della stanza (6 caratteri) e il link
d'invito, del tipo `http://192.168.1.20:3000/?stanza=K7PQ2M`. Con **Copia
link** lo copi negli appunti; chi lo apre trova il codice già compilato e deve
solo scrivere il nome. Quando ci sono almeno due giocatori, chi ha creato la
stanza preme **Avvia la partita**.

Il link contiene l'indirizzo con cui *tu* hai aperto il gioco, quindi conta da
dove lo apri:

- **Amici sulla stessa rete (stesso Wi-Fi).** Apri il gioco dall'indirizzo di
  rete stampato all'avvio (`http://192.168.x.y:3000`), non da `localhost`: un
  link con `localhost` funziona solo sul tuo computer, e la sala d'attesa ti
  avvisa se succede. Se gli amici non riescono a collegarsi, controlla che il
  firewall del computer lasci passare la porta.
- **Amici via Internet.** Serve un indirizzo pubblico. La strada più semplice
  è un tunnel, per esempio `cloudflared tunnel --url http://localhost:3000`
  oppure `ngrok http 3000`: il programma ti dà un indirizzo `https://…`. Avvia
  il server indicandolo in `PUBLIC_URL`, così i link d'invito lo usano:

  ```bash
  PUBLIC_URL=https://il-tuo-indirizzo.example npm start
  ```

- **Hosting.** Su un servizio che esegue applicazioni Node basta `npm start`;
  la porta viene letta da `PORT`. Il servizio deve supportare i WebSocket.
  Vedi il capitolo qui sotto per farlo gratis con Render.

Ogni scheda del browser è un giocatore distinto: per provare da solo puoi
aprire il link in più schede. Se ricarichi la pagina rientri al tuo posto da
solo. Se chiudi la scheda per sbaglio, riapri il link dallo stesso browser:
in alto compare il pulsante **Riprendi la partita**, che ti riporta al tuo
posto (vale per l'ultima partita a cui sei entrato da quel browser).

## Host e admin

Chiunque può creare stanze: chi la crea ne è l'**host**. L'host sceglie le
regole e avvia la partita (vedi «Regole della partita» qui sotto) e, dal
pulsante **Gestisci la stanza** in alto, può:

- **Togli dalla stanza** accanto a ogni giocatore. In sala d'attesa chi viene
  tolto esce, ma con il link d'invito potrebbe rientrare: avvia la partita
  quando ci sono tutti. In partita esce come se avesse abbandonato (proprietà
  alla banca e all'asta) e non può più rientrare;
- **Chiudi la stanza**: escono tutti e la partita finisce.

Se l'host lascia la sala d'attesa, o in partita fa bancarotta, il ruolo passa
al giocatore successivo.

In più c'è un **admin**, tu, con un link personale. Con quel link:

- in qualunque stanza in cui entri diventi tu l'host, anche se l'ha creata un
  amico, e lo resti finché ci sei (anche se fai bancarotta); il pulsante si
  chiama **Admin**;
- l'admin di una stanza è uno solo: il primo che entra con il link. Se entri
  con il link in un'altra scheda o da un altro dispositivo mentre c'è già un
  admin nella stanza, entri come giocatore normale;
- nella finestra **Admin** il pulsante **Cedi admin** passa il ruolo (admin e
  host) a un altro giocatore; da quel momento il tuo link non te lo ridà
  finché lui resta nella stanza;
- nessuno ti può togliere dalla stanza;
- non hai i limiti di stanze per connessione e per indirizzo.

Dove trovare il link:

- **Online (Render):** la chiave la genera Render. Nel pannello di Render apri
  il servizio `gioco-monopoly`, poi **Environment**, e copia il valore di
  `ADMIN_CHIAVE`. Il link è
  `https://gioco-monopoly.onrender.com/#admin=` seguito dalla chiave.
- **Sul tuo computer:** all'avvio il server stampa «Il tuo link da admin».
  La chiave sta in `.partite/chiave-admin` (esclusa da git); per sceglierla tu
  imposta `ADMIN_CHIAVE`.

Basta aprire il link una volta: il browser se lo ricorda e toglie la chiave
dalla barra degli indirizzi. Non condividerlo: chi ce l'ha è admin come te.
Per cambiare la chiave, su Render modifica `ADMIN_CHIAVE` (il vecchio link
smette di funzionare); in locale cancella `.partite/chiave-admin`.

## Regole della partita

Prima di avviare, chi guida la stanza (l'host, oppure l'admin quando c'è)
compila la finestra **Regole della partita**: il pulsante **Scegli le regole e
avvia** della sala d'attesa la apre, e senza passare di lì la partita non
parte (il server rifiuta l'avvio con `REGOLE_DA_IMPOSTARE`). Con **Salva le
regole** le si sceglie senza avviare: gli altri le vedono subito nella sala
d'attesa, con le varianti evidenziate. Si possono cambiare fino all'avvio, e il
browser ricorda le ultime scelte per la stanza successiva. In partita il
pulsante **Regole** in alto le mostra a tutti.

| Regola | Scelte (in grassetto la classica) |
|---|---|
| Denaro iniziale | 1.000 €, **1.500 €**, 2.000 €, 2.500 € |
| Proprietà all'inizio | **nessuna**, 1, 2 o 3 a testa: estratte a caso, gratis, mai un colore completo (per velocizzare l'inizio) |
| Come si costruisce | **quando vuoi**, oppure solo dove ti fermi |
| Proprietà non comprate | **vanno all'asta**, oppure restano alla banca |
| Parcheggio gratuito | **non succede niente**, oppure si vince il piatto: tasse, carte da pagare alla banca e cauzioni finiscono nel piatto, e chi si ferma sul Parcheggio lo incassa |
| Fermarsi sul Via | **200 €**, oppure 400 € se ci si ferma proprio sopra |
| Affitti dalla prigione | **si riscuotono**, oppure niente affitti finché si è dentro |

Il catalogo delle regole (titoli, spiegazioni, valori ammessi) è in
`server/gioco/regole.js`, che il browser riceve come `/dati/regole.js`.

## Chi comincia

La partita comincia con il lancio iniziale: tutti lanciano i due dadi, uno alla
volta, partendo dal primo della sala d'attesa. Chi fa di più gioca per primo,
poi gli altri in ordine di punteggio. Chi pareggia rilancia, ma solo contro chi
ha fatto il suo stesso punteggio e solo per i posti in palio: se Bruno, Carla e
Dario fanno tutti 5 dietro ad Anna, rilanciano solo loro tre per il 2°, 3° e 4°
posto, e se Bruno e Carla pareggiano di nuovo rilanciano solo loro due. Si va
avanti finché l'ordine è completo. Una finestra **Chi comincia?** mostra a
tutti i lanci e i posti provvisori.

Chi non lancia entro 60 secondi, o è disconnesso da più di 45, lancia in
automatico (lo fa il gioco al posto suo). Chi abbandona in questa fase esce
dall'ordine e le sue proprietà tornano alla banca, senza aste.

## Metterlo online (senza tenere acceso il computer)

Il file `render.yaml` descrive il servizio per [Render](https://render.com),
che ha un piano gratuito adatto a un gioco fra amici.

1. Il progetto deve stare su GitHub (`git push`).
2. Su Render: **New → Blueprint**, scegli il repository e conferma. Render
   legge `render.yaml`, installa e avvia il gioco.
3. A fine installazione Render mostra l'indirizzo pubblico, del tipo
   `https://gioco-monopoly.onrender.com`: è il link da aprire dal telefono e
   da mandare agli amici. I link d'invito delle stanze lo usano da soli.

**Quando si ripubblica.** `render.yaml` dice a Render di pubblicare solo il
ramo `pubblicazione`, non quello su cui lavori: così salvare il lavoro su
GitHub non interrompe le partite in corso. Per mettere online la versione
attuale, quando nessuno sta giocando:

```bash
git push origin HEAD:pubblicazione
```

La prima volta questo comando crea il ramo `pubblicazione` su GitHub: fallo
*prima* di caricare su GitHub il `render.yaml` che lo nomina, altrimenti
Render cerca un ramo che non c'è e la pubblicazione fallisce (quella già
online resta in piedi).

Cosa sapere del piano gratuito:

- Dopo circa 15 minuti senza traffico il servizio si addormenta. Il primo che
  riapre il link aspetta fino a un minuto, poi tutto è normale. Una pagina del
  gioco aperta **e in primo piano** lo tiene sveglio (ogni 4 minuti chiede
  `/salute` al server); una scheda in background o un telefono con lo schermo
  spento no.
- Quando il servizio si addormenta o viene ripubblicato, le partite in corso
  si perdono: il disco di Render gratuito si azzera, quindi il salvataggio su
  file lì non serve.
- Render passa le richieste attraverso un suo proxy: il server lo riconosce
  (variabile `RENDER`) e legge l'indirizzo del giocatore da `X-Forwarded-For`.

## Variabili d'ambiente

Nessuna è obbligatoria. L'unica segreta è `ADMIN_CHIAVE`.

| Variabile | Predefinito | A cosa serve |
|---|---|---|
| `PORT` | `3000` | Porta su cui il server ascolta (HTTP e WebSocket). |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto. Con `127.0.0.1` il gioco è raggiungibile solo dal tuo computer. |
| `PUBLIC_URL` | l'indirizzo con cui il browser ha raggiunto il server | Base dei link d'invito, da impostare quando usi un tunnel o un dominio. |
| `ORIGINE_LIBERA` | non impostata | Con `1` disattiva il controllo dell'origine sulle connessioni WebSocket. Serve solo se un proxy riscrive l'host e i giocatori non riescono a collegarsi. |
| `PROXY_FIDATO` | `1` su Render, altrimenti non impostata | Con `1` il server crede alle intestazioni `X-Forwarded-For`/`-Host`/`-Proto` (indirizzo del giocatore, host pubblico). Impostala quando il server sta dietro un tunnel o un proxy; senza proxy lasciala spenta, perché quelle intestazioni le potrebbe scrivere chiunque. `0` la spegne anche su Render. |
| `ADMIN_CHIAVE` | generata da Render; in locale `.partite/chiave-admin` | Chiave del link da admin (16–128 caratteri). **Questa è un segreto**: non metterla su GitHub. |
| `SALVATAGGIO` | `.partite/partite.json` | File in cui salvare le partite. `0` disattiva il salvataggio. Il file contiene i token di sessione dei giocatori: viene creato leggibile solo da te ed è escluso da git. |

Esempio:

```bash
PORT=8080 npm start
```

Su Windows (PowerShell): `$env:PORT=8080; npm start`.

## Test

```bash
npm test
```

Esegue con il test runner di Node (`node --test`) tutti i file `*.test.js` di
`tests/`: dati del tabellone e delle carte, regole del motore (movimento,
affitti, costruzioni, carte, aste, scambi, debiti, bancarotta, abbandono),
stanze, disconnessioni e inattività, salvataggio su file, difese del server
(limiti per indirizzo, origine, nomi), e i test di integrazione che avviano il
server vero su una porta libera e ci parlano via HTTP e WebSocket. I test di
integrazione hanno bisogno di `npm install`.

`tests/client.test.js` carica in Node i moduli del browser e ne prova le
funzioni pure; fra l'altro confronta, su migliaia di stati di partite giocate a
caso, le spiegazioni dei pulsanti del client con le risposte del motore. Serve
Node 22.15 o successivo: con un Node più vecchio quei test vengono saltati. La
grafica (tabellone 3D, animazioni, finestre) non ha test automatici e va
provata nel browser.

Per un solo file: `node --test tests/motore-affitti.test.js`.

## Regole implementate

Il gioco segue il regolamento classico dell'edizione italiana, in euro.

- **Partenza.** Da 2 a 6 giocatori, 1.500 € a testa (o quanto scelto nelle
  regole). L'ordine di turno lo decide il lancio iniziale dei dadi, con gli
  spareggi (vedi «Chi comincia»).
- **Turno.** Si lanciano due dadi. Con un doppio si rilancia; al terzo doppio
  di fila si va in prigione.
- **Via.** 200 € ogni volta che si passa o si arriva sul Via.
- **Acquisti.** Chi arriva su una proprietà libera può comprarla al prezzo di
  listino; se rinuncia, la proprietà va all'asta.
- **Aste.** Partecipano tutti i giocatori in gara, anche chi ha rinunciato.
  Ogni offerta deve superare la precedente; chi passa esce dall'asta.
- **Affitti.** Terreni: affitto base, raddoppiato con il gruppo completo senza
  case, poi secondo case e albergo. Stazioni: 25, 50, 100 o 200 € secondo
  quante ne ha il proprietario. Società: 4 o 10 volte il lancio dei dadi.
  Sulle proprietà ipotecate non si paga.
- **Case e alberghi.** Si costruisce solo con il gruppo completo e senza
  ipoteche nel gruppo, in modo uniforme. L'albergo sostituisce 4 case. La banca
  ha 32 case e 12 alberghi. Le costruzioni si rivendono a metà prezzo.
  Nelle regole della partita si può scegliere la variante **Solo dove
  ti fermi**: si costruisce su un colore solo nel turno in cui la propria
  pedina si ferma su una sua casella (e sempre solo con il gruppo completo).
  Vale ogni sosta del turno: chi fa un doppio, si ferma su un suo colore e poi
  rilancia può costruire su quel colore fino alla fine del turno.
- **Ipoteche.** Si incassa metà del prezzo; per riscattare si paga il valore
  d'ipoteca più il 10%. Non si ipoteca un terreno se nel gruppo ci sono case.
- **Scambi.** Denaro, proprietà senza costruzioni e carte "Uscite gratis di
  prigione". Chi riceve una proprietà ipotecata paga subito il 10% di
  interesse. Può esserci una sola proposta in attesa alla volta.
- **Probabilità e Imprevisti.** 16 carte per mazzo, mescolate a inizio partita.
- **Tasse.** Tassa patrimoniale 200 €, tassa di lusso 100 €.
- **Prigione.** Si esce con un doppio (tre tentativi), pagando 50 € o usando
  la carta. Al terzo tentativo fallito si pagano i 50 € e si esce. Anche dalla
  prigione si incassano gli affitti, salvo la variante «Niente affitti».
- **Debiti e bancarotta.** Il denaro non va mai sotto zero: chi non può pagare
  deve vendere case, ipotecare o scambiare. Se non basta dichiara bancarotta e
  i suoi beni passano al creditore; se il creditore è la banca, le proprietà
  vanno all'asta.
- **Fine partita.** Vince l'ultimo giocatore rimasto.

Cose che funzionano in modo diverso dal gioco da tavolo:

- Il "piatto" del Parcheggio gratuito, il Via a 400 €, gli affitti negati dalla
  prigione e le proprietà che restano alla banca sono varianti facoltative,
  spente se non le si sceglie (vedi «Regole della partita»).
- Si costruisce, si vende, si ipoteca e si riscatta solo nel proprio turno,
  oltre che per saldare un proprio debito o durante un'asta a cui si partecipa.
- Se la banca non ha 4 case da restituire, un albergo si vende per intero.
- **Abbandona la partita** equivale a una bancarotta volontaria: le proprietà
  tornano alla banca e vanno all'asta.
- Chi perde la connessione resta in partita e può rientrare ricaricando la
  pagina. Se è il suo turno e non torna entro 45 secondi, il turno passa (lo
  stesso vale per un'asta in corso). Se ha un debito aperto e resta assente per
  3 minuti viene dichiarato in bancarotta, così gli altri non restano bloccati.
- Anche chi resta collegato ma non gioca ha un tempo massimo: 3 minuti per il
  proprio turno (poi rinuncia all'acquisto o salta il turno), 60 secondi per
  rispondere in un'asta (poi passa), 5 minuti per saldare un debito (poi
  bancarotta). Trenta secondi prima compare un avviso. Riconnettersi non fa
  ripartire il tempo; qualunque mossa sì. Dopo due giri interi di turni saltati
  senza che nessuno giochi, la partita smette di avanzare da sola e aspetta.

Il dettaglio di ogni regola, con i casi limite, è nel capitolo 8 di
`INTERFACCE.md`.

## Limiti contro gli abusi

Il gioco non ha account: per tenerlo utilizzabile anche con un link pubblico il
server limita quello che una persona sola può fare.

- Al massimo 20 connessioni contemporanee e 10 stanze aperte per indirizzo IP,
  5 stanze per connessione, 200 stanze in tutto.
- Una stanza in cui non entra nessuno si chiude dopo 2 minuti. Se le 200 stanze
  sono tutte occupate, chi ne crea una nuova fa chiudere la stanza vuota più
  vecchia: si viene rifiutati solo se tutte e 200 hanno giocatori dentro.
- Nomi senza caratteri invisibili (spazi a larghezza zero, inversione del
  verso del testo): non si può entrare con un nome che sembra quello di un
  altro.

Dietro un proxy (Render, tunnel) l'indirizzo del giocatore arriva
dall'intestazione `X-Forwarded-For`, che un client malintenzionato può
riempire a piacere: lì i limiti per indirizzo sono di buona volontà. Restano
comunque il tetto alle stanze e la regola delle stanze vuote, che impediscono
di bloccare il gioco a chi arriva.

## Accessibilità

Tutto il gioco si usa da tastiera. Il primo Tab porta a "Salta al contenuto
principale"; il tabellone è un unico punto di sosta e ci si muove con le
frecce (Home, Fine, Pagina su/giù per saltare), Invio o Spazio aprono il
contratto della casella. Le finestre di dialogo trattengono il focus, si
chiudono con Esc e lo restituiscono al pulsante da cui sono partite. I pulsanti
non disponibili restano raggiungibili e spiegano perché non si possono usare.
Proprietari e ipoteche si distinguono anche senza il colore. L'interfaccia ha
un solo tema (il tavolo verde) e rispetta la riduzione delle animazioni e
l'alto contrasto.

## Il tabellone 3D

Il tabellone è un oggetto 3D fatto con le trasformazioni CSS, senza librerie:
piano inclinato, pedine, case e alberghi in piedi, dadi a cubo. I pulsanti in
alto a sinistra girano il tabellone di un lato, avvicinano il lato davanti (su
telefono è già così, e si scorre trascinando di lato), passano alla vista
dall'alto, accendono o spengono l'inseguimento della pedina di turno, le
**animazioni veloci** (pedine e camera più rapide) e i suoni. Le scelte restano
salvate nel browser.

Le conseguenze di un lancio (finestra d'acquisto, messaggi, denaro, carta
pescata) compaiono solo quando i dadi si sono fermati e la pedina è arrivata
sulla casella. La carta pescata resta al centro 8 secondi (un clic la mette
via prima); il denaro che sale dalla pedina ha il pallino del suo colore. I
messaggi a comparsa sono al massimo tre, colorati per tipo (rosso gli avvisi
urgenti come i 30 secondi d'inattività), e su schermi larghi stanno sopra il
tabellone, non sopra il pannello del turno. I suoni (dadi, passi, monete, carte) sono sintetizzati nel
browser da `client/js/suoni.js`: non ci sono file audio.

Il tabellone si muove con le dita:

- **un dito** (o il mouse) trascinato di lato lo fa **girare** liberamente;
  lasciandolo vicino a un lato si raddrizza da solo. In verticale, con un
  dito, la pagina scorre come sempre;
- **due dita** lo **avvicinano e allontanano** (da 1 a 3,2 volte) e lo
  spostano. Sul trackpad vale il pizzico; col mouse, Maiusc + trascina sposta;
- i pulsanti restano: giro di un quarto, "Avvicina" (che riporta anche lontano
  dopo uno zoom fatto con le dita), vista dall'alto (lì un dito sposta invece
  di girare);
- se "Segui la pedina di turno" è acceso, la vista torna sulla pedina quando
  cambia il turno o la pedina si muove, non a ogni aggiornamento.

I pezzi si toccano:

- **i dadi al centro del tabellone**: quando tocca a te lanciare si alzano e
  compare "Tocca i dadi"; un clic vale come il pulsante "Lancia i dadi" (che
  resta, anche per chi usa la tastiera);
- **le proprietà di un giocatore**: passando col mouse sulla sua scheda nel
  pannello (o entrandoci con Tab) le sue caselle si accendono del suo colore
  e le altre si abbassano;
- **il denaro**: nel pannello non scatta, scorre fino al nuovo importo (verde
  se sale, rosso se scende);
- **i dadi sopra il titolo**, all'ingresso: si lanciano con un clic, solo per
  gioco.

Le pedine sono birilli laccati (base a disco, corpo a campana, collare, testa
a sfera con l'iniziale del giocatore): un solo disegno SVG nel colore del
giocatore, con luci e ombre sovrapposte.

Sul telefono, con i suoni accesi, l'inizio del tuo turno dà anche un colpetto
di vibrazione (dove il browser lo permette). Il nome del giocatore non viene
salvato nel browser: a ogni apertura il campo è vuoto; resta salvato solo il
colore della pedina.

## Struttura delle cartelle

```
package.json          script npm e dipendenza ws
Avvia Monopoly.command  doppio clic per avviare il gioco su Mac
render.yaml           configurazione per pubblicarlo su Render
INTERFACCE.md         contratti fra motore, server e client (stato, azioni, protocollo)
REVISIONE.md          revisione storica (fase 3 dello sviluppo): superata, non descrive il codice attuale
server/
  index.js            server HTTP (file statici, /dati/*.js, /salute) e WebSocket su /ws
  stanze.js           stanze, giocatori, token di sessione, disconnessioni
  protocollo.js       messaggi, limiti, codici d'errore e validazione
  salvataggio.js      salvataggio delle partite su file e ripristino all'avvio
  gioco/
    motore.js         regole del gioco: creaPartita e applicaAzione (funzioni pure)
    ordine.js         lancio iniziale per decidere chi comincia, con gli spareggi
    regole.js         catalogo delle regole scelte prima di avviare (anche /dati/regole.js)
    nucleo.js         pagamenti, debiti, aste, turni
    scambi.js         proposte di scambio
    bancarotta.js     liquidazione di chi fallisce
    errori.js         codici e messaggi d'errore del motore
    tabellone.js      le 40 caselle, i gruppi, prezzi e affitti
    carte.js          Probabilità e Imprevisti
client/               pagine servite al browser, senza build
  index.html
  css/                base.css, tabellone.css, pannelli.css, tema.css
  js/
    app.js            avvio, stato locale, smistamento dei messaggi
    rete.js           WebSocket con riconnessione automatica
    lobby.js          schermata iniziale e sala d'attesa
    tabellone.js      tabellone 3D, camera, pedine, dadi, animazioni
    suoni.js          suoni sintetizzati (Web Audio), senza file audio
    pannelli.js       giocatori, azioni del turno, cronaca
    dialoghi.js       finestre di dialogo (acquisto, asta, scambio, debito…) e notifiche
tests/                tutti i test: motore, server, stanze, sicurezza, salvataggio, client
```

I dati di `tabellone.js` e `carte.js` sono scritti una sola volta sul server,
che li espone al browser come moduli (`/dati/tabellone.js`, `/dati/carte.js`).
