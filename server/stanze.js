'use strict';

/**
 * server/stanze.js
 *
 * Registro in memoria delle stanze di gioco: creazione con codice a 6
 * caratteri, ingresso/uscita dei giocatori in lobby, token di riconnessione,
 * avvio della partita e applicazione delle azioni tramite il motore.
 * Contratto in INTERFACCE.md §3.6. Il registro vive in memoria; a scriverlo su
 * file ci pensa server/salvataggio.js, tramite `esporta`/`importa`.
 *
 * I token e i socket vivono solo qui, mai nello StatoPartita.
 *
 * Timer per i giocatori scollegati in partita: dopo 45 secondi chi blocca il
 * gioco viene fatto avanzare e l'host (se non è l'admin) cede il ruolo a un
 * collegato; dopo 5 minuti di assenza abbandona d'ufficio. In più c'è un timer
 * d'inattività per stanza: se chi deve agire (giocatore di turno, partecipanti
 * all'asta, debitore) non lo fa entro TEMPI.INATTIVITA_*, il server fa avanzare
 * la partita per lui, con un preavviso 30 secondi prima. Uno scambio senza
 * risposta scade dopo TEMPI.SCAMBIO_MS.
 */

const crypto = require('node:crypto');
const P = require('./protocollo');
const motore = require('./gioco/motore');
const REGOLE = require('./gioco/regole');
const N = require('./gioco/nucleo');

const registro = new Map(); // codice → Stanza

const TEMPI = Object.freeze({
  RIMOZIONE_LOBBY_DISCONNESSO_MS: 60 * 1000,
  // In partita: dopo questa tolleranza un disconnesso che blocca il gioco
  // viene fatto avanzare dal motore (turno passato, asta passata, scambio annullato).
  TOLLERANZA_DISCONNESSIONE_MS: 45 * 1000,
  // Un debitore disconnesso da così a lungo viene dichiarato in bancarotta d'ufficio.
  BANCAROTTA_DISCONNESSO_MS: 3 * 60 * 1000,
  // Chi resta scollegato così a lungo mentre qualcun altro è collegato e
  // aspetta abbandona d'ufficio (azione `abbandona`): la partita non resta appesa.
  ABBANDONO_DISCONNESSO_MS: 5 * 60 * 1000,
  // Una proposta di scambio a cui nessuno risponde scade da sola.
  SCAMBIO_MS: 90 * 1000,
  // Sala d'attesa con un solo giocatore in cui non succede nulla.
  LOBBY_SOLITARIA_MS: 30 * 60 * 1000,
  STANZA_VUOTA_MS: 10 * 60 * 1000,
  // Stanza creata ma in cui non è mai entrato nessuno.
  STANZA_MAI_USATA_MS: 2 * 60 * 1000,
  STANZA_INATTIVA_MS: 2 * 60 * 60 * 1000,
  FINE_PARTITA_MS: 30 * 60 * 1000,
  // Giocatori connessi che non agiscono: dopo questi tempi la partita va avanti da sola.
  INATTIVITA_TURNO_MS: 3 * 60 * 1000,
  INATTIVITA_ASTA_MS: 60 * 1000,
  // Lancio iniziale per decidere chi comincia: basta un clic, si aspetta meno.
  INATTIVITA_ORDINE_MS: 60 * 1000,
  INATTIVITA_DEBITO_MS: 5 * 60 * 1000,
  PREAVVISO_INATTIVITA_MS: 30 * 1000,
});

/** Chiave dei timer che riguardano la stanza intera (gli id giocatore sono [a-z0-9]{8}). */
const ID_STANZA = '_stanza';
/** Chiave del timer di scadenza dello scambio in attesa. */
const ID_SCAMBIO = '_scambio';

/** Numero casuale in [0, 1) da crypto: codici stanza, dadi e mazzi non prevedibili. */
function casualeSicuro() {
  return crypto.randomInt(0, 2 ** 47) / 2 ** 47;
}

// ---------------------------------------------------------------------------
// Timer per giocatore (lobby, tolleranza, bancarotta d'ufficio)
// ---------------------------------------------------------------------------

/** Annulla i timer di un giocatore (o di tutti, senza giocatoreId). */
function annullaTimer(stanza, giocatoreId) {
  if (!stanza || !stanza.timer) return;
  for (const [chiave, t] of [...stanza.timer]) {
    if (giocatoreId === undefined || chiave.startsWith(`${giocatoreId}|`)) {
      clearTimeout(t);
      stanza.timer.delete(chiave);
    }
  }
}

