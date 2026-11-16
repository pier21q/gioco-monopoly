'use strict';

/**
 * tests/motore-ordine.test.js
 *
 * Lancio iniziale (fase 'ordine'): tutti lanciano i due dadi, chi fa di più
 * comincia; chi pareggia rilancia solo contro chi ha il suo stesso punteggio,
 * finché ogni posizione è decisa, dalla prima all'ultima.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const stanze = require('../server/stanze');
const H = require('./aiuti');

const { A, B, C, D } = H.ID;

const conLancio = (n) => H.nuovaPartita(n, { lancioIniziale: true });
/** Il giocatore di turno lancia (d1, d2): deve essere `id`. */
function tira(stato, id, d1, d2) {
  assert.equal(stato.turno.giocatoreId, id, `doveva lanciare ${id}, invece tocca a ${stato.turno.giocatoreId}`);
  return H.lancia(stato, id, d1, d2).stato;
}
const ordineDi = (stato) => stato.giocatori.map((g) => g.id);
const tipi = (stato) => stato.log.map((e) => e.tipo);

test('lancio iniziale: si parte in fase "ordine", lancia per primo il primo della sala d\'attesa', () => {
  const s = conLancio(3);
  assert.equal(s.fase, 'ordine');
  assert.equal(s.turno.giocatoreId, A);
  assert.equal(s.turno.numero, 0, 'il turno 1 comincia solo a ordine deciso');
  assert.deepEqual(s.ordine, { giro: 1, gruppi: [[A, B, C]], lanci: {}, storico: [] });
  assert.deepEqual(tipi(s), ['partitaIniziata'], 'nessun evento "turno" prima di sapere chi comincia');
  assert.ok(s.giocatori.every((g) => g.denaro === 1500), 'il denaro si dà subito');
  H.verificaJson(s);
});

