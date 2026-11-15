'use strict';

/**
 * tests/motore-scambi-debiti.test.js
 * Scambi (validi e non), interessi sulle ipoteche scambiate, debito,
 * bancarotta verso giocatore e verso banca, vittoria, disconnessioni.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const scambi = require('../server/gioco/scambi');
const bancarotta = require('../server/gioco/bancarotta');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const { giocatore, voce } = H;
const tipi = (r) => r.eventi.map((e) => e.tipo);
const proposta = { tipo: 'proponiScambio', aId: B, offre: { denaro: 100, proprieta: [1, 3] }, chiede: { proprieta: [6] } };
const s0 = () => H.assegna(H.assegna(H.nuovaPartita(), A, 1, 3), B, 6);
const inAsta = () => H.esegui(H.modifica(H.nuovaPartita(), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; }),
  A, { tipo: 'rifiutaAcquisto' }).stato;

// ---------------------------------------------------------------------------
// Scambi
// ---------------------------------------------------------------------------

test('scambio valido: proposta, accettazione e trasferimento di denaro e proprietà', () => {
  let r = H.esegui(s0(), A, proposta);
  const sc = r.stato.scambio;
  assert.equal(sc.id, 's1');
  assert.deepEqual([sc.daId, sc.aId], [A, B]);
  assert.deepEqual(sc.offre, { denaro: 100, proprieta: [1, 3], cartePrigione: 0 }, 'i campi mancanti valgono 0 / []');
  assert.deepEqual(sc.chiede, { denaro: 0, proprieta: [6], cartePrigione: 0 });
  assert.equal(r.stato.fase, 'daLanciare', 'proporre uno scambio non cambia la fase');
  assert.equal(r.eventi[0].tipo, 'scambioProposto');

  r = H.esegui(r.stato, B, { tipo: 'accettaScambio', scambioId: 's1' });
  assert.deepEqual([voce(r.stato, 1).proprietario, voce(r.stato, 3).proprietario, voce(r.stato, 6).proprietario], [B, B, A],
    'Regola: le proprietà cambiano proprietario');
  assert.deepEqual([giocatore(r.stato, A).denaro, giocatore(r.stato, B).denaro], [1400, 1600], 'il denaro passa da A a B');
  assert.equal(r.stato.scambio, null, 'dopo l\'accettazione non c\'è più nessuno scambio pendente');
  assert.equal(r.eventi[0].tipo, 'scambioAccettato');
  H.verificaJson(r.stato);
});

test('scambio: chi non è di turno può proporre, rifiutare e ritirare; il turno può passare con lo scambio pendente', () => {
  const s = H.assegna(H.assegna(H.nuovaPartita(), B, 6), C, 8);
  const r = H.esegui(s, B, { tipo: 'proponiScambio', aId: C, offre: { proprieta: [6] }, chiede: { proprieta: [8] } });
  assert.equal(r.stato.scambio.daId, B, 'Regola: gli scambi non sono riservati a chi è di turno');
  const ritirato = H.esegui(r.stato, B, { tipo: 'rifiutaScambio', scambioId: 's1' });
  assert.equal(ritirato.stato.scambio, null, 'il proponente può ritirare la proposta');
  const rifiutato = H.esegui(r.stato, C, { tipo: 'rifiutaScambio', scambioId: 's1' });
  assert.equal(rifiutato.stato.scambio, null, 'il destinatario può rifiutare');
  assert.equal(rifiutato.eventi[0].tipo, 'scambioRifiutato');
  const pendente = H.esegui(s0(), A, proposta).stato;
  const fine = H.esegui(H.turnoDi(pendente, A, 'mossa'), A, { tipo: 'finisciTurno' });
  assert.notEqual(fine.stato.scambio, null, 'Regola: lo scambio pendente non blocca il cambio di turno');
});

test('scambio non valido: proposte rifiutate senza modificare lo stato', () => {
  const s = s0();
  const p = (extra) => ({ tipo: 'proponiScambio', aId: B, ...extra });
  H.rifiuta(s, A, p({}), 'SCAMBIO_VUOTO', 'Uno scambio senza nulla da offrire né chiedere non ha senso');
  H.rifiuta(s, A, p({ offre: {}, chiede: { denaro: 0, proprieta: [] } }), 'SCAMBIO_VUOTO', 'Anche con campi a zero lo scambio è vuoto');
  H.rifiuta(s, A, p({ aId: A, offre: { denaro: 10 } }), 'GIOCATORE_NON_VALIDO', 'Non si può scambiare con se stessi');
  H.rifiuta(s, A, p({ aId: 'nessuno1', offre: { denaro: 10 } }), 'GIOCATORE_NON_VALIDO', 'Il destinatario deve esistere');
  H.rifiuta(H.modifica(s, (x) => { giocatore(x, B).fallito = true; }), A, p({ offre: { denaro: 10 } }),
    'GIOCATORE_NON_VALIDO', 'Non si scambia con un giocatore fallito');
  H.rifiuta(s, A, { tipo: 'proponiScambio', offre: { denaro: 10 } }, 'PARAMETRI_NON_VALIDI', 'Manca il destinatario');
  for (const offre of [{ denaro: -5 }, { denaro: 1.5 }, { proprieta: 'x' }, { proprieta: [99] }, { cartePrigione: -1 }, 'ciao']) {
    H.rifiuta(s, A, p({ offre }), 'PARAMETRI_NON_VALIDI', `"offre" = ${JSON.stringify(offre)} non è una metà di scambio valida`);
  }
  H.rifiuta(s, A, p({ offre: { proprieta: [6] } }), 'PROPRIETA_NON_TUA', 'Non si offre ciò che è di un altro');
  H.rifiuta(s, A, p({ chiede: { proprieta: [1] } }), 'PROPRIETA_NON_TUA', 'Non si chiede al destinatario ciò che non possiede');
  H.rifiuta(s, A, p({ offre: { proprieta: [0] } }), 'CASELLA_NON_VALIDA', 'Il Via non è una proprietà scambiabile');
  H.rifiuta(s, A, p({ offre: { denaro: 2000 } }), 'FONDI_INSUFFICIENTI', 'Non si offre più denaro di quello posseduto');
  H.rifiuta(s, A, p({ chiede: { denaro: 2000 } }), 'FONDI_INSUFFICIENTI', 'Non si chiede più denaro di quello che l\'altro possiede');
  H.rifiuta(s, A, p({ offre: { cartePrigione: 1 } }), 'NESSUNA_CARTA_PRIGIONE', 'Non si offre una carta che non si ha');
  H.rifiuta(H.costruito(s, { 1: 1 }), A, p({ offre: { proprieta: [3] } }), 'HA_COSTRUZIONI',
    'Non si scambia una via se in QUALSIASI via del suo gruppo ci sono costruzioni');
  H.rifiuta(H.esegui(s, A, proposta).stato, B, { tipo: 'proponiScambio', aId: C, offre: { denaro: 1 } }, 'SCAMBIO_IN_CORSO', 'Una sola proposta pendente per partita');
  H.rifiuta(inAsta(), A, p({ offre: { denaro: 10 } }), 'FASE_ERRATA', 'Durante un\'asta non si propongono scambi');
  H.rifiuta(H.modifica(s, (x) => { x.fase = 'finePartita'; }), A, p({ offre: { denaro: 10 } }), 'FASE_ERRATA', 'A partita finita non si scambia');
  H.rifiuta(H.modifica(s, (x) => { x.fase = 'lobby'; }), A, p({ offre: { denaro: 10 } }), 'FASE_ERRATA', 'In lobby non si scambia');
});

test('scambio: risposte non valide e verifica dei possessi all\'accettazione', () => {
  const pendente = H.esegui(s0(), A, proposta).stato;
  H.rifiuta(pendente, A, { tipo: 'accettaScambio', scambioId: 's1' }, 'NON_DESTINATARIO', 'Il proponente non può accettare la propria proposta');
  H.rifiuta(pendente, C, { tipo: 'accettaScambio', scambioId: 's1' }, 'NON_DESTINATARIO', 'Un terzo non può accettare');
  H.rifiuta(pendente, B, { tipo: 'accettaScambio', scambioId: 's9' }, 'SCAMBIO_NON_TROVATO', 'L\'id dello scambio deve coincidere');
  H.rifiuta(pendente, B, { tipo: 'accettaScambio' }, 'PARAMETRI_NON_VALIDI', 'Manca scambioId');
  H.rifiuta(s0(), B, { tipo: 'accettaScambio', scambioId: 's1' }, 'SCAMBIO_NON_TROVATO', 'Senza proposta pendente non c\'è nulla da accettare');
  H.rifiuta(s0(), B, { tipo: 'rifiutaScambio', scambioId: 's1' }, 'SCAMBIO_NON_TROVATO', 'Senza proposta pendente non c\'è nulla da rifiutare');
  H.rifiuta(pendente, C, { tipo: 'rifiutaScambio', scambioId: 's1' }, 'NON_COINVOLTO', 'Un terzo non può rifiutare lo scambio di altri');
  H.rifiuta(H.modifica(pendente, (x) => { voce(x, 6).proprietario = C; }), B, { tipo: 'accettaScambio', scambioId: 's1' },
    'PROPRIETA_NON_TUA', 'I possessi si riverificano all\'accettazione: B non ha più la casella 6');
  H.rifiuta(H.soldi(pendente, A, 50), B, { tipo: 'accettaScambio', scambioId: 's1' },
    'FONDI_INSUFFICIENTI', 'Il denaro si riverifica all\'accettazione: A non ha più 100 €');
});

test('scambio di proprietà ipotecate: chi le riceve paga subito il 10% alla banca', () => {
  const s = H.ipotecate(H.assegna(H.nuovaPartita(), A, 6), 6);
  const p = { tipo: 'proponiScambio', aId: B, offre: { proprieta: [6] } };
  let r = H.esegui(H.esegui(s, A, p).stato, B, { tipo: 'accettaScambio', scambioId: 's1' });
  assert.equal(voce(r.stato, 6).proprietario, B);
  assert.equal(voce(r.stato, 6).ipotecata, true, 'Regola: l\'ipoteca resta');
  assert.equal(giocatore(r.stato, B).denaro, 1495, 'Regola: il ricevente paga il 10% dell\'ipoteca (5 €) alla banca');
  assert.equal(giocatore(r.stato, A).denaro, 1500);
  const povero = H.soldi(H.esegui(s, A, p).stato, B, 3);
  r = H.esegui(povero, B, { tipo: 'accettaScambio', scambioId: 's1' });
  assert.equal(r.stato.fase, 'debito', 'senza 5 € per l\'interesse si apre un debito');
  assert.equal(r.stato.debito.motivo, 'interesseScambio');
  assert.equal(r.stato.debito.creditoreId, null);
});

test('scambio di carte "Uscite gratis di prigione": la carta cambia proprietario', () => {
  const s = H.conCartaPrigione(H.nuovaPartita(), A, 'P05');
  const p = { tipo: 'proponiScambio', aId: B, offre: { cartePrigione: 1 }, chiede: { denaro: 50 } };
  const r = H.esegui(H.esegui(s, A, p).stato, B, { tipo: 'accettaScambio', scambioId: 's1' });
  assert.deepEqual([giocatore(r.stato, A).cartePrigione, giocatore(r.stato, B).cartePrigione], [0, 1]);
  assert.equal(r.stato.cartePrigioneDi.P05, B, 'il registro delle carte deve seguire il nuovo proprietario');
  assert.deepEqual([giocatore(r.stato, A).denaro, giocatore(r.stato, B).denaro], [1550, 1450]);
});

test('scambi.js: validaProposta normalizza e applicaScambio non muta lo stato in ingresso', () => {
  const s = s0();
  const v = scambi.validaProposta(s, A, { aId: B, offre: { proprieta: [3, 1, 1] } }, { ora: H.ORA_FISSA });
  assert.equal(v.ok, true);
  assert.deepEqual(v.scambio.offre.proprieta, [1, 3], 'proprietà ordinate e senza doppioni');
  const prima = JSON.stringify(s);
  const r = scambi.applicaScambio(s, v.scambio, { ora: H.ORA_FISSA });
  assert.equal(voce(r.stato, 1).proprietario, B);
  assert.equal(JSON.stringify(s), prima, 'applicaScambio non deve mutare lo stato ricevuto');
});

// ---------------------------------------------------------------------------
// Debito e bancarotta
// ---------------------------------------------------------------------------

/** B (10 €) arriva sul Parco della Vittoria di A e non può pagare i 50 € d'affitto. */
function debitoDiB() {
  let s = H.assegna(H.assegna(H.nuovaPartita(), A, 39), B, 6, 11, 13, 14);
  s = H.ipotecate(H.costruito(s, { 11: 1, 13: 1, 14: 1 }), 6);
  s = H.conCartaPrigione(H.soldi(s, B, 10), B, 'P05');
  return H.arrivaSu(s, B, 39, 3, 4).stato;
}

