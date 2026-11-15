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
 */

const crypto = require('node:crypto');
const P = require('./protocollo');
const motore = require('./gioco/motore');

const registro = new Map(); // codice → Stanza

const TEMPI = Object.freeze({
  RIMOZIONE_LOBBY_DISCONNESSO_MS: 60 * 1000,
  STANZA_VUOTA_MS: 10 * 60 * 1000,
  STANZA_INATTIVA_MS: 2 * 60 * 60 * 1000,
  FINE_PARTITA_MS: 30 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// Generatori
// ---------------------------------------------------------------------------

function generaCodice(random = Math.random) {
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

/** Crea una stanza vuota in lobby e la registra. */
function crea({ ora = Date.now, random = Math.random } = {}) {
  const t = ora();
  const stanza = {
    codice: generaCodice(random),
    hostId: null,
    creataIl: t,
    aggiornataIl: t,
    vuotaDal: t,
    giocatori: new Map(),
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
  const nomiUsati = [...stanza.giocatori.values()].map((g) => g.nome.toLowerCase());
  if (nomiUsati.includes(nomeOk.toLowerCase())) return errore('NOME_OCCUPATO');

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
    try { giocatore.socket.close(4000, 'Sostituito da una nuova connessione'); } catch { /* ignora */ }
  }
  giocatore.socket = socket || null;
  giocatore.connesso = true;
  giocatore.disconnessoIl = null;
  stanza.vuotaDal = null;

  const eventi = [evento('connessione', giocatore.id, `${giocatore.nome} è di nuovo online`, { giocatoreId: giocatore.id, connesso: true }, t)];
  if (stanza.stato.fase === 'lobby') sincronizzaLobby(stanza, eventi, t);
  else sincronizzaConnessione(stanza, giocatore.id, true, eventi, t);
  return { stanza, giocatore, eventi };
}

/** Uscita volontaria: solo in lobby. */
function esci(stanza, giocatoreId, { ora = Date.now } = {}) {
  if (!stanza || !stanza.giocatori.has(giocatoreId)) return errore('NON_IN_STANZA');
  if (stanza.stato.fase !== 'lobby') return errore('SOLO_IN_LOBBY');
  const g = stanza.giocatori.get(giocatoreId);
  stanza.giocatori.delete(giocatoreId);
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

/** Il socket si è chiuso: il giocatore resta, marcato come disconnesso. */
function disconnetti(stanza, giocatoreId, { ora = Date.now } = {}) {
  if (!stanza || !stanza.giocatori.has(giocatoreId)) return { eventi: [] };
  const g = stanza.giocatori.get(giocatoreId);
  const t = ora();
  g.socket = null;
  g.connesso = false;
  g.disconnessoIl = t;
  if ([...stanza.giocatori.values()].every((x) => !x.connesso)) stanza.vuotaDal = t;
  const eventi = [evento('connessione', giocatoreId, `${g.nome} ha perso la connessione`, { giocatoreId, connesso: false }, t)];
  if (stanza.stato.fase === 'lobby') sincronizzaLobby(stanza, eventi, t);
  else sincronizzaConnessione(stanza, giocatoreId, false, eventi, t);
  return { eventi };
}

/** Avvia la partita (solo host, almeno 2 giocatori connessi). */
function avvia(stanza, giocatoreId, { random = Math.random, ora = Date.now } = {}) {
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
  return { eventi };
}

/** Applica un'azione di gioco tramite il motore e aggiorna la stanza. */
function applica(stanza, giocatoreId, azione, { random = Math.random, ora = Date.now } = {}) {
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
  return { eventi: Array.isArray(esito.eventi) ? esito.eventi : [] };
}

/** Lo stato come va inviato ai client (senza mazzi). */
function statoPerClient(stanza) {
  return motore.statoPubblico(stanza.stato);
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
    const daRimuovere =
      (vuota && stanza.vuotaDal && t - stanza.vuotaDal > TEMPI.STANZA_VUOTA_MS) ||
      t - stanza.aggiornataIl > TEMPI.STANZA_INATTIVA_MS ||
      (stanza.stato.fase === 'finePartita' && t - stanza.aggiornataIl > TEMPI.FINE_PARTITA_MS);
    if (daRimuovere) {
      registro.delete(stanza.codice);
      stanza.chiusa = true;
      // Avvisa chi è ancora collegato (stanza inattiva o partita finita da tempo).
      broadcast(stanza, P.errore('STANZA_INESISTENTE', { messaggio: 'La stanza è stata chiusa per inattività' }));
      for (const g of stanza.giocatori.values()) g.socket = null;
      rimosse += 1;
    }
  }
  return rimosse;
}

function rimuovi(codice) {
  return registro.delete(P.normalizzaCodice(codice));
}

/** Svuota il registro (per i test). */
function azzera() {
  registro.clear();
}

module.exports = {
  TEMPI,
  generaCodice,
  generaId,
  generaToken,
  crea,
  trova,
  tutte,
  entra,
  riconnetti,
  esci,
  disconnetti,
  avvia,
  applica,
  statoPerClient,
  broadcast,
  diffondiAggiornamento,
  pulisci,
  rimuovi,
  azzera,
};
