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
    stanze.avvia(stanza, anna.id, { ora, random: H.rngDeterministico(5), regole: {} });
    H.completaOrdine(stanze, stanza, { ora });
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

test('salvataggio illeggibile: viene messo da parte, mai sovrascritto dal salvataggio periodico', () => {
  const cartella = cartellaTemporanea();
  const file = path.join(cartella, 'partite.json');
  stanze.azzera();
  try {
    // Un salvataggio scritto da una versione più nuova del gioco.
    const originale = JSON.stringify({ formato: 2, stanze: [{ codice: 'ABCDEF', qualcosa: 'di prezioso' }] });
    fs.writeFileSync(file, originale, { mode: 0o600 });
    const ora = () => new Date(2026, 10, 16, 19, 30, 5).getTime();

    const esito = salvataggio.caricaSenzaPerdere(file, stanze, { ora });
    assert.equal(esito.ripristinate, 0);
    assert.match(esito.errore.message, /formato/);
    assert.equal(esito.sicuro, true);
    assert.equal(esito.messoDaParte, `${file}.illeggibile-20261116-193005`);
    assert.equal(fs.existsSync(file), false, 'l\'originale è stato spostato');
    assert.equal(fs.readFileSync(esito.messoDaParte, 'utf8'), originale, 'il contenuto è intatto');

    // Il salvataggio periodico parte e scrive: il file messo da parte resta.
    stanze.crea({ ora });
    const attivo = salvataggio.avvia(file, stanze, { intervallo: 60000 });
    assert.equal(attivo.salvaOra(), true);
    attivo.ferma();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).formato, salvataggio.VERSIONE_FORMATO);
    assert.equal(fs.readFileSync(esito.messoDaParte, 'utf8'), originale);

    // Due file illeggibili nello stesso secondo non si calpestano.
    fs.writeFileSync(file, 'non è JSON');
    const secondo = salvataggio.caricaSenzaPerdere(file, stanze, { ora });
    assert.equal(secondo.messoDaParte, `${file}.illeggibile-20261116-193005-1`);
    assert.equal(fs.readFileSync(esito.messoDaParte, 'utf8'), originale);

    // File leggibile o assente: nessuno spostamento.
    const pulito = salvataggio.caricaSenzaPerdere(path.join(cartella, 'non-esiste.json'), stanze, { ora });
    assert.deepEqual(pulito, { ripristinate: 0, errore: null, messoDaParte: null, sicuro: true });
  } finally {
    stanze.azzera();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});

test('salvataggio illeggibile che non si riesce a spostare: il salvataggio periodico non deve partire', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const cartella = cartellaTemporanea();
  const file = path.join(cartella, 'partite.json');
  try {
    fs.writeFileSync(file, '{"formato": 2}');
    fs.chmodSync(cartella, 0o500); // cartella in sola lettura: la rinomina fallisce
    const esito = salvataggio.caricaSenzaPerdere(file, stanze);
    assert.equal(esito.sicuro, false);
    assert.equal(esito.messoDaParte, null);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"formato": 2}');
  } finally {
    fs.chmodSync(cartella, 0o700);
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
