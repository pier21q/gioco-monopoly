'use strict';

/**
 * tests/http.test.js
 *
 * La parte HTTP di server/index.js: /salute (con i campi che servono al
 * lanciatore), file statici con ETag e risposta 304, compressione gzip, e
 * rifiuto dei percorsi con un nome che inizia con un punto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const indice = require('../server/index');

function richiesta(porta, percorso, intestazioni = {}, metodo = 'GET') {
  return new Promise((risolvi, rifiuta) => {
    http.request({ host: '127.0.0.1', port: porta, path: percorso, headers: intestazioni, method: metodo }, (res) => {
      const pezzi = [];
      res.on('data', (c) => pezzi.push(c));
      res.on('end', () => risolvi({ stato: res.statusCode, intestazioni: res.headers, corpo: Buffer.concat(pezzi) }));
    }).on('error', rifiuta).end();
  });
}

async function conServer(fn, opzioni = {}) {
  const { server, porta } = await indice.avvia({ port: 0, host: '127.0.0.1', ...opzioni });
  try {
    await fn(porta);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Cartella temporanea usata come radice dei file statici (non si scrive in client/). */
async function conRadiceFinta(file, fn) {
  const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-http-'));
  try {
    for (const [nome, testo] of Object.entries(file)) {
      fs.mkdirSync(path.dirname(path.join(radice, nome)), { recursive: true });
      fs.writeFileSync(path.join(radice, nome), testo);
    }
    await conServer((porta) => fn(porta, radice), { radiceClient: radice });
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
}

test('/salute dice che gioco è e quando è partito il server', async () => {
  const prima = Date.now();
  await conServer(async (porta) => {
    const r = await richiesta(porta, '/salute');
    assert.equal(r.stato, 200);
    const corpo = JSON.parse(r.corpo.toString());
    assert.equal(corpo.gioco, 'monopoly');
    assert.equal(Number.isInteger(corpo.avviatoIl), true);
    assert.ok(corpo.avviatoIl <= prima, 'è l\'ora in cui è partito il processo, non quella della richiesta');
    // Il lanciatore cerca proprio questo testo nella risposta.
    assert.match(r.corpo.toString(), /"gioco":"monopoly"/);
    assert.match(r.corpo.toString(), /"avviatoIl":\d+/);
  });
});

test('file statici: ETag, 304 se il browser ha già il file, gzip se lo accetta', async () => {
  await conServer(async (porta) => {
    for (const percorso of ['/js/app.js', '/css/base.css', '/', '/dati/tabellone.js']) {
      const piena = await richiesta(porta, percorso);
      assert.equal(piena.stato, 200, percorso);
      const etag = piena.intestazioni.etag;
      assert.match(etag, /^W\/"[\w-]+"$/, `${percorso}: ha un ETag`);
      assert.equal(piena.intestazioni['content-encoding'], undefined, 'senza Accept-Encoding niente compressione');
      assert.equal(piena.intestazioni['cache-control'], 'no-cache');
      assert.equal(piena.intestazioni.vary, 'Accept-Encoding');

      const stessa = await richiesta(porta, percorso, { 'If-None-Match': etag });
      assert.equal(stessa.stato, 304, `${percorso}: il browser che ha già il file riceve 304`);
      assert.equal(stessa.corpo.length, 0);
      assert.equal(stessa.intestazioni.etag, etag);
      const altra = await richiesta(porta, percorso, { 'If-None-Match': 'W/"un-altro"' });
      assert.equal(altra.stato, 200);

      const compressa = await richiesta(porta, percorso, { 'Accept-Encoding': 'gzip, deflate, br' });
      assert.equal(compressa.stato, 200);
      assert.equal(compressa.intestazioni['content-encoding'], 'gzip');
      assert.equal(compressa.intestazioni.etag, etag);
      assert.ok(compressa.corpo.length < piena.corpo.length / 2, `${percorso}: compresso pesa meno della metà`);
      assert.deepEqual(zlib.gunzipSync(compressa.corpo), piena.corpo, 'decompresso è identico');

      const rifiutata = await richiesta(porta, percorso, { 'Accept-Encoding': 'gzip;q=0, identity' });
      assert.equal(rifiutata.intestazioni['content-encoding'], undefined, 'gzip;q=0 vuol dire "non lo voglio"');
    }
    // Le intestazioni di sicurezza restano anche sulle risposte compresse e sui 304.
    const r = await richiesta(porta, '/js/app.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.intestazioni['x-content-type-options'], 'nosniff');
    assert.match(r.intestazioni['content-security-policy'], /default-src 'self'/);
    const testa = await richiesta(porta, '/js/app.js', {}, 'HEAD');
    assert.equal(testa.stato, 200);
    assert.equal(testa.corpo.length, 0);
  });
});

test('file statici: se il file cambia, cambiano ETag e contenuto', async () => {
  await conRadiceFinta({ 'prova.txt': 'prima versione '.repeat(100) }, async (porta, radice) => {
    const uno = await richiesta(porta, '/prova.txt');
    assert.match(uno.corpo.toString(), /^prima versione/);
    fs.writeFileSync(path.join(radice, 'prova.txt'), 'seconda versione, più lunga '.repeat(100));
    const due = await richiesta(porta, '/prova.txt', { 'If-None-Match': uno.intestazioni.etag });
    assert.equal(due.stato, 200, 'il vecchio ETag non vale più');
    assert.notEqual(due.intestazioni.etag, uno.intestazioni.etag);
    assert.match(due.corpo.toString(), /^seconda versione/);
    // File piccoli o non di testo: niente gzip anche se il browser lo accetta.
    fs.writeFileSync(path.join(radice, 'breve.txt'), 'ciao');
    assert.equal((await richiesta(porta, '/breve.txt', { 'Accept-Encoding': 'gzip' })).intestazioni['content-encoding'], undefined);
  });
});

test('file statici: i nomi che iniziano con un punto non si servono', async () => {
  const file = {
    'index.html': '<p>ciao</p>',
    'js/app.js': 'export {};',
    'js/.env': 'segreto',
    '.DS_Store': 'segreto',
    '.git/config': 'segreto',
    'css/.nascosto': 'segreto',
    'vuota/segnaposto.txt': 'x',
  };
  await conRadiceFinta(file, async (porta) => {
    for (const percorso of ['/.DS_Store', '/.git/config', '/css/.nascosto', '/%2Egit/config', '/js/.env', '/js/%2eenv']) {
      const r = await richiesta(porta, percorso);
      assert.equal(r.stato, 404, percorso);
      assert.equal(r.corpo.toString().includes('segreto'), false);
    }
    assert.equal((await richiesta(porta, '/js/app.js')).stato, 200, 'i file normali si servono');
    assert.equal((await richiesta(porta, '/')).corpo.toString(), '<p>ciao</p>');
    assert.equal((await richiesta(porta, '/vuota/')).stato, 404, 'una cartella senza index.html non si elenca');
    assert.equal((await richiesta(porta, '/vuota')).stato, 404);
  });
});
