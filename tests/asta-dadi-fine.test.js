'use strict';

/**
 * tests/asta-dadi-fine.test.js
 *
 * Tre regole aggiunte insieme:
 *   - asta: chi rinuncia all'acquisto non partecipa, e il timer dell'asta
 *     (30 secondi, riparte a ogni offerta) arriva ai client dentro lo stato;
 *   - carta "società più vicina": i dadi dell'affitto li lancia il giocatore
 *     (fase 'lancioAffitto'), il gioco solo se lui non c'è o non lancia;
 *   - a partita finita la stanza si chiude da sola dopo 30 secondi, o subito
 *     se escono tutti.
 *
 * I timer sono quelli veri del server con l'orologio finto di node:test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const stanze = require('../server/stanze');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const { giocatore, voce } = H;
const T = stanze.TEMPI;
const SECONDO = 1000;
const tipi = (r) => r.eventi.map((e) => e.tipo);

// ---------------------------------------------------------------------------
// Motore: chi rinuncia non partecipa all'asta
// ---------------------------------------------------------------------------

/** A è sulla casella 3, libera, e deve decidere se comprarla. */
const daAcquisto = (n = 3) => H.modifica(H.nuovaPartita(n), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; });

test('asta: chi non decide in tempo o è scollegato resta fuori come chi rinuncia', () => {
  const inattivo = motore.gestisciInattivita(daAcquisto(), A, { ora: H.ORA_FISSA });
  assert.equal(inattivo.stato.fase, 'asta');
  assert.deepEqual(inattivo.stato.asta.partecipanti, [B, C]);
  assert.equal(inattivo.stato.asta.esclusoId, A);

  const assente = H.modifica(daAcquisto(), (x) => { giocatore(x, A).connesso = false; });
  const scollegato = motore.gestisciDisconnessione(assente, A, { ora: H.ORA_FISSA });
  assert.deepEqual(scollegato.stato.asta.partecipanti, [B, C]);
  assert.deepEqual(scollegato.stato.asta.passati, [], 'gli altri sono collegati: l\'asta è loro');
});

test('asta: chi ha rinunciato non può vendere o ipotecare durante l\'asta, e resta fuori se riparte', () => {
  const base = H.assegna(daAcquisto(), A, 39);
  let s = H.esegui(base, A, { tipo: 'rifiutaAcquisto' }).stato;
  H.rifiuta(s, A, { tipo: 'ipoteca', casella: 39 }, 'GIOCATORE_NON_VALIDO', 'Durante l\'asta gestisce il patrimonio solo chi partecipa');
  assert.deepEqual(motore.azioniDisponibili(s, A), ['abbandona'], 'a chi ha rinunciato resta solo l\'abbandono');
  assert.deepEqual(motore.chiDeveAgire(s), [B, C]);

  // Il miglior offerente abbandona: l'asta riparte, ma sempre senza chi aveva rinunciato.
  s = H.esegui(s, B, { tipo: 'offertaAsta', importo: 50 }).stato;
  const r = H.esegui(s, B, { tipo: 'abbandona' });
  assert.equal(r.stato.fase, 'asta');
  assert.equal(r.stato.asta.partecipanti.includes(A), false);
  assert.equal(r.stato.asta.esclusoId, A);
  const fine = H.esegui(r.stato, C, { tipo: 'offertaAsta', importo: 5 });
  assert.equal(voce(fine.stato, 3).proprietario, C);
});

test('asta: le aste della banca (beni di chi abbandona) sono aperte a tutti', () => {
  const s = H.assegna(H.nuovaPartita(4), H.ID.D, 1);
  const r = H.esegui(s, H.ID.D, { tipo: 'abbandona' });
  assert.equal(r.stato.fase, 'asta');
  assert.deepEqual(r.stato.asta.partecipanti, [A, B, C]);
  assert.equal(r.stato.asta.esclusoId, null);
});

// ---------------------------------------------------------------------------
// Motore: i dadi della carta "società più vicina"
// ---------------------------------------------------------------------------

/** A pesca I04 sulla casella 22; la società più vicina (28) è di B. Resta da lanciare per l'affitto. */
function daLanciarePerAffitto({ prepara = () => {}, d1 = 1, d2 = 2 } = {}) {
  const base = H.modifica(H.assegna(H.nuovaPartita(), B, 28), (x) => {
    x.mazzi.imprevisti = ['I04', ...x.mazzi.imprevisti.filter((id) => id !== 'I04')];
    prepara(x);
  });
  const r = H.arrivaSu(base, A, 22, d1, d2);
  assert.equal(r.stato.fase, 'lancioAffitto');
  assert.equal(giocatore(r.stato, A).posizione, 28);
  return r.stato;
}

