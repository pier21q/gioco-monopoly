'use strict';

/**
 * tests/salvataggio.test.js
 *
 * Salvataggio delle partite su file (server/salvataggio.js): scrittura atomica
 * con permessi 600, ripristino dopo un "riavvio" (registro svuotato), rientro
 * dei giocatori con il loro token, variabile SALVATAGGIO.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stanze = require('../server/stanze');
const salvataggio = require('../server/salvataggio');
const H = require('./aiuti');

function cartellaTemporanea() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-salvataggio-'));
}

test('salvataggio: la partita sopravvive al riavvio e i giocatori rientrano con il token', () => {
  const cartella = cartellaTemporanea();
  const file = path.join(cartella, 'sotto', 'partite.json');
  stanze.azzera();
  try {
    const ora = H.ORA_FISSA;
    const stanza = stanze.crea({ ora });
    const anna = stanze.entra(stanza, { nome: 'Anna', ora }).giocatore;
    const bruno = stanze.entra(stanza, { nome: 'Bruno', ora }).giocatore;
    stanze.avvia(stanza, anna.id, { ora, random: H.rngDeterministico(5) });
    stanze.applica(stanza, stanza.stato.turno.giocatoreId, { tipo: 'lanciaDadi' }, { ora, random: H.rngDeterministico(9) });
    const statoPrima = structuredClone(stanza.stato);

    const attivo = salvataggio.avvia(file, stanze, { intervallo: 60000 });
    assert.equal(attivo.salvaOra(), true, 'il primo salvataggio scrive il file');
    assert.equal(attivo.salvaOra(), false, 'senza cambiamenti non riscrive');
    attivo.ferma();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'il file contiene i token: solo il proprietario lo legge');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['partite.json'], 'nessun file temporaneo lasciato in giro');

    // "Riavvio": il registro si svuota e si ricarica dal file.
    stanze.azzera();
    assert.equal(salvataggio.carica(file, stanze, { ora }), 1);
    const ripresa = stanze.trova(stanza.codice);
    assert.ok(ripresa);
    assert.equal(ripresa.stato.versione, statoPrima.versione);
    assert.deepEqual(ripresa.stato.mazzi, statoPrima.mazzi, 'anche i mazzi (segreti) sono ripristinati');
    assert.ok(ripresa.stato.giocatori.every((g) => g.connesso === false), 'dopo il riavvio tutti risultano disconnessi');

    const rientro = stanze.riconnetti(stanza.codice, bruno.token, null, { ora });
    assert.equal(rientro.errore, undefined);
    assert.equal(rientro.giocatore.id, bruno.id);
    assert.equal(stanze.riconnetti(stanza.codice, 'f'.repeat(32), null, { ora }).errore.codice, 'TOKEN_NON_VALIDO');
  } finally {
    stanze.azzera();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});

test('salvataggio: file assente = nessuna partita; file rovinato = errore; voci malformate saltate', () => {
  const cartella = cartellaTemporanea();
  stanze.azzera();
  try {
    assert.equal(salvataggio.carica(path.join(cartella, 'non-esiste.json'), stanze), 0);
    const rovinato = path.join(cartella, 'rovinato.json');
    fs.writeFileSync(rovinato, '{"formato": 99}');
    assert.throws(() => salvataggio.carica(rovinato, stanze), /formato/);
    assert.equal(stanze.importa([{ codice: '../..', stato: {} }, null, { codice: 'ABCDEF', giocatori: [], stato: { fase: 'lobby' } }]), 0);
  } finally {
    stanze.azzera();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});

test('salvataggio: la variabile SALVATAGGIO sceglie il file o lo disattiva', () => {
  const radice = path.join(os.tmpdir(), 'progetto');
  assert.equal(salvataggio.percorsoDaAmbiente(undefined, radice), path.join(radice, '.partite', 'partite.json'));
  assert.equal(salvataggio.percorsoDaAmbiente('0', radice), null);
  assert.equal(salvataggio.percorsoDaAmbiente('no', radice), null);
  assert.equal(salvataggio.percorsoDaAmbiente('/tmp/x.json', radice), path.resolve('/tmp/x.json'));
});
