'use strict';

/**
 * tests/dati.test.js — dati statici: tabellone.js (40 caselle) e carte.js (2 × 16 carte).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const TAB = require('../server/gioco/tabellone');
const CARTE = require('../server/gioco/carte');
const H = require('./aiuti');

const per = (tipo) => TAB.CASELLE.filter((c) => c.tipo === tipo);
const COLORI = ['marrone', 'celeste', 'rosa', 'arancione', 'rosso', 'giallo', 'verde', 'blu'];

// ---------------------------------------------------------------------------
// Tabellone
// ---------------------------------------------------------------------------

test('tabellone: 40 caselle numerate da 0 a 39 senza buchi né nomi doppi', () => {
  assert.equal(TAB.CASELLE.length, 40, 'Regola: il tabellone ha 40 caselle');
  TAB.CASELLE.forEach((c, i) => assert.equal(c.indice, i, `la casella in posizione ${i} deve avere indice ${i}, ha ${c.indice}`));
  const nomi = TAB.CASELLE.map((c) => c.nome);
  assert.equal(new Set(nomi.filter((n) => !['Probabilità', 'Imprevisti'].includes(n))).size,
    nomi.filter((n) => !['Probabilità', 'Imprevisti'].includes(n)).length, 'i nomi delle caselle (tranne carte) devono essere unici');
  for (const c of TAB.CASELLE) {
    assert.ok(typeof c.nome === 'string' && c.nome.length > 0, `la casella ${c.indice} deve avere un nome`);
  }
});

test('tabellone: composizione ufficiale (22 vie, 4 stazioni, 2 società, 2 tasse, 3+3 carte, 4 angoli)', () => {
  assert.equal(per('proprieta').length, 22, 'Regola: 22 vie (proprietà a colori)');
  assert.equal(per('stazione').length, 4, 'Regola: 4 stazioni');
  assert.equal(per('societa').length, 2, 'Regola: 2 società');
  assert.equal(per('tassa').length, 2, 'Regola: 2 caselle tassa');
  assert.equal(per('probabilita').length, 3, 'Regola: 3 caselle Probabilità');
  assert.equal(per('imprevisti').length, 3, 'Regola: 3 caselle Imprevisti');
  for (const [tipo, indice] of [['via', 0], ['prigione', 10], ['parcheggio', 20], ['vaiInPrigione', 30]]) {
    assert.equal(per(tipo).length, 1, `deve esistere una sola casella "${tipo}"`);
    assert.equal(per(tipo)[0].indice, indice, `la casella "${tipo}" deve essere in posizione ${indice}`);
  }
  assert.equal(TAB.CASELLE.filter((c) => TAB.acquistabile(c.indice)).length, 28, 'Regola: 28 proprietà acquistabili');
  assert.equal(TAB.INDICE_PRIGIONE, 10);
  assert.equal(TAB.INDICE_VAI_IN_PRIGIONE, 30);
  assert.equal(TAB.STIPENDIO_VIA, 200, 'Regola: il Via paga 200 €');
  assert.equal(TAB.CAUZIONE_PRIGIONE, 50, 'Regola: la cauzione è 50 €');
});

test('tabellone: 8 gruppi di colore con le dimensioni ufficiali (2-3-3-3-3-3-3-2)', () => {
  const gruppiUsati = new Set(per('proprieta').map((c) => c.gruppo));
  assert.deepEqual([...gruppiUsati].sort(), [...COLORI].sort(), 'Regola: le 22 vie sono divise in 8 gruppi colore');
  const attese = { marrone: 2, celeste: 3, rosa: 3, arancione: 3, rosso: 3, giallo: 3, verde: 3, blu: 2 };
  for (const colore of COLORI) {
    assert.equal(TAB.indiciGruppo(colore).length, attese[colore], `il gruppo ${colore} deve avere ${attese[colore]} caselle`);
    assert.equal(TAB.GRUPPI[colore].caselle, attese[colore], `GRUPPI.${colore}.caselle deve coincidere con le caselle reali`);
    assert.match(TAB.GRUPPI[colore].colore, /^#[0-9a-fA-F]{6}$/, `GRUPPI.${colore}.colore deve essere un colore #rrggbb`);
  }
  assert.equal(TAB.indiciGruppo('stazione').length, 4);
  assert.equal(TAB.indiciGruppo('societa').length, 2);
  assert.deepEqual(TAB.indiciGruppo('stazione'), [5, 15, 25, 35], 'le stazioni sono ai quattro lati');
  assert.deepEqual(TAB.indiciGruppo('societa'), [12, 28]);
});

test('tabellone: prezzi, affitti e costo delle case seguono i valori ufficiali', () => {
  const prezzi = { 1: 60, 3: 60, 6: 100, 8: 100, 9: 120, 11: 140, 13: 140, 14: 160, 16: 180, 18: 180, 19: 200,
    21: 220, 23: 220, 24: 240, 26: 260, 27: 260, 29: 280, 31: 300, 32: 300, 34: 320, 37: 350, 39: 400 };
  for (const [i, prezzo] of Object.entries(prezzi)) {
    assert.equal(TAB.casella(Number(i)).prezzo, prezzo, `${TAB.casella(Number(i)).nome} deve costare ${prezzo} €`);
  }
  for (const c of per('proprieta')) {
    assert.equal(c.ipoteca, c.prezzo / 2, `${c.nome}: l'ipoteca vale metà del prezzo`);
    assert.equal(c.affitti.length, 6, `${c.nome}: servono 6 affitti (0-4 case e albergo)`);
    for (let k = 1; k < 6; k += 1) {
      assert.ok(c.affitti[k] > c.affitti[k - 1], `${c.nome}: l'affitto deve crescere con le costruzioni (livello ${k})`);
    }
    const lato = Math.floor(c.indice / 10);
    assert.equal(c.costoCasa, [50, 100, 150, 200][lato], `${c.nome}: costo casa del lato ${lato + 1} del tabellone`);
  }
  assert.deepEqual(TAB.casella(39).affitti, [50, 200, 600, 1400, 1700, 2000], 'Parco della Vittoria: affitti ufficiali');
  assert.deepEqual(TAB.casella(1).affitti, [2, 10, 30, 90, 160, 250], 'Vicolo Corto: affitti ufficiali');
  for (const c of per('stazione')) {
    assert.equal(c.prezzo, 200, `${c.nome}: le stazioni costano 200 €`);
    assert.deepEqual(c.affitti, [25, 50, 100, 200], `${c.nome}: affitti 25/50/100/200 per 1-4 stazioni`);
    assert.equal(c.ipoteca, 100);
  }
  for (const c of per('societa')) {
    assert.equal(c.prezzo, 150, `${c.nome}: le società costano 150 €`);
    assert.deepEqual(c.affitti, [4, 10], `${c.nome}: moltiplicatori dadi 4× e 10×`);
    assert.equal(c.ipoteca, 75);
  }
  assert.equal(TAB.casella(4).importoTassa, 200, 'Tassa patrimoniale 200 €');
  assert.equal(TAB.casella(38).importoTassa, 100, 'Tassa di lusso 100 €');
});

test('tabellone: le funzioni di utilità e l\'immutabilità', () => {
  assert.equal(TAB.casella(40).indice, 0, 'casella(40) fa il giro e torna al Via');
  assert.equal(TAB.casella(-1).indice, 39, 'casella(-1) è l\'ultima casella');
  assert.equal(TAB.prossimaCasellaDiTipo(22, 'societa'), 28);
  assert.equal(TAB.prossimaCasellaDiTipo(28, 'societa'), 12, 'dalla società 28 la prossima è la 12 (giro completo)');
  assert.equal(TAB.prossimaCasellaDiTipo(36, 'stazione'), 5);
  assert.equal(TAB.prossimaCasellaDiTipo(5, 'stazione'), 15, 'la casella di partenza è esclusa');
  assert.equal(TAB.acquistabile(0), false);
  assert.equal(TAB.acquistabile(5), true);
  assert.ok(Object.isFrozen(TAB.CASELLE) && Object.isFrozen(TAB.CASELLE[1]), 'i dati del tabellone devono essere congelati');
  H.verificaJson(JSON.parse(JSON.stringify({ c: TAB.CASELLE, g: TAB.GRUPPI })), 'il tabellone');
});

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------

const MAZZI = { probabilita: ['P', CARTE.PROBABILITA], imprevisti: ['I', CARTE.IMPREVISTI] };

test('carte: due mazzi da 16 carte con id P01-P16 e I01-I16', () => {
  assert.equal(CARTE.PROBABILITA.length, 16, 'Regola: il mazzo Probabilità ha 16 carte');
  assert.equal(CARTE.IMPREVISTI.length, 16, 'Regola: il mazzo Imprevisti ha 16 carte');
  for (const [nome, [prefisso, mazzo]] of Object.entries(MAZZI)) {
    mazzo.forEach((c, i) => {
      assert.equal(c.id, `${prefisso}${String(i + 1).padStart(2, '0')}`, `id atteso della carta ${i + 1} di ${nome}`);
      assert.equal(c.mazzo, nome, `${c.id} deve dichiarare il mazzo ${nome}`);
      assert.ok(typeof c.testo === 'string' && c.testo.length > 10, `${c.id} deve avere un testo`);
      assert.ok(Object.isFrozen(c) && Object.isFrozen(c.effetto), `${c.id} deve essere congelata`);
    });
  }
  const tutti = [...CARTE.PROBABILITA, ...CARTE.IMPREVISTI].map((c) => c.id);
  assert.equal(new Set(tutti).size, 32, 'gli id delle 32 carte devono essere unici');
});

test('carte: ogni effetto ha un tipo noto e parametri validi', () => {
  const intero = (v) => Number.isInteger(v);
  for (const c of [...CARTE.PROBABILITA, ...CARTE.IMPREVISTI]) {
    const e = c.effetto;
    assert.ok(CARTE.TIPI_EFFETTO.includes(e.tipo), `${c.id}: tipo di effetto sconosciuto "${e.tipo}"`);
    switch (e.tipo) {
      case 'denaro': assert.ok(intero(e.importo) && e.importo !== 0, `${c.id}: importo intero diverso da 0`); break;
      case 'vaiA':
        assert.ok(intero(e.casella) && e.casella >= 0 && e.casella < 40, `${c.id}: casella di destinazione 0-39`);
        assert.equal(typeof e.incassaVia, 'boolean', `${c.id}: incassaVia deve essere booleano`);
        break;
      case 'indietro': assert.ok(intero(e.passi) && e.passi > 0 && e.passi < 40, `${c.id}: "passi" (non "caselle") intero positivo`); break;
      case 'pagaPerCasa':
        assert.ok(e.perCasa > 0 && e.perAlbergo > 0 && e.perAlbergo > e.perCasa, `${c.id}: perCasa/perAlbergo positivi, albergo più caro`);
        break;
      case 'riscuotiDaTutti':
      case 'pagaATutti': assert.ok(intero(e.importo) && e.importo > 0, `${c.id}: importo positivo`); break;
      case 'vaiAllaStazionePiuVicina': assert.equal(e.moltiplicatoreAffitto, 2, `${c.id}: affitto doppio`); break;
      case 'vaiAllaSocietaPiuVicina': assert.equal(e.moltiplicatoreDadi, 10, `${c.id}: dieci volte i dadi`); break;
      default: break; // vaiInPrigione, esciGratis: nessun parametro
    }
    assert.equal(H.trovaNonJson(e), null, `${c.id}: l'effetto deve essere serializzabile in JSON`);
  }
});

test('carte: composizione dei mazzi (una carta prigione e un "vai in prigione" per mazzo, destinazioni reali)', () => {
  for (const [nome, [, mazzo]] of Object.entries(MAZZI)) {
    const conta = (tipo) => mazzo.filter((c) => c.effetto.tipo === tipo).length;
    assert.equal(conta('esciGratis'), 1, `Regola: nel mazzo ${nome} c'è una sola carta "Uscite gratis di prigione"`);
    assert.equal(conta('vaiInPrigione'), 1, `Regola: nel mazzo ${nome} c'è una sola carta "Andate in prigione"`);
  }
  assert.equal(CARTE.IMPREVISTI.filter((c) => c.effetto.tipo === 'vaiAllaStazionePiuVicina').length, 2, 'due carte "stazione più vicina"');
  assert.equal(CARTE.IMPREVISTI.filter((c) => c.effetto.tipo === 'vaiAllaSocietaPiuVicina').length, 1, 'una carta "società più vicina"');
  for (const c of [...CARTE.PROBABILITA, ...CARTE.IMPREVISTI].filter((x) => x.effetto.tipo === 'vaiA')) {
    const dest = TAB.casella(c.effetto.casella);
    assert.ok(dest.tipo === 'via' || TAB.acquistabile(dest.indice), `${c.id}: la destinazione "${dest.nome}" deve essere il Via o una proprietà`);
  }
  assert.deepEqual([...CARTE.TIPI_EFFETTO].sort(), [...new Set([...CARTE.PROBABILITA, ...CARTE.IMPREVISTI].map((c) => c.effetto.tipo))]
    .concat(['vaiAllaStazionePiuVicina', 'vaiAllaSocietaPiuVicina'].filter((t) => ![...CARTE.IMPREVISTI].some((c) => c.effetto.tipo === t)))
    .sort(), 'TIPI_EFFETTO deve elencare esattamente i tipi usati dalle carte');
});