test('dadi per l\'affitto: tocca a chi ha pescato, e finché non lancia non si fa altro', () => {
  const s = daLanciarePerAffitto();
  assert.deepEqual(motore.chiDeveAgire(s), [A]);
  assert.deepEqual(motore.azioniDisponibili(s, A).sort(), ['abbandona', 'lanciaDadi', 'proponiScambio']);
  for (const tipo of ['finisciTurno', 'compra', 'rifiutaAcquisto']) {
    H.rifiuta(s, A, { tipo }, 'FASE_ERRATA', `In fase lancioAffitto "${tipo}" non è ammessa`);
  }
  const err = H.rifiuta(s, A, { tipo: 'ipoteca', casella: 28 }, 'FASE_ERRATA', 'Prima si lancia');
  assert.match(err.messaggio, /Anna deve lanciare i dadi per l'affitto/);
  H.rifiuta(s, B, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO', 'I dadi dell\'affitto li lancia chi ha pescato');
  assert.equal(motore.statoPubblico(s).lancioAffitto.creditoreId, B, 'i client sanno a chi andrà l\'affitto');
});

test('dadi per l\'affitto: il doppio non conta e dopo un doppio vero si rilancia', () => {
  const s = daLanciarePerAffitto({ d1: 2, d2: 2 });
  assert.equal(s.turno.doppiConsecutivi, 1);
  const r = H.lancia(s, A, 5, 5);
  assert.equal(giocatore(r.stato, B).denaro, 1600, '10 × (5 + 5)');
  assert.equal(r.stato.turno.doppiConsecutivi, 1, 'il doppio lanciato per l\'affitto non si somma');
  assert.equal(r.stato.fase, 'daLanciare', 'il doppio del movimento dà ancora diritto a rilanciare');
  assert.equal(giocatore(r.stato, A).posizione, 28, 'il lancio per l\'affitto non muove la pedina');
  const ev = r.eventi.find((e) => e.tipo === 'dadi');
  assert.equal(ev.dati.perAffitto, true);
});

test('dadi per l\'affitto: senza soldi si apre il debito e poi si torna alla mossa', () => {
  const s = daLanciarePerAffitto({ prepara: (x) => { giocatore(x, A).denaro = 20; } });
  const r = H.lancia(s, A, 3, 4);
  assert.equal(r.stato.fase, 'debito');
  const d = r.stato.debito;
  assert.deepEqual([d.giocatoreId, d.creditoreId, d.importo, d.motivo, d.faseDopo], [A, B, 70, 'affitto', 'mossa']);
  assert.equal(r.stato.lancioAffitto, null);
});

test('dadi per l\'affitto: se la società cambia mano prima del lancio valgono i conti di adesso', () => {
  // Passata a C con uno scambio: l'affitto va a C.
  let r = H.lancia(H.modifica(daLanciarePerAffitto(), (x) => { voce(x, 28).proprietario = C; }), A, 3, 4);
  assert.deepEqual([giocatore(r.stato, B).denaro, giocatore(r.stato, C).denaro], [1500, 1570]);
  // Passata proprio a chi deve lanciare: non paga nessuno.
  r = H.lancia(H.modifica(daLanciarePerAffitto(), (x) => { voce(x, 28).proprietario = A; }), A, 3, 4);
  assert.equal(giocatore(r.stato, A).denaro, 1500);
  assert.equal(tipi(r).includes('affitto'), false);
  assert.equal(r.stato.fase, 'mossa');
  // Ipotecata nel frattempo: affitto non dovuto, con l'evento che lo dice.
  r = H.lancia(H.modifica(daLanciarePerAffitto(), (x) => { voce(x, 28).ipotecata = true; }), A, 3, 4);
  assert.equal(giocatore(r.stato, A).denaro, 1500);
  assert.equal(r.eventi.find((e) => e.tipo === 'affitto').dati.importo, 0);
});

test('dadi per l\'affitto: se chi deve lanciare non lo fa o è scollegato lancia il gioco, poi il turno passa', () => {
  const s = daLanciarePerAffitto();
  let r = motore.gestisciInattivita(s, A, { random: H.dadi(6, 5), ora: H.ORA_FISSA });
  assert.deepEqual(tipi(r), ['dadi', 'affitto', 'turnoSaltato', 'turno']);
  assert.equal(r.eventi[0].dati.motivo, 'inattivo');
  assert.match(r.eventi[0].testo, /non ha lanciato in tempo/);
  assert.equal(giocatore(r.stato, B).denaro, 1610);
  assert.equal(r.stato.turno.giocatoreId, B);
  assert.equal(r.stato.fase, 'daLanciare');
  assert.equal(r.stato.lancioAffitto, null);

  const assente = H.modifica(s, (x) => { giocatore(x, A).connesso = false; });
  r = motore.gestisciDisconnessione(assente, A, { random: H.dadi(1, 1), ora: H.ORA_FISSA });
  assert.equal(r.eventi[0].dati.motivo, 'disconnesso');
  assert.equal(giocatore(r.stato, B).denaro, 1520);
  assert.equal(r.stato.turno.giocatoreId, B);
});

test('dadi per l\'affitto: se chi deve lanciare abbandona non resta niente in sospeso', () => {
  const r = H.esegui(daLanciarePerAffitto(), A, { tipo: 'abbandona' });
  assert.equal(r.stato.lancioAffitto, null);
  assert.equal(r.stato.fase, 'daLanciare');
  assert.equal(r.stato.turno.giocatoreId, B);
  assert.equal(giocatore(r.stato, B).denaro, 1500);
});

test('dadi per l\'affitto: una partita salvata prima della modifica si carica lo stesso', () => {
  const vecchia = H.modifica(H.nuovaPartita(), (x) => { delete x.lancioAffitto; });
  const r = H.lancia(vecchia, A, 1, 2);
  assert.equal(r.stato.lancioAffitto, null);
});

// ---------------------------------------------------------------------------
// Server: timer dell'asta e chiusura a partita finita
// ---------------------------------------------------------------------------

/** Socket finto: raccoglie i messaggi inviati. */
function socketFinto() {
  return { readyState: 1, ricevuti: [], send(x) { this.ricevuti.push(JSON.parse(x)); }, close() { this.readyState = 3; } };
}

/** Orologio finto: `ora()` per il server, `avanti(ms)` per far passare il tempo. */
function orologio(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let adesso = H.ORA_FISSA();
  return {
    ora: () => adesso,
    avanti(ms) {
      for (let resto = ms; resto > 0;) {
        const passo = Math.min(resto, SECONDO);
        adesso += passo;
        t.mock.timers.tick(passo);
        resto -= passo;
      }
    },
  };
}

/** Partita avviata (lancio iniziale già fatto) con i giocatori collegati. */
function partita(ora, nomi) {
  stanze.azzera();
  const stanza = stanze.crea({ ora, random: H.rngDeterministico(3) });
  const socket = nomi.map(() => socketFinto());
  const ids = nomi.map((nome, i) => stanze.entra(stanza, { nome, socket: socket[i], ora }).giocatore.id);
  assert.equal(stanze.avvia(stanza, ids[0], { ora, random: H.rngDeterministico(5), regole: {} }).errore, undefined);
  H.completaOrdine(stanze, stanza, { ora });
  return { stanza, ids, socket };
}

test('timer dell\'asta: 30 secondi mandati ai client, ripartono a ogni offerta, senza preavviso', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    const [primo, secondo] = ids.filter((id) => id !== diTurno);
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.durataMs, T.INATTIVITA_TURNO_MS, 'anche il turno ha la sua scadenza');
    stanza.stato = H.modifica(stanza.stato, (s) => { giocatore(s, diTurno).posizione = 1; s.fase = 'daDecidereAcquisto'; });
    assert.equal(stanze.applica(stanza, diTurno, { tipo: 'rifiutaAcquisto' }, { ora }).errore, undefined);
    assert.equal(stanza.stato.fase, 'asta');

    assert.equal(T.INATTIVITA_ASTA_MS, 30 * SECONDO);
    const scadenza = stanze.statoPerClient(stanza, { ora }).scadenza;
    assert.deepEqual({ ...scadenza, giocatori: [...scadenza.giocatori].sort() },
      { traMs: 30 * SECONDO, durataMs: 30 * SECONDO, giocatori: [primo, secondo].sort() });
    assert.equal(stanza.timer.has('_stanza|preavviso'), false, 'il tempo si vede nella finestra: niente preavviso');
    assert.equal(stanza.timer.has('_stanza|scadenza'), true);

    avanti(10 * SECONDO);
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.traMs, 20 * SECONDO, 'chi rientra a metà vede il tempo che resta');

    assert.equal(stanze.applica(stanza, primo, { tipo: 'offertaAsta', importo: 10 }, { ora }).errore, undefined);
    assert.deepEqual(stanze.statoPerClient(stanza, { ora }).scadenza,
      { traMs: 30 * SECONDO, durataMs: 30 * SECONDO, giocatori: [secondo] });

    avanti(29 * SECONDO);
    assert.equal(stanza.stato.fase, 'asta');
    avanti(SECONDO);
    assert.equal(stanza.stato.asta, null, 'scaduto il tempo chi non ha rilanciato passa e l\'asta si chiude');
    assert.equal(stanza.stato.proprieta['1'].proprietario, primo);
  } finally {
    stanze.azzera();
  }
});

