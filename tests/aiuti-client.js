'use strict';

/**
 * tests/aiuti-client.js
 *
 * Carica in Node i moduli del browser (client/js/*.js, ES module) per testarne
 * le funzioni pure. Installa degli hook di caricamento (module.registerHooks,
 * Node 22.15 e successivi) che:
 *   - trattano i file di client/ come ES module (il pacchetto è CommonJS);
 *   - risolvono gli import assoluti del browser: `/js/x.js` → client/js/x.js,
 *     `/dati/x.js` → il modulo che il server genera da server/gioco/x.js.
 * Con un Node più vecchio `disponibile` è false e i test vengono saltati.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');

const RADICE_CLIENT = pathToFileURL(path.join(__dirname, '..', 'client') + path.sep).href;
const PREFISSO_DATI = 'monopoly-dati:';
const disponibile = typeof nodeModule.registerHooks === 'function';

let installati = false;
function installa() {
  if (installati || !disponibile) return;
  installati = true;
  const { moduloDatiComeEsm } = require('../server/index');
  nodeModule.registerHooks({
    resolve(specificatore, contesto, prossimo) {
      if (specificatore.startsWith('/js/')) {
        return { url: new URL(`.${specificatore}`, RADICE_CLIENT).href, format: 'module', shortCircuit: true };
      }
      if (specificatore.startsWith('/dati/')) {
        return { url: PREFISSO_DATI + specificatore.slice('/dati/'.length), format: 'module', shortCircuit: true };
      }
      const r = prossimo(specificatore, contesto);
      return r.url.startsWith(RADICE_CLIENT) ? { ...r, format: 'module' } : r;
    },
    load(url, contesto, prossimo) {
      if (url.startsWith(PREFISSO_DATI)) {
        return { format: 'module', source: moduloDatiComeEsm(url.slice(PREFISSO_DATI.length)), shortCircuit: true };
      }
      if (url.startsWith(RADICE_CLIENT)) return prossimo(url, { ...contesto, format: 'module' });
      return prossimo(url, contesto);
    },
  });
}

/** Importa client/js/<nome> come ES module. */
async function carica(nome) {
  installa();
  return import(new URL(`js/${nome}`, RADICE_CLIENT).href);
}

module.exports = { carica, disponibile };
