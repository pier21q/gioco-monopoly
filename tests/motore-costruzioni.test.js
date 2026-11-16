'use strict';

/**
 * tests/motore-costruzioni.test.js
 * Costruzione di case e alberghi (uniformità e limiti della banca), vendita
 * delle case, ipoteca e disipoteca. A possiede il gruppo marrone (1 e 3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./aiuti');

const { A, B } = H.ID;
const { giocatore, voce } = H;
const s0 = () => H.assegna(H.nuovaPartita(), A, 1, 3);
const cost = (s, i) => H.esegui(s, A, { tipo: 'costruisci', casella: i });
const inAsta = () => H.esegui(H.modifica(s0(), (x) => { giocatore(x, A).posizione = 6; x.fase = 'daDecidereAcquisto'; }),
  A, { tipo: 'rifiutaAcquisto' }).stato;

test('costruzione: una casa costa il prezzo di listino e viene tolta dalle 32 della banca', () => {
  const r = cost(s0(), 1);
  assert.equal(voce(r.stato, 1).caseCostruite, 1);
  assert.equal(giocatore(r.stato, A).denaro, 1450, 'Regola: una casa sul gruppo marrone costa 50 €');
  assert.equal(r.stato.caseDisponibili, 31, 'Regola: la banca ha 32 case in tutto');
  assert.equal(r.eventi[0].tipo, 'costruzione');
  const blu = cost(H.assegna(H.nuovaPartita(), A, 37, 39), 37);
  assert.equal(giocatore(blu.stato, A).denaro, 1300, 'sul gruppo blu una casa costa 200 €');
  for (const fase of ['mossa', 'daDecidereAcquisto']) {
    assert.ok(cost(H.turnoDi(s0(), A, fase), 1), `si può costruire anche in fase ${fase}`);
  }
});

test('costruzione uniforme: mai più di una casa di differenza fra le caselle del gruppo', () => {
  let s = cost(s0(), 1).stato; // 1:1, 3:0
  H.rifiuta(s, A, { tipo: 'costruisci', casella: 1 }, 'COSTRUZIONE_NON_UNIFORME', 'Non si costruisce una seconda casa su una via se le altre del gruppo non ne hanno');
  s = cost(s, 3).stato; // 1:1, 3:1
  s = cost(s, 1).stato; // 1:2, 3:1
  assert.deepEqual([voce(s, 1).caseCostruite, voce(s, 3).caseCostruite], [2, 1]);
  const hotel = H.costruito(s0(), { 1: 4, 3: 3 });
  H.rifiuta(hotel, A, { tipo: 'costruisci', casella: 1 }, 'COSTRUZIONE_NON_UNIFORME', 'Non si compra l\'albergo finché le altre vie del gruppo non hanno 4 case');
});

test('costruzione: condizioni di possesso, gruppo completo, ipoteche, fondi, fase e turno', () => {
  H.rifiuta(H.assegna(H.nuovaPartita(), A, 1), A, { tipo: 'costruisci', casella: 1 }, 'GRUPPO_INCOMPLETO', 'Per costruire serve tutto il gruppo di colore');
  H.rifiuta(H.assegna(H.nuovaPartita(), B, 1, 3), A, { tipo: 'costruisci', casella: 1 }, 'PROPRIETA_NON_TUA', 'Si costruisce solo sulle proprie proprietà');
  H.rifiuta(H.assegna(s0(), A, 5), A, { tipo: 'costruisci', casella: 5 }, 'NON_EDIFICABILE', 'Sulle stazioni non si costruisce');
  H.rifiuta(H.assegna(s0(), A, 12), A, { tipo: 'costruisci', casella: 12 }, 'NON_EDIFICABILE', 'Sulle società non si costruisce');
  for (const casella of [0, 2, 10, 20, 30]) {
    H.rifiuta(s0(), A, { tipo: 'costruisci', casella }, 'CASELLA_NON_VALIDA', `La casella ${casella} non è una proprietà`);
  }
  for (const casella of [40, -1, 1.5, '1', undefined, null]) {
    H.rifiuta(s0(), A, { tipo: 'costruisci', casella }, 'PARAMETRI_NON_VALIDI', `L'indice di casella ${JSON.stringify(casella)} non è valido`);
  }
  H.rifiuta(H.ipotecate(s0(), 3), A, { tipo: 'costruisci', casella: 1 }, 'IPOTECATA', 'Non si costruisce se una via del gruppo è ipotecata');
  H.rifiuta(H.soldi(s0(), A, 49), A, { tipo: 'costruisci', casella: 1 }, 'FONDI_INSUFFICIENTI', 'Con 49 € non si compra una casa da 50 €');
  assert.equal(giocatore(cost(H.soldi(s0(), A, 50), 1).stato, A).denaro, 0, 'con esattamente 50 € si può costruire');
  H.rifiuta(s0(), B, { tipo: 'costruisci', casella: 1 }, 'NON_IL_TUO_TURNO', 'Costruisce solo chi è di turno');
  H.rifiuta(inAsta(), A, { tipo: 'costruisci', casella: 1 }, 'FASE_ERRATA', 'Durante un\'asta non si costruisce');
});

test('albergo: 4 case + costo di una casa; le 4 case tornano alla banca; mai oltre l\'albergo', () => {
  const s = H.costruito(s0(), { 1: 4, 3: 4 }); // 8 case sul tabellone → 24 disponibili
  assert.equal(s.caseDisponibili, 24);
  let r = cost(s, 1);
  assert.equal(voce(r.stato, 1).caseCostruite, 5, 'Regola: la quinta costruzione è l\'albergo');
  assert.equal(giocatore(r.stato, A).denaro, 1450, 'l\'albergo costa quanto una casa (50 €) in più delle 4 già presenti');
  assert.equal(r.stato.alberghiDisponibili, 11, 'un albergo in meno nella banca');
  assert.equal(r.stato.caseDisponibili, 28, 'Regola: costruendo l\'albergo le 4 case tornano alla banca');
  H.rifiuta(r.stato, A, { tipo: 'costruisci', casella: 1 }, 'NON_EDIFICABILE', 'Oltre l\'albergo non si può costruire');
  r = cost(r.stato, 3);
  assert.equal(voce(r.stato, 3).caseCostruite, 5, 'anche l\'altra via può avere l\'albergo');
});

test('limiti della banca: 32 case e 12 alberghi', () => {
  H.rifiuta(H.modifica(s0(), (x) => { x.caseDisponibili = 0; }), A, { tipo: 'costruisci', casella: 1 }, 'CASE_ESAURITE', 'Senza case in banca non si può costruire una casa');
  const senzaAlberghi = H.modifica(H.costruito(s0(), { 1: 4, 3: 4 }), (x) => { x.alberghiDisponibili = 0; });
  H.rifiuta(senzaAlberghi, A, { tipo: 'costruisci', casella: 1 }, 'ALBERGHI_ESAURITI', 'Senza alberghi in banca non si può costruire l\'albergo');
  const senzaCase = H.modifica(H.costruito(s0(), { 1: 4, 3: 4 }), (x) => { x.caseDisponibili = 0; });
  const r = cost(senzaCase, 1);
  assert.equal(r.stato.caseDisponibili, 4, 'l\'albergo si può comprare anche senza case in banca (le 4 case tornano)');
  assert.equal(H.costruito(H.nuovaPartita(), {}).caseDisponibili, 32);
  assert.equal(H.costruito(H.nuovaPartita(), {}).alberghiDisponibili, 12);
});

test('vendita: una casa torna alla banca a metà prezzo, sempre in modo uniforme', () => {
  let s = H.costruito(s0(), { 1: 2, 3: 2 });
  let r = H.esegui(s, A, { tipo: 'vendiCasa', casella: 3 });
  assert.equal(giocatore(r.stato, A).denaro, 1525, 'Regola: la banca paga metà del costo della casa (25 €)');
  assert.equal(voce(r.stato, 3).caseCostruite, 1);
  assert.equal(r.stato.caseDisponibili, s.caseDisponibili + 1);
  H.rifiuta(r.stato, A, { tipo: 'vendiCasa', casella: 3 }, 'COSTRUZIONE_NON_UNIFORME', 'Si vende prima dalla via che ha più case');
  r = H.esegui(r.stato, A, { tipo: 'vendiCasa', casella: 1 });
  assert.deepEqual([voce(r.stato, 1).caseCostruite, voce(r.stato, 3).caseCostruite], [1, 1]);
  H.rifiuta(s0(), A, { tipo: 'vendiCasa', casella: 1 }, 'NESSUNA_COSTRUZIONE', 'Non c\'è nulla da vendere');
  H.rifiuta(H.assegna(s0(), A, 5), A, { tipo: 'vendiCasa', casella: 5 }, 'NESSUNA_COSTRUZIONE', 'Su una stazione non ci sono case');
  H.rifiuta(H.costruito(H.assegna(H.nuovaPartita(), B, 1, 3), { 1: 1 }), A, { tipo: 'vendiCasa', casella: 1 }, 'PROPRIETA_NON_TUA', 'Si vendono solo le proprie case');
  s = H.costruito(s0(), { 1: 5, 3: 4 });
  H.rifiuta(s, A, { tipo: 'vendiCasa', casella: 3 }, 'COSTRUZIONE_NON_UNIFORME', 'Prima si vende l\'albergo, che è la costruzione più alta');
});

test('vendita dell\'albergo: torna a 4 case se la banca ne ha 4, a metà prezzo', () => {
  const s = H.costruito(s0(), { 1: 5, 3: 4 });
  const r = H.esegui(s, A, { tipo: 'vendiCasa', casella: 1 });
  assert.equal(voce(r.stato, 1).caseCostruite, 4, 'Regola: l\'albergo venduto torna a 4 case');
  assert.equal(r.stato.alberghiDisponibili, 12);
  assert.equal(r.stato.caseDisponibili, s.caseDisponibili - 4, 'le 4 case vengono prese dalla scorta della banca');
  assert.equal(giocatore(r.stato, A).denaro, 1525);
  // INTERFACCE.md §2.4 e §8.4: se la banca non ha 4 case da restituire,
  // l'albergo si vende per intero (5 × 50 € / 2 = 125 €) e il terreno resta vuoto.
  const povera = H.modifica(s, (x) => { x.caseDisponibili = 3; });
  const t = H.esegui(povera, A, { tipo: 'vendiCasa', casella: 1 }, undefined, 'Senza 4 case in banca l\'albergo si vende per intero');
  assert.equal(voce(t.stato, 1).caseCostruite, 0, 'Regola: senza 4 case in banca l\'albergo viene demolito del tutto');
  assert.equal(t.stato.alberghiDisponibili, 12);
  assert.equal(t.stato.caseDisponibili, 3, 'la banca non restituisce case');
  assert.equal(giocatore(t.stato, A).denaro, 1625, 'si incassa metà del valore di albergo e 4 case');
});

test('ipoteca: incassa metà prezzo; vietata con costruzioni nel gruppo o se già ipotecata', () => {
  const s = H.assegna(H.nuovaPartita(), A, 6, 5, 28);
  let r = H.esegui(s, A, { tipo: 'ipoteca', casella: 6 });
  assert.equal(voce(r.stato, 6).ipotecata, true);
  assert.equal(giocatore(r.stato, A).denaro, 1550, 'Regola: si incassa metà del prezzo (50 €)');
  H.rifiuta(r.stato, A, { tipo: 'ipoteca', casella: 6 }, 'GIA_IPOTECATA', 'Non si ipoteca due volte');
  assert.equal(giocatore(H.esegui(s, A, { tipo: 'ipoteca', casella: 5 }).stato, A).denaro, 1600, 'stazione: 100 €');
  assert.equal(giocatore(H.esegui(s, A, { tipo: 'ipoteca', casella: 28 }).stato, A).denaro, 1575, 'società: 75 €');
  H.rifiuta(H.costruito(s0(), { 1: 1 }), A, { tipo: 'ipoteca', casella: 3 }, 'HA_COSTRUZIONI',
    'Non si ipoteca una via se in QUALSIASI via del gruppo ci sono costruzioni');
  H.rifiuta(s, B, { tipo: 'ipoteca', casella: 6 }, 'NON_IL_TUO_TURNO', 'Fuori turno (e senza debito) non si ipoteca');
  H.rifiuta(s, A, { tipo: 'ipoteca', casella: 1 }, 'PROPRIETA_NON_TUA', 'Si ipotecano solo le proprie proprietà');
  r = H.esegui(H.turnoDi(s, A, 'mossa'), A, { tipo: 'ipoteca', casella: 6 });
  assert.equal(voce(r.stato, 6).ipotecata, true, 'si può ipotecare anche dopo aver lanciato');
});

test('disipoteca: costa l\'ipoteca più il 10% arrotondato per eccesso', () => {
  // casella → costo atteso: 6: 50+5, 1: 30+3, 28 (società): 75+ceil(7,5)=83, 5 (stazione): 100+10
  for (const [casella, costo] of [[6, 55], [1, 33], [28, 83], [5, 110]]) {
    const s = H.ipotecate(H.assegna(H.nuovaPartita(), A, casella), casella);
    const r = H.esegui(s, A, { tipo: 'disipoteca', casella });
    assert.equal(giocatore(r.stato, A).denaro, 1500 - costo, `togliere l'ipoteca alla casella ${casella} deve costare ${costo} €`);
    assert.equal(voce(r.stato, casella).ipotecata, false);
    H.rifiuta(H.soldi(s, A, costo - 1), A, { tipo: 'disipoteca', casella }, 'FONDI_INSUFFICIENTI', `con ${costo - 1} € non si toglie l'ipoteca da ${costo} €`);
  }
  H.rifiuta(H.assegna(H.nuovaPartita(), A, 6), A, { tipo: 'disipoteca', casella: 6 }, 'NON_IPOTECATA', 'Non si può disipotecare ciò che non è ipotecato');
  H.rifiuta(H.ipotecate(H.assegna(H.nuovaPartita(), B, 6), 6), A, { tipo: 'disipoteca', casella: 6 }, 'PROPRIETA_NON_TUA', 'Si disipotecano solo le proprie proprietà');
  H.rifiuta(inAsta(), A, { tipo: 'disipoteca', casella: 1 }, 'FASE_ERRATA', 'Durante un\'asta non si disipoteca');
});