test('timer dell\'asta: se nessuno offre in 30 secondi la casella resta alla banca', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    stanza.stato = H.modifica(stanza.stato, (s) => { giocatore(s, diTurno).posizione = 1; s.fase = 'daDecidereAcquisto'; });
    stanze.applica(stanza, diTurno, { tipo: 'rifiutaAcquisto' }, { ora });
    avanti(30 * SECONDO);
    assert.equal(stanza.stato.asta, null);
    assert.equal(stanza.stato.proprieta['1'].proprietario, null);
    assert.equal(stanza.stato.turno.giocatoreId, diTurno, 'il turno resta di chi aveva rinunciato');
  } finally {
    stanze.azzera();
  }
});

test('dadi per l\'affitto: il server aspetta un minuto, poi lancia lui', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    const altro = ids.find((id) => id !== diTurno);
    stanza.stato = H.modifica(stanza.stato, (s) => {
      s.proprieta['28'].proprietario = altro;
      giocatore(s, diTurno).posizione = 28;
      s.fase = 'lancioAffitto';
      s.lancioAffitto = { giocatoreId: diTurno, casella: 28, creditoreId: altro, moltiplicatore: 10 };
    });
    stanza.progresso += 1;
    stanze.programmaInattivita(stanza, { ora });
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.durataMs, T.INATTIVITA_ORDINE_MS);
    avanti(T.INATTIVITA_ORDINE_MS);
    assert.equal(stanza.stato.lancioAffitto, null);
    assert.ok(giocatore(stanza.stato, altro).denaro > 1500, 'l\'affitto è stato pagato');
    assert.equal(stanza.stato.turno.giocatoreId, altro);
  } finally {
    stanze.azzera();
  }
});