test('debito: il patrimonio liquidabile conta denaro, costruzioni a metà prezzo e ipoteche ottenibili', () => {
  // 10 € + 3 case (50 € ciascuna) + ipoteche di 11, 13, 14 (70 + 70 + 80); la 6 è già ipotecata.
  assert.equal(motore.patrimonioLiquidabile(debitoDiB(), B), 380);
  assert.equal(bancarotta.patrimonioLiquidabile(H.nuovaPartita(), A), 1500);
  const s = debitoDiB();
  assert.equal(s.fase, 'debito');
  assert.deepEqual([s.debito.giocatoreId, s.debito.creditoreId, s.debito.importo], [B, A, 50]);
});

test('bancarotta verso un giocatore: tutto al creditore, costruzioni vendute, ipoteche e carta incluse', () => {
  const r = H.esegui(debitoDiB(), B, { tipo: 'dichiaraBancarotta' });
  const st = r.stato;
  assert.equal(giocatore(st, B).fallito, true, 'Regola: il debitore è fallito');
  assert.equal(giocatore(st, B).denaro, 0);
  for (const i of [6, 11, 13, 14]) assert.equal(voce(st, i).proprietario, A, `la casella ${i} passa al creditore`);
  assert.deepEqual([11, 13, 14].map((i) => voce(st, i).caseCostruite), [0, 0, 0], 'Regola: le case tornano alla banca');
  assert.equal(voce(st, 6).ipotecata, true, 'le ipoteche restano');
  assert.equal(st.caseDisponibili, 32, 'le 3 case sono tornate alla banca');
  assert.equal(giocatore(st, A).denaro, 1500 + 10 + 150 - 5,
    'A riceve il denaro di B (10 €) + 150 € dalla vendita delle case, e paga 5 € di interesse sull\'ipoteca ricevuta');
  assert.equal(giocatore(st, A).cartePrigione, 1, 'la carta prigione passa al creditore');
  assert.equal(st.cartePrigioneDi.P05, A);
  assert.equal(st.debito, null);
  assert.equal(st.turno.giocatoreId, C, 'B era di turno: il turno passa al giocatore successivo');
  assert.equal(st.fase, 'daLanciare');
  assert.ok(tipi(r).includes('bancarotta'));
  assert.deepEqual(motore.azioniDisponibili(st, B), []);
  H.rifiuta(st, B, { tipo: 'lanciaDadi' }, 'GIOCATORE_FALLITO', 'Un fallito non può più agire');
  H.verificaJson(st);
});

