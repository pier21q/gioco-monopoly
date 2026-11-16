'use strict';

/**
 * tests/lanciatore.test.js
 *
 * `Avvia Monopoly.command`: se sulla porta risponde già qualcosa, il browser si
 * apre solo se è davvero questo gioco (campo `gioco` di /salute), con un avviso
 * se il server è partito prima dell'ultima modifica ai file.
 *
 * Il comando `open` è sostituito da uno finto che scrive in un file; sulla
 * porta risponde un piccolo server di prova. Il gioco vero non viene avviato.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const indice = require('../server/index');

const SCRIPT = path.resolve(__dirname, '..', 'Avvia Monopoly.command');
const haCurl = spawnSync('curl', ['--version']).status === 0;
const SALTA = process.platform === 'win32' ? 'script per macOS/Linux'
  : (!haCurl ? 'curl non installato' : false);

/** Server di prova che risponde `corpo` su /salute. */
function serverFinto(corpo) {
  return new Promise((risolvi) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    });
    server.listen(0, '127.0.0.1', () => risolvi(server));
  });
}

/** Esegue il lanciatore sulla `porta`; ritorna { codice, uscita, aperti }. */
function lancia(porta) {
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-lanciatore-'));
  const registro = path.join(cartella, 'aperti.txt');
  fs.writeFileSync(path.join(cartella, 'open'), `#!/bin/sh\necho "$1" >> "${registro}"\n`, { mode: 0o755 });
  return new Promise((risolvi, rifiuta) => {
    const figlio = spawn('bash', [SCRIPT], {
      env: { ...process.env, PORT: String(porta), PATH: `${cartella}:${path.dirname(process.execPath)}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let uscita = '';
    figlio.stdout.on('data', (d) => { uscita += d; });
    figlio.stderr.on('data', (d) => { uscita += d; });
    figlio.on('error', rifiuta);
    figlio.on('close', (codice) => {
      const aperti = fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8').trim().split('\n') : [];
      fs.rmSync(cartella, { recursive: true, force: true });
      risolvi({ codice, uscita, aperti });
    });
  });
}

const chiudi = (server) => new Promise((r) => server.close(r));

test('lanciatore: se sulla porta risponde un altro programma (o una versione vecchia) non apre il browser', { skip: SALTA, timeout: 20000 }, async () => {
  // Le versioni precedenti rispondevano così: senza il campo "gioco".
  const vecchio = await serverFinto({ ok: true, stanze: 0, versione: '0.1.0', websocket: true });
  try {
    const esito = await lancia(vecchio.address().port);
    assert.deepEqual(esito.aperti, [], 'il browser non si apre');
    assert.equal(esito.codice, 1);
    assert.match(esito.uscita, /non è questo Monopoly/);
  } finally {
    await chiudi(vecchio);
  }
});

test('lanciatore: se il gioco è già acceso apre il browser, e avvisa se il server è più vecchio dei file', { skip: SALTA, timeout: 20000 }, async () => {
  // Il server vero di questo progetto: partito adesso, dopo l'ultima modifica.
  const { server, porta } = await indice.avvia({ port: 0, host: '127.0.0.1' });
  try {
    const esito = await lancia(porta);
    assert.deepEqual(esito.aperti, [`http://localhost:${porta}`]);
    assert.equal(esito.codice, 0);
    assert.doesNotMatch(esito.uscita, /ATTENZIONE/);
  } finally {
    await chiudi(server);
  }

  // Un Monopoly acceso da anni: i file sono stati modificati dopo.
  const stagionato = await serverFinto({ ok: true, gioco: 'monopoly', avviatoIl: 1000 });
  try {
    const esito = await lancia(stagionato.address().port);
    assert.deepEqual(esito.aperti, [`http://localhost:${stagionato.address().port}`], 'si apre comunque');
    assert.equal(esito.codice, 0);
    assert.match(esito.uscita, /ATTENZIONE: Monopoly è acceso da prima dell'ultima modifica/);
  } finally {
    await chiudi(stagionato);
  }
});