test('fine partita: la stanza si chiude da sola dopo 30 secondi, con il nome di chi ha vinto', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids, socket } = partita(ora, ['Anna', 'Bruno']);
  try {
    const [anna, bruno] = ids;
    assert.equal(stanze.applica(stanza, bruno, { tipo: 'abbandona' }, { ora }).errore, undefined);
    assert.equal(stanza.stato.fase, 'finePartita');
    assert.equal(stanza.stato.vincitoreId, anna);
    assert.equal(T.FINE_PARTITA_MS, 30 * SECONDO);
    assert.equal(stanze.statoPerClient(stanza, { ora }).chiusuraTraMs, 30 * SECONDO);
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza, undefined, 'a partita finita non c\'è più nessuno da aspettare');

    avanti(29 * SECONDO);
    assert.equal(stanze.trova(stanza.codice), stanza);
    assert.equal(stanze.statoPerClient(stanza, { ora }).chiusuraTraMs, SECONDO);
    // Chi ricarica la pagina non fa ripartire i 30 secondi.
    stanze.disconnetti(stanza, bruno, { ora });
    stanze.riconnetti(stanza.codice, stanza.giocatori.get(bruno).token, socket[1], { ora });
    assert.equal(stanze.statoPerClient(stanza, { ora }).chiusuraTraMs, SECONDO);

    avanti(SECONDO);
    assert.equal(stanze.trova(stanza.codice) ?? null, null, 'il codice torna libero');
    assert.equal(stanza.chiusa, true);
    for (const s of socket) {
      const ultimo = s.ricevuti.at(-1);
      assert.equal(ultimo.codice, 'STANZA_INESISTENTE');
      assert.match(JSON.stringify(ultimo), /La partita è finita: ha vinto Anna\. La stanza è stata chiusa\./);
      assert.equal(s.readyState, 3, 'il socket viene chiuso');
    }
  } finally {
    stanze.azzera();
  }
});

