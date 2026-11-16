'use strict';

/**
 * tests/assenze-scadenze.test.js
 *
 * Quello che il server fa da solo quando il tempo passa (server/stanze.js):
 * giocatori scollegati in partita (host che passa dopo 45 secondi, abbandono
 * d'ufficio dopo 5 minuti), sale d'attesa (l'ultimo giocatore non si toglie,
 * sala solitaria chiusa dopo 30 minuti), partite ripristinate dal salvataggio
 * e scambi senza risposta (90 secondi).
 *
 * I timer sono quelli veri del server, ma con l'orologio finto di node:test:
 * `avanti(ms)` fa passare il tempo e scattare i timer nell'ordine giusto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const stanze = require('../server/stanze');
const H = require('./aiuti');

const T = stanze.TEMPI;
const SECONDO = 1000;
const MINUTO = 60 * SECONDO;
const giocatore = (s, id) => s.giocatori.find((g) => g.id === id);

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
      // A piccoli passi, così `ora()` è giusta quando scatta ogni timer.
      for (let resto = ms; resto > 0;) {
        const passo = Math.min(resto, SECONDO);
        adesso += passo;
        t.mock.timers.tick(passo);
        resto -= passo;
      }
    },
  };
}

/** Sala d'attesa con `nomi.length` giocatori collegati. */
function sala(ora, nomi) {
  stanze.azzera();
  const stanza = stanze.crea({ ora, random: H.rngDeterministico(3) });
  const ids = nomi.map((nome) => stanze.entra(stanza, { nome, socket: socketFinto(), ora }).giocatore.id);
  return { stanza, ids };
}

/** Partita avviata (lancio iniziale già fatto) con i giocatori collegati. */
function partita(ora, nomi) {
  const { stanza, ids } = sala(ora, nomi);
  assert.equal(stanze.avvia(stanza, ids[0], { ora, random: H.rngDeterministico(5), regole: {} }).errore, undefined);
  H.completaOrdine(stanze, stanza, { ora });
  return { stanza, ids };
}

const rientra = (stanza, id, ora) => stanze.riconnetti(stanza.codice, stanza.giocatori.get(id).token, socketFinto(), { ora });

test('assenza in partita: dopo 45 secondi l\'host passa a un collegato, dopo 5 minuti l\'assente abbandona', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const [anna, bruno] = ids;
    assert.equal(stanza.hostId, anna);
    stanze.disconnetti(stanza, anna, { ora });

    avanti(44 * SECONDO);
    assert.equal(stanza.hostId, anna, 'durante la tolleranza l\'host resta lui');
    avanti(1 * SECONDO);
    assert.equal(stanza.hostId, bruno, 'dopo 45 secondi il ruolo va al primo giocatore collegato');
    assert.equal(stanza.stato.hostId, bruno, 'e i client lo vedono nello stato');
    const passaggio = stanza.stato.log.find((e) => e.tipo === 'host');
    assert.deepEqual(passaggio.dati, { giocatoreId: bruno, precedenteId: anna });
    assert.equal(stanze.puoComandare(stanza, bruno), true);

    avanti(4 * MINUTO + 14 * SECONDO);
    assert.equal(giocatore(stanza.stato, anna).fallito, false, 'a 4 minuti e 59 secondi è ancora in partita');
    avanti(1 * SECONDO);
    assert.equal(giocatore(stanza.stato, anna).fallito, true, 'dopo 5 minuti di fila abbandona d\'ufficio');
    const abbandono = stanza.stato.log.find((e) => e.tipo === 'abbandono');
    assert.equal(abbandono.giocatoreId, anna);
    assert.equal(abbandono.dati.motivo, 'assente');
    assert.match(abbandono.testo, /non rientra da troppo tempo/);
    assert.notEqual(stanza.stato.fase, 'finePartita', 'in tre la partita continua fra gli altri due');
    assert.equal(stanza.hostId, bruno);
  } finally {
    stanze.azzera();
  }
});

test('assenza in partita: in due, chi sparisce per 5 minuti perde e la partita finisce', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    const [anna, bruno] = ids;
    stanze.disconnetti(stanza, bruno, { ora });
    avanti(5 * MINUTO);
    assert.equal(stanza.stato.fase, 'finePartita');
    assert.equal(stanza.stato.vincitoreId, anna);
  } finally {
    stanze.azzera();
  }
});

test('assenza in partita: chi rientra in tempo non perde nulla e il conto riparte da capo', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const carla = ids[2];
    stanze.disconnetti(stanza, carla, { ora });
    avanti(4 * MINUTO);
    rientra(stanza, carla, ora);
    avanti(2 * MINUTO);
    assert.equal(giocatore(stanza.stato, carla).fallito, false, 'rientrata dopo 4 minuti: i 5 minuti non si sommano');
    stanze.disconnetti(stanza, carla, { ora });
    avanti(4 * MINUTO + 59 * SECONDO);
    assert.equal(giocatore(stanza.stato, carla).fallito, false);
    avanti(1 * SECONDO);
    assert.equal(giocatore(stanza.stato, carla).fallito, true);
  } finally {
    stanze.azzera();
  }
});