test('bancarotta verso la banca: proprietà libere e senza ipoteca, messe all\'asta una dopo l\'altra', () => {
  let s = H.ipotecate(H.assegna(H.nuovaPartita(), B, 1, 3, 6), 6);
  s = H.conCartaPrigione(H.soldi(s, B, 10), B, 'I08');
  let r = H.arrivaSu(s, B, 4, 1, 3); // Tassa patrimoniale 200 €, B ha 10 €
  assert.equal(r.stato.fase, 'debito');
  r = H.esegui(r.stato, B, { tipo: 'dichiaraBancarotta' });
  let st = r.stato;
  assert.equal(giocatore(st, B).fallito, true);
  assert.deepEqual([giocatore(st, A).denaro, giocatore(st, C).denaro], [1500, 1500], 'verso la banca il denaro di B sparisce');
  for (const i of [1, 3, 6]) {
    assert.deepEqual(voce(st, i), { proprietario: null, caseCostruite: 0, ipotecata: false }, `la casella ${i} torna libera e senza ipoteca`);
  }
  assert.ok(st.mazzi.imprevisti.includes('I08'), 'la carta prigione torna nel mazzo');
  assert.deepEqual(st.cartePrigioneDi, {});
  assert.equal(st.fase, 'asta', 'Regola: le proprietà del fallito vanno all\'asta');
  assert.equal(st.asta.casella, 1);
  assert.deepEqual(st.asta.partecipanti, [A, C], 'all\'asta partecipano solo i giocatori rimasti');
  assert.equal(st.turno.giocatoreId, C);

  st = H.esegui(st, A, { tipo: 'offertaAsta', importo: 10 }).stato;
  st = H.esegui(st, C, { tipo: 'passaAsta' }).stato; // A si aggiudica la casella 1
  assert.equal(voce(st, 1).proprietario, A);
  assert.equal(giocatore(st, A).denaro, 1490);
  assert.equal(st.asta.casella, 3, 'parte subito l\'asta della proprietà successiva');
  st = H.esegui(st, A, { tipo: 'passaAsta' }).stato;
  st = H.esegui(st, C, { tipo: 'passaAsta' }).stato;
  assert.equal(st.asta.casella, 6);
  st = H.esegui(st, A, { tipo: 'passaAsta' }).stato;
  st = H.esegui(st, C, { tipo: 'passaAsta' }).stato;
  assert.equal(st.asta, null);
  assert.equal(st.fase, 'daLanciare', 'finite le aste si riprende dal turno del giocatore successivo');
  assert.equal(st.turno.giocatoreId, C);
  assert.deepEqual([voce(st, 3).proprietario, voce(st, 6).proprietario], [null, null], 'senza offerte restano alla banca');
});

