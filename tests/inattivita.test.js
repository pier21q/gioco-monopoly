'use strict';

/**
 * tests/inattivita.test.js
 *
 * Timer d'inattività per i giocatori connessi che non agiscono (server/stanze.js):
 * preavviso, turno saltato, asta passata, acquisto rifiutato, bancarotta del
 * debitore, niente azzeramento con le riconnessioni, stop dopo due giri a
 * vuoto. I timer veri non vengono attesi: si chiamano le funzioni che
 * eseguono allo scadere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const stanze = require('../server/stanze');
const H = require('./aiuti');

const giocatore = (s, id) => s.giocatori.find((g) => g.id === id);

/** Socket finto: raccoglie i messaggi inviati. */
function socketFinto() {
  return { readyState: 1, ricevuti: [], send(t) { this.ricevuti.push(JSON.parse(t)); }, close() { this.readyState = 3; } };
}

/** Stanza con `n` giocatori collegati (socket finti) e partita avviata. */
function stanzaAvviata(n = 2) {
  stanze.azzera();
  const ora = H.ORA_FISSA;
  const stanza = stanze.crea({ ora, random: H.rngDeterministico(3) });
  const socket = [];
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const s = socketFinto();
    socket.push(s);
    ids.push(stanze.entra(stanza, { nome: `G${i}`, socket: s, ora }).giocatore.id);
  }
  assert.equal(stanze.avvia(stanza, ids[0], { ora, random: H.rngDeterministico(5), regole: {} }).errore, undefined);
  H.completaOrdine(stanze, stanza, { ora });
  return { stanza, ora, ids, socket };
}

const scadi = (stanza, ora) => stanze.scadutaInattivita(stanza, stanza.inattivita.chiave, { ora, random: H.rngDeterministico(7) });

test('inattività: all\'avvio parte il timer; scaduto, il giocatore di turno salta il turno', () => {
  const { stanza, ora } = stanzaAvviata();
  try {
    assert.ok(stanza.inattivita, 'a partita avviata il timer d\'inattività è programmato');
    assert.ok(stanza.timer.has('_stanza|scadenza') && stanza.timer.has('_stanza|preavviso'));
    assert.equal(stanza.inattivita.scadeIl, ora() + stanze.TEMPI.INATTIVITA_TURNO_MS);
    const diTurno = stanza.stato.turno.giocatoreId;
    scadi(stanza, ora);
    assert.notEqual(stanza.stato.turno.giocatoreId, diTurno, 'il turno passa');
    const saltato = stanza.stato.log.find((e) => e.tipo === 'turnoSaltato');
    assert.equal(saltato.dati.motivo, 'inattivo');
    assert.equal(giocatore(stanza.stato, diTurno).fallito, false, 'saltare il turno non fa perdere nulla');
    assert.ok(stanza.inattivita, 'il timer riparte per il giocatore successivo');
  } finally {
    stanze.azzera();
  }
});

test('inattività: il preavviso arriva a tutti i socket ma non entra nel log', () => {
  const { stanza, ora, socket } = stanzaAvviata();
  try {
    const lunghezza = stanza.stato.log.length;
    stanze.preavvisaInattivita(stanza, stanza.inattivita.chiave, { ora });
    for (const s of socket) {
      const ev = s.ricevuti.at(-1);
      assert.equal(ev.tipo, 'evento');
      assert.equal(ev.evento.tipo, 'avvisoInattivita');
      assert.deepEqual(ev.evento.dati.giocatori, [stanza.stato.turno.giocatoreId]);
    }
    assert.equal(stanza.stato.log.length, lunghezza);
    // Un preavviso vecchio (la partita è andata avanti) viene ignorato.
    const vecchia = stanza.inattivita.chiave;
    const n = socket[0].ricevuti.length;
    stanze.applica(stanza, stanza.stato.turno.giocatoreId, { tipo: 'lanciaDadi' }, { ora, random: H.rngDeterministico(1) });
    stanze.preavvisaInattivita(stanza, vecchia, { ora });
    assert.equal(socket[0].ricevuti.length, n);
  } finally {
    stanze.azzera();
  }
});

test('inattività: riconnettersi non azzera il tempo; un\'azione sì', () => {
  const { stanza, ora, ids } = stanzaAvviata();
  try {
    const chiave = stanza.inattivita.chiave;
    const altro = ids.find((id) => id !== stanza.stato.turno.giocatoreId);
    stanze.disconnetti(stanza, altro, { ora });
    stanze.riconnetti(stanza.codice, stanza.giocatori.get(altro).token, socketFinto(), { ora });
    assert.equal(stanza.inattivita.chiave, chiave, 'connessioni e riconnessioni non fanno ripartire il timer');
    stanze.applica(stanza, stanza.stato.turno.giocatoreId, { tipo: 'lanciaDadi' }, { ora, random: H.rngDeterministico(1) });
    assert.notEqual(stanza.inattivita.chiave, chiave, 'un\'azione di gioco fa ripartire il timer');
  } finally {
    stanze.azzera();
  }
});