/** Programma `fn` dopo `ms`; il timer non tiene vivo il processo (test, arresto). */
function programmaTimer(stanza, giocatoreId, nome, ms, fn) {
  const chiave = `${giocatoreId}|${nome}`;
  if (stanza.timer.has(chiave)) clearTimeout(stanza.timer.get(chiave));
  const t = setTimeout(() => {
    stanza.timer.delete(chiave);
    if (stanza.chiusa) return;
    try {
      fn();
    } catch (e) {
      console.error('[stanze] errore nel timer', nome, stanza.codice, e);
    }
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  stanza.timer.set(chiave, t);
}

// ---------------------------------------------------------------------------
// Generatori
// ---------------------------------------------------------------------------

function generaCodice(random = casualeSicuro) {
  const alfabeto = P.ALFABETO_CODICE;
  for (let tentativo = 0; tentativo < 1000; tentativo += 1) {
    let codice = '';
    for (let i = 0; i < P.LIMITI.CODICE_LUNGHEZZA; i += 1) {
      codice += alfabeto[Math.floor(random() * alfabeto.length)];
    }
    if (!registro.has(codice)) return codice;
  }
  throw new Error('Impossibile generare un codice stanza libero');
}

/** 8 caratteri [a-z0-9]. */
function generaId() {
  const n = crypto.randomBytes(8).readBigUInt64BE();
  return n.toString(36).padStart(8, '0').slice(-8);
}

/** 32 caratteri hex, segreto del singolo client. */
function generaToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** Confronto a tempo costante tra due token esadecimali di 32 caratteri. */
function tokenUguali(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function errore(codice, dettagli) {
  const out = { codice, messaggio: P.ERRORI[codice] || codice };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return { errore: out };
}

function evento(tipo, giocatoreId, testo, dati, t) {
  return { t, tipo, giocatoreId: giocatoreId ?? null, testo, dati: dati || {} };
}

// ---------------------------------------------------------------------------
// Sincronizzazione lobby → stato
// ---------------------------------------------------------------------------

/** Ricostruisce lo stato di lobby dai giocatori della stanza e accoda gli eventi. */
function sincronizzaLobby(stanza, eventi, t) {
  const precedente = stanza.stato;
  const nuovo = motore.creaStatoLobby({
    codice: stanza.codice,
    hostId: stanza.hostId,
    giocatori: [...stanza.giocatori.values()],
    ora: () => t,
  });
  nuovo.creataIl = stanza.creataIl;
  // Le regole scelte in sala d'attesa restano anche quando entra o esce qualcuno.
  if (precedente && precedente.regoleImpostate) {
    nuovo.regole = { ...precedente.regole };
    nuovo.regoleImpostate = true;
  }
  nuovo.versione = (precedente ? precedente.versione : 0) + 1;
  nuovo.log = [...(precedente ? precedente.log : []), ...eventi].slice(-P.LIMITI.LOG_MAX);
  stanza.stato = nuovo;
  stanza.aggiornataIl = t;
}

/** In partita: aggiorna solo il flag `connesso` del giocatore nello stato. */
function sincronizzaConnessione(stanza, giocatoreId, connesso, eventi, t) {
  const stato = structuredClone(stanza.stato);
  const g = stato.giocatori.find((x) => x.id === giocatoreId);
  if (g) g.connesso = connesso;
  stato.versione += 1;
  stato.aggiornataIl = t;
  stato.log = [...stato.log, ...eventi].slice(-P.LIMITI.LOG_MAX);
  stanza.stato = stato;
  stanza.aggiornataIl = t;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Crea una stanza vuota in lobby e la registra. `ip` è l'indirizzo di chi la
 * crea, per il limite di stanze aperte per indirizzo (index.js).
 */
function crea({ ora = Date.now, random = casualeSicuro, ip = null } = {}) {
  const t = ora();
  const stanza = {
    codice: generaCodice(random),
    hostId: null,
    creataIl: t,
    aggiornataIl: t,
    vuotaDal: t,
    creataDa: ip,
    maiUsata: true,
    progresso: 0,
    saltiInattivita: 0,
    inattivita: null,
    adminId: null,
    giocatori: new Map(),
    timer: new Map(),
    stato: null,
  };
  sincronizzaLobby(stanza, [], t);
  registro.set(stanza.codice, stanza);
  return stanza;
}

function trova(codice) {
  const c = P.normalizzaCodice(codice);
  return c ? registro.get(c) : undefined;
}

function tutte() {
  return [...registro.values()];
}

/** Stanze ancora aperte create dall'indirizzo `ip`. */
function aperteDa(ip) {
  if (!ip) return 0;
  let n = 0;
  for (const s of registro.values()) if (s.creataDa === ip) n += 1;
  return n;
}

/**
 * Libera un posto nel registro chiudendo la stanza senza giocatori creata da
 * più tempo (mai usata o svuotata). Ritorna true se ne ha chiusa una.
 */
function liberaPosto() {
  let vecchia = null;
  for (const s of registro.values()) {
    if (s.giocatori.size === 0 && (!vecchia || s.creataIl < vecchia.creataIl)) vecchia = s;
  }
  if (!vecchia) return false;
  chiudiStanza(vecchia, 'La stanza è stata chiusa');
  return true;
}

function coloreLibero(stanza) {
  const usati = new Set([...stanza.giocatori.values()].map((g) => g.colore));
  return P.COLORI_GIOCATORE.find((c) => !usati.has(c)) || P.COLORI_GIOCATORE[stanza.giocatori.size % P.COLORI_GIOCATORE.length];
}

/**
 * Aggiunge un giocatore alla lobby.
 * @returns {{giocatore: object, token: string, eventi: object[]} | {errore: object}}
 */
function entra(stanza, { nome, colore, socket, ora = Date.now }) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (stanza.stato.fase !== 'lobby') return errore('PARTITA_INIZIATA');
  if (stanza.giocatori.size >= P.LIMITI.MAX_GIOCATORI) return errore('STANZA_PIENA');

  const nomeOk = P.normalizzaNome(nome);
  if (!nomeOk) return errore('NOME_NON_VALIDO');
  const nomiUsati = [...stanza.giocatori.values()].map((g) => P.chiaveNome(g.nome));
  if (nomiUsati.includes(P.chiaveNome(nomeOk))) return errore('NOME_OCCUPATO');

  let coloreOk = null;
  if (colore) {
    coloreOk = P.normalizzaColore(colore);
    if (!coloreOk) return errore('COLORE_NON_VALIDO');
    if ([...stanza.giocatori.values()].some((g) => g.colore === coloreOk)) return errore('COLORE_OCCUPATO');
  } else {
    coloreOk = coloreLibero(stanza);
  }

  let id = generaId();
  while (stanza.giocatori.has(id)) id = generaId();
  const token = generaToken();
  const t = ora();
  const giocatore = { id, nome: nomeOk, colore: coloreOk, token, connesso: true, socket: socket || null, disconnessoIl: null };
  stanza.giocatori.set(id, giocatore);
  if (!stanza.hostId) stanza.hostId = id;
  stanza.vuotaDal = null;
  stanza.maiUsata = false;

  const eventi = [evento('giocatoreEntrato', id, `${nomeOk} entra nella stanza`, { giocatoreId: id, nome: nomeOk, colore: coloreOk }, t)];
  sincronizzaLobby(stanza, eventi, t);
  return { giocatore, token, eventi };
}

/**
 * Riassocia un socket a un giocatore tramite token.
 * @returns {{stanza: object, giocatore: object, eventi: object[]} | {errore: object}}
 */
function riconnetti(codice, token, socket, { ora = Date.now } = {}) {
  const stanza = trova(codice);
  if (!stanza) return errore('STANZA_INESISTENTE');
  const tokenOk = P.normalizzaToken(token);
  const giocatore = tokenOk ? [...stanza.giocatori.values()].find((g) => tokenUguali(g.token, tokenOk)) : null;
  if (!giocatore) return errore('TOKEN_NON_VALIDO');

  const t = ora();
  if (giocatore.socket && giocatore.socket !== socket && typeof giocatore.socket.close === 'function') {
    // Codice dedicato: il client lo riconosce e NON prova a riconnettersi (altrimenti
    // due schede dello stesso browser si butterebbero fuori a vicenda in loop).
    try { giocatore.socket.close(P.CHIUSURE.SOSTITUITO, 'Sostituito da una nuova connessione'); } catch { /* ignora */ }
  }
  annullaTimer(stanza, giocatore.id);
  giocatore.socket = socket || null;
  giocatore.connesso = true;
  giocatore.disconnessoIl = null;
  stanza.vuotaDal = null;

  const eventi = [evento('connessione', giocatore.id, `${giocatore.nome} è di nuovo online`, { giocatoreId: giocatore.id, connesso: true }, t)];
  if (stanza.stato.fase === 'lobby') {
    // Sala ripristinata dal salvataggio: gli altri non hanno ancora un'ora di
    // disconnessione (vedi importa). Il loro minuto parte adesso che c'è
    // qualcuno a cui liberare il posto, altrimenti un host che non torna
    // terrebbe ferma la sala per sempre.
    for (const altro of stanza.giocatori.values()) {
      if (!altro.connesso && !altro.disconnessoIl) altro.disconnessoIl = t;
    }
    sincronizzaLobby(stanza, eventi, t);
  } else {
    sincronizzaConnessione(stanza, giocatore.id, true, eventi, t);
    // Chi torna può trovare altri assenti che tengono ferma la partita.
    sorvegliaDisconnessi(stanza, { ora });
  }
  return { stanza, giocatore, eventi };
}

/** Uscita volontaria: solo in lobby. */
function esci(stanza, giocatoreId, { ora = Date.now } = {}) {
  if (!stanza || !stanza.giocatori.has(giocatoreId)) return errore('NON_IN_STANZA');
  if (stanza.stato.fase !== 'lobby') return errore('SOLO_IN_LOBBY');
  const g = stanza.giocatori.get(giocatoreId);
  stanza.giocatori.delete(giocatoreId);
  annullaTimer(stanza, giocatoreId);
  const t = ora();
  if (stanza.adminId === giocatoreId) stanza.adminId = null;
  if (stanza.hostId === giocatoreId) {
    const primo = stanza.giocatori.values().next().value;
    stanza.hostId = primo ? primo.id : null;
  }
  const eventi = [evento('giocatoreUscito', giocatoreId, `${g.nome} ha lasciato la stanza`, { giocatoreId }, t)];
  sincronizzaLobby(stanza, eventi, t);
  if (stanza.giocatori.size === 0) {
    // Tutti sono usciti: la stanza si chiude subito e il codice torna libero.
    stanza.vuotaDal = t;
    stanza.chiusa = true;
    if (registro.get(stanza.codice) === stanza) registro.delete(stanza.codice);
    return { eventi, chiusa: true };
  }
  return { eventi, chiusa: false };
}

/**
 * Toglie dalla sala d'attesa un giocatore scollegato, ma solo se c'è qualcun
 * altro collegato a cui liberare il posto. Una sala in cui sono tutti
 * scollegati (l'host da solo che ricarica la pagina, la rete che cade) resta
 * com'è: chi torna rientra con il suo token, e se non torna nessuno la pulizia
 * la chiude dopo STANZA_VUOTA_MS. Ritorna l'esito di `esci` oppure null.
 */
function rimuoviAssenteLobby(stanza, giocatoreId, { ora = Date.now } = {}) {
  const reg = stanza.giocatori.get(giocatoreId);
  if (!reg || reg.connesso || stanza.chiusa || stanza.stato.fase !== 'lobby') return null;
  if (![...stanza.giocatori.values()].some((g) => g.connesso)) return null;
  const esito = esci(stanza, giocatoreId, { ora });
  return esito.errore ? null : esito;
}

/**
 * Il socket si è chiuso: il giocatore resta, marcato come disconnesso.
 * In lobby viene rimosso dopo RIMOZIONE_LOBBY_DISCONNESSO_MS (se c'è qualcun
 * altro collegato); in partita, dopo TOLLERANZA_DISCONNESSIONE_MS, il motore
 * fa avanzare il gioco se lo stava bloccando e l'host cede il ruolo; se è un
 * debitore, dopo BANCAROTTA_DISCONNESSO_MS viene dichiarato in bancarotta
 * d'ufficio, e in ogni caso dopo ABBANDONO_DISCONNESSO_MS abbandona d'ufficio
 * (azione `abbandona` eseguita per lui).
 */
function disconnetti(stanza, giocatoreId, { ora = Date.now, random = casualeSicuro } = {}) {
  if (!stanza || !stanza.giocatori.has(giocatoreId)) return { eventi: [] };
  const g = stanza.giocatori.get(giocatoreId);
  const t = ora();
  g.socket = null;
  g.connesso = false;
  g.disconnessoIl = t;
  if ([...stanza.giocatori.values()].every((x) => !x.connesso)) stanza.vuotaDal = t;
  const eventi = [evento('connessione', giocatoreId, `${g.nome} ha perso la connessione`, { giocatoreId, connesso: false }, t)];
  if (stanza.stato.fase === 'lobby') {
    sincronizzaLobby(stanza, eventi, t);
    programmaTimer(stanza, giocatoreId, 'lobby', TEMPI.RIMOZIONE_LOBBY_DISCONNESSO_MS, () => {
      const esito = rimuoviAssenteLobby(stanza, giocatoreId, { ora });
      if (esito && !esito.chiusa) diffondiAggiornamento(stanza, esito.eventi);
    });
  } else {
    sincronizzaConnessione(stanza, giocatoreId, false, eventi, t);
    sorvegliaDisconnessi(stanza, { ora, random });
  }
  return { eventi };
}

/** C'è almeno un giocatore non fallito con il socket collegato? */
function qualcunoInGara(stanza) {
  return stanza.stato.giocatori.some((g) => {
    const reg = stanza.giocatori.get(g.id);
    return !g.fallito && Boolean(reg) && reg.connesso;
  });
}

/** Il giocatore (disconnesso) sta tenendo ferma la partita o uno scambio? */
function bloccaIlGioco(stato, id) {
  const { fase, asta, scambio, turno } = stato;
  if (scambio && (scambio.daId === id || scambio.aId === id)) return true;
  if (fase === 'asta' && asta) {
    return asta.partecipanti.includes(id) && !asta.passati.includes(id) && asta.migliorOfferenteId !== id;
  }
  return turno.giocatoreId === id && ['ordine', 'daLanciare', 'mossa', 'daDecidereAcquisto'].includes(fase);
}

/**
 * Programma (se non sono già in corso) i timer dei giocatori disconnessi: la
 * tolleranza per chi tiene fermo turno/asta/scambio, la bancarotta d'ufficio
 * per un debito, l'abbandono d'ufficio per chi non torna e il passaggio del
 * ruolo di host; più l'inattività dei connessi e la scadenza dello scambio.
 * Va richiamata dopo ogni cambio di stato, perché un disconnesso può diventare
 * "bloccante" anche più tardi (per esempio quando una carta gli addebita una
 * somma che non ha).
 */
function sorvegliaDisconnessi(stanza, { ora = Date.now, random = casualeSicuro } = {}) {
  sorvegliaAssenti(stanza, { ora, random });
  sorvegliaHost(stanza, { ora });
  sorvegliaScambio(stanza, { ora, random });
  programmaInattivita(stanza, { ora, random });
}

function sorvegliaAssenti(stanza, { ora, random }) {
  const stato = stanza.stato;
  if (stanza.chiusa || !stato || stato.fase === 'lobby' || stato.fase === 'finePartita') return;
  // Se nessun giocatore ancora in gara è collegato non c'è nessuno da
  // sbloccare: la partita aspetta il ritorno di qualcuno.
  if (!qualcunoInGara(stanza)) return;
  for (const g of stato.giocatori) {
    const reg = stanza.giocatori.get(g.id);
    if (!reg || reg.connesso || g.fallito) continue;
    if (bloccaIlGioco(stato, g.id) && !stanza.timer.has(`${g.id}|tolleranza`)) {
      programmaTimer(stanza, g.id, 'tolleranza', TEMPI.TOLLERANZA_DISCONNESSIONE_MS,
        () => sbloccaDisconnesso(stanza, g.id, { ora, random }));
    }
    const debitore = stato.fase === 'debito' && stato.debito && stato.debito.giocatoreId === g.id;
    if (debitore && !stanza.timer.has(`${g.id}|bancarotta`)) {
      programmaTimer(stanza, g.id, 'bancarotta', TEMPI.BANCAROTTA_DISCONNESSO_MS,
        () => bancarottaDisconnesso(stanza, g.id, { ora, random }));
    }
    // Il conto parte quando c'è qualcuno collegato che aspetta (qui sopra si
    // esce se non c'è nessuno) e si azzera quando l'assente rientra.
    if (!stanza.timer.has(`${g.id}|abbandono`)) {
      programmaTimer(stanza, g.id, 'abbandono', TEMPI.ABBANDONO_DISCONNESSO_MS,
        () => abbandonoDisconnesso(stanza, g.id, { ora, random }));
    }
  }
}

/**
 * Assente da ABBANDONO_DISCONNESSO_MS: esce dalla partita come se avesse
 * abbandonato (i suoi beni tornano alla banca o al creditore). Se nel
 * frattempo se ne sono andati tutti non succede nulla: la partita aspetta, e il
 * conto riparte da capo quando rientra qualcuno.
 */
function abbandonoDisconnesso(stanza, giocatoreId, { ora = Date.now, random = casualeSicuro } = {}) {
  const g = stanza.giocatori.get(giocatoreId);
  if (!g || g.connesso || stanza.chiusa) return;
  const stato = stanza.stato;
  if (stato.fase === 'lobby' || stato.fase === 'finePartita') return;
  if (!qualcunoInGara(stanza)) return;
  const inGara = stato.giocatori.find((x) => x.id === giocatoreId);
  if (!inGara || inGara.fallito) return;
  const esito = applica(stanza, giocatoreId, { tipo: 'abbandona' }, { random, ora, motivo: 'assente' });
  if (!esito.errore) diffondiAggiornamento(stanza, esito.eventi);
}

/** Il primo giocatore collegato (meglio se ancora in gara) a cui dare il ruolo di host. */
function eredeHost(stanza) {
  const collegato = (g) => {
    const reg = stanza.giocatori.get(g.id);
    return Boolean(reg) && reg.connesso;
  };
  const giocatori = stanza.stato.giocatori || [];
  return giocatori.find((g) => !g.fallito && collegato(g)) || giocatori.find(collegato) || null;
}

/** L'host di una partita iniziata è scollegato e non è l'admin? */
function hostAssente(stanza) {
  const stato = stanza.stato;
  if (stanza.chiusa || !stato || stato.fase === 'lobby') return false;
  const id = stanza.hostId;
  if (!id || id === stanza.adminId) return false;
  const host = stanza.giocatori.get(id);
  return !host || !host.connesso;
}

/**
 * In partita un host scollegato lascerebbe la stanza senza nessuno che possa
 * togliere un giocatore o chiuderla: dopo la tolleranza il ruolo passa al
 * primo giocatore collegato. L'admin è escluso: resta host anche da assente.
 */
function sorvegliaHost(stanza, { ora = Date.now } = {}) {
  if (!hostAssente(stanza) || !eredeHost(stanza)) return;
  const id = stanza.hostId;
  if (stanza.timer.has(`${id}|host`)) return;
  programmaTimer(stanza, id, 'host', TEMPI.TOLLERANZA_DISCONNESSIONE_MS, () => passaHostAssente(stanza, { ora }));
}

/** Scaduta la tolleranza: se l'host è ancora scollegato il ruolo passa a un collegato. */
function passaHostAssente(stanza, { ora = Date.now } = {}) {
  if (!hostAssente(stanza)) return;
  const nuovo = eredeHost(stanza);
  if (!nuovo) return;
  const precedenteId = stanza.hostId;
  const vecchio = stanza.giocatori.get(precedenteId);
  const t = ora();
  const eventi = [evento('host', nuovo.id,
    `${nuovo.nome} è il nuovo host della stanza: ${vecchio ? vecchio.nome : 'chi lo era'} ha perso la connessione`,
    { giocatoreId: nuovo.id, precedenteId }, t)];
  const stato = structuredClone(stanza.stato);
  stato.hostId = nuovo.id;
  stato.versione += 1;
  stato.log = [...stato.log, ...eventi].slice(-P.LIMITI.LOG_MAX);
  stanza.hostId = nuovo.id;
  stanza.stato = stato;
  diffondiAggiornamento(stanza, eventi);
}

// ---------------------------------------------------------------------------
// Scambio in attesa
// ---------------------------------------------------------------------------

/**
 * Finché c'è uno scambio in attesa nessun altro può proporne: senza una
 * scadenza basterebbe non rispondere per bloccare gli scambi di tutti. Il timer
 * parte quando compare la proposta e viene annullato quando sparisce.
 */
function sorvegliaScambio(stanza, { ora = Date.now, random = casualeSicuro } = {}) {
  const stato = stanza.stato;
  const inCorso = !stanza.chiusa && stato && stato.fase !== 'lobby' && stato.fase !== 'finePartita';
  const id = inCorso && stato.scambio ? stato.scambio.id : null;
  const chiave = `${ID_SCAMBIO}|scadenza`;
  if (id && stanza.scambioInAttesa === id && stanza.timer.has(chiave)) return;
  annullaTimer(stanza, ID_SCAMBIO);
  stanza.scambioInAttesa = id;
  if (!id) return;
  programmaTimer(stanza, ID_SCAMBIO, 'scadenza', TEMPI.SCAMBIO_MS, () => scadutoScambio(stanza, id, { ora, random }));
}

/** Nessuna risposta entro SCAMBIO_MS: la proposta decade (evento `scambioRifiutato`). */
function scadutoScambio(stanza, scambioId, { ora = Date.now, random = casualeSicuro } = {}) {
  const stato = stanza.stato;
  if (stanza.chiusa || !stato || !stato.scambio || stato.scambio.id !== scambioId) return;
  let esito;
  try {
    esito = motore.scadeScambio(stato, scambioId, { ora, random, secondi: Math.round(TEMPI.SCAMBIO_MS / 1000) });
  } catch (e) {
    console.error('[stanze] scadeScambio ha lanciato', stanza.codice, e);
    return;
  }
  if (!esito || !esito.eventi || esito.eventi.length === 0) return;
  for (const x of esito.stato.giocatori) {
    const reg = stanza.giocatori.get(x.id);
    if (reg) x.connesso = reg.connesso;
  }
  stanza.stato = esito.stato;
  stanza.aggiornataIl = ora();
  sorvegliaDisconnessi(stanza, { ora, random });
  diffondiAggiornamento(stanza, esito.eventi);
}

/** Scaduta la tolleranza: se il disconnesso blocca la partita, il motore la fa avanzare. */
function sbloccaDisconnesso(stanza, giocatoreId, { ora = Date.now, random = casualeSicuro } = {}) {
  const g = stanza.giocatori.get(giocatoreId);
  if (!g || g.connesso) return;
  const stato = stanza.stato;
  if (stato.fase === 'lobby' || stato.fase === 'finePartita') return;
  if (!qualcunoInGara(stanza)) return;
  let esito;
  try {
    esito = motore.gestisciDisconnessione(stato, giocatoreId, { random, ora });
  } catch (e) {
    console.error('[stanze] gestisciDisconnessione ha lanciato', stanza.codice, e);
    return;
  }
  if (!esito || !esito.eventi || esito.eventi.length === 0) return;
  for (const x of esito.stato.giocatori) {
    const reg = stanza.giocatori.get(x.id);
    if (reg) x.connesso = reg.connesso;
  }
  stanza.stato = esito.stato;
  stanza.aggiornataIl = ora();
  stanza.progresso += 1;
  sorvegliaDisconnessi(stanza, { ora, random });
  diffondiAggiornamento(stanza, esito.eventi);
}

// ---------------------------------------------------------------------------
// Inattività dei giocatori connessi
// ---------------------------------------------------------------------------

function durataInattivita(fase) {
  if (fase === 'asta') return TEMPI.INATTIVITA_ASTA_MS;
  if (fase === 'ordine') return TEMPI.INATTIVITA_ORDINE_MS;
  if (fase === 'debito') return TEMPI.INATTIVITA_DEBITO_MS;
  return TEMPI.INATTIVITA_TURNO_MS;
}

/**
 * (Ri)programma il timer d'inattività della stanza. Riparte da capo solo
 * quando la partita è andata avanti (`stanza.progresso` cambiato): connessioni
 * e riconnessioni non lo azzerano. Si ferma se nessun giocatore in gara è
 * collegato, o dopo due giri interi di turni saltati senza che nessuno giochi
 * (tutti lontani dal computer: la partita aspetta, e la pulizia la chiuderà).
 */
function programmaInattivita(stanza, { ora = Date.now, random = casualeSicuro } = {}) {
  const stato = stanza.stato;
  const inCorso = !stanza.chiusa && stato && stato.fase !== 'lobby' && stato.fase !== 'finePartita'
    && qualcunoInGara(stanza);
  const daAspettare = inCorso ? motore.chiDeveAgire(stato) : [];
  const vivi = inCorso ? stato.giocatori.filter((g) => !g.fallito).length : 0;
  if (!inCorso || daAspettare.length === 0 || stanza.saltiInattivita >= 2 * vivi) {
    annullaTimer(stanza, ID_STANZA);
    stanza.inattivita = null;
    return;
  }
  const chiave = stanza.progresso;
  if (stanza.inattivita && stanza.inattivita.chiave === chiave) return;
  annullaTimer(stanza, ID_STANZA);
  const durata = durataInattivita(stato.fase);
  stanza.inattivita = { chiave, scadeIl: ora() + durata, giocatori: daAspettare };
  programmaTimer(stanza, ID_STANZA, 'preavviso', Math.max(0, durata - TEMPI.PREAVVISO_INATTIVITA_MS),
    () => preavvisaInattivita(stanza, chiave, { ora }));
  programmaTimer(stanza, ID_STANZA, 'scadenza', durata,
    () => scadutaInattivita(stanza, chiave, { ora, random }));
}

/** 30 secondi prima della scadenza: avviso a tutti (solo evento, non entra nel log). */
function preavvisaInattivita(stanza, chiave, { ora = Date.now } = {}) {
  if (!stanza.inattivita || stanza.inattivita.chiave !== chiave) return;
  const ids = motore.chiDeveAgire(stanza.stato);
  if (ids.length === 0) return;
  const nomi = ids.map((id) => (stanza.giocatori.get(id) || {}).nome || 'un giocatore');
  const secondi = Math.round(TEMPI.PREAVVISO_INATTIVITA_MS / 1000);
  const debito = stanza.stato.fase === 'debito';
  const poi = debito ? 'poi viene dichiarata la bancarotta' : 'poi la partita va avanti da sola';
  const testo = `${nomi.join(', ')}: ancora ${secondi} secondi per giocare, ${poi}`;
  const ev = evento('avvisoInattivita', null, testo, { giocatori: ids, secondi, debito }, ora());
  broadcast(stanza, { tipo: 'evento', versione: stanza.stato.versione, evento: ev });
}

/**
 * Scaduto il tempo: il debitore fa bancarotta (azione `abbandona`); chi deve
 * agire in un'asta passa; il giocatore di turno rinuncia all'acquisto o salta
 * il turno (motore.gestisciInattivita).
 */
function scadutaInattivita(stanza, chiave, { ora = Date.now, random = casualeSicuro } = {}) {
  if (!stanza.inattivita || stanza.inattivita.chiave !== chiave) return;
  stanza.inattivita = null;
  const stato = stanza.stato;
  if (!stato || stato.fase === 'lobby' || stato.fase === 'finePartita') return;
  if (stato.fase === 'debito' && stato.debito) {
    const esito = applica(stanza, stato.debito.giocatoreId, { tipo: 'abbandona' }, { random, ora, motivo: 'debito' });
    if (!esito.errore) diffondiAggiornamento(stanza, esito.eventi);
    return;
  }
  let nuovo = stato;
  const eventi = [];
  for (const id of motore.chiDeveAgire(stato)) {
    let esito;
    try {
      esito = motore.gestisciInattivita(nuovo, id, { random, ora });
    } catch (e) {
      console.error('[stanze] gestisciInattivita ha lanciato', stanza.codice, e);
      return;
    }
    if (esito.eventi.length) {
      nuovo = esito.stato;
      eventi.push(...esito.eventi);
    }
  }
  if (eventi.length === 0) return;
  for (const x of nuovo.giocatori) {
    const reg = stanza.giocatori.get(x.id);
    if (reg) x.connesso = reg.connesso;
  }
  stanza.stato = nuovo;
  stanza.aggiornataIl = ora();
  stanza.progresso += 1;
  stanza.saltiInattivita += 1;
  sorvegliaDisconnessi(stanza, { ora, random });
  diffondiAggiornamento(stanza, eventi);
}

/** Debitore assente da troppo: bancarotta d'ufficio tramite l'azione `abbandona`. */
function bancarottaDisconnesso(stanza, giocatoreId, { ora = Date.now, random = casualeSicuro } = {}) {
  const g = stanza.giocatori.get(giocatoreId);
  if (!g || g.connesso) return;
  const stato = stanza.stato;
  if (stato.fase !== 'debito' || !stato.debito || stato.debito.giocatoreId !== giocatoreId) return;
  const esito = applica(stanza, giocatoreId, { tipo: 'abbandona' }, { random, ora, motivo: 'debito' });
  if (!esito.errore) diffondiAggiornamento(stanza, esito.eventi);
}

/**
 * Host o admin compilano la finestra delle regole in sala d'attesa: le vedono
 * tutti, e da qui in poi si può avviare. `regole` arriva già validata
 * (protocollo.js → regole.normalizza).
 */
function impostaRegole(stanza, giocatoreId, regole, { ora = Date.now } = {}) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (stanza.stato.fase !== 'lobby') return errore('SOLO_IN_LOBBY');
  if (!puoComandare(stanza, giocatoreId)) return errore('NON_ADMIN');
  const t = ora();
  const nome = (stanza.giocatori.get(giocatoreId) || {}).nome || 'L\'host';
  const eventi = [evento('regoleImpostate', giocatoreId, `${nome} ha scelto le regole della partita`, { regole: { ...regole } }, t)];
  stanza.stato.regole = { ...regole };
  stanza.stato.regoleImpostate = true;
  sincronizzaLobby(stanza, eventi, t);
  return { eventi };
}

/**
 * Avvia la partita (host o admin, almeno 2 giocatori connessi), con le regole
 * del messaggio o, se mancano, quelle già scelte con impostaRegole: senza
 * nessuna delle due la partita non parte (REGOLE_DA_IMPOSTARE). Si parte dal
 * lancio iniziale per decidere chi comincia (fase 'ordine'); `lancioIniziale:
 * false` (solo dai test) salta questo passo e comincia il primo della lista.
 */
function avvia(stanza, giocatoreId, { random = casualeSicuro, ora = Date.now, regole = null, lancioIniziale = true } = {}) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (stanza.stato.fase !== 'lobby') return errore('PARTITA_INIZIATA');
  if (!puoComandare(stanza, giocatoreId)) return errore('NON_HOST');
  const connessi = [...stanza.giocatori.values()].filter((g) => g.connesso);
  if (connessi.length < P.LIMITI.MIN_GIOCATORI) return errore('POCHI_GIOCATORI');
  const scelte = regole || (stanza.stato.regoleImpostate ? stanza.stato.regole : null);
  if (!scelte) return errore('REGOLE_DA_IMPOSTARE');

  // Chi è disconnesso in lobby all'avvio viene lasciato fuori (solo se il
  // motore accetta la partita: in caso di errore la lobby resta intatta).
  const precedente = stanza.stato;
  let stato;
  try {
    stato = motore.creaPartita({
      codice: stanza.codice,
      hostId: stanza.hostId,
      giocatori: connessi.map((g) => ({ id: g.id, nome: g.nome, colore: g.colore, connesso: true })),
      random,
      ora,
      opzioni: { ...REGOLE.PREDEFINITE, ...scelte, lancioIniziale: lancioIniziale !== false },
    });
  } catch (e) {
    console.error('[stanze] creaPartita fallita', stanza.codice, e);
    return errore('ERRORE_INTERNO', { motivo: 'creaPartita' });
  }
  if (!stato || typeof stato !== 'object' || !Array.isArray(stato.giocatori)) {
    return errore('ERRORE_INTERNO', { motivo: 'creaPartita' });
  }
  for (const g of [...stanza.giocatori.values()]) {
    if (!g.connesso) stanza.giocatori.delete(g.id);
  }
  const eventi = Array.isArray(stato.log) ? stato.log.slice() : [];
  stato.versione = precedente.versione + 1;
  stato.creataIl = stanza.creataIl;
  stato.log = [...precedente.log, ...eventi].slice(-P.LIMITI.LOG_MAX);
  stanza.stato = stato;
  stanza.aggiornataIl = stato.aggiornataIl;
  stanza.progresso += 1;
  sorvegliaDisconnessi(stanza, { ora, random });
  return { eventi };
}

/**
 * Applica un'azione di gioco tramite il motore e aggiorna la stanza. `motivo`
 * lo passa solo il server quando agisce al posto di un giocatore ('assente',
 * 'debito': vedi `abbandona` nel motore).
 */
function applica(stanza, giocatoreId, azione, { random = casualeSicuro, ora = Date.now, motivo = null } = {}) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (!stanza.giocatori.has(giocatoreId)) return errore('NON_IN_STANZA');
  if (stanza.stato.fase === 'lobby') {
    return errore('FASE_ERRATA', { fase: 'lobby', motivo: 'La partita non è ancora iniziata' });
  }
  let esito;
  try {
    esito = motore.applicaAzione(stanza.stato, giocatoreId, azione, { random, ora, motivo });
  } catch (e) {
    // Un bug del motore non deve rompere la stanza: lo stato resta quello precedente.
    console.error('[stanze] applicaAzione ha lanciato', stanza.codice, azione && azione.tipo, e);
    return errore('ERRORE_INTERNO', { azione: azione && azione.tipo });
  }
  if (!esito || typeof esito !== 'object') return errore('ERRORE_INTERNO', { azione: azione && azione.tipo });
  if (esito.errore) {
    const { codice = 'ERRORE_INTERNO', messaggio, dettagli } = esito.errore;
    const out = errore(codice, dettagli);
    if (typeof messaggio === 'string' && messaggio) out.errore.messaggio = messaggio;
    return out;
  }
  if (!esito.stato || typeof esito.stato !== 'object' || !Array.isArray(esito.stato.giocatori)) {
    console.error('[stanze] applicaAzione ha ritornato uno stato malformato', stanza.codice, azione && azione.tipo);
    return errore('ERRORE_INTERNO', { azione: azione && azione.tipo });
  }
  // La connessione è un dato della stanza, non del motore: lo riallineiamo.
  for (const g of esito.stato.giocatori) {
    const reg = stanza.giocatori.get(g.id);
    if (reg) g.connesso = reg.connesso;
  }
  aggiornaHost(stanza, esito.stato);
  stanza.stato = esito.stato;
  stanza.aggiornataIl = typeof esito.stato.aggiornataIl === 'number' ? esito.stato.aggiornataIl : ora();
  stanza.progresso += 1;
  stanza.saltiInattivita = 0;
  sorvegliaDisconnessi(stanza, { ora, random });
  return { eventi: Array.isArray(esito.eventi) ? esito.eventi : [] };
}

