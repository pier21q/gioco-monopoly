'use strict';

/**
 * server/gioco/carte.js
 *
 * I due mazzi di carte dell'edizione italiana del Monopoly: PROBABILITA
 * (16 carte) e IMPREVISTI (16 carte). Modulo puro, senza stato: il motore di
 * gioco mescola copie di questi array e applica gli effetti; il client mostra
 * il testo. Il server espone questi dati al browser come ES module generato
 * (`import { PROBABILITA, IMPREVISTI } from '/dati/carte.js'`).
 *
 * Ogni carta ha:
 *   id       identificatore stabile, unico tra i due mazzi: P01-P16 / I01-I16
 *   mazzo    'probabilita' | 'imprevisti'
 *   testo    testo in italiano mostrato al giocatore
 *   effetto  oggetto tipizzato, discriminato dal campo `tipo`:
 *
 *   { tipo: 'denaro', importo }
 *       importo > 0: il giocatore incassa dalla banca
 *       importo < 0: il giocatore paga alla banca
 *   { tipo: 'vaiA', casella, incassaVia }
 *       spostamento sempre in avanti fino a `casella`; se `incassaVia` è
 *       true e si passa (o si arriva) dal Via si ritirano i 200 €
 *   { tipo: 'vaiInPrigione' }
 *       dritti in prigione, senza passare dal Via e senza ritirare 200 €
 *   { tipo: 'esciGratis' }
 *       il giocatore conserva la carta e la usa per uscire di prigione; la
 *       carta torna in fondo al mazzo quando viene usata o venduta
 *   { tipo: 'indietro', passi }
 *       arretra di `passi` caselle e applica l'effetto della casella d'arrivo
 *   { tipo: 'pagaPerCasa', perCasa, perAlbergo }
 *       paga alla banca `perCasa` per ogni casa e `perAlbergo` per ogni
 *       albergo posseduti
 *   { tipo: 'riscuotiDaTutti', importo }
 *       ogni altro giocatore paga `importo` al possessore della carta
 *   { tipo: 'pagaATutti', importo }
 *       il possessore paga `importo` a ciascun altro giocatore
 *   { tipo: 'vaiAllaStazionePiuVicina', moltiplicatoreAffitto }
 *       avanza alla prossima stazione; se è di un avversario paga l'affitto
 *       moltiplicato (x2), se è libera può comprarla
 *   { tipo: 'vaiAllaSocietaPiuVicina', moltiplicatoreDadi }
 *       avanza alla prossima società; se è di un avversario tira i dadi e
 *       paga `moltiplicatoreDadi` volte il risultato, se è libera può
 *       comprarla
 */

// Indici del tabellone usati dalle carte (vedi server/gioco/tabellone.js).
const VIA = 0;
const VIA_ACCADEMIA = 11;
const LARGO_COLOMBO = 24;
const STAZIONE_NORD = 25;
const PARCO_DELLA_VITTORIA = 39;

/** Crea un mazzo numerando le carte con il prefisso dato (P01, P02, ...). */
function mazzo(nomeMazzo, prefisso, definizioni) {
  return Object.freeze(definizioni.map(([testo, effetto], i) => Object.freeze({
    id: `${prefisso}${String(i + 1).padStart(2, '0')}`,
    mazzo: nomeMazzo,
    testo,
    effetto: Object.freeze(effetto),
  })));
}

// ---------------------------------------------------------------------------
// PROBABILITÀ (16 carte) — P01..P16
// ---------------------------------------------------------------------------

const PROBABILITA = mazzo('probabilita', 'P', [
  ['Andate avanti fino al "Via!" e ritirate 200 €.',
    { tipo: 'vaiA', casella: VIA, incassaVia: true }],

  ['Errore bancario a vostro favore: ritirate 200 €.',
    { tipo: 'denaro', importo: 200 }],

  ['Pagate il conto del dottore: 50 €.',
    { tipo: 'denaro', importo: -50 }],

  ['Avete venduto delle azioni: ricavate 50 €.',
    { tipo: 'denaro', importo: 50 }],

  ['Uscite gratis di prigione. Conservate questa carta fino al momento di usarla o venderla.',
    { tipo: 'esciGratis' }],

  ['Andate in prigione direttamente, senza passare dal "Via!" e senza ritirare 200 €.',
    { tipo: 'vaiInPrigione' }],

  ['È il vostro compleanno: ricevete 10 € da ogni giocatore.',
    { tipo: 'riscuotiDaTutti', importo: 10 }],

  ['Rimborso fiscale: ritirate 20 €.',
    { tipo: 'denaro', importo: 20 }],

  ['Matura la vostra polizza vita: ritirate 100 €.',
    { tipo: 'denaro', importo: 100 }],

  ['Pagate le spese ospedaliere: 100 €.',
    { tipo: 'denaro', importo: -100 }],

  ['Pagate la retta scolastica: 150 €.',
    { tipo: 'denaro', importo: -150 }],

  ['Ricevete 25 € per una consulenza.',
    { tipo: 'denaro', importo: 25 }],

  ['Siete tassati per il rifacimento delle strade: pagate 40 € per ogni casa e 115 € per ogni albergo.',
    { tipo: 'pagaPerCasa', perCasa: 40, perAlbergo: 115 }],

  ['Avete vinto il secondo premio in un concorso di bellezza: ritirate 10 €.',
    { tipo: 'denaro', importo: 10 }],

  ['Ereditate 100 €.',
    { tipo: 'denaro', importo: 100 }],

  ['Matura il vostro fondo natalizio: ritirate 100 €.',
    { tipo: 'denaro', importo: 100 }],
]);

