'use strict';

/**
 * tests/motore-regole.test.js
 *
 * Test delle regole del motore (fase 2). Esecuzione:
 *   node --test tests/motore-regole.test.js
 *
 * Tutti i lanci di dadi sono forzati con un generatore iniettato: `dadi(2, 5)`
 * produce esattamente un 2 e poi un 5. Gli stati di partenza vengono
 * preparati a mano (posizioni, proprietà, denaro) su copie fresche.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const motore = require('../server/gioco/motore');
const scambi = require('../server/gioco/scambi');
const bancarotta = require('../server/gioco/bancarotta');
const CARTE = require('../server/gioco/carte');
const TAB = require('../server/gioco/tabellone');

const ORA = () => 1763204073000;
const A = 'anna0001';
const B = 'bruno002';
const C = 'carla003';

/** Generatore che restituisce i valori dei dadi indicati, nell'ordine. */
function dadi(...valori) {
  const coda = valori.map((v) => (v - 0.5) / 6);
  return () => {
    if (coda.length === 0) throw new Error('il test non ha previsto altri lanci di dadi');
    return coda.shift();
  };
}

/** Partita con 2 o 3 giocatori in ordine fisso (Anna, Bruno, Carla). */
function nuova(n = 3) {
  const giocatori = [
    { id: A, nome: 'Anna', colore: '#d62828', connesso: true },
    { id: B, nome: 'Bruno', colore: '#1d4ed8', connesso: true },
    { id: C, nome: 'Carla', colore: '#1e8e3e', connesso: true },
  ].slice(0, n);
  return motore.creaPartita({
    codice: 'K7PQ2M', hostId: A, giocatori, random: () => 0.5, ora: ORA, opzioni: { ordineCasuale: false },
  });
}

function gioc(s, id) {
  return s.giocatori.find((g) => g.id === id);
}

/** Assegna una proprietà nello stato di prova (mutandolo). */
function assegna(s, indice, id, caseCostruite = 0, ipotecata = false) {
  s.proprieta[String(indice)] = { proprietario: id, caseCostruite, ipotecata };
}

/** Applica un'azione che deve riuscire; `valori` sono i dadi eventuali. */
function ok(s, id, azione, ...valori) {
  const prima = JSON.stringify(s);
  const r = motore.applicaAzione(s, id, azione, {
    random: valori.length ? dadi(...valori) : () => { throw new Error('dadi non previsti'); },
    ora: ORA,
  });
  assert.equal(r.errore, undefined, r.errore && `${r.errore.codice}: ${r.errore.messaggio}`);
  assert.equal(JSON.stringify(s), prima, 'lo stato in ingresso non deve cambiare');
  assert.equal(r.stato.versione, s.versione + 1);
  return r;
}

/** Applica un'azione che deve fallire con `codice`, senza mutare lo stato. */
function ko(s, id, azione, codice) {
  const prima = JSON.stringify(s);
  const r = motore.applicaAzione(s, id, azione, { random: dadi(1, 2), ora: ORA });
  assert.ok(r.errore, `atteso errore ${codice}, invece l'azione è riuscita`);
  assert.equal(r.errore.codice, codice, r.errore.messaggio);
  assert.equal(typeof r.errore.messaggio, 'string');
  assert.ok(r.errore.messaggio.length > 0);
  assert.equal(r.stato, undefined);
  assert.equal(JSON.stringify(s), prima, 'un errore non deve mutare lo stato');
  return r.errore;
}

function tipi(r) {
  return r.eventi.map((e) => e.tipo);
}

// ---------------------------------------------------------------------------
// Dati
// ---------------------------------------------------------------------------

test('dati: mazzi completi e coerenti con il motore', () => {
  assert.equal(CARTE.PROBABILITA.length, 16);
  assert.equal(CARTE.IMPREVISTI.length, 16);
  for (const m of [CARTE.PROBABILITA, CARTE.IMPREVISTI]) {
    assert.equal(m.filter((c) => c.effetto.tipo === 'esciGratis').length, 1);
    for (const c of m) assert.ok(CARTE.TIPI_EFFETTO.includes(c.effetto.tipo), c.id);
  }
  const s = nuova(2);
  assert.equal(Object.keys(s.proprieta).length, 28);
  assert.equal(s.mazzi.probabilita.length, 16);
  assert.equal(TAB.CASELLE.filter((c) => c.ipoteca !== null).every((c) => Number.isInteger(c.ipoteca)), true);
});

// ---------------------------------------------------------------------------
// Movimento, Via, doppi
// ---------------------------------------------------------------------------

test('Via: 200 € arrivando sul Via e passandoci', () => {
  const s = nuova(2);
  gioc(s, A).posizione = 35;
  const r = ok(s, A, { tipo: 'lanciaDadi' }, 2, 3);
  assert.equal(gioc(r.stato, A).posizione, 0);
  assert.equal(gioc(r.stato, A).denaro, 1700);
  assert.ok(tipi(r).includes('passaggioVia'));
  assert.equal(r.stato.fase, 'mossa');

  const s2 = nuova(2);
  gioc(s2, A).posizione = 39;
  s2.mazzi.probabilita = ['P02', 'P03'];
  const r2 = ok(s2, A, { tipo: 'lanciaDadi' }, 1, 2); // → 2 Probabilità: errore bancario +200
  assert.equal(gioc(r2.stato, A).denaro, 1900);
  assert.deepEqual(r2.stato.mazzi.probabilita, ['P03', 'P02']);
});

