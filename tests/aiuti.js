'use strict';

/**
 * tests/aiuti.js
 *
 * Strumenti condivisi dai test (NON è un file di test: il nome non finisce
 * in ".test.js", quindi `node --test` non lo esegue da solo).
 *
 * - generatori casuali deterministici (`rngDeterministico`, `dadi`);
 * - costruzione di partite di prova e modifica "pulita" dello stato (ogni
 *   funzione che modifica ritorna una COPIA: gli stati dei test non si
 *   sporcano a vicenda);
 * - esecuzione di azioni con messaggi di errore che spiegano la regola;
 * - controllo che uno stato sia serializzabile in JSON.
 */

const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');

const ORA_FISSA = () => 1763204073000;

/** Id dei giocatori di prova: A = Anna (primo di turno), B = Bruno, ... */
const ID = Object.freeze({
  A: 'aaaaaaa1', B: 'bbbbbbb2', C: 'ccccccc3', D: 'ddddddd4', E: 'eeeeeee5', F: 'fffffff6',
});
const SIGLE = ['A', 'B', 'C', 'D', 'E', 'F'];
const NOMI = ['Anna', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio'];
const COLORI = ['#d62828', '#1d4ed8', '#1e8e3e', '#f28c28', '#7c3aed', '#0891b2'];

/** Generatore pseudo-casuale deterministico (mulberry32). */
function rngDeterministico(seme) {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generatore che produce, nell'ordine, i valori di dado indicati (1-6).
 * dadi(3, 4) → il primo dado vale 3 e il secondo 4. Se il motore chiede più
 * numeri casuali di quelli previsti dal test, lancia un errore esplicito.
 */
function dadi(...valori) {
  const coda = valori.map((v) => {
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, `valore di dado non valido nel test: ${v}`);
    return (v - 0.5) / 6;
  });
  return () => {
    if (coda.length === 0) {
      throw new Error('Il motore ha estratto più numeri casuali di quelli previsti dal test (dadi in più)');
    }
    return coda.shift();
  };
}

// ---------------------------------------------------------------------------
// Stati di prova
// ---------------------------------------------------------------------------

function elencoGiocatori(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: ID[SIGLE[i]], nome: NOMI[i], colore: COLORI[i], connesso: true,
  }));
}

/** Partita appena iniziata con n giocatori in ordine fisso (A, B, C...) e 1500 € ciascuno. */
function nuovaPartita(n = 3, opzioni = {}) {
  return motore.creaPartita({
    codice: 'TEST23',
    hostId: ID.A,
    giocatori: elencoGiocatori(n),
    random: rngDeterministico(1),
    ora: ORA_FISSA,
    opzioni: { ordineCasuale: false, ...opzioni },
  });
}

const giocatore = (stato, id) => stato.giocatori.find((g) => g.id === id);
const voce = (stato, indice) => stato.proprieta[String(indice)];

/** Copia dello stato modificata da `fn(copia)`. */
function modifica(stato, fn) {
  const copia = structuredClone(stato);
  fn(copia);
  return copia;
}

/** Riallinea case e alberghi disponibili a quelli costruiti sul tabellone. */
function ricalcolaScorte(s) {
  let nCase = 0;
  let alberghi = 0;
  for (const v of Object.values(s.proprieta)) {
    if (v.caseCostruite === 5) alberghi += 1;
    else nCase += v.caseCostruite;
  }
  s.caseDisponibili = 32 - nCase;
  s.alberghiDisponibili = 12 - alberghi;
}

/** `id` diventa proprietario delle caselle indicate. */
function assegna(stato, id, ...indici) {
  return modifica(stato, (s) => { for (const i of indici) voce(s, i).proprietario = id; });
}

/** Imposta le costruzioni { indice: nCase } (5 = albergo) e ricalcola le scorte. */
function costruito(stato, mappa) {
  return modifica(stato, (s) => {
    for (const [i, n] of Object.entries(mappa)) voce(s, i).caseCostruite = n;
    ricalcolaScorte(s);
  });
}

/** Ipoteca le caselle indicate (senza incassare nulla: è solo preparazione). */
function ipotecate(stato, ...indici) {
  return modifica(stato, (s) => { for (const i of indici) voce(s, i).ipotecata = true; });
}

function soldi(stato, id, importo) {
  return modifica(stato, (s) => { giocatore(s, id).denaro = importo; });
}

function inCasella(stato, id, posizione) {
  return modifica(stato, (s) => { giocatore(s, id).posizione = posizione; });
}

/** Il turno è di `id` nella fase indicata (di norma 'daLanciare'), senza doppi. */
function turnoDi(stato, id, fase = 'daLanciare') {
  return modifica(stato, (s) => {
    s.turno.giocatoreId = id;
    s.turno.doppiConsecutivi = 0;
    s.fase = fase;
  });
}

/** `id` è in prigione (casella 10) con `turni` tentativi già falliti. */
function inPrigione(stato, id, turni = 0) {
  return modifica(stato, (s) => {
    const g = giocatore(s, id);
    g.inPrigione = true;
    g.posizione = 10;
    g.turniInPrigione = turni;
  });
}

/** Dà a `id` una carta "Uscite gratis di prigione" (P05 o I08) togliendola dal mazzo. */
function conCartaPrigione(stato, id, cartaId = 'P05') {
  return modifica(stato, (s) => {
    const mazzo = cartaId.startsWith('P') ? 'probabilita' : 'imprevisti';
    s.mazzi[mazzo] = s.mazzi[mazzo].filter((x) => x !== cartaId);
    s.cartePrigioneDi[cartaId] = id;
    giocatore(s, id).cartePrigione += 1;
  });
}