test('vittoria: quando resta un solo giocatore la partita finisce e non si può più agire', () => {
  let s = H.arrivaSu(H.soldi(H.assegna(H.nuovaPartita(2), A, 39), B, 10), B, 39, 3, 4).stato;
  let r = H.esegui(s, B, { tipo: 'dichiaraBancarotta' });
  assert.equal(r.stato.fase, 'finePartita', 'Regola: fine partita quando resta un solo giocatore non fallito');
  assert.equal(r.stato.vincitoreId, A);
  assert.equal(r.stato.debito, null);
  assert.equal(r.stato.asta, null);
  assert.ok(tipi(r).includes('finePartita'));
  assert.deepEqual(motore.azioniDisponibili(r.stato, A), []);
  H.rifiuta(r.stato, A, { tipo: 'lanciaDadi' }, 'FASE_ERRATA', 'A partita finita non si lancia più');
  H.rifiuta(r.stato, B, { tipo: 'lanciaDadi' }, 'GIOCATORE_FALLITO', 'Chi è fallito non agisce');

  s = H.arrivaSu(H.soldi(H.assegna(H.nuovaPartita(2), B, 1), B, 10), B, 4, 1, 3).stato; // tassa non pagabile
  r = H.esegui(s, B, { tipo: 'dichiaraBancarotta' });
  assert.equal(r.stato.fase, 'finePartita', 'fine partita anche con bancarotta verso la banca');
  assert.equal(r.stato.vincitoreId, A);
  assert.equal(r.stato.asta, null, 'a partita finita non parte nessuna asta');
});