test('doppi: si rilancia, al terzo doppio si va in prigione', () => {
  const s = nuova(2);
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 3, 3); // → 6 libera
  assert.equal(r1.stato.fase, 'daDecidereAcquisto');
  const r2 = ok(r1.stato, A, { tipo: 'compra' });
  assert.equal(r2.stato.fase, 'daLanciare', 'dopo un doppio si rilancia');
  assert.equal(r2.stato.turno.doppiConsecutivi, 1);
  const r3 = ok(r2.stato, A, { tipo: 'lanciaDadi' }, 2, 2); // → 10 transito
  assert.equal(r3.stato.fase, 'daLanciare');
  assert.equal(r3.stato.turno.doppiConsecutivi, 2);
  const r4 = ok(r3.stato, A, { tipo: 'lanciaDadi' }, 1, 1);
  const a = gioc(r4.stato, A);
  assert.equal(a.inPrigione, true);
  assert.equal(a.posizione, 10);
  assert.equal(r4.stato.fase, 'mossa');
  assert.equal(r4.eventi.at(-1).dati.motivo, 'treDoppi');
  assert.ok(!tipi(r4).includes('movimento'), 'al terzo doppio non si muove');
});

test('casella "In prigione!": dritti in prigione senza Via', () => {
  const s = nuova(2);
  gioc(s, A).posizione = 25;
  const r = ok(s, A, { tipo: 'lanciaDadi' }, 2, 3);
  assert.equal(gioc(r.stato, A).posizione, 10);
  assert.equal(gioc(r.stato, A).inPrigione, true);
  assert.equal(gioc(r.stato, A).denaro, 1500);
  assert.equal(r.stato.fase, 'mossa');
});

// ---------------------------------------------------------------------------
// Affitti e tasse
// ---------------------------------------------------------------------------

test('affitti: base, gruppo completo raddoppiato, case, ipotecata', () => {
  const arriva = (prepara) => {
    const s = nuova(2);
    gioc(s, A).posizione = 37;
    prepara(s);
    return ok(s, A, { tipo: 'lanciaDadi' }, 1, 3).stato; // 37 + 4 → 1 passando dal Via
  };
  let st = arriva((s) => assegna(s, 1, B));
  assert.equal(gioc(st, A).denaro, 1500 + 200 - 2);
  assert.equal(gioc(st, B).denaro, 1502);

  st = arriva((s) => { assegna(s, 1, B); assegna(s, 3, B); });
  assert.equal(gioc(st, B).denaro, 1504, 'gruppo completo senza case: affitto doppio');

  st = arriva((s) => { assegna(s, 1, B, 2); assegna(s, 3, B, 2); s.caseDisponibili = 28; });
  assert.equal(gioc(st, B).denaro, 1530);

  st = arriva((s) => assegna(s, 1, B, 0, true));
  assert.equal(gioc(st, B).denaro, 1500, 'niente affitto su proprietà ipotecata');
  assert.equal(st.fase, 'mossa');
});

test('affitti: stazioni per numero possedute, società secondo i dadi', () => {
  const s = nuova(2);
  [5, 15, 25].forEach((i) => assegna(s, i, B));
  const r = ok(s, A, { tipo: 'lanciaDadi' }, 2, 3); // → 5
  assert.equal(gioc(r.stato, B).denaro, 1600);
  assert.equal(r.eventi.find((e) => e.tipo === 'affitto').dati.importo, 100);

  const s2 = nuova(2);
  gioc(s2, A).posizione = 7;
  assegna(s2, 12, B);
  const r2 = ok(s2, A, { tipo: 'lanciaDadi' }, 2, 3); // → 12, 5 × 4
  assert.equal(gioc(r2.stato, B).denaro, 1520);

  const s3 = nuova(2);
  gioc(s3, A).posizione = 7;
  assegna(s3, 12, B);
  assegna(s3, 28, B);
  const r3 = ok(s3, A, { tipo: 'lanciaDadi' }, 2, 3); // 5 × 10
  assert.equal(gioc(r3.stato, B).denaro, 1550);
});

test('tasse: patrimoniale e di lusso alla banca', () => {
  const s = nuova(2);
  const r = ok(s, A, { tipo: 'lanciaDadi' }, 1, 3); // → 4
  assert.equal(gioc(r.stato, A).denaro, 1300);
  assert.ok(tipi(r).includes('tassa'));
  const s2 = nuova(2);
  gioc(s2, A).posizione = 35;
  const r2 = ok(s2, A, { tipo: 'lanciaDadi' }, 1, 2); // → 38
  assert.equal(gioc(r2.stato, A).denaro, 1400);
});

// ---------------------------------------------------------------------------
// Debito e bancarotta
// ---------------------------------------------------------------------------

test('debito: si ipoteca finché il debito si salda da solo', () => {
  const s = nuova(2);
  gioc(s, A).denaro = 10;
  assegna(s, 21, A);
  assegna(s, 6, A);
  assegna(s, 8, A);
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 1, 3); // tassa 200
  assert.equal(r1.stato.fase, 'debito');
  assert.deepEqual(r1.stato.debito, { giocatoreId: A, creditoreId: null, importo: 200, motivo: 'tassa', casella: 4, faseDopo: 'mossa' });
  assert.equal(gioc(r1.stato, A).denaro, 10, 'il denaro non va mai sotto zero');
  const disp = motore.azioniDisponibili(r1.stato, A);
  for (const t of ['ipoteca', 'vendiCasa', 'dichiaraBancarotta', 'proponiScambio']) assert.ok(disp.includes(t), t);
  assert.ok(!disp.includes('finisciTurno'));
  ko(r1.stato, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA');
  ko(r1.stato, B, { tipo: 'dichiaraBancarotta' }, 'NON_DEBITORE');
  ko(r1.stato, B, { tipo: 'ipoteca', casella: 6 }, 'NON_DEBITORE');

  const r2 = ok(r1.stato, A, { tipo: 'ipoteca', casella: 21 });
  assert.equal(r2.stato.fase, 'debito');
  const r3 = ok(r2.stato, A, { tipo: 'ipoteca', casella: 6 });
  const r4 = ok(r3.stato, A, { tipo: 'ipoteca', casella: 8 });
  assert.equal(r4.stato.fase, 'mossa');
  assert.equal(r4.stato.debito, null);
  assert.equal(gioc(r4.stato, A).denaro, 20);
  assert.ok(tipi(r4).includes('debitoSaldato'));
  ko(s, A, { tipo: 'dichiaraBancarotta' }, 'FASE_ERRATA');
});

