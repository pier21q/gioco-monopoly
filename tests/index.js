'use strict';

/**
 * tests/index.js
 *
 * Da Node 22 in poi `node --test tests/` non cerca più i file dentro la
 * cartella ma la esegue come se fosse un modulo: Node carica allora questo
 * file, che a sua volta carica tutti i *.test.js. Con Node 20 questo file
 * viene ignorato (non ha il suffisso ".test.js") e i test girano uno per
 * file, quindi non si esegue nulla due volte.
 */

const fs = require('node:fs');
const path = require('node:path');

for (const nome of fs.readdirSync(__dirname).sort()) {
  if (nome.endsWith('.test.js')) require(path.join(__dirname, nome));
}