test('lancio iniziale: senza pareggi l\'ordine segue i punteggi, dal più alto', () => {
  let s = conLancio(3);
  s = tira(s, A, 3, 4); // 7
  assert.equal(s.fase, 'ordine');
  assert.deepEqual(s.ordine.lanci, { [A]: [3, 4] });
  s = tira(s, B, 5, 6); // 11
  s = tira(s, C, 1, 2); // 3
  assert.equal(s.fase, 'daLanciare');
  assert.deepEqual(ordineDi(s), [B, A, C]);
  assert.deepEqual(s.turno, { giocatoreId: B, numero: 1, doppiConsecutivi: 0, soste: [] });
  assert.equal(s.ordine, null);
  assert.equal(s.dadi, null, 'i dadi del lancio iniziale non contano come primo lancio');
  assert.ok(s.giocatori.every((g) => g.posizione === 0), 'nessuno si è mosso');
  const deciso = s.log.find((e) => e.tipo === 'ordineDeciso');
  assert.deepEqual(deciso.dati.ordine, [B, A, C]);
  assert.match(deciso.testo, /Comincia Bruno.*1\. Bruno, 2\. Anna, 3\. Carla/);
  assert.equal(s.log.at(-1).tipo, 'turno');
  // Da qui è una partita normale: tocca a Bruno.
  H.rifiuta(s, A, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO', 'Comincia chi ha fatto di più');
  H.esegui(s, B, { tipo: 'lanciaDadi' }, H.dadi(1, 2), 'Il primo dell\'ordine lancia');
});

test('lancio iniziale: pareggio per il primo posto, rilanciano solo i due che hanno pareggiato', () => {
  let s = conLancio(3);
  s = tira(s, A, 5, 5); // 10
  s = tira(s, B, 4, 6); // 10
  s = tira(s, C, 1, 1); // 2: è terzo, non rilancia
  assert.equal(s.fase, 'ordine');
  assert.equal(s.ordine.giro, 2);
  assert.deepEqual(s.ordine.gruppi, [[A, B], [C]]);
  const sp = s.log.find((e) => e.tipo === 'spareggio');
  assert.deepEqual(sp.dati.giocatori, [A, B]);
  assert.equal(sp.dati.da, 1);
  assert.match(sp.testo, /Anna e Bruno fanno tutti 10: rilanciano per decidere chi comincia/);
  assert.deepEqual(s.ordine.storico, [{ giro: 1, lanci: { [A]: [5, 5], [B]: [4, 6], [C]: [1, 1] } }]);
  s = tira(s, A, 1, 2); // 3
  s = tira(s, B, 3, 3); // 6
  assert.equal(s.fase, 'daLanciare');
  assert.deepEqual(ordineDi(s), [B, A, C]);
  const lanciB = s.log.filter((e) => e.tipo === 'lancioOrdine' && e.giocatoreId === B);
  assert.deepEqual(lanciB.map((e) => e.dati.spareggio), [false, true]);
});

test('lancio iniziale: spareggi a catena anche per le posizioni dopo la prima', () => {
  let s = conLancio(4);
  s = tira(s, A, 6, 6); // 12: primo
  s = tira(s, B, 2, 3); // 5
  s = tira(s, C, 1, 4); // 5
  s = tira(s, D, 4, 1); // 5
  assert.deepEqual(s.ordine.gruppi, [[A], [B, C, D]]);
  assert.match(s.log.at(-1).testo, /Bruno, Carla e Dario fanno tutti 5: rilanciano per decidere il 2° posto/);
  s = tira(s, B, 3, 3); // 6
  s = tira(s, C, 3, 3); // 6: di nuovo pari con Bruno
  s = tira(s, D, 1, 1); // 2: quarto
  assert.equal(s.ordine.giro, 3);
  assert.deepEqual(s.ordine.gruppi, [[A], [B, C], [D]]);
  s = tira(s, B, 1, 1); // 2
  s = tira(s, C, 2, 2); // 4
  assert.equal(s.fase, 'daLanciare');
  assert.deepEqual(ordineDi(s), [A, C, B, D]);
  assert.equal(s.turno.giocatoreId, A);
});

test('lancio iniziale: due pareggi nello stesso giro si spareggiano insieme, ciascuno per i suoi posti', () => {
  let s = conLancio(4);
  s = tira(s, A, 3, 3); // 6
  s = tira(s, B, 2, 4); // 6
  s = tira(s, C, 1, 1); // 2
  s = tira(s, D, 1, 1); // 2
  assert.deepEqual(s.ordine.gruppi, [[A, B], [C, D]]);
  const sp = s.log.filter((e) => e.tipo === 'spareggio');
  assert.deepEqual(sp.map((e) => [e.dati.da, e.dati.a]), [[1, 2], [3, 4]]);
  s = tira(s, A, 1, 2); // 3
  s = tira(s, B, 2, 2); // 4
  s = tira(s, C, 6, 5); // 11: vince lo spareggio ma resta dietro ad A e B
  s = tira(s, D, 1, 2); // 3
  assert.deepEqual(ordineDi(s), [B, A, C, D]);
});

test('lancio iniziale: solo chi è di turno lancia e si può solo lanciare o abbandonare', () => {
  const s = conLancio(3);
  H.rifiuta(s, B, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO', 'Si lancia uno alla volta');
  for (const tipo of ['finisciTurno', 'pagaCauzione', 'compra']) {
    H.rifiuta(s, A, { tipo }, 'FASE_ERRATA', `${tipo}: prima si decide chi comincia`);
  }
  H.rifiuta(s, A, { tipo: 'proponiScambio', aId: B, offerta: { denaro: 10 }, richiesta: {} }, 'FASE_ERRATA', 'Niente scambi prima di cominciare');
  assert.deepEqual(motore.azioniDisponibili(s, A), ['lanciaDadi', 'abbandona']);
  assert.deepEqual(motore.azioniDisponibili(s, B), ['abbandona']);
  assert.deepEqual(motore.statoPubblico(s).azioni[A], ['lanciaDadi', 'abbandona']);
  assert.deepEqual(motore.chiDeveAgire(s), [A]);
});

test('lancio iniziale: chi abbandona esce dall\'ordine; se il suo rivale resta solo, lo spareggio non serve più', () => {
  let s = conLancio(3);
  s = tira(s, A, 5, 5); // 10
  s = tira(s, B, 4, 6); // 10
  s = tira(s, C, 1, 1); // 2
  assert.deepEqual(s.ordine.gruppi, [[A, B], [C]]);
  s = H.esegui(s, B, { tipo: 'abbandona' }, undefined, 'Bruno abbandona prima dello spareggio').stato;
  assert.equal(s.fase, 'daLanciare', 'Anna resta sola al primo posto: l\'ordine è deciso');
  assert.deepEqual(ordineDi(s), [A, C, B], 'chi è uscito va in fondo');
  assert.equal(H.giocatore(s, B).fallito, true);
  assert.equal(s.turno.giocatoreId, A);

  // Abbandona chi deve lanciare: tocca al successivo.
  let t = conLancio(3);
  t = H.esegui(t, A, { tipo: 'abbandona' }).stato;
  assert.equal(t.fase, 'ordine');
  assert.equal(t.turno.giocatoreId, B);
  t = tira(t, B, 1, 2);
  t = tira(t, C, 2, 2);
  assert.deepEqual(ordineDi(t), [C, B, A]);

  // In due, se uno abbandona la partita finisce.
  const u = H.esegui(conLancio(2), B, { tipo: 'abbandona' }).stato;
  assert.equal(u.fase, 'finePartita');
  assert.equal(u.vincitoreId, A);
});

test('lancio iniziale: per chi non lancia in tempo, o è disconnesso, lancia il gioco', () => {
  const s = conLancio(2);
  const r = motore.gestisciInattivita(s, A, { random: H.dadi(6, 6), ora: H.ORA_FISSA });
  assert.equal(r.stato.turno.giocatoreId, B);
  const ev = r.eventi.find((e) => e.tipo === 'lancioOrdine');
  assert.equal(ev.dati.automatico, 'inattivo');
  assert.equal(ev.dati.totale, 12);
  assert.match(ev.testo, /Anna non lancia in tempo: il gioco lancia al posto suo/);
  assert.deepEqual(motore.gestisciInattivita(s, B, { ora: H.ORA_FISSA }).eventi, [], 'chi non deve lanciare non viene toccato');

  const d = motore.gestisciDisconnessione(r.stato, B, { random: H.dadi(1, 1), ora: H.ORA_FISSA });
  assert.equal(d.stato.fase, 'daLanciare');
  assert.deepEqual(ordineDi(d.stato), [A, B]);
  assert.equal(d.eventi[0].dati.automatico, 'disconnesso');
});

test('lancio iniziale: con dadi casuali finisce sempre con un ordine completo e coerente con i primi lanci', () => {
  for (let seme = 1; seme <= 300; seme += 1) {
    const n = 2 + (seme % 5);
    const random = H.rngDeterministico(seme);
    let s = conLancio(n);
    let passi = 0;
    while (s.fase === 'ordine') {
      passi += 1;
      assert.ok(passi < 500, `seme ${seme}: il lancio iniziale non finisce`);
      const r = motore.applicaAzione(s, s.turno.giocatoreId, { tipo: 'lanciaDadi' }, { random, ora: H.ORA_FISSA });
      assert.equal(r.errore, undefined);
      s = r.stato;
    }
    const ordine = ordineDi(s);
    assert.equal(new Set(ordine).size, n, `seme ${seme}: ognuno compare una volta`);
    assert.equal(s.turno.giocatoreId, ordine[0]);
    // Chi al primo giro ha fatto di più sta davanti, qualunque cosa succeda negli spareggi.
    const primo = {};
    for (const e of s.log) if (e.tipo === 'lancioOrdine' && e.dati.giro === 1) primo[e.giocatoreId] = e.dati.totale;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        assert.ok(primo[ordine[i]] >= primo[ordine[j]], `seme ${seme}: ${ordine[i]} (${primo[ordine[i]]}) non può stare davanti a ${ordine[j]} (${primo[ordine[j]]})`);
      }
    }
  }
});