test('bancarotta verso un giocatore: beni al creditore, interessi, turno passa', () => {
  const s = nuova(3);
  const a = gioc(s, A);
  a.denaro = 100;
  a.posizione = 35;
  a.cartePrigione = 1;
  s.cartePrigioneDi = { P05: A };
  s.mazzi.probabilita = s.mazzi.probabilita.filter((id) => id !== 'P05');
  assegna(s, 1, A, 1);
  assegna(s, 3, A, 1);
  assegna(s, 6, A, 0, true);
  assegna(s, 39, B, 5);
  s.caseDisponibili = 30;
  s.alberghiDisponibili = 11;
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 1, 3); // → 39 albergo: 2000
  assert.equal(r1.stato.fase, 'debito');
  assert.equal(r1.stato.debito.creditoreId, B);
  // denaro + metà delle 2 case + ipoteca di 1 e 3 (dopo la vendita delle case); la 6 è già ipotecata
  assert.equal(bancarotta.patrimonioLiquidabile(r1.stato, A), 100 + 25 + 25 + 30 + 30);

  const r2 = ok(r1.stato, A, { tipo: 'dichiaraBancarotta' });
  const st = r2.stato;
  assert.equal(gioc(st, A).fallito, true);
  assert.equal(gioc(st, A).denaro, 0);
  assert.equal(gioc(st, B).denaro, 1500 + 150 - 5, 'riceve 150 € e paga 5 € di interesse sull\'ipotecata');
  assert.equal(st.proprieta['1'].proprietario, B);
  assert.equal(st.proprieta['1'].caseCostruite, 0);
  assert.equal(st.proprieta['6'].ipotecata, true);
  assert.equal(st.caseDisponibili, 32);
  assert.equal(gioc(st, B).cartePrigione, 1);
  assert.equal(st.cartePrigioneDi.P05, B);
  assert.equal(st.turno.giocatoreId, B);
  assert.equal(st.fase, 'daLanciare');
  assert.ok(tipi(r2).includes('bancarotta'));
  ko(st, A, { tipo: 'proponiScambio', aId: B, offre: { denaro: 1 } }, 'GIOCATORE_FALLITO');
});

test('bancarotta verso la banca: proprietà libere all\'asta, poi vittoria', () => {
  const s = nuova(3);
  gioc(s, A).denaro = 0;
  assegna(s, 6, A, 0, true);
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 1, 3); // tassa 200 senza patrimonio
  assert.equal(bancarotta.patrimonioLiquidabile(r1.stato, A), 0);
  const r2 = ok(r1.stato, A, { tipo: 'dichiaraBancarotta' });
  let st = r2.stato;
  assert.equal(st.fase, 'asta');
  assert.equal(st.asta.casella, 6);
  assert.deepEqual(st.asta.partecipanti, [B, C]);
  assert.equal(st.proprieta['6'].ipotecata, false);
  assert.equal(st.turno.giocatoreId, B);
  st = ok(st, B, { tipo: 'offertaAsta', importo: 10 }).stato;
  st = ok(st, C, { tipo: 'passaAsta' }).stato;
  assert.equal(st.proprieta['6'].proprietario, B);
  assert.equal(gioc(st, B).denaro, 1490);
  assert.equal(st.fase, 'daLanciare');
  assert.equal(st.turno.giocatoreId, B);

  // Con due giocatori la bancarotta chiude la partita.
  const d = nuova(2);
  gioc(d, A).denaro = 0;
  const f1 = ok(d, A, { tipo: 'lanciaDadi' }, 1, 3);
  const f2 = ok(f1.stato, A, { tipo: 'dichiaraBancarotta' });
  assert.equal(f2.stato.fase, 'finePartita');
  assert.equal(f2.stato.vincitoreId, B);
  assert.equal(f2.eventi.at(-1).tipo, 'finePartita');
  ko(f2.stato, B, { tipo: 'lanciaDadi' }, 'FASE_ERRATA');
  assert.deepEqual(motore.azioniDisponibili(f2.stato, B), []);
});

// ---------------------------------------------------------------------------
// Aste
// ---------------------------------------------------------------------------

test('asta: offerte crescenti, pareggio rifiutato, chiusura al miglior offerente', () => {
  const s = nuova(3);
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 1, 2); // → 3 libera
  assert.equal(r1.stato.fase, 'daDecidereAcquisto');
  let st = ok(r1.stato, A, { tipo: 'rifiutaAcquisto' }).stato;
  assert.equal(st.fase, 'asta');
  assert.deepEqual(st.asta.partecipanti, [B, C], 'chi ha rinunciato non partecipa');
  assert.equal(st.asta.esclusoId, A);
  ko(st, A, { tipo: 'offertaAsta', importo: 10 }, 'GIOCATORE_NON_VALIDO');
  ko(st, A, { tipo: 'passaAsta' }, 'GIOCATORE_NON_VALIDO');
  // Chi passa senza offerte resta fuori, ma l'asta continua per l'altro.
  const passato = ok(st, C, { tipo: 'passaAsta' }).stato;
  assert.equal(passato.fase, 'asta');
  ko(passato, C, { tipo: 'passaAsta' }, 'GIA_PASSATO');
  ko(passato, C, { tipo: 'offertaAsta', importo: 100 }, 'GIA_PASSATO');
  ko(st, B, { tipo: 'offertaAsta', importo: '20' }, 'PARAMETRI_NON_VALIDI');
  ko(st, B, { tipo: 'offertaAsta', importo: 0 }, 'PARAMETRI_NON_VALIDI');
  st = ok(st, B, { tipo: 'offertaAsta', importo: 10 }).stato;
  ko(st, C, { tipo: 'offertaAsta', importo: 10 }, 'OFFERTA_BASSA'); // pareggio: vale la prima offerta
  ko(st, B, { tipo: 'passaAsta' }, 'MIGLIOR_OFFERENTE');
  ko(st, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA');
  ko(st, A, { tipo: 'proponiScambio', aId: B, offre: { denaro: 1 } }, 'FASE_ERRATA');
  st = ok(st, C, { tipo: 'offertaAsta', importo: 15 }).stato;
  ko(st, B, { tipo: 'offertaAsta', importo: 2000 }, 'FONDI_INSUFFICIENTI');
  const fine = ok(st, B, { tipo: 'passaAsta' });
  st = fine.stato;
  assert.equal(st.asta, null);
  assert.equal(st.proprieta['3'].proprietario, C);
  assert.equal(gioc(st, C).denaro, 1485);
  assert.equal(st.fase, 'mossa');
  assert.equal(st.turno.giocatoreId, A);
  assert.deepEqual(fine.eventi.find((e) => e.tipo === 'astaFine').dati, { casella: 3, vincitoreId: C, importo: 15 });
});

