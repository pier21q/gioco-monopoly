'use strict';

/**
 * tests/motore-limite-costruzioni.test.js
 *
 * Due varianti facoltative sulle case:
 *   - «Case per turno» (`opzioni.limiteCostruzioni`: 0 = senza limite, oppure
 *     1, 2 o 3): quante costruzioni si possono fare in un turno su ogni
 *     terreno, sempre in modo uniforme; dopo un doppio il conto riparte;
 *   - «Senza tetto» (`opzioni.scorteIllimitate: true`): la banca non finisce
 *     mai né le 32 case né i 12 alberghi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const REGOLE = require('../server/gioco/regole');
const H = require('./aiuti');

const { A, B } = H.ID;

// Gruppo marrone: caselle 1 e 3. Gruppo celeste: 6, 8, 9.
function ricco(opzioni) {
  const s = H.soldi(H.assegna(H.nuovaPartita(2, opzioni), A, 1, 3, 6, 8, 9), A, 9000);
  return H.turnoDi(H.inCasella(s, A, 20), A, 'mossa');
}

/** Costruisce in fila sulle caselle indicate e ritorna lo stato finale. */
function costruisci(stato, ...caselle) {
  let s = stato;
  for (const casella of caselle) s = H.esegui(s, A, { tipo: 'costruisci', casella }).stato;
  return s;
}

const caseSu = (s, ...caselle) => caselle.map((i) => s.proprieta[String(i)].caseCostruite);

test('regola classica: nessun limite alle case costruite in un turno', () => {
  assert.equal(REGOLE.PREDEFINITE.limiteCostruzioni, 0);
  const s = costruisci(ricco(), 1, 3, 1, 3, 1, 3, 1, 3, 1, 3);
  assert.deepEqual(caseSu(s, 1, 3), [5, 5], 'due alberghi in un turno solo');
});

test('variante «Case per turno»: 1, 2 o 3 costruzioni a turno su ogni terreno', () => {
  for (const limite of [1, 2, 3]) {
    const base = ricco({ limiteCostruzioni: limite });
    assert.equal(base.regole.limiteCostruzioni, limite);
    // Si costruisce in modo uniforme: un giro alla volta sul marrone (1 e 3).
    const giri = Array.from({ length: limite }, () => [1, 3]).flat();
    const pieno = costruisci(base, ...giri);
    assert.deepEqual(caseSu(pieno, 1, 3), [limite, limite]);
    assert.deepEqual(pieno.turno.costruite, { 1: limite, 3: limite });
    for (const casella of [1, 3]) {
      const no = H.rifiuta(pieno, A, { tipo: 'costruisci', casella }, 'LIMITE_COSTRUZIONI', `limite ${limite}: una in più aspetta il turno dopo`);
      assert.match(no.messaggio, limite === 1 ? /al massimo una casa per turno/ : new RegExp(`al massimo ${limite} case per turno`));
    }
    // Ogni terreno ha il suo conto: sul celeste si costruisce ancora.
    const celeste = costruisci(pieno, 6, 8, 9);
    assert.deepEqual(caseSu(celeste, 6, 8, 9), [1, 1, 1]);
  }
});

test('variante «Case per turno»: resta l\'obbligo di costruire in modo uniforme', () => {
  const base = ricco({ limiteCostruzioni: 3 });
  const una = costruisci(base, 6);
  H.rifiuta(una, A, { tipo: 'costruisci', casella: 6 }, 'COSTRUZIONE_NON_UNIFORME', 'anche con 3 per terreno non si fa una torre su un terreno solo');
});

test('variante «Case per turno»: dopo un doppio il conto riparte, al turno dopo pure; vendere non restituisce niente', () => {
  const pieno = costruisci(ricco({ limiteCostruzioni: 2 }), 1, 3, 1, 3);
  // Vendere una casa non restituisce una costruzione del turno.
  const venduta = H.esegui(pieno, A, { tipo: 'vendiCasa', casella: 1 }).stato;
  H.rifiuta(venduta, A, { tipo: 'costruisci', casella: 1 }, 'LIMITE_COSTRUZIONI');

  // Prima del lancio ha già costruito il massimo; lancia un doppio: rigioca e può costruire ancora.
  const primaDelLancio = H.modifica(pieno, (s) => { s.fase = 'daLanciare'; });
  H.rifiuta(primaDelLancio, A, { tipo: 'costruisci', casella: 1 }, 'LIMITE_COSTRUZIONI');
  const doppio = H.lancia(primaDelLancio, A, 2, 2).stato;
  assert.equal(doppio.turno.giocatoreId, A);
  assert.equal(doppio.turno.costruite, undefined, 'con il doppio il conto riparte');
  // Un lancio normale invece non azzera niente.
  const normale = H.lancia(primaDelLancio, A, 1, 2).stato;
  assert.deepEqual(normale.turno.costruite, { 1: 2, 3: 2 });

  const dopo = H.esegui(pieno, A, { tipo: 'finisciTurno' }).stato;
  assert.equal(dopo.turno.giocatoreId, B);
  assert.equal(dopo.turno.costruite, undefined, 'il turno nuovo riparte da zero');
  const mioTurno = H.modifica(dopo, (s) => { s.turno.giocatoreId = A; s.fase = 'mossa'; });
  const terza = H.esegui(mioTurno, A, { tipo: 'costruisci', casella: 1 }).stato;
  assert.deepEqual(terza.turno.costruite, { 1: 1 });
  assert.deepEqual(caseSu(terza, 1), [3]);
});