test('fine partita: se escono tutti la stanza si chiude subito', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const [anna, bruno, carla] = ids;
    stanze.applica(stanza, bruno, { tipo: 'abbandona' }, { ora });
    stanze.applica(stanza, carla, { tipo: 'abbandona' }, { ora });
    assert.equal(stanza.stato.fase, 'finePartita');
    avanti(5 * SECONDO);
    stanze.disconnetti(stanza, anna, { ora });
    stanze.disconnetti(stanza, bruno, { ora });
    avanti(SECONDO);
    assert.equal(stanze.trova(stanza.codice), stanza, 'finché qualcuno è collegato la stanza resta');
    stanze.disconnetti(stanza, carla, { ora });
    avanti(SECONDO);
    assert.equal(stanze.trova(stanza.codice) ?? null, null);
    assert.equal(stanza.chiusa, true);
  } finally {
    stanze.azzera();
  }
});

test('fine partita: una partita finita ripristinata dal salvataggio viene chiusa dalla pulizia', (t) => {
  const { ora } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    stanze.applica(stanza, ids[1], { tipo: 'abbandona' }, { ora });
    const salvate = JSON.parse(JSON.stringify(stanze.esporta()));
    stanze.azzera();
    assert.equal(stanze.importa(salvate, { ora }), 1);
    assert.equal(stanze.pulisci({ ora: () => ora() + 29 * SECONDO }), 0);
    assert.equal(stanze.pulisci({ ora: () => ora() + 31 * SECONDO }), 1);
    assert.equal(stanze.trova(stanza.codice) ?? null, null);
  } finally {
    stanze.azzera();
  }
});

test('fine del turno: lanciati i dadi restano 15 secondi, poi il turno passa da solo', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    assert.equal(T.INATTIVITA_FINE_TURNO_MS, 15 * SECONDO);
    const diTurno = stanza.stato.turno.giocatoreId;
    const altro = ids.find((id) => id !== diTurno);
    const inMossa = (s) => { s.fase = 'mossa'; s.turno.doppiConsecutivi = 0; giocatore(s, diTurno).posizione = 10; };
    stanza.stato = H.modifica(stanza.stato, inMossa);
    stanza.progresso += 1;
    stanze.programmaInattivita(stanza, { ora });
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.durataMs, 15 * SECONDO, 'i client ricevono i 15 secondi');
    assert.equal(stanza.timer.has('_stanza|preavviso'), false, 'nessun preavviso: il conto alla rovescia si vede');

    // Ogni mossa fa ripartire il tempo.
    avanti(10 * SECONDO);
    stanza.stato = H.modifica(stanza.stato, (s) => { s.proprieta['1'].proprietario = diTurno; });
    assert.equal(stanze.applica(stanza, diTurno, { tipo: 'ipoteca', casella: 1 }, { ora }).errore, undefined);
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.traMs, 15 * SECONDO);
    avanti(14 * SECONDO);
    assert.equal(stanza.stato.turno.giocatoreId, diTurno, 'a 14 secondi il turno è ancora suo');
    avanti(SECONDO);
    assert.equal(stanza.stato.turno.giocatoreId, altro, 'a 15 secondi il turno passa');
    const saltato = stanza.stato.log.find((e) => e.tipo === 'turnoSaltato');
    assert.match(saltato.testo, /^(Anna|Bruno) non ha finito il turno in tempo: il turno passa$/);
    assert.equal(stanza.stato.fase, 'daLanciare');
    assert.equal(stanze.statoPerClient(stanza, { ora }).scadenza.durataMs, T.INATTIVITA_TURNO_MS, 'per lanciare restano i 3 minuti');
  } finally {
    stanze.azzera();
  }
});

test('fine del turno: con uno scambio in attesa vale il tempo normale, poi tornano i 15 secondi', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    const altro = ids.find((id) => id !== diTurno);
    stanza.stato = H.modifica(stanza.stato, (s) => {
      s.fase = 'mossa'; s.turno.doppiConsecutivi = 0; giocatore(s, diTurno).posizione = 10;
      s.proprieta['1'].proprietario = diTurno;
    });
    assert.equal(stanze.applica(stanza, diTurno, { tipo: 'proponiScambio', aId: altro, offre: { proprieta: [1] } }, { ora }).errore, undefined);
    assert.equal(stanza.inattivita.durata, T.INATTIVITA_TURNO_MS, 'mentre aspetta la risposta non gli scade il turno');
    avanti(T.SCAMBIO_MS);
    assert.equal(stanza.stato.scambio, null, 'lo scambio è scaduto');
    assert.equal(stanza.stato.turno.giocatoreId, diTurno);
    assert.equal(stanza.inattivita.durata, 15 * SECONDO, 'scaduto lo scambio ripartono i 15 secondi');
    avanti(15 * SECONDO);
    assert.equal(stanza.stato.turno.giocatoreId, altro);
  } finally {
    stanze.azzera();
  }
});
