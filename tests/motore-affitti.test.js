'use strict';

/**
 * tests/motore-affitti.test.js
 * Affitti (semplici, gruppo completo, case e alberghi, stazioni, società),
 * caselle ipotecate, tasse e debiti nati da affitti e tasse.
 * B è sempre chi paga, A il proprietario.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const H = require('./aiuti');

const { A, B } = H.ID;
const { giocatore } = H;
const base = () => H.nuovaPartita();
const denaro = (r, id) => giocatore(r.stato, id).denaro;

test('affitto semplice: chi arriva su una proprietà altrui paga l\'affitto base al proprietario', () => {
  const r = H.arrivaSu(H.assegna(base(), A, 11), B, 11, 3, 4); // Via Accademia, affitto base 10 €
  assert.equal(denaro(r, B), 1490, 'Regola: si paga l\'affitto base (10 €) a chi possiede la via');
  assert.equal(denaro(r, A), 1510, 'il proprietario incassa l\'affitto');
  const e = r.eventi.find((x) => x.tipo === 'affitto');
  assert.ok(e, 'deve esserci un evento "affitto"');
  assert.deepEqual([e.dati.daId, e.dati.aId, e.dati.casella, e.dati.importo], [B, A, 11, 10]);
  assert.equal(r.stato.fase, 'mossa');
});

test('affitto: con il gruppo completo e nessuna costruzione l\'affitto base è raddoppiato', () => {
  const s = H.assegna(base(), A, 11, 13, 14);
  assert.equal(denaro(H.arrivaSu(s, B, 11, 3, 4), B), 1480, 'Regola: gruppo completo senza case = affitto doppio (20 €)');
  // Regola dichiarata in INTERFACCE.md §8.3: il raddoppio vale anche se un'altra casella è ipotecata.
  const conIpoteca = H.ipotecate(s, 13);
  assert.equal(denaro(H.arrivaSu(conIpoteca, B, 11, 3, 4), B), 1480, 'il raddoppio resta anche con un\'altra casella del gruppo ipotecata');
  assert.equal(motore.calcolaAffitto(H.assegna(base(), A, 11, 13), 11).importo, 10, 'con il gruppo incompleto l\'affitto non raddoppia');
});

test('affitto: case e alberghi usano la tabella ufficiale della proprietà', () => {
  const attesi = [20, 50, 150, 450, 625, 750]; // Via Accademia con 0..4 case e albergo (0 case = base doppio)
  attesi.forEach((importo, n) => {
    const s = H.costruito(H.assegna(base(), A, 11, 13, 14), { 11: n, 13: n, 14: n });
    assert.equal(motore.calcolaAffitto(s, 11).importo, importo, `Via Accademia con ${n === 5 ? 'albergo' : `${n} case`} deve rendere ${importo} €`);
  });
  const s = H.costruito(H.assegna(base(), A, 11, 13, 14), { 11: 5, 13: 5, 14: 5 });
  const r = H.arrivaSu(s, B, 11, 3, 4);
  assert.equal(denaro(r, B), 750, 'Regola: con l\'albergo si pagano 750 € su Via Accademia');
  assert.equal(denaro(r, A), 2250);
});

test('affitto: una casella ipotecata non fa pagare nulla', () => {
  const s = H.ipotecate(H.assegna(base(), A, 11), 11);
  const r = H.arrivaSu(s, B, 11, 3, 4);
  assert.equal(denaro(r, B), 1500, 'Regola: sulle proprietà ipotecate non si paga l\'affitto');
  assert.equal(denaro(r, A), 1500);
  assert.equal(motore.calcolaAffitto(s, 11).importo, 0);
  assert.equal(r.stato.fase, 'mossa');
});

test('affitto: si paga anche se il proprietario è in prigione o disconnesso', () => {
  let s = H.inPrigione(H.assegna(base(), A, 11), A);
  assert.equal(denaro(H.arrivaSu(s, B, 11, 3, 4), A), 1510, 'Regola: chi è in prigione incassa gli affitti');
  s = H.modifica(H.assegna(base(), A, 11), (x) => { giocatore(x, A).connesso = false; });
  assert.equal(denaro(H.arrivaSu(s, B, 11, 3, 4), B), 1490, 'l\'affitto è dovuto anche se il proprietario è offline');
});

test('stazioni: 25/50/100/200 € in base al numero di stazioni possedute (le ipotecate contano)', () => {
  [[[5], 25], [[5, 15], 50], [[5, 15, 25], 100], [[5, 15, 25, 35], 200]].forEach(([possedute, importo]) => {
    const s = H.assegna(base(), A, ...possedute);
    assert.equal(motore.calcolaAffitto(s, 5).importo, importo, `con ${possedute.length} stazioni l'affitto è ${importo} €`);
  });
  const s = H.ipotecate(H.assegna(base(), A, 5, 15), 15);
  const r = H.arrivaSu(s, B, 5, 2, 3);
  assert.equal(denaro(r, B), 1450, 'Regola (INTERFACCE §8.3): le stazioni ipotecate contano nel numero → 2 stazioni = 50 €');
  assert.deepEqual(motore.calcolaAffitto(H.assegna(base(), A, 5), 5, { moltiplicatore: 2 }), { importo: 50, moltiplicatore: 2 });
});

test('società: 4× i dadi con una società, 10× con due', () => {
  let r = H.arrivaSu(H.assegna(base(), A, 12), B, 12, 3, 4); // dadi 7
  assert.equal(denaro(r, B), 1500 - 28, 'Regola: una società = 4 volte il lancio (7 × 4 = 28 €)');
  assert.deepEqual(r.eventi.find((e) => e.tipo === 'affitto').dati.dadi, [3, 4]);
  r = H.arrivaSu(H.assegna(base(), A, 12, 28), B, 12, 3, 4);
  assert.equal(denaro(r, B), 1500 - 70, 'Regola: due società = 10 volte il lancio (7 × 10 = 70 €)');
  assert.equal(denaro(r, A), 1570);
});

test('tasse: la Tassa patrimoniale costa 200 € e la Tassa di lusso 100 €', () => {
  let r = H.arrivaSu(base(), B, 4, 1, 3);
  assert.equal(denaro(r, B), 1300, 'Regola: Tassa patrimoniale = 200 € alla banca');
  assert.ok(r.eventi.some((e) => e.tipo === 'tassa'));
  assert.equal(r.stato.fase, 'mossa');
  r = H.arrivaSu(base(), B, 38, 3, 4);
  assert.equal(denaro(r, B), 1400, 'Regola: Tassa di lusso = 100 € alla banca');
  assert.equal(denaro(r, A), 1500, 'le tasse vanno alla banca, non agli altri giocatori');
});

test('debito: senza soldi per un affitto si apre un debito (mai denaro negativo) e si salda ipotecando', () => {
  const s = H.soldi(H.assegna(H.assegna(base(), A, 11), B, 1), B, 5);
  const r = H.arrivaSu(s, B, 11, 3, 4); // affitto 10 €, B ha 5 €
  assert.equal(r.stato.fase, 'debito', 'Regola: chi non può pagare entra in fase debito');
  assert.equal(denaro(r, B), 5, 'il denaro non deve diventare negativo');
  assert.equal(denaro(r, A), 1500, 'finché non paga, il creditore non incassa');
  const d = r.stato.debito;
  assert.deepEqual([d.giocatoreId, d.creditoreId, d.importo, d.motivo, d.casella, d.faseDopo], [B, A, 10, 'affitto', 11, 'mossa']);
  assert.deepEqual(motore.azioniDisponibili(r.stato, B), ['vendiCasa', 'ipoteca', 'proponiScambio', 'dichiaraBancarotta']);
  assert.deepEqual(motore.azioniDisponibili(r.stato, A), ['proponiScambio']);
  H.rifiuta(r.stato, B, { tipo: 'finisciTurno' }, 'FASE_ERRATA', 'Con un debito aperto non si può finire il turno');
  H.rifiuta(r.stato, A, { tipo: 'ipoteca', casella: 11 }, 'NON_DEBITORE', 'Durante il debito di B solo B può ipotecare');

  const pagato = H.esegui(r.stato, B, { tipo: 'ipoteca', casella: 1 }); // +30 → 35 ≥ 10: salda da solo
  assert.equal(pagato.stato.fase, 'mossa', 'saldato il debito si torna alla fase precedente');
  assert.equal(pagato.stato.debito, null);
  assert.equal(denaro(pagato, B), 25, '5 + 30 (ipoteca) − 10 (affitto)');
  assert.equal(denaro(pagato, A), 1510);
  assert.ok(pagato.eventi.some((e) => e.tipo === 'debitoSaldato'));
});

test('debito: una tassa non pagabile diventa un debito verso la banca', () => {
  const r = H.arrivaSu(H.soldi(base(), B, 150), B, 4, 1, 3);
  assert.equal(r.stato.fase, 'debito');
  const d = r.stato.debito;
  assert.deepEqual([d.giocatoreId, d.creditoreId, d.importo, d.motivo, d.casella], [B, null, 200, 'tassa', 4]);
  assert.equal(denaro(r, B), 150);
  H.verificaJson(r.stato);
});
