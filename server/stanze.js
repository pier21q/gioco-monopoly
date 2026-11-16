'use strict';

/**
 * server/stanze.js
 *
 * Registro in memoria delle stanze di gioco: creazione con codice a 6
 * caratteri, ingresso/uscita dei giocatori in lobby, token di riconnessione,
 * avvio della partita e applicazione delle azioni tramite il motore.
 * Contratto in INTERFACCE.md §3.6. Nessuna persistenza (fase 1).
 *
 * I token e i socket vivono solo qui, mai nello StatoPartita.
 *
 * Oltre ai timer per i disconnessi c'è un timer d'inattività per stanza: se
 * chi deve agire (giocatore di turno, partecipanti all'asta, debitore) non lo
 * fa entro TEMPI.INATTIVITA_*, il server fa avanzare la partita per lui, con
 * un preavviso 30 secondi prima. `esporta`/`importa` servono al salvataggio
 * su file (server/salvataggio.js).
 */

const crypto = require('node:crypto');
const P = require('./protocollo');
const motore = require('./gioco/motore');

const registro = new Map(); // codice → Stanza

const TEMPI = Object.freeze({
  RIMOZIONE_LOBBY_DISCONNESSO_MS: 60 * 1000,
  // In partita: dopo questa tolleranza un disconnesso che blocca il gioco
  // viene fatto avanzare dal motore (turno passato, asta passata, scambio annullato).
  TOLLERANZA_DISCONNESSIONE_MS: 45 * 1000,
  // Un debitore disconnesso da così a lungo viene dichiarato in bancarotta d'ufficio.
  BANCAROTTA_DISCONNESSO_MS: 3 * 60 * 1000,
  STANZA_VUOTA_MS: 10 * 60 * 1000,
  // Stanza creata ma in cui non è mai entrato nessuno.
  STANZA_MAI_USATA_MS: 2 * 60 * 1000,
  STANZA_INATTIVA_MS: 2 * 60 * 60 * 1000,
  FINE_PARTITA_MS: 30 * 60 * 1000,
  // Giocatori connessi che non agiscono: dopo questi tempi la partita va avanti da sola.
  INATTIVITA_TURNO_MS: 3 * 60 * 1000,
  INATTIVITA_ASTA_MS: 60 * 1000,
  INATTIVITA_DEBITO_MS: 5 * 60 * 1000,
  PREAVVISO_INATTIVITA_MS: 30 * 1000,
});

/** Chiave dei timer che riguardano la stanza intera (gli id giocatore sono [a-z0-9]{8}). */
const ID_STANZA = '_stanza';

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
  if (stanza.stato.fase === 'lobby') sincronizzaLobby(stanza, eventi, t);
  else {
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
 * Il socket si è chiuso: il giocatore resta, marcato come disconnesso.
 * In lobby viene rimosso dopo RIMOZIONE_LOBBY_DISCONNESSO_MS; in partita,
 * dopo TOLLERANZA_DISCONNESSIONE_MS, il motore fa avanzare il gioco se lo
 * stava bloccando e, se è un debitore, dopo BANCAROTTA_DISCONNESSO_MS viene
 * dichiarato in bancarotta d'ufficio (azione `abbandona` eseguita per lui).
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
      const reg = stanza.giocatori.get(giocatoreId);
      if (!reg || reg.connesso || stanza.stato.fase !== 'lobby') return;
      const esito = esci(stanza, giocatoreId, { ora });
      if (!esito.errore && !esito.chiusa) diffondiAggiornamento(stanza, esito.eventi);
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
  return turno.giocatoreId === id && ['daLanciare', 'mossa', 'daDecidereAcquisto'].includes(fase);
}

/**
 * Programma (se non sono già in corso) i timer dei giocatori disconnessi che
 * tengono ferma la partita: la tolleranza per turno/asta/scambio e la
 * bancarotta d'ufficio per un debito. Va richiamata dopo ogni cambio di stato,
 * perché un disconnesso può diventare "bloccante" anche più tardi (per esempio
 * quando una carta gli addebita una somma che non ha).
 */