/**
 * Lo stato come va inviato ai client (senza mazzi). Di norma il log è
 * accorciato agli ultimi LOG_BREVE eventi; con `completo: true` (ingresso e
 * riconnessione) arriva tutto, così il client ricostruisce la cronaca.
 */
function statoPerClient(stanza, { completo = false } = {}) {
  const stato = motore.statoPubblico(stanza.stato);
  stato.adminId = stanza.adminId || null;
  if (!completo && Array.isArray(stato.log) && stato.log.length > P.LIMITI.LOG_BREVE) {
    stato.log = stato.log.slice(-P.LIMITI.LOG_BREVE);
  }
  return stato;
}

/** Invia un messaggio (oggetto) a tutti i socket aperti della stanza. */
function broadcast(stanza, messaggio) {
  const testo = typeof messaggio === 'string' ? messaggio : JSON.stringify(messaggio);
  for (const g of stanza.giocatori.values()) {
    const s = g.socket;
    if (s && s.readyState === 1 /* OPEN */) {
      try { s.send(testo); } catch { /* il socket verrà chiuso dall'handler di errore */ }
    }
  }
}

/** Invia prima gli eventi, poi lo stato (INTERFACCE.md §3.1). */
function diffondiAggiornamento(stanza, eventi) {
  const stato = statoPerClient(stanza);
  for (const ev of eventi || []) {
    broadcast(stanza, { tipo: 'evento', versione: stato.versione, evento: ev });
  }
  broadcast(stanza, { tipo: 'stato', versione: stato.versione, stato });
}

