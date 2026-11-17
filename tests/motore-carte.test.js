'use strict';

/**
 * tests/motore-carte.test.js
 * Tutte le 32 carte (16 Probabilità + 16 Imprevisti): la carta voluta viene
 * messa in cima al mazzo e il giocatore A viene fatto arrivare sulla
 * casella Probabilità/Imprevisti con un lancio (1, 2) non doppio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./aiuti');
const CARTE = require('../server/gioco/carte');

const { A, B, C } = H.ID;
const { giocatore } = H;
const tipi = (r) => r.eventi.map((e) => e.tipo);

/** Pesca `idCarta` con A sulla casella `casella` (P: 17 o 33, I: 7, 22 o 36). */
function pesca(base, idCarta, { casella, extra = [] } = {}) {
  const mazzo = idCarta[0] === 'P' ? 'probabilita' : 'imprevisti';
  const dove = casella ?? (idCarta[0] === 'P' ? 17 : 22);
  const s = H.modifica(base, (x) => { x.mazzi[mazzo] = [idCarta, ...x.mazzi[mazzo].filter((id) => id !== idCarta)]; });
  const r = H.arrivaSu(s, A, dove, 1, 2, ...extra);
  const carta = r.eventi.find((e) => e.tipo === 'carta');
  assert.ok(carta && carta.dati.carta.id === idCarta, `la carta pescata doveva essere ${idCarta}`);
  return r;
}

const soldiA = (r) => giocatore(r.stato, A).denaro;

test('carte: i mazzi iniziali contengono tutte le 32 carte, mescolate con il generatore iniettato', () => {
  const s = H.nuovaPartita();
  assert.deepEqual([...s.mazzi.probabilita].sort(), CARTE.PROBABILITA.map((c) => c.id), 'il mazzo Probabilità deve contenere P01-P16');
  assert.deepEqual([...s.mazzi.imprevisti].sort(), CARTE.IMPREVISTI.map((c) => c.id), 'il mazzo Imprevisti deve contenere I01-I16');
  assert.deepEqual(s.mazzi, H.nuovaPartita().mazzi, 'con lo stesso seme l\'ordine dei mazzi è identico');
});

test('carte di denaro: incassi e pagamenti alla banca', () => {
  const tabella = [['P02', 200], ['P03', -50], ['P04', 50], ['P08', 20], ['P09', 100], ['P10', -100], ['P11', -150],
    ['P12', 25], ['P14', 10], ['P15', 100], ['P16', 100], ['I07', 50], ['I12', -15], ['I16', 150]];
  for (const [id, delta] of tabella) {
    const r = pesca(H.nuovaPartita(), id);
    assert.equal(soldiA(r), 1500 + delta, `${id}: il saldo deve variare di ${delta} €`);
    assert.equal(r.stato.fase, 'mossa', `${id}: dopo la carta si può solo finire il turno`);
    assert.ok(tipi(r).includes('carta'));
    assert.equal(giocatore(r.stato, B).denaro, 1500, `${id}: gli altri giocatori non sono toccati`);
  }
});

test('carte: la carta pescata va in fondo al mazzo (tranne "Uscite gratis di prigione")', () => {
  const r = pesca(H.nuovaPartita(), 'P02');
  assert.equal(r.stato.mazzi.probabilita.at(-1), 'P02', 'Regola: la carta usata torna in fondo al mazzo');
  assert.equal(r.stato.mazzi.probabilita.length, 16);
});

