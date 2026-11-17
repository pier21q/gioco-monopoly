'use strict';

/**
 * tests/motore-movimento.test.js
 * Movimento, 200 € al Via, doppi, prigione, turni, acquisto e asta.
 * I dadi sono forzati con H.dadi(...): ogni test è deterministico.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const { giocatore, voce } = H;
const tipi = (r) => r.eventi.map((e) => e.tipo);

// ---------------------------------------------------------------------------
// Movimento e Via
// ---------------------------------------------------------------------------

test('movimento: la pedina avanza della somma dei dadi (eventi dadi + movimento)', () => {
  const s = H.turnoDi(H.inCasella(H.nuovaPartita(), A, 14), A);
  const r = H.lancia(s, A, 2, 4); // 14 + 6 = 20, Parcheggio gratuito: non succede nulla
  assert.deepEqual(r.stato.dadi, [2, 4], 'stato.dadi deve contenere l\'ultimo lancio');
  assert.equal(giocatore(r.stato, A).posizione, 20, 'Regola: la pedina avanza della somma dei dadi');
  assert.equal(giocatore(r.stato, A).denaro, 1500, 'Regola: il Parcheggio gratuito non dà né toglie denaro');
  assert.deepEqual(tipi(r), ['dadi', 'movimento']);
  assert.equal(r.stato.fase, 'mossa', 'dopo un lancio senza doppio si può solo finire il turno');
  assert.equal(r.stato.versione, s.versione + 1, 'ogni azione accettata incrementa la versione di 1');
  H.verificaJson(r.stato);
});

test('Via: passando dal Via si riscuotono 200 €', () => {
  const s = H.turnoDi(H.inCasella(H.nuovaPartita(), A, 38), A);
  const r = H.lancia(s, A, 2, 3); // 38 + 5 = 43 → casella 3
  assert.equal(giocatore(r.stato, A).posizione, 3);
  assert.equal(giocatore(r.stato, A).denaro, 1700, 'Regola: passare dal Via vale 200 €');
  assert.deepEqual(tipi(r), ['dadi', 'movimento', 'passaggioVia']);
  assert.equal(r.eventi[1].dati.passatoDalVia, true);
  assert.equal(r.eventi[2].dati.importo, 200);
});

test('Via: anche arrivare esattamente sul Via vale 200 €', () => {
  const s = H.turnoDi(H.inCasella(H.nuovaPartita(), A, 35), A);
  const r = H.lancia(s, A, 2, 3); // 35 + 5 = 40 → casella 0
  assert.equal(giocatore(r.stato, A).posizione, 0);
  assert.equal(giocatore(r.stato, A).denaro, 1700, 'Regola: arrivare sul Via riscuote 200 €');
});

test('Via: non si riscuotono 200 € andando in prigione dalla casella "In prigione!"', () => {
  const s = H.turnoDi(H.inCasella(H.nuovaPartita(), A, 26), A);
  const r = H.lancia(s, A, 1, 3); // 26 + 4 = 30
  const a = giocatore(r.stato, A);
  assert.equal(a.posizione, 10, 'Regola: dalla casella 30 si va in prigione (casella 10)');
  assert.equal(a.inPrigione, true);
  assert.equal(a.denaro, 1500, 'Regola: andando in prigione non si ritirano 200 €');
  assert.equal(r.stato.fase, 'mossa', 'dopo "In prigione!" il turno può solo finire');
  assert.ok(!tipi(r).includes('passaggioVia'));
});

test('Prigione / Transito: arrivarci con i dadi non manda in prigione', () => {
  const s = H.turnoDi(H.inCasella(H.nuovaPartita(), A, 4), A);
  const r = H.lancia(s, A, 2, 4); // 4 + 6 = 10
  assert.equal(giocatore(r.stato, A).posizione, 10);
  assert.equal(giocatore(r.stato, A).inPrigione, false, 'Regola: la casella 10 è solo "transito" per chi vi arriva coi dadi');
});

// ---------------------------------------------------------------------------
// Doppi
// ---------------------------------------------------------------------------

test('doppi: un doppio dà un altro lancio, il terzo doppio consecutivo manda in prigione', () => {
  let r = H.lancia(H.nuovaPartita(), A, 5, 5); // 0 → 10 (transito), doppio
  assert.equal(giocatore(r.stato, A).posizione, 10);
  assert.equal(r.stato.fase, 'daLanciare', 'Regola: con un doppio si lancia di nuovo');
  assert.equal(r.stato.turno.giocatoreId, A, 'dopo un doppio il turno resta dello stesso giocatore');
  assert.equal(r.stato.turno.doppiConsecutivi, 1);
  assert.ok(motore.azioniDisponibili(r.stato, A).includes('lanciaDadi'));
  assert.ok(!motore.azioniDisponibili(r.stato, A).includes('finisciTurno'), 'non si può chiudere il turno prima di rilanciare');
  H.rifiuta(r.stato, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA', 'Dopo un doppio non si può finire il turno');

  r = H.lancia(r.stato, A, 5, 5); // 10 → 20, secondo doppio
  assert.equal(r.stato.turno.doppiConsecutivi, 2);
  assert.equal(r.stato.fase, 'daLanciare');

  r = H.lancia(r.stato, A, 1, 1); // terzo doppio
  const a = giocatore(r.stato, A);
  assert.equal(a.inPrigione, true, 'Regola: tre doppi consecutivi mandano in prigione');
  assert.equal(a.posizione, 10, 'con il terzo doppio la pedina NON si muove: va direttamente in prigione');
  assert.equal(a.denaro, 1500, 'andando in prigione non si ritirano 200 €');
  assert.equal(r.stato.turno.doppiConsecutivi, 0);
  assert.equal(r.stato.fase, 'mossa');
  assert.deepEqual(tipi(r), ['dadi', 'prigione']);
  assert.equal(r.eventi[1].dati.motivo, 'treDoppi');
});

test('doppi: un lancio senza doppio azzera il conteggio e chiude la mossa', () => {
  let r = H.lancia(H.nuovaPartita(), A, 5, 5); // doppio → pos 10
  r = H.lancia(r.stato, A, 4, 6); // 10 + 10 = 20, non doppio
  assert.equal(r.stato.turno.doppiConsecutivi, 0, 'Regola: il conteggio dei doppi riparte da zero');
  assert.equal(r.stato.fase, 'mossa');
});

test('doppi: dopo aver comprato con un doppio si rilancia', () => {
  let r = H.lancia(H.nuovaPartita(), A, 3, 3); // 0 → 6 Bastioni Gran Sasso (100 €)
  assert.equal(r.stato.fase, 'daDecidereAcquisto');
  r = H.esegui(r.stato, A, { tipo: 'compra' });
  assert.equal(r.stato.fase, 'daLanciare', 'Regola: dopo un doppio, anche comprando, si lancia ancora');
  assert.equal(giocatore(r.stato, A).denaro, 1400);
});

test('turni: finisciTurno passa al giocatore successivo, azzera i doppi e salta i falliti', () => {
  let s = H.turnoDi(H.nuovaPartita(), A, 'mossa');
  let r = H.esegui(s, A, { tipo: 'finisciTurno' });
  assert.equal(r.stato.turno.giocatoreId, B);
  assert.equal(r.stato.turno.numero, s.turno.numero + 1);
  assert.equal(r.stato.turno.doppiConsecutivi, 0);
  assert.equal(r.stato.fase, 'daLanciare');
  assert.equal(r.eventi[0].tipo, 'turno');

  r = H.esegui(H.modifica(r.stato, (x) => { x.fase = 'mossa'; }), B, { tipo: 'finisciTurno' });
  r = H.esegui(H.modifica(r.stato, (x) => { x.fase = 'mossa'; }), C, { tipo: 'finisciTurno' });
  assert.equal(r.stato.turno.giocatoreId, A, 'dopo l\'ultimo giocatore si torna al primo');

  s = H.modifica(H.turnoDi(H.nuovaPartita(), B, 'mossa'), (x) => { giocatore(x, C).fallito = true; });
  r = H.esegui(s, B, { tipo: 'finisciTurno' });
  assert.equal(r.stato.turno.giocatoreId, A, 'Regola: un giocatore fallito viene saltato');
});

test('turni: i giocatori disconnessi vengono saltati con un evento turnoSaltato', () => {
  const s = H.modifica(H.turnoDi(H.nuovaPartita(), A, 'mossa'), (x) => { giocatore(x, B).connesso = false; });
  const r = H.esegui(s, A, { tipo: 'finisciTurno' });
  assert.equal(r.stato.turno.giocatoreId, C, 'Regola: il turno passa oltre chi è disconnesso');
  assert.ok(tipi(r).includes('turnoSaltato'));
});

test('disconnessione: gestisciDisconnessione fa passare il turno di chi è sparito e non fa nulla se non serve', () => {
  const s = H.modifica(H.nuovaPartita(), (x) => { giocatore(x, A).connesso = false; });
  const r = motore.gestisciDisconnessione(s, A, { ora: H.ORA_FISSA });
  assert.equal(r.stato.turno.giocatoreId, B, 'Regola: se il giocatore di turno è disconnesso il turno passa al prossimo');
  assert.ok(r.eventi.length > 0);
  const nulla = motore.gestisciDisconnessione(s, C, { ora: H.ORA_FISSA });
  assert.equal(nulla.stato, s, 'se non c\'è nulla da fare lo stato resta lo stesso oggetto');
  assert.deepEqual(nulla.eventi, []);
});

// ---------------------------------------------------------------------------
// Prigione
// ---------------------------------------------------------------------------

test('prigione: con un doppio si esce, si muove e NON si rilancia', () => {
  const s = H.turnoDi(H.inPrigione(H.nuovaPartita(), A, 1), A);
  const r = H.lancia(s, A, 5, 5);
  const a = giocatore(r.stato, A);
  assert.equal(a.inPrigione, false, 'Regola: con un doppio si esce di prigione');
  assert.equal(a.posizione, 20, 'si avanza della somma dei dadi (10 + 10)');
  assert.equal(a.denaro, 1500, 'uscire col doppio non costa nulla');
  assert.equal(r.stato.fase, 'mossa', 'Regola: uscendo con un doppio non si rilancia');
  assert.equal(r.stato.turno.doppiConsecutivi, 0);
  assert.deepEqual(tipi(r), ['dadi', 'uscitaPrigione', 'movimento']);
});

test('prigione: senza doppio si resta dentro (3 tentativi) e il turno finisce', () => {
  let s = H.turnoDi(H.inPrigione(H.nuovaPartita(), A, 0), A);
  let r = H.lancia(s, A, 1, 2);
  assert.equal(giocatore(r.stato, A).inPrigione, true);
  assert.equal(giocatore(r.stato, A).posizione, 10, 'chi resta in prigione non si muove');
  assert.equal(giocatore(r.stato, A).turniInPrigione, 1);
  assert.equal(r.stato.fase, 'mossa');
  assert.deepEqual(tipi(r), ['dadi']);

  s = H.turnoDi(H.inPrigione(H.nuovaPartita(), A, 1), A);
  r = H.lancia(s, A, 1, 2);
  assert.equal(giocatore(r.stato, A).turniInPrigione, 2, 'secondo tentativo fallito');
  assert.equal(giocatore(r.stato, A).inPrigione, true);
});

test('prigione: al terzo tentativo fallito si paga 50 €, si esce e ci si muove', () => {
  const s = H.turnoDi(H.inPrigione(H.nuovaPartita(), A, 2), A);
  const r = H.lancia(s, A, 4, 6);
  const a = giocatore(r.stato, A);
  assert.equal(a.inPrigione, false, 'Regola: dopo il terzo tentativo fallito si esce');
  assert.equal(a.denaro, 1450, 'Regola: al terzo tentativo si paga la cauzione di 50 €');
  assert.equal(a.posizione, 20, 'e si avanza della somma dei dadi');
  assert.deepEqual(tipi(r), ['dadi', 'uscitaPrigione', 'pagamento', 'movimento']);
});

test('prigione: al terzo tentativo senza liquidità la cauzione diventa un debito verso la banca', () => {
  const s = H.soldi(H.turnoDi(H.inPrigione(H.nuovaPartita(), A, 2), A), A, 30);
  const r = H.lancia(s, A, 4, 6);
  assert.equal(r.stato.fase, 'debito', 'Regola: non si va mai in negativo, si apre un debito');
  assert.equal(giocatore(r.stato, A).denaro, 30, 'il denaro non deve scendere sotto zero');
  assert.deepEqual({ ...r.stato.debito, faseDopo: undefined },
    { giocatoreId: A, creditoreId: null, importo: 50, motivo: 'cauzione', faseDopo: undefined });
  assert.equal(giocatore(r.stato, A).inPrigione, false);
  assert.equal(giocatore(r.stato, A).posizione, 20, 'il giocatore si muove comunque');
});

test('prigione: pagaCauzione costa 50 €, libera e permette di lanciare normalmente', () => {
  const s = H.turnoDi(H.inPrigione(H.nuovaPartita(), A), A);
  let r = H.esegui(s, A, { tipo: 'pagaCauzione' });
  assert.equal(giocatore(r.stato, A).inPrigione, false);
  assert.equal(giocatore(r.stato, A).denaro, 1450, 'Regola: la cauzione costa 50 €');
  assert.equal(r.stato.fase, 'daLanciare', 'dopo la cauzione si lancia i dadi');
  r = H.lancia(r.stato, A, 1, 2);
  assert.equal(giocatore(r.stato, A).posizione, 13);

  const povero = H.soldi(s, A, 49);
  H.rifiuta(povero, A, { tipo: 'pagaCauzione' }, 'FONDI_INSUFFICIENTI', 'Con 49 € non si può pagare la cauzione di 50 €');
  assert.equal(giocatore(H.esegui(H.soldi(s, A, 50), A, { tipo: 'pagaCauzione' }).stato, A).denaro, 0, 'con esattamente 50 € si può');
  H.rifiuta(H.turnoDi(H.nuovaPartita(), A), A, { tipo: 'pagaCauzione' }, 'NON_IN_PRIGIONE', 'Chi non è in prigione non può pagare la cauzione');
  H.rifiuta(s, B, { tipo: 'pagaCauzione' }, 'NON_IL_TUO_TURNO', 'La cauzione la paga solo chi è di turno');
});

test('prigione: usaCartaPrigione esce gratis e la carta torna in fondo al suo mazzo', () => {
  for (const [carta, mazzo] of [['P05', 'probabilita'], ['I08', 'imprevisti']]) {
    const s = H.turnoDi(H.conCartaPrigione(H.inPrigione(H.nuovaPartita(), A), A, carta), A);
    const r = H.esegui(s, A, { tipo: 'usaCartaPrigione' });
    const a = giocatore(r.stato, A);
    assert.equal(a.inPrigione, false, 'Regola: la carta fa uscire di prigione');
    assert.equal(a.cartePrigione, 0, 'la carta viene consumata');
    assert.equal(a.denaro, 1500, 'la carta è gratuita');
    assert.equal(r.stato.mazzi[mazzo].at(-1), carta, `la carta ${carta} torna in fondo al mazzo ${mazzo}`);
    assert.equal(r.stato.mazzi[mazzo].length, 16);
    assert.deepEqual(r.stato.cartePrigioneDi, {});
    assert.equal(r.stato.fase, 'daLanciare');
  }
  H.rifiuta(H.turnoDi(H.inPrigione(H.nuovaPartita(), A), A), A, { tipo: 'usaCartaPrigione' }, 'NESSUNA_CARTA_PRIGIONE', 'Senza carta non si può usarla');
  H.rifiuta(H.turnoDi(H.conCartaPrigione(H.nuovaPartita(), A), A), A, { tipo: 'usaCartaPrigione' }, 'NON_IN_PRIGIONE', 'Fuori di prigione la carta non si usa');
});

// ---------------------------------------------------------------------------
// Acquisto
// ---------------------------------------------------------------------------

const daAcquisto = () => H.modifica(H.nuovaPartita(), (s) => { giocatore(s, A).posizione = 3; s.fase = 'daDecidereAcquisto'; });

test('acquisto: arrivando su una proprietà libera si può comprarla al prezzo di listino', () => {
  let r = H.lancia(H.nuovaPartita(), A, 1, 2); // 0 → 3 Vicolo Stretto (60 €)
  assert.equal(r.stato.fase, 'daDecidereAcquisto');
  assert.deepEqual(motore.azioniDisponibili(r.stato, A).filter((t) => ['compra', 'rifiutaAcquisto', 'lanciaDadi'].includes(t)),
    ['compra', 'rifiutaAcquisto']);
  r = H.esegui(r.stato, A, { tipo: 'compra' });
  assert.equal(voce(r.stato, 3).proprietario, A, 'Regola: chi compra diventa proprietario');
  assert.equal(giocatore(r.stato, A).denaro, 1440, 'Regola: si paga il prezzo di listino (60 €)');
  assert.equal(r.stato.fase, 'mossa');
  assert.equal(r.eventi[0].tipo, 'acquisto');
});

test('acquisto: servono i soldi (con esattamente il prezzo si può) e solo nella fase giusta', () => {
  const s = daAcquisto();
  H.rifiuta(H.soldi(s, A, 59), A, { tipo: 'compra' }, 'FONDI_INSUFFICIENTI', 'Con 59 € non si compra una proprietà da 60 €');
  const r = H.esegui(H.soldi(s, A, 60), A, { tipo: 'compra' });
  assert.equal(giocatore(r.stato, A).denaro, 0, 'con esattamente 60 € l\'acquisto è possibile');
  H.rifiuta(H.turnoDi(s, A, 'mossa'), A, { tipo: 'compra' }, 'FASE_ERRATA', 'Non si compra fuori dalla fase di decisione');
  H.rifiuta(s, B, { tipo: 'compra' }, 'NON_IL_TUO_TURNO', 'Compra solo chi è di turno');
});

test('acquisto: sulla propria proprietà non si paga né si compra nulla', () => {
  const s = H.assegna(H.turnoDi(H.inCasella(H.nuovaPartita(), A, 0), A), A, 3);
  const r = H.lancia(s, A, 1, 2);
  assert.equal(r.stato.fase, 'mossa');
  assert.equal(giocatore(r.stato, A).denaro, 1500);
});

// ---------------------------------------------------------------------------
// Asta
// ---------------------------------------------------------------------------

test('asta: rifiutare l\'acquisto apre un\'asta fra gli altri giocatori in gioco', () => {
  const r = H.esegui(daAcquisto(), A, { tipo: 'rifiutaAcquisto' });
  const a = r.stato.asta;
  assert.equal(r.stato.fase, 'asta');
  assert.equal(a.casella, 3);
  assert.deepEqual(a.partecipanti, [B, C], 'Regola: chi ha rinunciato all\'acquisto non partecipa');
  assert.equal(a.esclusoId, A);
  assert.equal(r.eventi[0].dati.esclusoId, A);
  assert.match(r.eventi[0].testo, /Anna ha rinunciato e non partecipa/);
  assert.equal(a.offertaMassima, 0);
  assert.equal(a.migliorOfferenteId, null);
  assert.deepEqual(a.passati, []);
  assert.equal(a.incrementoMinimo, 1);
  assert.equal(r.eventi[0].tipo, 'astaInizio');
});

test('asta: offerte, rilanci e vittoria dell\'ultimo rimasto', () => {
  let s = H.esegui(daAcquisto(), A, { tipo: 'rifiutaAcquisto' }).stato;
  s = H.esegui(s, B, { tipo: 'offertaAsta', importo: 100 }).stato;
  assert.equal(s.asta.offertaMassima, 100);
  assert.equal(s.asta.migliorOfferenteId, B);
  H.rifiuta(s, C, { tipo: 'offertaAsta', importo: 100 }, 'OFFERTA_BASSA', 'Un\'offerta uguale alla massima non basta: deve superarla');
  H.rifiuta(s, A, { tipo: 'offertaAsta', importo: 200 }, 'GIOCATORE_NON_VALIDO', 'Chi ha rinunciato all\'acquisto non può offrire');
  H.rifiuta(s, A, { tipo: 'passaAsta' }, 'GIOCATORE_NON_VALIDO', 'Chi ha rinunciato all\'acquisto non partecipa: non ha niente da passare');
  H.rifiuta(s, C, { tipo: 'offertaAsta', importo: 5000 }, 'FONDI_INSUFFICIENTI', 'Non si può offrire più di quanto si possiede');
  for (const importo of [0, -5, 1.5, '10', undefined, null]) {
    H.rifiuta(s, C, { tipo: 'offertaAsta', importo }, 'PARAMETRI_NON_VALIDI', `L'offerta ${JSON.stringify(importo)} non è un intero positivo`);
  }
  H.rifiuta(s, B, { tipo: 'passaAsta' }, 'MIGLIOR_OFFERENTE', 'Il miglior offerente non può passare');
  s = H.esegui(s, B, { tipo: 'offertaAsta', importo: 120 }).stato; // può rilanciare su se stesso
  assert.equal(s.asta.offertaMassima, 120);
  const senzaOfferte = H.esegui(H.esegui(daAcquisto(), A, { tipo: 'rifiutaAcquisto' }).stato, C, { tipo: 'passaAsta' }).stato;
  H.rifiuta(senzaOfferte, C, { tipo: 'passaAsta' }, 'GIA_PASSATO', 'Chi ha già passato non può passare di nuovo');
  H.rifiuta(senzaOfferte, C, { tipo: 'offertaAsta', importo: 130 }, 'GIA_PASSATO', 'Chi ha passato non può più offrire');
  const r = H.esegui(s, C, { tipo: 'passaAsta' });
  assert.equal(r.stato.asta, null, 'Regola: l\'asta termina quando resta solo il miglior offerente');
  assert.equal(voce(r.stato, 3).proprietario, B, 'la proprietà va al miglior offerente');
  assert.equal(giocatore(r.stato, B).denaro, 1380, 'paga l\'offerta massima (120 €)');
  assert.equal(r.stato.fase, 'mossa', 'dopo l\'asta si torna alla fase del giocatore di turno');
  assert.equal(r.stato.turno.giocatoreId, A);
  assert.ok(tipi(r).includes('astaFine'));
});

test('asta: se tutti passano senza offerte la proprietà resta alla banca', () => {
  let s = H.esegui(daAcquisto(), A, { tipo: 'rifiutaAcquisto' }).stato;
  s = H.esegui(s, B, { tipo: 'passaAsta' }).stato;
  assert.equal(s.fase, 'asta', 'finché manca un giocatore l\'asta resta aperta');
  s = H.esegui(s, C, { tipo: 'passaAsta' }).stato;
  assert.equal(s.fase, 'mossa');
  assert.equal(voce(s, 3).proprietario, null, 'Regola: senza offerte la proprietà resta alla banca');
  assert.equal(s.asta, null);
});

test('asta: con due giocatori basta un\'offerta dell\'altro; dopo un doppio si rilancia', () => {
  let s = H.modifica(H.nuovaPartita(2), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; x.turno.doppiConsecutivi = 1; });
  s = H.esegui(s, A, { tipo: 'rifiutaAcquisto' }).stato;
  assert.deepEqual(s.asta.partecipanti, [B], 'chi ha rinunciato resta fuori: in gara c\'è solo l\'altro');
  const r = H.esegui(s, B, { tipo: 'offertaAsta', importo: 10 });
  assert.equal(voce(r.stato, 3).proprietario, B, 'unico in gara con un\'offerta: vince subito');
  assert.equal(r.stato.fase, 'daLanciare', 'Regola: se la mossa era un doppio, dopo l\'asta si lancia ancora');
});

test('asta: azioni d\'asta fuori dall\'asta o da chi non partecipa vengono rifiutate', () => {
  const s = H.nuovaPartita();
  H.rifiuta(s, A, { tipo: 'offertaAsta', importo: 10 }, 'FASE_ERRATA', 'Non si offre se non c\'è un\'asta');
  H.rifiuta(s, B, { tipo: 'passaAsta' }, 'FASE_ERRATA', 'Non si passa se non c\'è un\'asta');
  const inAsta = H.esegui(daAcquisto(), A, { tipo: 'rifiutaAcquisto' }).stato;
  H.rifiuta(inAsta, A, { tipo: 'compra' }, 'FASE_ERRATA', 'Durante l\'asta non si compra a prezzo di listino');
  H.rifiuta(inAsta, A, { tipo: 'lanciaDadi' }, 'FASE_ERRATA', 'Durante l\'asta non si lanciano i dadi');
  H.rifiuta(inAsta, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA', 'Durante l\'asta non si finisce il turno');
  const senzaC = H.modifica(inAsta, (x) => { x.asta.partecipanti = [A, B]; });
  H.rifiuta(senzaC, C, { tipo: 'offertaAsta', importo: 10 }, 'GIOCATORE_NON_VALIDO', 'Chi non partecipa all\'asta non può offrire');
});

test('asta: chi è disconnesso all\'avvio parte già "passato"', () => {
  const s = H.modifica(daAcquisto(), (x) => { giocatore(x, C).connesso = false; });
  const r = H.esegui(s, A, { tipo: 'rifiutaAcquisto' });
  assert.deepEqual(r.stato.asta.passati, [C], 'Regola: un disconnesso non deve bloccare l\'asta');
});