function sorvegliaDisconnessi(stanza, { ora = Date.now, random = casualeSicuro } = {}) {
  sorvegliaAssenti(stanza, { ora, random });
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
  }
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
    const esito = applica(stanza, stato.debito.giocatoreId, { tipo: 'abbandona' }, { random, ora });
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
  const esito = applica(stanza, giocatoreId, { tipo: 'abbandona' }, { random, ora });
  if (!esito.errore) diffondiAggiornamento(stanza, esito.eventi);
}

/** Avvia la partita (solo host, almeno 2 giocatori connessi). */
function avvia(stanza, giocatoreId, { random = casualeSicuro, ora = Date.now, regole = null } = {}) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (stanza.stato.fase !== 'lobby') return errore('PARTITA_INIZIATA');
  if (stanza.hostId !== giocatoreId) return errore('NON_HOST');
  const connessi = [...stanza.giocatori.values()].filter((g) => g.connesso);
  if (connessi.length < P.LIMITI.MIN_GIOCATORI) return errore('POCHI_GIOCATORI');

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
      opzioni: regole && regole.costruzione ? { costruzione: regole.costruzione } : undefined,
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

/** Applica un'azione di gioco tramite il motore e aggiorna la stanza. */
function applica(stanza, giocatoreId, azione, { random = casualeSicuro, ora = Date.now } = {}) {
  if (!stanza) return errore('STANZA_INESISTENTE');
  if (!stanza.giocatori.has(giocatoreId)) return errore('NON_IN_STANZA');
  if (stanza.stato.fase === 'lobby') {
    return errore('FASE_ERRATA', { fase: 'lobby', motivo: 'La partita non è ancora iniziata' });
  }
  let esito;
  try {
    esito = motore.applicaAzione(stanza.stato, giocatoreId, azione, { random, ora });
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
 * @returns {number} stanze rimosse
 */
function pulisci({ ora = Date.now } = {}) {
  const t = ora();
  let rimosse = 0;
  for (const stanza of [...registro.values()]) {
    if (stanza.stato.fase === 'lobby') {
      for (const g of [...stanza.giocatori.values()]) {
        if (!g.connesso && g.disconnessoIl && t - g.disconnessoIl > TEMPI.RIMOZIONE_LOBBY_DISCONNESSO_MS) {
          const esito = esci(stanza, g.id, { ora: () => t });
          if (!esito.errore) diffondiAggiornamento(stanza, esito.eventi);
        }
      }
      if (stanza.chiusa) {
        rimosse += 1;
        continue;
      }
    }
    const vuota = stanza.giocatori.size === 0 || [...stanza.giocatori.values()].every((g) => !g.connesso);
    const maiUsata = stanza.maiUsata && stanza.giocatori.size === 0 && t - stanza.creataIl > TEMPI.STANZA_MAI_USATA_MS;
    const daRimuovere =
      maiUsata ||
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
    giocatori: [...s.giocatori.values()].map((g) => ({ id: g.id, nome: g.nome, colore: g.colore, token: g.token })),
    stato: s.stato,
  }));
}

/**
 * Ricrea le stanze salvate. Tutti i giocatori risultano disconnessi: rientrano
 * con il token che il loro browser ha conservato. Le voci malformate o con un
 * codice già in uso vengono saltate. Ritorna il numero di stanze ripristinate.
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
        id: g.id, nome: String(g.nome), colore: String(g.colore), token: g.token, connesso: false, socket: null, disconnessoIl: t,
      });
    }
    const stato = structuredClone(d.stato);
    for (const g of stato.giocatori) g.connesso = false;
    registro.set(d.codice, {
      codice: d.codice,
      hostId: d.hostId ?? null,
      creataIl: Number(d.creataIl) || t,
      aggiornataIl: t,
      vuotaDal: t,
      creataDa: d.creataDa || null,
      maiUsata: Boolean(d.maiUsata),
      progresso: 0,
      saltiInattivita: 0,
      inattivita: null,
      giocatori,
      timer: new Map(),
      stato,
    });
    n += 1;
  }
  return n;
}

function rimuovi(codice) {
  const stanza = registro.get(P.normalizzaCodice(codice));
  if (!stanza) return false;
  chiudiStanza(stanza, 'La stanza è stata chiusa');
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
  programmaInattivita,
  preavvisaInattivita,
  scadutaInattivita,
  pulisci,
  esporta,
  importa,
  rimuovi,
  azzera,
};