test('carte di spostamento: destinazione, 200 € al Via solo se si passa e fase successiva', () => {
  // [carta, casella di pesca, posizione finale, passa dal Via?, fase]
  const tabella = [
    ['P01', 17, 0, true, 'mossa'], ['P01', 33, 0, true, 'mossa'], ['I01', 22, 0, true, 'mossa'], ['I01', 36, 0, true, 'mossa'],
    ['I02', 22, 24, false, 'daDecidereAcquisto'], ['I02', 36, 24, true, 'daDecidereAcquisto'],
    ['I03', 22, 11, true, 'daDecidereAcquisto'], ['I03', 7, 11, false, 'daDecidereAcquisto'],
    ['I04', 22, 28, false, 'daDecidereAcquisto'], ['I04', 36, 12, true, 'daDecidereAcquisto'],
    ['I05', 22, 25, false, 'daDecidereAcquisto'], ['I05', 36, 5, true, 'daDecidereAcquisto'],
    ['I06', 22, 25, false, 'daDecidereAcquisto'], ['I06', 36, 5, true, 'daDecidereAcquisto'],
    ['I13', 22, 25, false, 'daDecidereAcquisto'], ['I13', 36, 25, true, 'daDecidereAcquisto'],
    ['I14', 22, 39, false, 'daDecidereAcquisto'], ['I14', 36, 39, false, 'daDecidereAcquisto'],
    ['I09', 22, 19, false, 'daDecidereAcquisto'],
  ];
  for (const [id, casella, finale, via, fase] of tabella) {
    const r = pesca(H.nuovaPartita(), id, { casella });
    const nome = `${id} pescata sulla casella ${casella}`;
    assert.equal(giocatore(r.stato, A).posizione, finale, `${nome}: deve finire sulla casella ${finale}`);
    assert.equal(soldiA(r), via ? 1700 : 1500, `${nome}: ${via ? 'passando dal Via si ritirano 200 €' : 'senza passare dal Via non si ritira nulla'}`);
    assert.equal(tipi(r).includes('passaggioVia'), via, `${nome}: evento passaggioVia ${via ? 'atteso' : 'non atteso'}`);
    assert.equal(r.stato.fase, fase, `${nome}: fase attesa ${fase}`);
  }
});

test('carta "Fate tre passi indietro": non riscuote mai dal Via e applica la casella d\'arrivo', () => {
  let r = pesca(H.nuovaPartita(), 'I09', { casella: 7 }); // 7 → 4: Tassa patrimoniale
  assert.equal(giocatore(r.stato, A).posizione, 4);
  assert.equal(soldiA(r), 1300, 'Regola: tre passi indietro dalla casella 7 portano alla Tassa patrimoniale (200 €)');
  assert.equal(r.stato.fase, 'mossa');
  // A cascata: 36 → 33 (Probabilità) e la carta P02 (+200 €) si applica subito.
  const s = H.modifica(H.nuovaPartita(), (x) => { x.mazzi.probabilita = ['P02', ...x.mazzi.probabilita.filter((id) => id !== 'P02')]; });
  r = pesca(s, 'I09', { casella: 36 });
  assert.equal(giocatore(r.stato, A).posizione, 33);
  assert.equal(r.eventi.filter((e) => e.tipo === 'carta').length, 2, 'la carta d\'arrivo va pescata e applicata');
  assert.equal(soldiA(r), 1700, 'P02 (+200 €), non un passaggio dal Via');
  // Anche con la pedina in casella 1 l'arretramento oltre il Via non paga 200 €.
  const interni = require('../server/gioco/motore')._interni;
  const copia = H.modifica(H.nuovaPartita(), (x) => {
    x.mazzi.imprevisti = ['I09', ...x.mazzi.imprevisti.filter((id) => id !== 'I09')];
    giocatore(x, A).posizione = 1;
  });
  const ctx = interni.nucleo.creaContesto({ ora: H.ORA_FISSA, random: H.rngDeterministico(1) });
  interni.pescaCarta(copia, giocatore(copia, A), ctx, 'imprevisti');
  assert.equal(giocatore(copia, A).posizione, 38, '1 − 3 = 38 (giro all\'indietro)');
  assert.equal(giocatore(copia, A).denaro, 1400, 'solo la Tassa di lusso (100 €): nessun 200 € dal Via andando indietro');
});