test('bancarotta: ammessa solo al debitore e solo in fase di debito', () => {
  H.rifiuta(H.nuovaPartita(), A, { tipo: 'dichiaraBancarotta' }, 'FASE_ERRATA', 'Senza debito non si dichiara bancarotta');
  H.rifiuta(debitoDiB(), A, { tipo: 'dichiaraBancarotta' }, 'NON_DEBITORE', 'Solo il debitore può dichiarare bancarotta');
  H.rifiuta(debitoDiB(), C, { tipo: 'dichiaraBancarotta' }, 'NON_DEBITORE', 'Un terzo non può far fallire il debitore');
});

test('disconnessioni: annullano lo scambio, fanno passare dall\'asta e liberano il turno', () => {
  let s = H.modifica(H.esegui(s0(), A, proposta).stato, (x) => { giocatore(x, B).connesso = false; });
  let r = motore.gestisciDisconnessione(s, B, { ora: H.ORA_FISSA });
  assert.equal(r.stato.scambio, null, 'lo scambio con un disconnesso viene annullato');
  assert.ok(tipi(r).includes('scambioRifiutato'));

  s = H.modifica(inAsta(), (x) => { giocatore(x, B).connesso = false; });
  r = motore.gestisciDisconnessione(s, B, { ora: H.ORA_FISSA });
  assert.ok(r.stato.asta.passati.includes(B), 'un disconnesso che non è il miglior offerente passa l\'asta');

  s = H.modifica(H.nuovaPartita(), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; giocatore(x, A).connesso = false; });
  r = motore.gestisciDisconnessione(s, A, { ora: H.ORA_FISSA });
  assert.equal(r.stato.fase, 'asta', 'se il giocatore di turno sparisce davanti a un acquisto, la casella va all\'asta');
});