test('assenza in partita: se sono tutti scollegati nessuno abbandona; il conto riparte quando rientra qualcuno', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  try {
    const [anna, bruno] = ids;
    stanze.disconnetti(stanza, anna, { ora });
    stanze.disconnetti(stanza, bruno, { ora });
    avanti(8 * MINUTO);
    assert.equal(stanza.stato.giocatori.some((g) => g.fallito), false, 'senza nessuno che aspetta la partita resta ferma');
    assert.equal(stanza.hostId, anna, 'e l\'host resta lui: non c\'è nessun collegato a cui passare il ruolo');

    rientra(stanza, bruno, ora);
    avanti(44 * SECONDO);
    assert.equal(stanza.hostId, anna);
    avanti(1 * SECONDO);
    assert.equal(stanza.hostId, bruno, 'tornato Bruno, dopo 45 secondi diventa host');
    avanti(4 * MINUTO);
    assert.equal(giocatore(stanza.stato, anna).fallito, false, 'Anna ha 5 minuti da quando Bruno è rientrato');
    avanti(16 * SECONDO);
    assert.equal(stanza.stato.vincitoreId, bruno);
  } finally {
    stanze.azzera();
  }
});

test('assenza in partita: l\'admin resta host anche da scollegato', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const [anna] = ids;
    stanze.rendiAdmin(stanza, anna, { ora });
    stanze.disconnetti(stanza, anna, { ora });
    avanti(2 * MINUTO);
    assert.equal(stanza.hostId, anna);
    assert.equal(stanza.adminId, anna);
  } finally {
    stanze.azzera();
  }
});

test('sala d\'attesa: l\'host da solo che si scollega per più di un minuto ritrova la stanza', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = sala(ora, ['Anna']);
  try {
    const [anna] = ids;
    const token = stanza.giocatori.get(anna).token;
    stanze.disconnetti(stanza, anna, { ora });
    avanti(61 * SECONDO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(stanza.codice), stanza, 'la stanza non viene distrutta dopo 60 secondi');
    assert.equal(stanza.giocatori.has(anna), true, 'l\'ultimo giocatore rimasto non si toglie');
    const rientro = stanze.riconnetti(stanza.codice, token, socketFinto(), { ora });
    assert.equal(rientro.errore, undefined, 'la riconnessione con il token funziona');
    assert.equal(stanza.hostId, anna);

    // Se invece non torna nessuno, la sala si chiude dopo 10 minuti.
    stanze.disconnetti(stanza, anna, { ora });
    avanti(T.STANZA_VUOTA_MS - MINUTO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(stanza.codice), stanza);
    avanti(MINUTO + SECONDO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(stanza.codice), undefined);
  } finally {
    stanze.azzera();
  }
});

test('sala d\'attesa: lo scollegato viene tolto solo se c\'è qualcun altro collegato', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = sala(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const [anna, bruno, carla] = ids;
    // Carla si scollega mentre gli altri ci sono: dopo un minuto il posto si libera.
    stanze.disconnetti(stanza, carla, { ora });
    avanti(61 * SECONDO);
    assert.equal(stanza.giocatori.has(carla), false);

    // Poi cade la rete a tutti e due: nessuno viene tolto.
    stanze.disconnetti(stanza, anna, { ora });
    stanze.disconnetti(stanza, bruno, { ora });
    avanti(3 * MINUTO);
    stanze.pulisci({ ora });
    assert.deepEqual([...stanza.giocatori.keys()], [anna, bruno]);
    assert.equal(stanza.hostId, anna);

    // Torna Bruno, Anna no: alla pulizia successiva il posto di Anna si libera.
    rientra(stanza, bruno, ora);
    stanze.pulisci({ ora });
    assert.deepEqual([...stanza.giocatori.keys()], [bruno]);
    assert.equal(stanza.hostId, bruno);
  } finally {
    stanze.azzera();
  }
});

test('sala d\'attesa con un solo giocatore: chiusa se resta ferma 30 minuti', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza } = sala(ora, ['Anna']);
  const inDue = stanze.crea({ ora });
  stanze.entra(inDue, { nome: 'Bruno', socket: socketFinto(), ora });
  stanze.entra(inDue, { nome: 'Carla', socket: socketFinto(), ora });
  try {
    assert.equal(T.LOBBY_SOLITARIA_MS, 30 * MINUTO);
    avanti(29 * MINUTO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(stanza.codice), stanza);
    avanti(MINUTO + SECONDO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(stanza.codice), undefined, 'una sala con un solo giocatore non resta aperta per ore');
    assert.equal(stanze.trova(inDue.codice), inDue, 'in due si può aspettare di più');
  } finally {
    stanze.azzera();
  }
});