test('carte "vai in prigione": niente Via, niente 200 €, la mossa finisce', () => {
  for (const [id, casella] of [['P06', 33], ['I10', 36]]) {
    const r = pesca(H.nuovaPartita(), id, { casella });
    const a = giocatore(r.stato, A);
    assert.equal(a.posizione, 10, `${id}: si va in prigione (casella 10)`);
    assert.equal(a.inPrigione, true);
    assert.equal(a.denaro, 1500, `${id}: Regola: senza passare dal Via e senza ritirare 200 €`);
    assert.equal(r.stato.fase, 'mossa');
    assert.ok(!tipi(r).includes('passaggioVia'));
  }
});

test('carte "Uscite gratis di prigione": il giocatore la conserva e il mazzo ne perde una', () => {
  for (const [id, mazzo] of [['P05', 'probabilita'], ['I08', 'imprevisti']]) {
    const r = pesca(H.nuovaPartita(), id);
    assert.equal(giocatore(r.stato, A).cartePrigione, 1, `${id}: il giocatore tiene la carta`);
    assert.equal(r.stato.cartePrigioneDi[id], A, `${id}: va registrato il proprietario della carta`);
    assert.ok(!r.stato.mazzi[mazzo].includes(id), `${id}: finché è in mano a un giocatore la carta non è nel mazzo`);
    assert.equal(r.stato.mazzi[mazzo].length, 15);
    assert.equal(soldiA(r), 1500);
  }
});

test('carte "pagate per ogni casa e albergo": 40/115 € (Probabilità) e 25/100 € (Imprevisti)', () => {
  const s = H.costruito(H.assegna(H.nuovaPartita(), A, 1, 3, 6), { 1: 2, 3: 2, 6: 5 }); // 4 case + 1 albergo
  assert.equal(soldiA(pesca(s, 'P13')), 1500 - (4 * 40 + 115), 'P13: 4 case × 40 + 1 albergo × 115 = 275 €');
  assert.equal(soldiA(pesca(s, 'I11')), 1500 - (4 * 25 + 100), 'I11: 4 case × 25 + 1 albergo × 100 = 200 €');
  const senza = pesca(H.nuovaPartita(), 'P13');
  assert.equal(soldiA(senza), 1500, 'senza costruzioni non si paga nulla');
  assert.equal(senza.stato.fase, 'mossa');
});

test('carte con più giocatori: compleanno (10 € da tutti) e presidente (50 € a tutti)', () => {
  let r = pesca(H.nuovaPartita(), 'P07');
  assert.deepEqual([soldiA(r), giocatore(r.stato, B).denaro, giocatore(r.stato, C).denaro], [1520, 1490, 1490],
    'P07: ogni altro giocatore paga 10 € a chi pesca');
  r = pesca(H.nuovaPartita(), 'I15');
  assert.deepEqual([soldiA(r), giocatore(r.stato, B).denaro, giocatore(r.stato, C).denaro], [1400, 1550, 1550],
    'I15: chi pesca paga 50 € a ciascun altro giocatore');
  r = pesca(H.modifica(H.nuovaPartita(), (x) => { giocatore(x, C).fallito = true; }), 'I15');
  assert.deepEqual([soldiA(r), giocatore(r.stato, B).denaro], [1450, 1550], 'i falliti non ricevono nulla');
});

