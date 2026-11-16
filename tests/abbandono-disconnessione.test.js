'use strict';

/**
 * tests/abbandono-disconnessione.test.js
 * Uscita volontaria dalla partita (azione `abbandona`) e gestione lato server
 * dei giocatori disconnessi che tengono ferma la partita (INTERFACCE.md §2.4,
 * §3.4 e §8.12). I timer veri non vengono attesi: si chiamano direttamente le
 * funzioni che i timer eseguono allo scadere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const stanze = require('../server/stanze');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const { giocatore, voce } = H;
const tipi = (r) => r.eventi.map((e) => e.tipo);

test('abbandona: ammessa in ogni momento; i beni tornano alla banca e vanno all\'asta, il turno passa', () => {
  const s = H.assegna(H.nuovaPartita(3), A, 1);
  assert.ok(motore.azioniDisponibili(s, A).includes('abbandona'), 'chi è di turno può abbandonare');
  assert.ok(motore.azioniDisponibili(s, B).includes('abbandona'), 'anche chi non è di turno può abbandonare');

  const r = H.esegui(s, A, { tipo: 'abbandona' }, undefined, 'Abbandono del giocatore di turno');
  assert.equal(giocatore(r.stato, A).fallito, true, 'chi abbandona esce dalla partita');
  assert.equal(giocatore(r.stato, A).denaro, 0);
  assert.equal(voce(r.stato, 1).proprietario, null, 'le proprietà tornano alla banca');
  assert.equal(r.stato.turno.giocatoreId, B, 'il turno passa al giocatore successivo');
  assert.equal(r.stato.fase, 'asta', 'le proprietà di chi abbandona vanno all\'asta fra i rimasti');
  assert.equal(r.stato.asta.casella, 1);
  assert.deepEqual(r.stato.asta.partecipanti, [B, C]);
  assert.ok(tipi(r).includes('abbandono') && tipi(r).includes('bancarotta'));
  assert.deepEqual(motore.azioniDisponibili(r.stato, A), [], 'dopo l\'abbandono non si può più agire');
  H.rifiuta(r.stato, A, { tipo: 'abbandona' }, 'GIOCATORE_FALLITO', 'Non si abbandona due volte');
  H.verificaJson(r.stato);
});

test('abbandona: fuori turno non cambia il turno; in due la partita finisce con la vittoria dell\'altro', () => {
  const tre = H.esegui(H.nuovaPartita(3), C, { tipo: 'abbandona' });
  assert.equal(tre.stato.turno.giocatoreId, A, 'il turno resta a chi lo aveva');
  assert.equal(tre.stato.fase, 'daLanciare');
  assert.equal(giocatore(tre.stato, C).fallito, true);

  const due = H.esegui(H.nuovaPartita(2), A, { tipo: 'abbandona' });
  assert.equal(due.stato.fase, 'finePartita', 'Regola: la partita finisce quando resta un solo giocatore');
  assert.equal(due.stato.vincitoreId, B);
});

test('abbandona con un debito aperto: i beni vanno al creditore, come nella bancarotta', () => {
  const s = H.soldi(H.assegna(H.assegna(H.nuovaPartita(3), A, 11), B, 1), B, 5);
  const debito = H.arrivaSu(s, B, 11, 3, 4).stato; // affitto 10 €, B ha 5 €
  assert.equal(debito.fase, 'debito');
  const r = H.esegui(debito, B, { tipo: 'abbandona' });
  assert.equal(giocatore(r.stato, B).fallito, true);
  assert.equal(voce(r.stato, 1).proprietario, A, 'la proprietà del debitore passa al creditore');
  assert.equal(giocatore(r.stato, A).denaro, 1505, 'anche il denaro rimasto va al creditore');
  assert.equal(r.stato.debito, null);
});

test('asta: se il miglior offerente abbandona si riparte da zero, e chi aveva passato torna a offrire', () => {
  const D = H.ID.D;
  const asta = H.modifica(H.nuovaPartita(4), (s) => {
    s.fase = 'asta';
    s.asta = {
      casella: 1, offertaMassima: 80, migliorOfferenteId: A, partecipanti: [A, B, C, D], passati: [B, D],
      incrementoMinimo: 1, iniziataIl: H.ORA_FISSA(), faseDopo: 'mossa',
    };
    giocatore(s, D).connesso = false; // D aveva "passato" perché scollegato
  });
  const r = H.esegui(asta, A, { tipo: 'abbandona' }, undefined, 'Abbandono del miglior offerente');
  assert.equal(r.stato.fase, 'asta', 'l\'asta continua fra gli altri');
  assert.equal(r.stato.asta.migliorOfferenteId, null);
  assert.equal(r.stato.asta.offertaMassima, 0);
  assert.deepEqual(r.stato.asta.passati, [D, A], 'B rientra in gara; restano fuori lo scollegato e chi ha abbandonato');
  assert.deepEqual(motore.chiDeveAgire(r.stato), [B, C]);
  const riparte = r.eventi.find((e) => e.tipo === 'astaInizio');
  assert.equal(riparte.dati.riparte, true);
  assert.match(riparte.testo, /riparte da zero/);
  // B, che aveva passato davanti agli 80 € di A, ora può prendersela per 1 €.
  const offerta = H.esegui(r.stato, B, { tipo: 'offertaAsta', importo: 1 });
  const chiusa = H.esegui(offerta.stato, C, { tipo: 'passaAsta' });
  assert.equal(chiusa.stato.proprieta['1'].proprietario, B);
  assert.equal(giocatore(chiusa.stato, B).denaro, 1499);

  // Se abbandona uno che non aveva l'offerta più alta, chi ha passato resta fuori.
  const altro = H.esegui(asta, C, { tipo: 'abbandona' });
  assert.equal(altro.stato.proprieta['1'].proprietario, A, 'restava solo A: l\'asta si chiude a 80 €');
  assert.equal(altro.eventi.some((e) => e.tipo === 'astaInizio'), false);
});

/** Stanza con due giocatori (senza socket) e partita avviata. */
function stanzaAvviata() {
  stanze.azzera();
  const ora = H.ORA_FISSA;
  const stanza = stanze.crea({ ora, random: H.rngDeterministico(3) });
  const uno = stanze.entra(stanza, { nome: 'Anna', ora }).giocatore;
  const due = stanze.entra(stanza, { nome: 'Bruno', ora }).giocatore;
  assert.equal(stanze.avvia(stanza, uno.id, { ora, random: H.rngDeterministico(5), regole: {} }).errore, undefined);
  H.completaOrdine(stanze, stanza, { ora });
  return { stanza, ora, ids: [uno.id, due.id] };
}