test('asta: senza offerte la casella resta alla banca; i disconnessi partono passati', () => {
  const s = nuova(3);
  gioc(s, C).connesso = false;
  let st = ok(s, A, { tipo: 'lanciaDadi' }, 1, 2).stato;
  st = ok(st, A, { tipo: 'rifiutaAcquisto' }).stato;
  assert.deepEqual(st.asta.passati, [C]);
  const r = ok(st, B, { tipo: 'passaAsta' });
  assert.equal(r.stato.proprieta['3'].proprietario, null);
  assert.equal(r.stato.fase, 'mossa');
  assert.equal(r.eventi.at(-1).dati.vincitoreId, null);
});

// ---------------------------------------------------------------------------
// Costruzioni, vendita, ipoteche
// ---------------------------------------------------------------------------

test('costruzioni: gruppo completo, uniformità, scorte, errori', () => {
  const s = nuova(2);
  assegna(s, 1, A);
  assegna(s, 3, A);
  assegna(s, 6, A);
  assegna(s, 5, A);
  let r = ok(s, A, { tipo: 'costruisci', casella: 1 });
  assert.equal(r.stato.proprieta['1'].caseCostruite, 1);
  assert.equal(r.stato.caseDisponibili, 31);
  assert.equal(gioc(r.stato, A).denaro, 1450);
  ko(r.stato, A, { tipo: 'costruisci', casella: 1 }, 'COSTRUZIONE_NON_UNIFORME');
  r = ok(r.stato, A, { tipo: 'costruisci', casella: 3 });
  assert.equal(r.stato.proprieta['3'].caseCostruite, 1);
  ko(s, A, { tipo: 'costruisci', casella: 6 }, 'GRUPPO_INCOMPLETO');
  ko(s, A, { tipo: 'costruisci', casella: 5 }, 'NON_EDIFICABILE');
  ko(s, A, { tipo: 'costruisci', casella: 39 }, 'PROPRIETA_NON_TUA');
  ko(s, A, { tipo: 'costruisci', casella: 2 }, 'CASELLA_NON_VALIDA');
  ko(s, A, { tipo: 'costruisci', casella: 'uno' }, 'PARAMETRI_NON_VALIDI');
  ko(s, A, { tipo: 'costruisci' }, 'PARAMETRI_NON_VALIDI');
  ko(s, B, { tipo: 'costruisci', casella: 1 }, 'NON_IL_TUO_TURNO');

  const ip = structuredClone(s);
  ip.proprieta['3'].ipotecata = true;
  ko(ip, A, { tipo: 'costruisci', casella: 1 }, 'IPOTECATA');

  const esaurite = structuredClone(s);
  esaurite.caseDisponibili = 0;
  ko(esaurite, A, { tipo: 'costruisci', casella: 1 }, 'CASE_ESAURITE');

  const povero = structuredClone(s);
  gioc(povero, A).denaro = 49;
  ko(povero, A, { tipo: 'costruisci', casella: 1 }, 'FONDI_INSUFFICIENTI');
});

test('alberghi e vendita a metà prezzo, uniforme', () => {
  const s = nuova(2);
  assegna(s, 1, A, 4);
  assegna(s, 3, A, 4);
  s.caseDisponibili = 24;
  let r = ok(s, A, { tipo: 'costruisci', casella: 1 });
  assert.equal(r.stato.proprieta['1'].caseCostruite, 5);
  assert.equal(r.stato.alberghiDisponibili, 11);
  assert.equal(r.stato.caseDisponibili, 28, 'le 4 case tornano alla banca');
  ko(r.stato, A, { tipo: 'costruisci', casella: 1 }, 'NON_EDIFICABILE');
  const noAlberghi = structuredClone(r.stato);
  noAlberghi.alberghiDisponibili = 0;
  ko(noAlberghi, A, { tipo: 'costruisci', casella: 3 }, 'ALBERGHI_ESAURITI');

  ko(r.stato, A, { tipo: 'vendiCasa', casella: 3 }, 'COSTRUZIONE_NON_UNIFORME');
  ko(r.stato, A, { tipo: 'ipoteca', casella: 1 }, 'HA_COSTRUZIONI');
  const pocheCase = structuredClone(r.stato);
  pocheCase.caseDisponibili = 3;
  // Senza 4 case in banca si vendono tutte le costruzioni del gruppo:
  // l'albergo (5 × 50 / 2 = 125 €) e le 4 case dell'altro terreno (100 €).
  const intero = ok(pocheCase, A, { tipo: 'vendiCasa', casella: 1 });
  assert.equal(intero.stato.proprieta['1'].caseCostruite, 0);
  assert.equal(intero.stato.proprieta['3'].caseCostruite, 0);
  assert.equal(intero.stato.alberghiDisponibili, 12);
  assert.equal(intero.stato.caseDisponibili, 7);
  assert.equal(gioc(intero.stato, A).denaro, gioc(pocheCase, A).denaro + 225);

  const denaro = gioc(r.stato, A).denaro;
  r = ok(r.stato, A, { tipo: 'vendiCasa', casella: 1 });
  assert.equal(r.stato.proprieta['1'].caseCostruite, 4);
  assert.equal(r.stato.alberghiDisponibili, 12);
  assert.equal(r.stato.caseDisponibili, 24);
  assert.equal(gioc(r.stato, A).denaro, denaro + 25);
  r = ok(r.stato, A, { tipo: 'vendiCasa', casella: 3 });
  assert.equal(r.stato.proprieta['3'].caseCostruite, 3);
  assert.equal(r.stato.caseDisponibili, 25);
  ko(nuova(2), A, { tipo: 'vendiCasa', casella: 1 }, 'PROPRIETA_NON_TUA');
});