test('variante «Case per turno»: l\'albergo conta come una costruzione', () => {
  const quattro = H.costruito(ricco({ limiteCostruzioni: 1 }), { 1: 4, 3: 4 });
  const albergo = costruisci(quattro, 1);
  assert.deepEqual(caseSu(albergo, 1), [5]);
  H.rifiuta(albergo, A, { tipo: 'costruisci', casella: 1 }, 'LIMITE_COSTRUZIONI');
  H.esegui(albergo, A, { tipo: 'costruisci', casella: 3 }, undefined, 'sull\'altro terreno l\'albergo si può ancora');
});

test('regola classica: finite le 32 case o i 12 alberghi non si costruisce', () => {
  assert.equal(REGOLE.PREDEFINITE.scorteIllimitate, false);
  const senzaCase = H.modifica(ricco(), (s) => { s.caseDisponibili = 0; });
  H.rifiuta(senzaCase, A, { tipo: 'costruisci', casella: 1 }, 'CASE_ESAURITE');
  const senzaAlberghi = H.modifica(H.costruito(ricco(), { 1: 4, 3: 4 }), (s) => { s.alberghiDisponibili = 0; });
  H.rifiuta(senzaAlberghi, A, { tipo: 'costruisci', casella: 1 }, 'ALBERGHI_ESAURITI');
});

test('variante «Senza tetto»: la banca non finisce mai case e alberghi', () => {
  const base = ricco({ scorteIllimitate: true });
  assert.equal(base.regole.scorteIllimitate, true);
  const senzaCase = H.modifica(base, (s) => { s.caseDisponibili = 0; });
  assert.deepEqual(caseSu(costruisci(senzaCase, 1, 3), 1, 3), [1, 1], 'si costruisce anche con la banca a zero');
  const senzaAlberghi = H.modifica(H.costruito(base, { 1: 4, 3: 4 }), (s) => { s.alberghiDisponibili = 0; });
  assert.deepEqual(caseSu(costruisci(senzaAlberghi, 1, 3), 1, 3), [5, 5]);

  // Vendere un albergo con la banca "senza case": torna a 4 case, non si svende tutto il gruppo.
  const alberghi = H.modifica(H.costruito(base, { 1: 5, 3: 5 }), (s) => { s.caseDisponibili = 0; });
  const venduto = H.esegui(alberghi, A, { tipo: 'vendiCasa', casella: 1 }).stato;
  assert.deepEqual(caseSu(venduto, 1, 3), [4, 5]);
  // Con la regola classica, nello stesso caso, si vende tutto il gruppo.
  const classica = H.modifica(H.costruito(ricco(), { 1: 5, 3: 5 }), (s) => { s.caseDisponibili = 0; });
  assert.deepEqual(caseSu(H.esegui(classica, A, { tipo: 'vendiCasa', casella: 1 }).stato, 1, 3), [0, 0]);
});

test('regole: «Case per turno» e «Case e alberghi in banca» nel catalogo, spente se non le si sceglie', () => {
  const limite = REGOLE.REGOLE.find((x) => x.chiave === 'limiteCostruzioni');
  assert.deepEqual(limite.valori.map((v) => v.valore), [0, 1, 2, 3]);
  assert.equal(REGOLE.normalizza({ limiteCostruzioni: 3 }).regole.limiteCostruzioni, 3);
  assert.equal(REGOLE.normalizza({}).regole.limiteCostruzioni, 0);
  assert.ok(REGOLE.normalizza({ limiteCostruzioni: 4 }).errore);
  assert.ok(REGOLE.normalizza({ limiteCostruzioni: true }).errore);
  const scorte = REGOLE.REGOLE.find((x) => x.chiave === 'scorteIllimitate');
  assert.deepEqual(scorte.valori.map((v) => v.valore), [false, true]);
  assert.equal(REGOLE.normalizza({ scorteIllimitate: true }).regole.scorteIllimitate, true);
  // Partite salvate prima che esistessero: valgono le regole classiche.
  assert.equal(REGOLE.valore({ regole: { aste: true } }, 'limiteCostruzioni'), 0);
  assert.equal(REGOLE.valore({ regole: { aste: true } }, 'scorteIllimitate'), false);
});