/**
 * Rimuove stanze vuote/inattive e giocatori di lobby disconnessi da troppo.
 * Scadenze: mai usata 2 minuti; tutti scollegati 10 minuti (le partite appena
 * ripristinate dal salvataggio aspettano invece STANZA_INATTIVA_MS, finché non
 * rientra qualcuno); sala d'attesa con un solo giocatore ferma da 30 minuti;
 * nessun cambiamento da 2 ore; partita finita da 30 minuti.
 * @returns {number} stanze rimosse
 */
function pulisci({ ora = Date.now } = {}) {
  const t = ora();
  let rimosse = 0;
  for (const stanza of [...registro.values()]) {
    if (stanza.stato.fase === 'lobby') {
      for (const g of [...stanza.giocatori.values()]) {
        if (!g.connesso && g.disconnessoIl && t - g.disconnessoIl > TEMPI.RIMOZIONE_LOBBY_DISCONNESSO_MS) {
          const esito = rimuoviAssenteLobby(stanza, g.id, { ora: () => t });
          if (esito && !esito.chiusa) diffondiAggiornamento(stanza, esito.eventi);
        }
      }
      if (stanza.chiusa) {
        rimosse += 1;
        continue;
      }
    }
    const vuota = stanza.giocatori.size === 0 || [...stanza.giocatori.values()].every((g) => !g.connesso);
    const maiUsata = stanza.maiUsata && stanza.giocatori.size === 0 && t - stanza.creataIl > TEMPI.STANZA_MAI_USATA_MS;
    // Qualcuno ha creato la stanza, è entrato e l'ha lasciata aperta in una scheda.
    const solitaria = stanza.stato.fase === 'lobby' && stanza.giocatori.size === 1
      && t - stanza.aggiornataIl > TEMPI.LOBBY_SOLITARIA_MS;
    const daRimuovere =
      maiUsata ||
      solitaria ||
      (vuota && stanza.vuotaDal && t - stanza.vuotaDal > TEMPI.STANZA_VUOTA_MS) ||
      t - stanza.aggiornataIl > TEMPI.STANZA_INATTIVA_MS ||
      (stanza.stato.fase === 'finePartita' && t - stanza.aggiornataIl > TEMPI.FINE_PARTITA_MS);
    if (daRimuovere) {
      chiudiStanza(stanza, 'La stanza è stata chiusa per inattività');
      rimosse += 1;
    }
  }
  return rimosse;
}