test('ipoteca e disipoteca con interesse del 10%', () => {
  const s = nuova(2);
  assegna(s, 6, A);
  let r = ok(s, A, { tipo: 'ipoteca', casella: 6 });
  assert.equal(r.stato.proprieta['6'].ipotecata, true);
  assert.equal(gioc(r.stato, A).denaro, 1550);
  ko(r.stato, A, { tipo: 'ipoteca', casella: 6 }, 'GIA_IPOTECATA');
  const povero = structuredClone(r.stato);
  gioc(povero, A).denaro = 54;
  ko(povero, A, { tipo: 'disipoteca', casella: 6 }, 'FONDI_INSUFFICIENTI');
  r = ok(r.stato, A, { tipo: 'disipoteca', casella: 6 });
  assert.equal(r.stato.proprieta['6'].ipotecata, false);
  assert.equal(gioc(r.stato, A).denaro, 1495);
  ko(r.stato, A, { tipo: 'disipoteca', casella: 6 }, 'NON_IPOTECATA');
});

// ---------------------------------------------------------------------------
// Prigione
// ---------------------------------------------------------------------------

/** Partita in cui Anna è in prigione da `tentativi` turni. */
function inPrigione(tentativi = 0, denaro = 1500) {
  const s = nuova(2);
  Object.assign(gioc(s, A), { posizione: 10, inPrigione: true, turniInPrigione: tentativi, denaro });
  return s;
}

test('prigione: cauzione, carta, doppio, tentativo fallito', () => {
  let r = ok(inPrigione(), A, { tipo: 'pagaCauzione' });
  assert.equal(gioc(r.stato, A).inPrigione, false);
  assert.equal(gioc(r.stato, A).denaro, 1450);
  assert.equal(r.stato.fase, 'daLanciare');
  ko(r.stato, A, { tipo: 'pagaCauzione' }, 'NON_IN_PRIGIONE');
  ko(inPrigione(0, 40), A, { tipo: 'pagaCauzione' }, 'FONDI_INSUFFICIENTI');
  ko(inPrigione(), A, { tipo: 'usaCartaPrigione' }, 'NESSUNA_CARTA_PRIGIONE');

  const conCarta = inPrigione();
  gioc(conCarta, A).cartePrigione = 1;
  conCarta.cartePrigioneDi = { P05: A };
  conCarta.mazzi.probabilita = conCarta.mazzi.probabilita.filter((id) => id !== 'P05');
  assert.ok(motore.azioniDisponibili(conCarta, A).includes('usaCartaPrigione'));
  r = ok(conCarta, A, { tipo: 'usaCartaPrigione' });
  assert.equal(gioc(r.stato, A).cartePrigione, 0);
  assert.equal(gioc(r.stato, A).inPrigione, false);
  assert.equal(r.stato.mazzi.probabilita.at(-1), 'P05', 'la carta torna in fondo al suo mazzo');
  assert.equal(r.stato.cartePrigioneDi.P05, undefined);

  r = ok(inPrigione(), A, { tipo: 'lanciaDadi' }, 2, 2); // doppio: esce e va a 14
  assert.equal(gioc(r.stato, A).inPrigione, false);
  assert.equal(gioc(r.stato, A).posizione, 14);
  assert.equal(r.stato.fase, 'daDecidereAcquisto');
  assert.equal(ok(r.stato, A, { tipo: 'compra' }).stato.fase, 'mossa', 'uscito col doppio non rilancia');

  r = ok(inPrigione(), A, { tipo: 'lanciaDadi' }, 1, 2);
  assert.equal(gioc(r.stato, A).inPrigione, true);
  assert.equal(gioc(r.stato, A).turniInPrigione, 1);
  assert.equal(gioc(r.stato, A).posizione, 10);
  assert.equal(r.stato.fase, 'mossa');
});

test('prigione: al terzo tentativo si paga 50 € (o si va in debito) e si esce', () => {
  let r = ok(inPrigione(2), A, { tipo: 'lanciaDadi' }, 1, 2);
  assert.equal(gioc(r.stato, A).inPrigione, false);
  assert.equal(gioc(r.stato, A).denaro, 1450);
  assert.equal(gioc(r.stato, A).posizione, 13);
  assert.equal(r.stato.fase, 'daDecidereAcquisto');

  const s = inPrigione(2, 20);
  assegna(s, 6, A);
  r = ok(s, A, { tipo: 'lanciaDadi' }, 1, 2);
  assert.equal(r.stato.fase, 'debito');
  assert.equal(r.stato.debito.motivo, 'cauzione');
  assert.equal(r.stato.debito.faseDopo, 'daDecidereAcquisto');
  assert.equal(gioc(r.stato, A).posizione, 13);
  r = ok(r.stato, A, { tipo: 'ipoteca', casella: 6 });
  assert.equal(gioc(r.stato, A).denaro, 20);
  assert.equal(r.stato.fase, 'daDecidereAcquisto');
});

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------

/** Fa arrivare Anna su Imprevisti (7) o Probabilità (17) con la carta indicata in cima. */
function pesca(idCarta, prepara = () => {}, extraDadi = []) {
  const s = nuova(3);
  const mazzo = idCarta.startsWith('P') ? 'probabilita' : 'imprevisti';
  s.mazzi[mazzo] = [idCarta, ...s.mazzi[mazzo].filter((id) => id !== idCarta)];
  gioc(s, A).posizione = mazzo === 'probabilita' ? 10 : 0;
  prepara(s);
  return ok(s, A, { tipo: 'lanciaDadi' }, 3, 4, ...extraDadi);
}

