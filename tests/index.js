'use strict';

/**
 * tests/index.js
 *
 * `npm test` esegue `node --test` senza argomenti: Node trova da solo tutti i
 * file `*.test.js` (questa cartella e `server/gioco/test/`), con Node 20 e
 * successivi. Questo file serve solo a chi lancia a mano `node --test tests/`
 * con Node 22 o più recente, dove una cartella passata come argomento viene
 * eseguita come modulo: in quel caso Node carica questo file, che a sua volta
 * carica tutti i `*.test.js` della cartella. Non avendo il suffisso
 * ".test.js" non viene mai eseguito due volte.
 */

const fs = require('node:fs');
const path = require('node:path');

for (const nome of fs.readdirSync(__dirname).sort()) {
  if (nome.endsWith('.test.js')) require(path.join(__dirname, nome));
}
