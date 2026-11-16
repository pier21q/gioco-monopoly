# Monopoly online

Monopoly multigiocatore da giocare nel browser, da 2 a 6 giocatori. Chi ospita
avvia il server, crea una stanza e manda il link agli amici: ognuno entra dal
proprio browser, senza installare nulla e senza registrarsi.

Il server tiene lo stato della partita e applica le regole; i browser mostrano
il tabellone e inviano le mosse. Le partite vivono in memoria: se il server
viene riavviato, le partite in corso si perdono.

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

## Metterlo online (senza tenere acceso il computer)

Il file `render.yaml` descrive il servizio per [Render](https://render.com),
che ha un piano gratuito adatto a un gioco fra amici.

1. Il progetto deve stare su GitHub (`git push`).
2. Su Render: **New → Blueprint**, scegli il repository e conferma. Render
   legge `render.yaml`, installa e avvia il gioco.
3. A fine installazione Render mostra l'indirizzo pubblico, del tipo
   `https://gioco-monopoly.onrender.com`: è il link da aprire dal telefono e
   da mandare agli amici. I link d'invito delle stanze lo usano da soli.

Cosa sapere del piano gratuito:

- Dopo circa 15 minuti senza nessuno collegato il servizio si addormenta. Il
  primo che riapre il link aspetta fino a un minuto, poi tutto è normale.
  Finché almeno una pagina del gioco è aperta il servizio resta sveglio.
- Le partite vivono in memoria: quando il servizio si addormenta o viene
  aggiornato, le partite in corso si perdono.
- A ogni `git push` sul ramo collegato Render ripubblica da solo.

## Variabili d'ambiente

Nessuna è obbligatoria e nessuna è un segreto.

| Variabile | Predefinito | A cosa serve |
|---|---|---|
| `PORT` | `3000` | Porta su cui il server ascolta (HTTP e WebSocket). |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto. Con `127.0.0.1` il gioco è raggiungibile solo dal tuo computer. |
| `PUBLIC_URL` | l'indirizzo con cui il browser ha raggiunto il server | Base dei link d'invito, da impostare quando usi un tunnel o un dominio. |
| `ORIGINE_LIBERA` | non impostata | Con `1` disattiva il controllo dell'origine sulle connessioni WebSocket. Serve solo se un proxy riscrive l'host e i giocatori non riescono a collegarsi. |

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
`tests/` e di `server/gioco/test/`: dati del tabellone e delle carte, regole
del motore (movimento, affitti, costruzioni, carte, aste, scambi, debiti,
bancarotta, abbandono), gestione delle stanze e delle disconnessioni, e i test
di integrazione che avviano il server vero su una porta libera e ci parlano
via HTTP e WebSocket. I test di integrazione hanno bisogno di `npm install`.

Per un solo file: `node --test tests/motore-affitti.test.js`.

## Regole implementate

Il gioco segue il regolamento classico dell'edizione italiana, in euro.

- **Partenza.** Da 2 a 6 giocatori, 1.500 € a testa, ordine di turno sorteggiato.
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
  Chi crea la stanza può scegliere, prima di avviare, la variante **Solo dove
  ti fermi**: si costruisce su un colore solo nel turno in cui la propria
  pedina si ferma su una sua casella (e sempre solo con il gruppo completo).
- **Ipoteche.** Si incassa metà del prezzo; per riscattare si paga il valore
  d'ipoteca più il 10%. Non si ipoteca un terreno se nel gruppo ci sono case.
- **Scambi.** Denaro, proprietà senza costruzioni e carte "Uscite gratis di
  prigione". Chi riceve una proprietà ipotecata paga subito il 10% di
  interesse. Può esserci una sola proposta in attesa alla volta.
- **Probabilità e Imprevisti.** 16 carte per mazzo, mescolate a inizio partita.
- **Tasse.** Tassa patrimoniale 200 €, tassa di lusso 100 €.
- **Prigione.** Si esce con un doppio (tre tentativi), pagando 50 € o usando
  la carta. Al terzo tentativo fallito si pagano i 50 € e si esce. Anche dalla
  prigione si incassano gli affitti.
- **Debiti e bancarotta.** Il denaro non va mai sotto zero: chi non può pagare
  deve vendere case, ipotecare o scambiare. Se non basta dichiara bancarotta e
  i suoi beni passano al creditore; se il creditore è la banca, le proprietà
  vanno all'asta.
- **Fine partita.** Vince l'ultimo giocatore rimasto.

Cose che funzionano in modo diverso dal gioco da tavolo:

- Sul Parcheggio gratuito non succede nulla (nessun "piatto" con le tasse).
- Si costruisce, si vende, si ipoteca e si riscatta solo nel proprio turno,
  oltre che per saldare un proprio debito o durante un'asta a cui si partecipa.
- Se la banca non ha 4 case da restituire, un albergo si vende per intero.
- **Abbandona la partita** equivale a una bancarotta volontaria: le proprietà
  tornano alla banca e vanno all'asta.
- Chi perde la connessione resta in partita e può rientrare ricaricando la
  pagina. Se è il suo turno e non torna entro 45 secondi, il turno passa (lo
  stesso vale per un'asta in corso). Se ha un debito aperto e resta assente per
  3 minuti viene dichiarato in bancarotta, così gli altri non restano bloccati.

Il dettaglio di ogni regola, con i casi limite, è nel capitolo 8 di
`INTERFACCE.md`.

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
dall'alto e accendono o spengono l'inseguimento della pedina di turno. Le
scelte restano salvate nel browser.

## Struttura delle cartelle

```
package.json          script npm e dipendenza ws
Avvia Monopoly.command  doppio clic per avviare il gioco su Mac
render.yaml           configurazione per pubblicarlo su Render
INTERFACCE.md         contratti fra motore, server e client (stato, azioni, protocollo)
REVISIONE.md          revisione del codice fatta prima dell'integrazione
server/
  index.js            server HTTP (file statici, /dati/*.js, /salute) e WebSocket su /ws
  stanze.js           stanze, giocatori, token di sessione, disconnessioni
  protocollo.js       messaggi, limiti, codici d'errore e validazione
  gioco/
    motore.js         regole del gioco: creaPartita e applicaAzione (funzioni pure)
    nucleo.js         pagamenti, debiti, aste, turni
    scambi.js         proposte di scambio
    bancarotta.js     liquidazione di chi fallisce
    errori.js         codici e messaggi d'errore del motore
    tabellone.js      le 40 caselle, i gruppi, prezzi e affitti
    carte.js          Probabilità e Imprevisti
    test/             test delle regole del motore
client/               pagine servite al browser, senza build
  index.html
  css/                base.css, tabellone.css, pannelli.css, tema.css
  js/
    app.js            avvio, stato locale, smistamento dei messaggi
    rete.js           WebSocket con riconnessione automatica
    lobby.js          schermata iniziale e sala d'attesa
    tabellone.js      tabellone 3D, camera, pedine, dadi
    pannelli.js       giocatori, azioni del turno, cronaca
    dialoghi.js       finestre di dialogo (acquisto, asta, scambio, debito…) e notifiche
tests/                test del server, delle stanze e di integrazione
```

I dati di `tabellone.js` e `carte.js` sono scritti una sola volta sul server,
che li espone al browser come moduli (`/dati/tabellone.js`, `/dati/carte.js`).