test('carte: denaro, prigione, esciGratis, Via, vai a, indietro', () => {
  let r = pesca('P03');
  assert.equal(gioc(r.stato, A).denaro, 1450);
  assert.equal(r.eventi.find((e) => e.tipo === 'carta').dati.carta.id, 'P03');

  r = pesca('P06');
  assert.equal(gioc(r.stato, A).inPrigione, true);
  assert.equal(gioc(r.stato, A).posizione, 10);

  r = pesca('P05');
  assert.equal(gioc(r.stato, A).cartePrigione, 1);
  assert.ok(!r.stato.mazzi.probabilita.includes('P05'), 'la carta esce dal mazzo');
  assert.equal(r.stato.cartePrigioneDi.P05, A);

  r = pesca('I01');
  assert.equal(gioc(r.stato, A).posizione, 0);
  assert.equal(gioc(r.stato, A).denaro, 1700);

  r = pesca('I02');
  assert.equal(gioc(r.stato, A).posizione, 24);
  assert.equal(gioc(r.stato, A).denaro, 1500);
  assert.equal(r.stato.fase, 'daDecidereAcquisto');

  r = pesca('I03', (s) => { gioc(s, A).posizione = 29; }); // 29 + 7 → 36, poi fino a 11 passando dal Via
  assert.equal(gioc(r.stato, A).posizione, 11);
  assert.equal(gioc(r.stato, A).denaro, 1700);

  r = pesca('I09'); // 7 − 3 → 4 tassa patrimoniale
  assert.equal(gioc(r.stato, A).posizione, 4);
  assert.equal(gioc(r.stato, A).denaro, 1300);
  assert.equal(r.eventi.filter((e) => e.tipo === 'movimento').at(-1).dati.passi, -3);
});

test('carte: riparazioni, compleanno, paga a tutti', () => {
  let r = pesca('P13', (s) => { assegna(s, 1, A, 5); assegna(s, 3, A, 4); });
  assert.equal(gioc(r.stato, A).denaro, 1500 - (4 * 40 + 115));

  r = pesca('P07', (s) => { gioc(s, C).denaro = 5; });
  assert.equal(gioc(r.stato, A).denaro, 1510);
  assert.equal(gioc(r.stato, B).denaro, 1490);
  assert.equal(r.stato.fase, 'debito');
  assert.equal(r.stato.debito.giocatoreId, C);
  assert.equal(r.stato.debito.creditoreId, A);
  ko(r.stato, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA');
  const fine = ok(r.stato, C, { tipo: 'dichiaraBancarotta' });
  assert.equal(gioc(fine.stato, A).denaro, 1515);
  assert.equal(gioc(fine.stato, C).fallito, true);
  assert.equal(fine.stato.fase, 'mossa');
  assert.equal(fine.stato.turno.giocatoreId, A);

  r = pesca('I15');
  assert.equal(gioc(r.stato, A).denaro, 1400);
  assert.equal(gioc(r.stato, B).denaro, 1550);
  assert.equal(gioc(r.stato, C).denaro, 1550);
});

test('carte: stazione più vicina (affitto doppio) e società più vicina (dadi × 10)', () => {
  let r = pesca('I05', (s) => { assegna(s, 5, B); assegna(s, 15, B); });
  assert.equal(gioc(r.stato, A).posizione, 15);
  assert.equal(gioc(r.stato, B).denaro, 1600);
  assert.equal(r.eventi.find((e) => e.tipo === 'affitto').dati.moltiplicatore, 2);

  r = pesca('I05', (s) => { gioc(s, A).posizione = 29; }); // 36 → 5 passando dal Via, libera
  assert.equal(gioc(r.stato, A).posizione, 5);
  assert.equal(gioc(r.stato, A).denaro, 1700);
  assert.equal(r.stato.fase, 'daDecidereAcquisto');

  r = pesca('I04', (s) => assegna(s, 12, B));
  assert.equal(gioc(r.stato, A).posizione, 12);
  assert.equal(r.stato.fase, 'lancioAffitto', 'i dadi dell\'affitto li lancia il giocatore');
  assert.deepEqual(motore.azioniDisponibili(r.stato, A).sort(), ['abbandona', 'lanciaDadi', 'proponiScambio']);
  ko(r.stato, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA');
  ko(r.stato, B, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO');
  r = ok(r.stato, A, { tipo: 'lanciaDadi' }, 3, 4); // 3 + 4 = 7 → 70 €
  assert.equal(r.stato.fase, 'mossa');
  assert.equal(gioc(r.stato, A).denaro, 1430);
  assert.equal(gioc(r.stato, B).denaro, 1570);
  assert.deepEqual(r.stato.dadi, [3, 4]);
});

// ---------------------------------------------------------------------------
// Scambi
// ---------------------------------------------------------------------------

test('scambi: proposta, accettazione, interesse sulle ipotecate, carte prigione', () => {
  const s = nuova(3);
  assegna(s, 6, A, 0, true);
  assegna(s, 1, A);
  assegna(s, 39, B);
  gioc(s, A).cartePrigione = 1;
  s.cartePrigioneDi = { I08: A };
  s.mazzi.imprevisti = s.mazzi.imprevisti.filter((id) => id !== 'I08');
  const proposta = {
    tipo: 'proponiScambio', aId: B,
    offre: { denaro: 100, proprieta: [6], cartePrigione: 1 },
    chiede: { proprieta: [39] },
  };
  const r1 = ok(s, A, proposta);
  assert.equal(r1.stato.scambio.id, 's1');
  assert.deepEqual(r1.stato.scambio.chiede, { denaro: 0, proprieta: [39], cartePrigione: 0 });
  ko(r1.stato, C, { ...proposta, aId: A, offre: { denaro: 1 } }, 'SCAMBIO_IN_CORSO');
  ko(r1.stato, A, { tipo: 'accettaScambio', scambioId: 's1' }, 'NON_DESTINATARIO');
  ko(r1.stato, C, { tipo: 'rifiutaScambio', scambioId: 's1' }, 'NON_COINVOLTO');
  ko(r1.stato, B, { tipo: 'accettaScambio', scambioId: 's9' }, 'SCAMBIO_NON_TROVATO');
  ko(r1.stato, B, { tipo: 'accettaScambio' }, 'PARAMETRI_NON_VALIDI');
  assert.ok(motore.azioniDisponibili(r1.stato, B).includes('accettaScambio'));

  const r2 = ok(r1.stato, B, { tipo: 'accettaScambio', scambioId: 's1' });
  const st = r2.stato;
  assert.equal(st.scambio, null);
  assert.equal(st.proprieta['6'].proprietario, B);
  assert.equal(st.proprieta['6'].ipotecata, true);
  assert.equal(st.proprieta['39'].proprietario, A);
  assert.equal(gioc(st, A).denaro, 1400);
  assert.equal(gioc(st, B).denaro, 1500 + 100 - 5);
  assert.equal(gioc(st, B).cartePrigione, 1);
  assert.equal(st.cartePrigioneDi.I08, B);
  assert.ok(tipi(r2).includes('scambioAccettato'));

  const r3 = ok(st, A, { ...proposta, offre: { denaro: 1 }, chiede: {} });
  const ritiro = ok(r3.stato, A, { tipo: 'rifiutaScambio', scambioId: 's2' });
  assert.equal(ritiro.stato.scambio, null);
  assert.equal(ritiro.eventi[0].dati.daId, A);
});

test('scambi: validazioni', () => {
  const s = nuova(3);
  assegna(s, 1, A, 1);
  assegna(s, 3, A);
  assegna(s, 6, A);
  ko(s, A, { tipo: 'proponiScambio', aId: B }, 'SCAMBIO_VUOTO');
  ko(s, A, { tipo: 'proponiScambio', aId: A, offre: { denaro: 1 } }, 'GIOCATORE_NON_VALIDO');
  ko(s, A, { tipo: 'proponiScambio', aId: 'nessuno9', offre: { denaro: 1 } }, 'GIOCATORE_NON_VALIDO');
  ko(s, A, { tipo: 'proponiScambio', offre: { denaro: 1 } }, 'PARAMETRI_NON_VALIDI');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { denaro: -5 } }, 'PARAMETRI_NON_VALIDI');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { proprieta: 'tutte' } }, 'PARAMETRI_NON_VALIDI');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { denaro: 5000 } }, 'FONDI_INSUFFICIENTI');
  ko(s, A, { tipo: 'proponiScambio', aId: B, chiede: { proprieta: [39] } }, 'PROPRIETA_NON_TUA');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { proprieta: [3] } }, 'HA_COSTRUZIONI');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { cartePrigione: 1 } }, 'NESSUNA_CARTA_PRIGIONE');
  ko(s, A, { tipo: 'proponiScambio', aId: B, offre: { proprieta: [2] } }, 'CASELLA_NON_VALIDA');
  // anche chi non è di turno può proporre
  assert.ok(ok(s, C, { tipo: 'proponiScambio', aId: A, chiede: { proprieta: [6] }, offre: { denaro: 200 } }).stato.scambio);

  // validaProposta non muta lo stato; lo scambio vero passa da applicaAzione.
  const v = scambi.validaProposta(s, A, { aId: B, offre: { proprieta: [6] } }, { ora: ORA });
  assert.equal(v.ok, true);
  const proposto = ok(s, A, { tipo: 'proponiScambio', aId: B, offre: { proprieta: [6] } }).stato;
  const app = ok(proposto, B, { tipo: 'accettaScambio', scambioId: proposto.scambio.id });
  assert.equal(app.stato.proprieta['6'].proprietario, B);
  assert.equal(s.proprieta['6'].proprietario, A);
});