test('partite ripristinate: non scadono dopo 10 minuti, ma dopo 2 ore se non rientra nessuno', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno']);
  const { stanza: attesa } = (() => {
    const s = stanze.crea({ ora });
    stanze.entra(s, { nome: 'Carla', socket: socketFinto(), ora });
    stanze.entra(s, { nome: 'Dario', socket: socketFinto(), ora });
    return { stanza: s };
  })();
  try {
    const salvate = JSON.parse(JSON.stringify(stanze.esporta()));
    const tokenAnna = stanza.giocatori.get(ids[0]).token;
    stanze.azzera(); // il server si riavvia
    assert.equal(stanze.importa(salvate, { ora }), 2);

    avanti(11 * MINUTO);
    assert.equal(stanze.pulisci({ ora }), 0, 'a 11 minuti dal riavvio le partite ci sono ancora');
    const ripresa = stanze.trova(stanza.codice);
    assert.ok(ripresa);
    assert.equal(ripresa.stato.giocatori.some((g) => g.fallito), false, 'nessuno ha abbandonato mentre il server era giù');
    assert.equal(stanze.trova(attesa.codice).giocatori.size, 2, 'anche la sala d\'attesa ripristinata tiene i suoi giocatori');

    // Anna rientra: da qui valgono le regole normali (Bruno ha 5 minuti).
    assert.equal(stanze.riconnetti(stanza.codice, tokenAnna, socketFinto(), { ora }).errore, undefined);
    avanti(5 * MINUTO);
    assert.equal(ripresa.stato.vincitoreId, ids[0]);

    // Nella sala d'attesa ripristinata rientra solo Dario: dopo un minuto il
    // posto di Carla (che era l'host) si libera e l'host diventa lui.
    const salaRipresa = stanze.trova(attesa.codice);
    const [carla, dario] = [...salaRipresa.giocatori.values()];
    assert.equal(salaRipresa.hostId, carla.id);
    assert.equal(stanze.riconnetti(attesa.codice, dario.token, socketFinto(), { ora }).errore, undefined);
    avanti(61 * SECONDO);
    stanze.pulisci({ ora });
    assert.deepEqual([...salaRipresa.giocatori.keys()], [dario.id], 'chi non rientra non blocca la sala ripristinata');
    assert.equal(salaRipresa.hostId, dario.id);

    // Un'altra sala ripristinata in cui non rientra nessuno si chiude dopo 2 ore.
    stanze.azzera();
    stanze.importa(salvate, { ora });
    avanti(T.STANZA_INATTIVA_MS - MINUTO);
    stanze.pulisci({ ora });
    assert.ok(stanze.trova(attesa.codice), 'a un minuto dalle 2 ore c\'è ancora');
    avanti(2 * MINUTO);
    stanze.pulisci({ ora });
    assert.equal(stanze.trova(attesa.codice), undefined, 'dopo 2 ore senza nessuno la stanza ripristinata si chiude');
  } finally {
    stanze.azzera();
  }
});

test('scambio senza risposta: scade dopo 90 secondi e un terzo giocatore può proporre', (t) => {
  const { ora, avanti } = orologio(t);
  const { stanza, ids } = partita(ora, ['Anna', 'Bruno', 'Carla']);
  try {
    const [anna, bruno, carla] = ids;
    assert.equal(T.SCAMBIO_MS, 90 * SECONDO);
    const proposta = stanze.applica(stanza, anna, { tipo: 'proponiScambio', aId: bruno, offre: { denaro: 10 } }, { ora });
    assert.equal(proposta.errore, undefined);
    const idScambio = stanza.stato.scambio.id;

    avanti(89 * SECONDO);
    assert.ok(stanza.stato.scambio, 'a 89 secondi la proposta è ancora in attesa');
    const bloccata = stanze.applica(stanza, carla, { tipo: 'proponiScambio', aId: bruno, offre: { denaro: 5 } }, { ora });
    assert.equal(bloccata.errore.codice, 'SCAMBIO_IN_CORSO');

    avanti(1 * SECONDO);
    assert.equal(stanza.stato.scambio, null, 'dopo 90 secondi la proposta decade');
    const scaduto = stanza.stato.log.filter((e) => e.tipo === 'scambioRifiutato').at(-1);
    assert.equal(scaduto.dati.motivo, 'scaduto');
    assert.equal(scaduto.dati.scambio.id, idScambio);
    assert.match(scaduto.testo, /scaduta/);
    assert.equal(giocatore(stanza.stato, anna).denaro, 1500, 'nessuno ha pagato niente');

    const nuova = stanze.applica(stanza, carla, { tipo: 'proponiScambio', aId: bruno, offre: { denaro: 5 } }, { ora });
    assert.equal(nuova.errore, undefined, 'ora il terzo giocatore può proporre');

    // Una risposta arrivata in tempo ferma il timer: niente evento a vuoto più tardi.
    stanze.applica(stanza, bruno, { tipo: 'rifiutaScambio', scambioId: stanza.stato.scambio.id }, { ora });
    const eventi = stanza.stato.log.length;
    assert.equal(stanza.timer.has('_scambio|scadenza'), false);
    avanti(100 * SECONDO);
    assert.equal(stanza.stato.log.filter((e) => e.tipo === 'scambioRifiutato' && e.dati.motivo === 'scaduto').length, 1);
    assert.ok(stanza.stato.log.length >= eventi);
  } finally {
    stanze.azzera();
  }
});