test('inattività: in asta passa chi non risponde; sulla casella libera l\'acquisto va all\'asta', () => {
  const { stanza, ora, ids } = stanzaAvviata(3);
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    stanza.stato = H.modifica(stanza.stato, (s) => { giocatore(s, diTurno).posizione = 1; s.fase = 'daDecidereAcquisto'; });
    stanza.progresso += 1;
    stanze.programmaInattivita(stanza, { ora });
    scadi(stanza, ora);
    assert.equal(stanza.stato.fase, 'asta', 'chi non decide manda la casella all\'asta');
    assert.equal(stanze.TEMPI.INATTIVITA_ASTA_MS, 60 * 1000);
    assert.equal(stanza.inattivita.scadeIl, ora() + stanze.TEMPI.INATTIVITA_ASTA_MS, 'in asta il tempo è più breve');
    // Uno offre, gli altri non rispondono: passano e l'asta si chiude.
    const offerente = ids.find((id) => id !== diTurno);
    stanze.applica(stanza, offerente, { tipo: 'offertaAsta', importo: 10 }, { ora });
    scadi(stanza, ora);
    assert.equal(stanza.stato.asta, null);
    assert.equal(stanza.stato.proprieta['1'].proprietario, offerente);
  } finally {
    stanze.azzera();
  }
});

test('inattività: il debitore che non salda né dichiara viene dichiarato in bancarotta', () => {
  const { stanza, ora, ids } = stanzaAvviata();
  try {
    const [debitore, altro] = ids;
    stanza.stato = H.modifica(stanza.stato, (s) => {
      giocatore(s, debitore).denaro = 0;
      s.fase = 'debito';
      s.debito = { giocatoreId: debitore, creditoreId: null, importo: 100, motivo: 'tassa', casella: 4, faseDopo: 'mossa' };
    });
    stanza.progresso += 1;
    stanze.programmaInattivita(stanza, { ora });
    assert.equal(stanza.inattivita.scadeIl, ora() + stanze.TEMPI.INATTIVITA_DEBITO_MS);
    scadi(stanza, ora);
    assert.equal(giocatore(stanza.stato, debitore).fallito, true);
    assert.equal(stanza.stato.vincitoreId, altro);
    assert.equal(stanza.inattivita, null, 'a partita finita non c\'è più nessun timer');
  } finally {
    stanze.azzera();
  }
});

test('inattività: gli scambi in attesa restano; il timer si ferma dopo due giri a vuoto o senza nessuno collegato', () => {
  const { stanza, ora, ids } = stanzaAvviata();
  try {
    const [a, b] = ids;
    stanza.stato = H.modifica(stanza.stato, (s) => { s.proprieta['1'].proprietario = a; });
    stanze.applica(stanza, a, { tipo: 'proponiScambio', aId: b, offre: { proprieta: [1] } }, { ora });
    scadi(stanza, ora);
    assert.ok(stanza.stato.scambio, 'lo scambio proposto non viene annullato da chi è solo lento');

    // Due giri interi (2 giocatori × 2) di turni saltati senza azioni: la partita aspetta.
    for (let i = 1; i < 4; i += 1) scadi(stanza, ora);
    assert.equal(stanza.saltiInattivita, 4);
    assert.equal(stanza.inattivita, null);
    assert.equal(stanza.timer.has('_stanza|scadenza'), false);
    // Basta un'azione vera per far ripartire tutto.
    stanze.applica(stanza, stanza.stato.turno.giocatoreId, { tipo: 'lanciaDadi' }, { ora, random: H.rngDeterministico(1) });
    assert.ok(stanza.inattivita);

    for (const id of ids) stanze.disconnetti(stanza, id, { ora });
    assert.equal(stanza.inattivita, null, 'senza nessuno collegato non si salta niente');
  } finally {
    stanze.azzera();
  }
});

test('motore.chiDeveAgire: turno, asta (escluso il miglior offerente), debito; nessuno a partita finita', () => {
  const { A, B, C } = H.ID;
  const s = H.nuovaPartita(3);
  assert.deepEqual(motore.chiDeveAgire(s), [A]);
  const asta = H.modifica(s, (x) => {
    x.fase = 'asta';
    x.asta = { casella: 1, offertaMassima: 10, migliorOfferenteId: B, partecipanti: [A, B, C], passati: [C], incrementoMinimo: 1, faseDopo: 'mossa' };
  });
  assert.deepEqual(motore.chiDeveAgire(asta), [A]);
  const debito = H.modifica(s, (x) => { x.fase = 'debito'; x.debito = { giocatoreId: C, creditoreId: null, importo: 5, faseDopo: 'mossa' }; });
  assert.deepEqual(motore.chiDeveAgire(debito), [C]);
  assert.deepEqual(motore.chiDeveAgire(H.modifica(s, (x) => { x.fase = 'finePartita'; })), []);
});