test('scambi: interesse non pagabile → debito del destinatario', () => {
  const s = nuova(2);
  assegna(s, 6, A, 0, true);
  gioc(s, B).denaro = 2;
  let st = ok(s, A, { tipo: 'proponiScambio', aId: B, offre: { proprieta: [6] } }).stato;
  st = ok(st, B, { tipo: 'accettaScambio', scambioId: 's1' }).stato;
  assert.equal(st.fase, 'debito');
  assert.equal(st.debito.giocatoreId, B);
  assert.equal(st.debito.importo, 5);
  assert.equal(st.debito.motivo, 'interesseScambio');
  assert.equal(st.debito.faseDopo, 'daLanciare');
});

// ---------------------------------------------------------------------------
// Turni, disconnessioni, permessi
// ---------------------------------------------------------------------------

test('turno: i disconnessi vengono saltati', () => {
  const s = nuova(3);
  gioc(s, B).connesso = false;
  const r1 = ok(s, A, { tipo: 'lanciaDadi' }, 4, 6); // → 10, solo transito
  assert.equal(r1.stato.fase, 'mossa');
  const r2 = ok(r1.stato, A, { tipo: 'finisciTurno' });
  assert.equal(r2.stato.turno.giocatoreId, C);
  assert.equal(r2.stato.turno.numero, 2);
  assert.deepEqual(tipi(r2), ['turnoSaltato', 'turno']);
  assert.equal(motore.prossimoGiocatore(r2.stato), A);

  // Se nessun altro è connesso il turno passa comunque al prossimo (si aspetta).
  const soli = nuova(2);
  gioc(soli, B).connesso = false;
  assert.equal(motore.prossimoGiocatore(soli), B);
});

test('gestisciDisconnessione: passa il turno o l\'asta di chi è disconnesso', () => {
  const s = nuova(3);
  const nulla = motore.gestisciDisconnessione(s, B, { ora: ORA });
  assert.equal(nulla.stato, s);
  assert.deepEqual(nulla.eventi, []);

  gioc(s, A).connesso = false;
  const r = motore.gestisciDisconnessione(s, A, { ora: ORA });
  assert.equal(r.stato.turno.giocatoreId, B);
  assert.equal(r.stato.versione, s.versione + 1);
  assert.equal(gioc(s, A).connesso, false);
  assert.equal(s.turno.giocatoreId, A, 'lo stato originale non cambia');

  const s2 = nuova(3);
  let st = ok(s2, A, { tipo: 'lanciaDadi' }, 1, 2).stato;
  st = ok(st, A, { tipo: 'rifiutaAcquisto' }).stato;
  st = ok(st, B, { tipo: 'offertaAsta', importo: 5 }).stato;
  gioc(st, C).connesso = false;
  const r2 = motore.gestisciDisconnessione(st, C, { ora: ORA });
  assert.equal(r2.stato.proprieta['3'].proprietario, B);
  assert.equal(r2.stato.fase, 'mossa');
});