// ---------------------------------------------------------------------------
// IMPREVISTI (16 carte) — I01..I16
// ---------------------------------------------------------------------------

const IMPREVISTI = mazzo('imprevisti', 'I', [
  ['Andate avanti fino al "Via!" e ritirate 200 €.',
    { tipo: 'vaiA', casella: VIA, incassaVia: true }],

  ['Andate fino a Largo Colombo. Se passate dal "Via!" ritirate 200 €.',
    { tipo: 'vaiA', casella: LARGO_COLOMBO, incassaVia: true }],

  ['Andate fino a Via Accademia. Se passate dal "Via!" ritirate 200 €.',
    { tipo: 'vaiA', casella: VIA_ACCADEMIA, incassaVia: true }],

  ['Andate alla società più vicina. Se non è di nessuno potete comprarla dalla banca; se è di un altro giocatore, tirate i dadi e pagategli dieci volte il risultato.',
    { tipo: 'vaiAllaSocietaPiuVicina', moltiplicatoreDadi: 10 }],

  ["Andate alla stazione più vicina. Se non è di nessuno potete comprarla dalla banca; se è di un altro giocatore pagategli il doppio dell'affitto dovuto.",
    { tipo: 'vaiAllaStazionePiuVicina', moltiplicatoreAffitto: 2 }],

  ["Andate alla stazione più vicina. Se non è di nessuno potete comprarla dalla banca; se è di un altro giocatore pagategli il doppio dell'affitto dovuto.",
    { tipo: 'vaiAllaStazionePiuVicina', moltiplicatoreAffitto: 2 }],

  ['La Banca vi paga un dividendo di 50 €.',
    { tipo: 'denaro', importo: 50 }],

  ['Uscite gratis di prigione. Conservate questa carta fino al momento di usarla o venderla.',
    { tipo: 'esciGratis' }],

  ['Fate tre passi indietro.',
    { tipo: 'indietro', passi: 3 }],

  ['Andate in prigione direttamente, senza passare dal "Via!" e senza ritirare 200 €.',
    { tipo: 'vaiInPrigione' }],

  ['Eseguite lavori di manutenzione su tutti i vostri edifici: pagate 25 € per ogni casa e 100 € per ogni albergo.',
    { tipo: 'pagaPerCasa', perCasa: 25, perAlbergo: 100 }],

  ['Multa per eccesso di velocità: pagate 15 €.',
    { tipo: 'denaro', importo: -15 }],

  ['Fate un viaggio fino alla Stazione Nord. Se passate dal "Via!" ritirate 200 €.',
    { tipo: 'vaiA', casella: STAZIONE_NORD, incassaVia: true }],

  ['Andate fino a Parco della Vittoria.',
    { tipo: 'vaiA', casella: PARCO_DELLA_VITTORIA, incassaVia: true }],

  ["Siete stati eletti presidente del consiglio d'amministrazione: pagate 50 € a ogni giocatore.",
    { tipo: 'pagaATutti', importo: 50 }],

  ['Maturano le cedole delle vostre cartelle di rendita: ritirate 150 €.',
    { tipo: 'denaro', importo: 150 }],
]);

/** Tutti i tipi di effetto ammessi, utile per validazioni e per il client. */
const TIPI_EFFETTO = Object.freeze([
  'denaro',
  'vaiA',
  'vaiInPrigione',
  'esciGratis',
  'indietro',
  'pagaPerCasa',
  'riscuotiDaTutti',
  'pagaATutti',
  'vaiAllaStazionePiuVicina',
  'vaiAllaSocietaPiuVicina',
]);

module.exports = { PROBABILITA, IMPREVISTI, TIPI_EFFETTO };