/** Elimina una stanza: avvisa e chiude i socket ancora collegati (codice 4002). */
function chiudiStanza(stanza, messaggio) {
  registro.delete(stanza.codice);
  stanza.chiusa = true;
  annullaTimer(stanza);
  broadcast(stanza, P.errore('STANZA_INESISTENTE', { messaggio }));
  for (const g of stanza.giocatori.values()) {
    const s = g.socket;
    g.socket = null;
    if (s && typeof s.close === 'function') {
      try { s.close(P.CHIUSURE.STANZA_CHIUSA, 'Stanza chiusa'); } catch { /* ignora */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Admin (index.js verifica la chiave; qui solo gli effetti sulla stanza)
// ---------------------------------------------------------------------------

/**
 * Il giocatore ha la chiave admin: diventa admin e host della stanza
 * (avvia la partita), qualunque sia chi l'ha creata. Solo il primo: se la
 * stanza ha già un admin ancora dentro, resta lui (l'admin può cedere il
 * ruolo con `cediAdmin`). Ritorna gli eventi da diffondere.
 */
function rendiAdmin(stanza, giocatoreId, { ora = Date.now } = {}) {
  const g = stanza.giocatori.get(giocatoreId);
  if (!g || (stanza.adminId === giocatoreId && stanza.hostId === giocatoreId)) return [];
  if (stanza.adminId && stanza.adminId !== giocatoreId && stanza.giocatori.has(stanza.adminId)) return [];
  return passaAdmin(stanza, giocatoreId, `${g.nome} è l'admin della stanza`, ora());
}

/**
 * L'admin cede il ruolo (admin e host) a un altro giocatore della stanza,
 * ancora in gara se la partita è iniziata. Ritorna { eventi } oppure { errore }.
 */
function cediAdmin(stanza, chiId, giocatoreId, { ora = Date.now } = {}) {
  if (!chiId || stanza.adminId !== chiId) {
    const e = errore('NON_ADMIN');
    e.errore.messaggio = 'Solo l\'admin può cedere il ruolo';
    return e;
  }
  const da = stanza.giocatori.get(chiId);
  const a = stanza.giocatori.get(giocatoreId);
  const inGara = stanza.stato.fase === 'lobby'
    || (stanza.stato.giocatori || []).some((x) => x.id === giocatoreId && !x.fallito);
  if (!a || giocatoreId === chiId || !inGara) {
    const e = errore('GIOCATORE_NON_VALIDO');
    e.errore.messaggio = 'Puoi cedere l\'admin solo a un altro giocatore ancora in gioco';
    return e;
  }
  return { eventi: passaAdmin(stanza, giocatoreId, `${da ? da.nome : 'L\'admin'} cede l'admin ${N.aChi(a.nome)}`, ora()) };
}

/**
 * L'admin rinuncia al ruolo ("Esci da admin su questo browser"): la stanza
 * resta senza admin e lui resta host, come un giocatore qualunque che l'ha
 * creata. Ritorna gli eventi da diffondere (nessuno se non era l'admin).
 */
function lasciaAdmin(stanza, giocatoreId, { ora = Date.now } = {}) {
  if (!giocatoreId || stanza.adminId !== giocatoreId) return [];
  const g = stanza.giocatori.get(giocatoreId);
  const t = ora();
  stanza.adminId = null;
  const eventi = [evento('admin', null, `${g ? g.nome : 'L\'admin'} non è più l'admin della stanza`,
    { giocatoreId: null, precedenteId: giocatoreId }, t)];
  if (stanza.stato.fase === 'lobby') {
    sincronizzaLobby(stanza, eventi, t);
  } else {
    const stato = structuredClone(stanza.stato);
    stato.versione += 1;
    stato.log = [...stato.log, ...eventi].slice(-P.LIMITI.LOG_MAX);
    stanza.stato = stato;
    // Da qui valgono le regole di un host qualunque (anche quella dell'assenza).
    sorvegliaHost(stanza, { ora });
  }
  return eventi;
}

/** Rende `giocatoreId` admin e host, aggiorna lo stato e ritorna l'evento. */
function passaAdmin(stanza, giocatoreId, testo, t) {
  stanza.adminId = giocatoreId;
  stanza.hostId = giocatoreId;
  const eventi = [evento('admin', giocatoreId, testo, { giocatoreId }, t)];
  if (stanza.stato.fase === 'lobby') {
    sincronizzaLobby(stanza, eventi, t);
  } else {
    const stato = structuredClone(stanza.stato);
    stato.hostId = giocatoreId;
    stato.versione += 1;
    stato.log = [...stato.log, ...eventi].slice(-P.LIMITI.LOG_MAX);
    stanza.stato = stato;
  }
  return eventi;
}

/** Chi comanda la stanza (togliere giocatori, chiuderla): l'host e l'admin. */
function puoComandare(stanza, giocatoreId) {
  return Boolean(giocatoreId) && stanza.giocatori.has(giocatoreId)
    && (stanza.hostId === giocatoreId || stanza.adminId === giocatoreId);
}

/**
 * In partita l'host che fa bancarotta (o viene tolto) passa il ruolo al primo
 * giocatore ancora in gara, così la stanza ha sempre chi la comanda. L'admin
 * resta host comunque. Muta `stato` (già nuovo) e la stanza.
 */
function aggiornaHost(stanza, stato) {
  if (!stato || stato.fase === 'lobby' || stanza.hostId === stanza.adminId) return;
  const host = stato.giocatori.find((g) => g.id === stanza.hostId);
  if (host && !host.fallito && stanza.giocatori.has(host.id)) return;
  const nuovo = stato.giocatori.find((g) => !g.fallito && stanza.giocatori.has(g.id));
  if (!nuovo) return;
  stanza.hostId = nuovo.id;
  stato.hostId = nuovo.id;
}

/**
 * L'host o l'admin toglie un giocatore dalla stanza. In lobby esce; in
 * partita fa bancarotta verso la banca (come `abbandona`) e non può più
 * rientrare: il suo token viene cambiato. L'admin non si può togliere.
 * Ritorna { eventi, socket } (il socket da chiudere) oppure { errore }.
 */
function caccia(stanza, chiId, giocatoreId, { ora = Date.now, random = casualeSicuro } = {}) {
  if (!puoComandare(stanza, chiId)) return errore('NON_ADMIN');
  if (giocatoreId === chiId) {
    const e = errore('GIOCATORE_NON_VALIDO');
    e.errore.messaggio = 'Non puoi togliere te stesso dalla stanza';
    return e;
  }
  if (giocatoreId === stanza.adminId) {
    const e = errore('NON_ADMIN');
    e.errore.messaggio = 'L\'admin non si può togliere dalla stanza';
    return e;
  }
  const g = stanza.giocatori.get(giocatoreId);
  if (!g) return errore('GIOCATORE_NON_VALIDO');
  const socket = g.socket;
  const eventi = [];
  if (stanza.stato.fase === 'lobby') {
    const esito = esci(stanza, giocatoreId, { ora });
    if (esito.errore) return esito;
    eventi.push(...esito.eventi);
  } else {
    const inGara = stanza.stato.giocatori.find((x) => x.id === giocatoreId);
    if (inGara && !inGara.fallito && stanza.stato.fase !== 'finePartita') {
      const esito = applica(stanza, giocatoreId, { tipo: 'abbandona' }, { ora, random });
      if (esito.errore) return esito;
      eventi.push(...esito.eventi);
    }
    g.token = generaToken();
    const fuori = disconnetti(stanza, giocatoreId, { ora, random });
    // Non ha "perso la connessione": è stato tolto, e la cronaca lo dice.
    eventi.push(...fuori.eventi.filter((e) => e.tipo !== 'connessione'));
    const chi = chiId === stanza.adminId ? 'L\'admin' : 'L\'host';
    const tolto = evento('giocatoreUscito', giocatoreId, `${chi} toglie ${g.nome} dalla partita`, { giocatoreId, tolto: true }, ora());
    const stato = structuredClone(stanza.stato);
    stato.versione += 1;
    const persa = fuori.eventi.find((e) => e.tipo === 'connessione');
    stato.log = [
      ...stato.log.filter((e) => !(persa && e.tipo === 'connessione' && e.giocatoreId === giocatoreId && e.t === persa.t)),
      tolto,
    ].slice(-P.LIMITI.LOG_MAX);
    stanza.stato = stato;
    eventi.push(tolto);
    aggiornaHost(stanza, stanza.stato);
  }
  return { eventi, socket };
}

// ---------------------------------------------------------------------------
// Salvataggio su file (server/salvataggio.js)
// ---------------------------------------------------------------------------

/** Le stanze aperte in forma serializzabile (senza socket né timer; con i token). */
function esporta() {
  return [...registro.values()].filter((s) => !s.chiusa).map((s) => ({
    codice: s.codice,
    hostId: s.hostId,
    creataIl: s.creataIl,
    aggiornataIl: s.aggiornataIl,
    creataDa: s.creataDa || null,
    maiUsata: Boolean(s.maiUsata),
    adminId: s.adminId || null,
    giocatori: [...s.giocatori.values()].map((g) => ({ id: g.id, nome: g.nome, colore: g.colore, token: g.token })),
    stato: s.stato,
  }));
}

/**
 * Ricrea le stanze salvate. Tutti i giocatori risultano disconnessi: rientrano
 * con il token che il loro browser ha conservato. Le voci malformate o con un
 * codice già in uso vengono saltate. Ritorna il numero di stanze ripristinate.
 *
 * `vuotaDal` e `disconnessoIl` restano vuoti apposta: nessuno ha ancora avuto
 * modo di rientrare, quindi non valgono i 10 minuti delle stanze svuotate né
 * il minuto dei giocatori di lobby scollegati. Una stanza ripristinata in cui
 * non rientra nessuno viene chiusa dopo STANZA_INATTIVA_MS (2 ore).
 */
function importa(elenco, { ora = Date.now } = {}) {
  if (!Array.isArray(elenco)) return 0;
  const t = ora();
  let n = 0;
  for (const d of elenco) {
    if (!d || typeof d !== 'object' || !P.REGEX_CODICE.test(String(d.codice)) || registro.has(d.codice)) continue;
    if (!d.stato || typeof d.stato !== 'object' || typeof d.stato.fase !== 'string' || !Array.isArray(d.stato.giocatori)) continue;
    if (!Array.isArray(d.giocatori)) continue;
    const giocatori = new Map();
    for (const g of d.giocatori) {
      if (!g || !P.REGEX_ID.test(String(g.id)) || !P.REGEX_TOKEN.test(String(g.token))) continue;
      giocatori.set(g.id, {
        id: g.id, nome: String(g.nome), colore: String(g.colore), token: g.token, connesso: false, socket: null, disconnessoIl: null,
      });
    }
    const stato = structuredClone(d.stato);
    for (const g of stato.giocatori) g.connesso = false;
    registro.set(d.codice, {
      codice: d.codice,
      hostId: d.hostId ?? null,
      creataIl: Number(d.creataIl) || t,
      aggiornataIl: t,
      vuotaDal: null,
      creataDa: d.creataDa || null,
      maiUsata: Boolean(d.maiUsata),
      progresso: 0,
      saltiInattivita: 0,
      inattivita: null,
      adminId: giocatori.has(d.adminId) ? d.adminId : null,
      giocatori,
      timer: new Map(),
      stato,
    });
    n += 1;
  }
  return n;
}

function rimuovi(codice, messaggio = 'La stanza è stata chiusa') {
  const stanza = registro.get(P.normalizzaCodice(codice));
  if (!stanza) return false;
  chiudiStanza(stanza, messaggio);
  return true;
}

/** Svuota il registro (per i test). */
function azzera() {
  for (const stanza of registro.values()) {
    annullaTimer(stanza);
    stanza.chiusa = true;
  }
  registro.clear();
}

module.exports = {
  TEMPI,
  casualeSicuro,
  generaCodice,
  generaId,
  generaToken,
  crea,
  trova,
  tutte,
  aperteDa,
  liberaPosto,
  entra,
  riconnetti,
  esci,
  disconnetti,
  avvia,
  applica,
  statoPerClient,
  broadcast,
  diffondiAggiornamento,
  sorvegliaDisconnessi,
  sbloccaDisconnesso,
  bancarottaDisconnesso,
  abbandonoDisconnesso,
  passaHostAssente,
  scadutoScambio,
  rendiAdmin,
  cediAdmin,
  lasciaAdmin,
  impostaRegole,
  puoComandare,
  caccia,
  programmaInattivita,
  preavvisaInattivita,
  scadutaInattivita,
  pulisci,
  esporta,
  importa,
  rimuovi,
  azzera,
};