test('disconnessione: scaduta la tolleranza il turno del giocatore assente passa al successivo', () => {
  const { stanza, ora, ids } = stanzaAvviata();
  try {
    const diTurno = stanza.stato.turno.giocatoreId;
    const altro = ids.find((id) => id !== diTurno);
    stanze.disconnetti(stanza, diTurno, { ora });
    assert.equal(stanza.stato.turno.giocatoreId, diTurno, 'durante la tolleranza la partita aspetta');

    const versione = stanza.stato.versione;
    stanze.sbloccaDisconnesso(stanza, diTurno, { ora });
    assert.equal(stanza.stato.turno.giocatoreId, altro, 'dopo la tolleranza tocca al giocatore successivo');
    assert.equal(stanza.stato.fase, 'daLanciare');
    assert.equal(stanza.stato.versione, versione + 1);
    assert.equal(giocatore(stanza.stato, diTurno).connesso, false, 'il giocatore assente resta in partita, disconnesso');
    assert.equal(giocatore(stanza.stato, diTurno).fallito, false);
    assert.ok(stanza.stato.log.some((e) => e.tipo === 'turnoSaltato'));

    // Chi è tornato in tempo non viene toccato.
    stanze.riconnetti(stanza.codice, stanza.giocatori.get(diTurno).token, null, { ora });
    const prima = stanza.stato;
    stanze.sbloccaDisconnesso(stanza, diTurno, { ora });
    assert.equal(stanza.stato, prima, 'un giocatore riconnesso non perde nulla');
  } finally {
    stanze.azzera();
  }
});

test('disconnessione: un debitore assente troppo a lungo viene dichiarato in bancarotta d\'ufficio', () => {
  const { stanza, ora, ids } = stanzaAvviata();
  try {
    const [debitore, altro] = ids;
    stanza.stato = H.modifica(stanza.stato, (s) => {
      giocatore(s, debitore).denaro = 0;
      s.fase = 'debito';
      s.debito = { giocatoreId: debitore, creditoreId: null, importo: 100, motivo: 'tassa', casella: 4, faseDopo: 'mossa' };
    });

    // Se è collegato non succede nulla: la bancarotta resta una sua scelta.
    stanze.bancarottaDisconnesso(stanza, debitore, { ora });
    assert.equal(giocatore(stanza.stato, debitore).fallito, false);

    stanze.disconnetti(stanza, debitore, { ora });
    stanze.bancarottaDisconnesso(stanza, debitore, { ora });
    assert.equal(giocatore(stanza.stato, debitore).fallito, true);
    assert.equal(stanza.stato.fase, 'finePartita');
    assert.equal(stanza.stato.vincitoreId, altro);
  } finally {
    stanze.azzera();
  }
});

test('stato per i client: log accorciato negli aggiornamenti, completo per chi entra o si riconnette', () => {
  const { stanza } = stanzaAvviata();
  try {
    const evento = (i) => ({ t: H.ORA_FISSA(), tipo: 'turno', giocatoreId: null, testo: `evento ${i}`, dati: {} });
    stanza.stato = H.modifica(stanza.stato, (s) => { s.log = Array.from({ length: 80 }, (_, i) => evento(i)); });
    const breve = stanze.statoPerClient(stanza);
    const completo = stanze.statoPerClient(stanza, { completo: true });
    assert.equal(breve.log.length, 30);
    assert.equal(breve.log.at(-1).testo, 'evento 79', 'il log breve contiene gli eventi più recenti');
    assert.equal(completo.log.length, 80);
    assert.equal('mazzi' in breve || 'mazzi' in completo, false);
    assert.equal(stanza.stato.log.length, 80, 'lo stato della stanza non viene accorciato');
  } finally {
    stanze.azzera();
  }
});