test('permessi: turno sbagliato, fase errata, giocatore sconosciuto', () => {
  const s = nuova(3);
  ko(s, B, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO');
  ko(s, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA');
  ko(s, A, { tipo: 'compra' }, 'FASE_ERRATA');
  ko(s, A, { tipo: 'offertaAsta', importo: 5 }, 'FASE_ERRATA');
  ko(s, A, { tipo: 'accettaScambio', scambioId: 's1' }, 'SCAMBIO_NON_TROVATO');
  ko(s, A, { tipo: 'volare' }, 'AZIONE_NON_VALIDA');
  ko(s, 'nessuno9', { tipo: 'lanciaDadi' }, 'GIOCATORE_NON_VALIDO');
  const err = ko(s, B, { tipo: 'finisciTurno' }, 'NON_IL_TUO_TURNO');
  assert.match(err.messaggio, /Anna/);

  const disp = motore.azioniDisponibili(s, A);
  assert.deepEqual(disp.sort(), ['abbandona', 'costruisci', 'disipoteca', 'ipoteca', 'lanciaDadi', 'proponiScambio', 'vendiCasa']);
  assert.deepEqual(motore.azioniDisponibili(s, B), ['proponiScambio', 'abbandona']);

  const pub = motore.statoPubblico(s);
  assert.equal('mazzi' in pub, false);
  assert.equal('contatoreScambi' in pub, false);
});

test('partita lunga casuale: nessuna eccezione e invarianti rispettate', () => {
  // Generatore deterministico (mulberry32): le scelte dei giocatori sono automatiche.
  let seme = 12345;
  const rng = () => {
    seme = (seme + 0x6d2b79f5) >>> 0;
    let t = seme;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let st = motore.creaPartita({
    codice: 'K7PQ2M', hostId: A, random: rng, ora: ORA,
    giocatori: [A, B, C].map((id, i) => ({ id, nome: `G${i}`, colore: '#000000' })),
  });
  for (let passo = 0; passo < 3000 && st.fase !== 'finePartita'; passo += 1) {
    let attore = st.turno.giocatoreId;
    if (st.fase === 'debito') attore = st.debito.giocatoreId;
    if (st.fase === 'asta') {
      // chi non ha passato e non è il miglior offerente (esiste sempre ad asta aperta)
      attore = st.asta.partecipanti.find((id) => !st.asta.passati.includes(id) && id !== st.asta.migliorOfferenteId);
    }
    const mie = Object.keys(st.proprieta).map(Number).filter((i) => st.proprieta[i].proprietario === attore);
    // Candidati in ordine di preferenza: si applica il primo valido.
    let candidati;
    if (st.fase === 'asta') {
      const offerta = { tipo: 'offertaAsta', importo: st.asta.offertaMassima + 1 + Math.floor(rng() * 20) };
      candidati = rng() < 0.6 ? [{ tipo: 'passaAsta' }] : [offerta, { tipo: 'passaAsta' }];
    } else if (st.fase === 'debito') {
      const perCase = mie.slice().sort((x, y) => st.proprieta[y].caseCostruite - st.proprieta[x].caseCostruite);
      candidati = [
        ...perCase.filter((i) => st.proprieta[i].caseCostruite > 0).map((i) => ({ tipo: 'vendiCasa', casella: i })),
        ...mie.filter((i) => !st.proprieta[i].ipotecata).map((i) => ({ tipo: 'ipoteca', casella: i })),
        { tipo: 'dichiaraBancarotta' },
      ];
    } else if (st.fase === 'daDecidereAcquisto') {
      candidati = rng() < 0.7 ? [{ tipo: 'compra' }, { tipo: 'rifiutaAcquisto' }] : [{ tipo: 'rifiutaAcquisto' }];
    } else if (st.fase === 'lancioAffitto') {
      candidati = [{ tipo: 'lanciaDadi' }];
    } else if (st.fase === 'daLanciare') {
      candidati = rng() < 0.3 && mie.length
        ? [{ tipo: 'costruisci', casella: mie[Math.floor(rng() * mie.length)] }, { tipo: 'lanciaDadi' }]
        : [{ tipo: 'lanciaDadi' }];
    } else {
      candidati = [{ tipo: 'finisciTurno' }];
    }
    let riuscita = null;
    const errori = [];
    for (const azione of candidati) {
      const r = motore.applicaAzione(st, attore, azione, { random: rng, ora: ORA });
      if (!r.errore) { riuscita = r; break; }
      errori.push(`${azione.tipo}: ${r.errore.codice}`);
    }
    assert.ok(riuscita, `partita bloccata in fase ${st.fase}: ${errori.join(', ')}`);
    st = riuscita.stato;

    for (const g of st.giocatori) {
      assert.ok(Number.isInteger(g.denaro) && g.denaro >= 0, `denaro di ${g.id} = ${g.denaro}`);
      assert.ok(g.posizione >= 0 && g.posizione < 40);
    }
    const caseInGioco = Object.values(st.proprieta).reduce((n, v) => n + (v.caseCostruite < 5 ? v.caseCostruite : 0), 0);
    const alberghi = Object.values(st.proprieta).filter((v) => v.caseCostruite === 5).length;
    assert.equal(st.caseDisponibili + caseInGioco, 32);
    assert.equal(st.alberghiDisponibili + alberghi, 12);
    assert.equal(st.mazzi.probabilita.length + Object.keys(st.cartePrigioneDi).filter((id) => id[0] === 'P').length, 16);
    assert.equal(st.mazzi.imprevisti.length + Object.keys(st.cartePrigioneDi).filter((id) => id[0] === 'I').length, 16);
    assert.ok(st.log.length <= 200);
  }
});
