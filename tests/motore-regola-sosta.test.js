'use strict';

/**
 * tests/motore-regola-sosta.test.js
 *
 * Regola facoltativa scelta dall'host (`opzioni.costruzione: 'sosta'`): si
 * costruisce su un gruppo solo nel turno in cui ci si ferma su una sua casella.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const H = require('./aiuti');

const { A } = H.ID;
// Gruppo marrone: caselle 1 e 3. Gruppo azzurro: 6, 8, 9.
function conGruppi(opzioni) {
  let s = H.nuovaPartita(2, opzioni);
  s = H.assegna(s, A, 1, 3, 6, 8, 9);
  return s;
}

test('regola classica: si costruisce su ogni gruppo completo, ovunque sia la pedina', () => {
  const s = H.turnoDi(H.inCasella(conGruppi(), A, 20), A, 'mossa');
  assert.equal(s.regole.costruzione, 'libera');
  H.esegui(s, A, { tipo: 'costruisci', casella: 1 }, undefined, 'Con la regola classica la posizione non conta');
});

test('regola "solo dove ti fermi": si costruisce sul gruppo della casella di arrivo', () => {
  const base = conGruppi({ costruzione: 'sosta' });
  assert.equal(base.regole.costruzione, 'sosta');

  const lontano = H.turnoDi(H.inCasella(base, A, 20), A, 'mossa');
  H.rifiuta(lontano, A, { tipo: 'costruisci', casella: 1 }, 'NON_SULLA_CASELLA', 'Lontano dal gruppo non si costruisce');

  const sopra = H.turnoDi(H.inCasella(base, A, 3), A, 'mossa');
  H.esegui(sopra, A, { tipo: 'costruisci', casella: 1 }, undefined, 'Fermo su una casella del gruppo, costruisce su tutte le sue caselle');
  H.esegui(sopra, A, { tipo: 'costruisci', casella: 3 }, undefined, 'Anche sulla casella dove si trova');
  H.rifiuta(sopra, A, { tipo: 'costruisci', casella: 6 }, 'NON_SULLA_CASELLA', 'Non su un altro gruppo, anche se completo');
});

test('regola "solo dove ti fermi": prima di lanciare la sosta del turno scorso non vale, dopo un doppio sì', () => {
  const base = conGruppi({ costruzione: 'sosta' });
  const primaDelLancio = H.turnoDi(H.inCasella(base, A, 3), A, 'daLanciare');
  H.rifiuta(primaDelLancio, A, { tipo: 'costruisci', casella: 1 }, 'NON_SULLA_CASELLA', 'La pedina è lì dal turno scorso');

  const dopoDoppio = H.modifica(primaDelLancio, (s) => { s.turno.doppiConsecutivi = 1; });
  H.esegui(dopoDoppio, A, { tipo: 'costruisci', casella: 1 }, undefined, 'Dopo un doppio la pedina si è appena fermata lì');
});

test('regola di costruzione sconosciuta: creaPartita la rifiuta', () => {
  assert.throws(() => motore.creaPartita({
    codice: 'K7PQ2M', hostId: A, giocatori: H.elencoGiocatori(2), opzioni: { costruzione: 'boh' },
  }), TypeError);
});