test('carte "più vicina": stazione con affitto doppio, società con un lancio del giocatore × 10', () => {
  let r = pesca(H.assegna(H.nuovaPartita(), B, 25), 'I05');
  assert.equal(soldiA(r), 1450, 'I05: stazione di un avversario = doppio dell\'affitto (25 × 2 = 50 €)');
  assert.equal(giocatore(r.stato, B).denaro, 1550);
  r = pesca(H.assegna(H.nuovaPartita(), B, 25, 35), 'I06');
  assert.equal(soldiA(r), 1400, 'I06: con 2 stazioni dell\'avversario l\'affitto base è 50 € → doppio = 100 €');
  r = pesca(H.assegna(H.nuovaPartita(), B, 28), 'I04');
  assert.equal(r.stato.fase, 'lancioAffitto', 'I04: i dadi dell\'affitto li lancia chi ha pescato, non il gioco');
  assert.equal(soldiA(r), 1500, 'finché non lancia non paga nulla');
  assert.deepEqual(r.stato.lancioAffitto, { giocatoreId: A, casella: 28, creditoreId: B, moltiplicatore: 10 });
  assert.deepEqual(r.stato.dadi, [1, 2], 'sul tabellone restano i dadi del movimento');
  assert.ok(r.eventi.some((e) => e.tipo === 'affittoDaLanciare'));
  r = H.lancia(r.stato, A, 3, 4);
  assert.equal(soldiA(r), 1430, 'I04: lancia 3+4 e paga 10 × 7 = 70 €');
  assert.deepEqual(r.stato.dadi, [3, 4], 'i dadi lanciati per l\'affitto si vedono sul tabellone');
  assert.equal(r.stato.lancioAffitto, null);
  const aff = r.eventi.find((e) => e.tipo === 'affitto');
  assert.deepEqual([aff.dati.dadi, aff.dati.moltiplicatore], [[3, 4], 10]);
  r = pesca(H.assegna(H.nuovaPartita(), A, 25), 'I05');
  assert.equal(soldiA(r), 1500, 'sulla propria stazione non si paga');
  assert.equal(r.stato.fase, 'mossa');
});

test('carte con debito: "pagate a ogni giocatore" senza liquidità crea un debito per il secondo creditore', () => {
  const s = H.assegna(H.soldi(H.nuovaPartita(), A, 60), A, 39);
  const r = pesca(s, 'I15');
  assert.equal(giocatore(r.stato, B).denaro, 1550, 'il primo creditore viene pagato subito (60 → 10)');
  assert.equal(r.stato.fase, 'debito', 'Regola: il secondo pagamento (50 €) non è possibile: debito');
  const d = r.stato.debito;
  assert.deepEqual([d.giocatoreId, d.creditoreId, d.importo, d.motivo, d.faseDopo], [A, C, 50, 'pagaATutti', 'mossa']);
  const pagato = H.esegui(r.stato, A, { tipo: 'ipoteca', casella: 39 }); // +200 → salda 50
  assert.equal(pagato.stato.fase, 'mossa');
  assert.equal(giocatore(pagato.stato, C).denaro, 1550);
  assert.equal(soldiA(pagato), 160, '10 + 200 − 50');
});

test('carte con debiti in coda: "10 € da ogni giocatore" con due giocatori senza soldi, poi bancarotte e vittoria', () => {
  const s = H.soldi(H.soldi(H.nuovaPartita(), B, 5), C, 5);
  let r = pesca(s, 'P07');
  assert.equal(r.stato.fase, 'debito');
  assert.equal(r.stato.debito.giocatoreId, B, 'il primo debito riguarda B');
  assert.deepEqual(r.stato.debitiInAttesa.map((d) => d.giocatoreId), [C], 'il debito di C aspetta in coda');
  r = H.esegui(r.stato, B, { tipo: 'dichiaraBancarotta' });
  assert.equal(giocatore(r.stato, B).fallito, true);
  assert.equal(soldiA(r), 1505, 'i 5 € di B passano ad A, creditore del debito');
  assert.equal(r.stato.fase, 'debito', 'dopo la bancarotta di B si apre il debito di C');
  assert.equal(r.stato.debito.giocatoreId, C);
  r = H.esegui(r.stato, C, { tipo: 'dichiaraBancarotta' });
  assert.equal(r.stato.fase, 'finePartita', 'Regola: la partita finisce quando resta un solo giocatore');
  assert.equal(r.stato.vincitoreId, A);
  assert.equal(soldiA(r), 1510);
});