/** Congela ricorsivamente un valore: ogni tentativo di modifica lancia un errore. */
function congela(valore) {
  if (valore && typeof valore === 'object' && !Object.isFrozen(valore)) {
    Object.freeze(valore);
    for (const figlio of Object.values(valore)) congela(figlio);
  }
  return valore;
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------

function applica(stato, id, azione, random) {
  return motore.applicaAzione(stato, id, azione, { random: random || rngDeterministico(99), ora: ORA_FISSA });
}

/** Esegue un'azione che DEVE essere accettata; ritorna { stato, eventi }. */
function esegui(stato, id, azione, random, regola) {
  const r = applica(stato, id, azione, random);
  const e = r.errore;
  assert.ok(!e, `${regola ? `${regola}: ` : ''}l'azione "${azione.tipo}" doveva essere accettata, ma il motore l'ha rifiutata con ${e && e.codice} (${e && e.messaggio})`);
  return r;
}

/**
 * Verifica che un'azione sia rifiutata con `codice`, che non venga restituito
 * un nuovo stato e che lo stato in ingresso resti identico. Ritorna l'errore.
 */
function rifiuta(stato, id, azione, codice, regola) {
  const prima = JSON.stringify(stato);
  const r = applica(stato, id, azione);
  const nome = azione && azione.tipo;
  assert.ok(r.errore, `${regola}: l'azione "${nome}" doveva essere rifiutata con ${codice}, invece è stata accettata`);
  assert.equal(r.errore.codice, codice,
    `${regola}: codice d'errore atteso ${codice}, ricevuto ${r.errore.codice} (${r.errore.messaggio})`);
  assert.equal(typeof r.errore.messaggio, 'string', `${regola}: l'errore deve avere un messaggio in italiano`);
  assert.ok(r.errore.messaggio.length > 0, `${regola}: il messaggio d'errore non deve essere vuoto`);
  assert.equal(r.stato, undefined, `${regola}: un'azione rifiutata non deve restituire un nuovo stato`);
  assert.equal(JSON.stringify(stato), prima, `${regola}: un'azione rifiutata NON deve modificare lo stato`);
  return r.errore;
}

/** Lancia i dadi per `id` con i valori forzati (più eventuali lanci extra). */
function lancia(stato, id, d1, d2, ...extra) {
  return esegui(stato, id, { tipo: 'lanciaDadi' }, dadi(d1, d2, ...extra), 'lancio dei dadi');
}

/**
 * Posiziona `id` in modo che il lancio (d1, d2) lo faccia arrivare sulla
 * `casella` (senza passare dal Via), imposta il suo turno e lancia.
 */
function arrivaSu(stato, id, casella, d1, d2, ...extra) {
  const partenza = casella - d1 - d2;
  assert.ok(partenza >= 0, `errore nel test: da ${d1}+${d2} non si arriva su ${casella} senza passare dal Via`);
  return lancia(turnoDi(inCasella(stato, id, partenza), id), id, d1, d2, ...extra);
}

// ---------------------------------------------------------------------------
// Serializzazione JSON
// ---------------------------------------------------------------------------

/** Percorso del primo valore non rappresentabile in JSON, oppure null. */
function trovaNonJson(valore, percorso = 'stato', visti = new Set()) {
  if (valore === null) return null;
  const tipo = typeof valore;
  if (tipo === 'string' || tipo === 'boolean') return null;
  if (tipo === 'number') return Number.isFinite(valore) ? null : `${percorso} = ${valore}`;
  if (tipo !== 'object') return `${percorso} (${tipo})`;
  if (visti.has(valore)) return `${percorso} (riferimento circolare)`;
  visti.add(valore);
  if (Array.isArray(valore)) {
    for (let i = 0; i < valore.length; i += 1) {
      const p = trovaNonJson(valore[i], `${percorso}[${i}]`, visti);
      if (p) return p;
    }
  } else {
    const proto = Object.getPrototypeOf(valore);
    if (proto !== Object.prototype && proto !== null) return `${percorso} (oggetto non semplice: ${proto.constructor && proto.constructor.name})`;
    for (const [k, v] of Object.entries(valore)) {
      const p = trovaNonJson(v, `${percorso}.${k}`, visti);
      if (p) return p;
    }
  }
  visti.delete(valore);
  return null;
}

/** Lo stato deve poter viaggiare come JSON senza perdere nulla. */
function verificaJson(stato, etichetta = 'lo stato') {
  const problema = trovaNonJson(stato);
  assert.equal(problema, null, `${etichetta} deve essere serializzabile in JSON, ma contiene un valore non valido: ${problema}`);
  const copia = JSON.parse(JSON.stringify(stato));
  assert.deepEqual(copia, stato, `${etichetta}: dopo JSON.stringify/parse deve restare identico`);
}

module.exports = {
  ORA_FISSA,
  ID,
  rngDeterministico,
  dadi,
  elencoGiocatori,
  nuovaPartita,
  giocatore,
  voce,
  modifica,
  ricalcolaScorte,
  assegna,
  costruito,
  ipotecate,
  soldi,
  inCasella,
  turnoDi,
  inPrigione,
  conCartaPrigione,
  congela,
  applica,
  esegui,
  rifiuta,
  lancia,
  arrivaSu,
  trovaNonJson,
  verificaJson,
};