test('stanze: la partita parte dal lancio iniziale; timer di 60 s, poi lancia il gioco', () => {
  stanze.azzera();
  try {
    const ora = H.ORA_FISSA;
    const socket = () => ({ readyState: 1, send() {}, close() {} });
    const stanza = stanze.crea({ ora, random: H.rngDeterministico(3) });
    const anna = stanze.entra(stanza, { nome: 'Anna', socket: socket(), ora }).giocatore;
    const bruno = stanze.entra(stanza, { nome: 'Bruno', socket: socket(), ora }).giocatore;
    assert.equal(stanze.avvia(stanza, anna.id, { ora, random: H.rngDeterministico(5), regole: {} }).errore, undefined);
    assert.equal(stanza.stato.fase, 'ordine');
    assert.equal(stanza.stato.turno.giocatoreId, anna.id, 'lancia per primo l\'host, il primo della sala d\'attesa');
    assert.equal(stanza.inattivita.scadeIl, ora() + stanze.TEMPI.INATTIVITA_ORDINE_MS);
    stanze.scadutaInattivita(stanza, stanza.inattivita.chiave, { ora, random: H.rngDeterministico(7) });
    assert.equal(stanza.stato.turno.giocatoreId, bruno.id, 'scaduto il tempo, per Anna lancia il gioco');

    // Bruno si disconnette: dopo la tolleranza lancia il gioco anche per lui.
    stanze.disconnetti(stanza, bruno.id, { ora });
    assert.ok(stanza.timer.has(`${bruno.id}|tolleranza`), 'chi deve lanciare e se ne va blocca il lancio iniziale');
    let giri = 0;
    while (stanza.stato.fase === 'ordine') {
      assert.ok((giri += 1) < 50);
      const chi = stanza.stato.turno.giocatoreId;
      if (chi === bruno.id) stanze.sbloccaDisconnesso(stanza, bruno.id, { ora, random: H.rngDeterministico(giri) });
      else stanze.applica(stanza, chi, { tipo: 'lanciaDadi' }, { ora, random: H.rngDeterministico(100 + giri) });
    }
    assert.equal(stanza.stato.fase, 'daLanciare');
    assert.equal(stanza.stato.turno.numero, 1);
  } finally {
    stanze.azzera();
  }
});
