'use strict';

/**
 * server/index.js
 *
 * Punto d'ingresso: server HTTP nativo che serve i file statici di `client/`
 * e i dati di gioco come ES module generati, più il server WebSocket (`ws`)
 * su /ws che smista i messaggi del protocollo (INTERFACCE.md §3).
 *
 * Avvio: `npm start` (= node server/index.js). Variabili: PORT, HOST, PUBLIC_URL.
 * Esporta `avvia()` e `crea()` per i test; parte da solo se eseguito come main.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const P = require('./protocollo');
const stanze = require('./stanze');
const pacchetto = require('../package.json');

// `ws` è l'unica dipendenza: se manca (npm install non eseguito) il server
// parte comunque in sola modalità HTTP e lo segnala, invece di crashare.
let WebSocketServer = null;
try {
  ({ WebSocketServer } = require('ws'));
} catch (e) {
  if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
}

const RADICE_CLIENT = path.resolve(__dirname, '..', 'client');
const CARTELLA_DATI = path.resolve(__dirname, 'gioco');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

// ---------------------------------------------------------------------------
// HTTP: utilità di risposta
// ---------------------------------------------------------------------------

function rispondi(res, codice, corpo, tipo = 'text/plain; charset=utf-8', intestazioni = {}) {
  res.writeHead(codice, { 'Content-Type': tipo, 'Cache-Control': 'no-cache', ...intestazioni });
  res.end(corpo);
}

function rispondiJson(res, codice, oggetto) {
  rispondi(res, codice, JSON.stringify(oggetto), 'application/json; charset=utf-8');
}

/** Serve un file sotto RADICE_CLIENT impedendo di uscire dalla cartella. */
function serviStatico(percorsoUrl, res) {
  let decodificato;
  try {
    decodificato = decodeURIComponent(percorsoUrl);
  } catch {
    return rispondi(res, 400, 'Percorso non valido');
  }
  if (decodificato.includes('\0') || decodificato.split(/[\\/]/).includes('..')) {
    return rispondi(res, 403, 'Accesso negato');
  }
  let relativo = decodificato === '/' ? '/index.html' : decodificato;
  let assoluto = path.normalize(path.join(RADICE_CLIENT, relativo));
  if (!assoluto.startsWith(RADICE_CLIENT + path.sep) && assoluto !== RADICE_CLIENT) {
    return rispondi(res, 403, 'Accesso negato');
  }

  fs.stat(assoluto, (err, info) => {
    if (!err && info.isDirectory()) {
      assoluto = path.join(assoluto, 'index.html');
      relativo = path.join(relativo, 'index.html');
    }
    fs.readFile(assoluto, (errLettura, contenuto) => {
      if (errLettura) {
        if (relativo === '/index.html' || relativo === path.join('/', 'index.html')) {
          return rispondi(res, 404, 'Il client non è ancora disponibile: manca client/index.html.');
        }
        return rispondi(res, 404, 'Non trovato');
      }
      const tipo = MIME[path.extname(assoluto).toLowerCase()] || 'application/octet-stream';
      return rispondi(res, 200, contenuto, tipo);
    });
  });
  return undefined;
}

/**
 * Converte un modulo CommonJS di soli dati in sorgente ES module:
 * una riga `export const NOME = <JSON>;` per ogni export serializzabile.
 * Funzioni e valori non JSON vengono saltati. Ritorna null se il modulo manca.
 */
function moduloDatiComeEsm(nomeFile) {
  const percorso = path.join(CARTELLA_DATI, nomeFile);
  if (!fs.existsSync(percorso)) return null;
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const modulo = require(percorso);
  const righe = [`// Generato da server/gioco/${nomeFile} — non modificare a mano.`];
  for (const [nome, valore] of Object.entries(modulo)) {
    if (typeof valore === 'function' || typeof valore === 'undefined' || typeof valore === 'symbol') continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(nome)) continue;
    righe.push(`export const ${nome} = ${JSON.stringify(valore)};`);
  }
  return righe.join('\n') + '\n';
}

const DATI_ESPOSTI = Object.freeze({
  '/dati/tabellone.js': 'tabellone.js',
  '/dati/carte.js': 'carte.js',
});

function gestoreHttp(req, res) {
  try {
    return smistaHttp(req, res);
  } catch (e) {
    console.error('[http] errore', req.method, req.url, e && e.message);
    if (!res.headersSent) return rispondi(res, 500, 'Errore interno del server');
    return res.end();
  }
}

function smistaHttp(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return rispondi(res, 400, 'URL non valido');
  }
  const percorso = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return rispondi(res, 405, 'Metodo non consentito', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
  }

  if (percorso === '/salute') {
    return rispondiJson(res, 200, {
      ok: true,
      stanze: stanze.tutte().length,
      versione: pacchetto.version,
      websocket: Boolean(WebSocketServer),
    });
  }

  if (DATI_ESPOSTI[percorso]) {
    let sorgente;
    try {
      sorgente = moduloDatiComeEsm(DATI_ESPOSTI[percorso]);
    } catch (e) {
      return rispondi(res, 500, `Errore nel modulo dati: ${e.message}`);
    }
    if (sorgente === null) return rispondi(res, 404, 'Modulo dati non ancora disponibile');
    return rispondi(res, 200, sorgente, MIME['.js']);
  }

  return serviStatico(percorso, res);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function linkStanza(publicUrl, codice) {
  return `${publicUrl.replace(/\/+$/, '')}/?stanza=${codice}`;
}

function invia(socket, messaggio) {
  if (socket.readyState === 1) {
    try { socket.send(JSON.stringify(messaggio)); } catch { /* chiusura in corso */ }
  }
}

function inviaErrore(socket, codice, extra) {
  invia(socket, P.errore(codice, extra));
}

/** Crea i gestori di un socket. `ctx` è lo stato per connessione. */
function collegaSocket(socket, { publicUrl, random, ora }) {
  const ctx = { stanza: null, giocatoreId: null, erroriConsecutivi: 0 };

  const messaggioEntrato = (stanza, giocatore) => ({
    tipo: 'entrato',
    giocatoreId: giocatore.id,
    token: giocatore.token,
    codice: stanza.codice,
    link: linkStanza(publicUrl, stanza.codice),
    hostId: stanza.hostId,
  });

  const gestori = {
    creaStanza(m) {
      if (ctx.stanza) return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      const stanza = stanze.crea({ ora, random });
      return invia(socket, { tipo: 'stanzaCreata', codice: stanza.codice, link: linkStanza(publicUrl, stanza.codice) });
    },

    entraStanza(m) {
      if (ctx.stanza) return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      const stanza = stanze.trova(m.codice);
      if (!stanza) return inviaErrore(socket, 'STANZA_INESISTENTE', { rif: m.rif });
      const esito = stanze.entra(stanza, { nome: m.nome, colore: m.colore, socket, ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, { rif: m.rif, dettagli: esito.errore.dettagli });
      ctx.stanza = stanza;
      ctx.giocatoreId = esito.giocatore.id;
      invia(socket, messaggioEntrato(stanza, esito.giocatore));
      return stanze.diffondiAggiornamento(stanza, esito.eventi);
    },

    riconnetti(m) {
      if (ctx.stanza) return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      const esito = stanze.riconnetti(m.codice, m.token, socket, { ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, { rif: m.rif });
      ctx.stanza = esito.stanza;
      ctx.giocatoreId = esito.giocatore.id;
      invia(socket, messaggioEntrato(esito.stanza, esito.giocatore));
      return stanze.diffondiAggiornamento(esito.stanza, esito.eventi);
    },

    avviaPartita(m) {
      if (!ctx.stanza) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const esito = stanze.avvia(ctx.stanza, ctx.giocatoreId, { random, ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, { rif: m.rif, dettagli: esito.errore.dettagli });
      return stanze.diffondiAggiornamento(ctx.stanza, esito.eventi);
    },

    azione(m) {
      if (!ctx.stanza) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const esito = stanze.applica(ctx.stanza, ctx.giocatoreId, m.azione, { random, ora });
      if (esito.errore) {
        return inviaErrore(socket, esito.errore.codice, {
          rif: m.rif,
          messaggio: esito.errore.messaggio,
          dettagli: esito.errore.dettagli,
        });
      }
      return stanze.diffondiAggiornamento(ctx.stanza, esito.eventi);
    },

    esciStanza(m) {
      if (!ctx.stanza) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const stanza = ctx.stanza;
      const esito = stanze.esci(stanza, ctx.giocatoreId, { ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, { rif: m.rif });
      ctx.stanza = null;
      ctx.giocatoreId = null;
      return stanze.diffondiAggiornamento(stanza, esito.eventi);
    },

    ping() {
      return invia(socket, { tipo: 'pong' });
    },
  };

  socket.on('message', (grezzo, eBinario) => {
    if (eBinario) {
      ctx.erroriConsecutivi += 1;
      inviaErrore(socket, 'MESSAGGIO_NON_VALIDO');
    } else {
      const esito = P.analizza(grezzo.toString('utf8'));
      if (!esito.ok) {
        ctx.erroriConsecutivi += 1;
        inviaErrore(socket, esito.errore, { rif: esito.rif });
      } else {
        ctx.erroriConsecutivi = 0;
        try {
          gestori[esito.messaggio.tipo](esito.messaggio);
        } catch (e) {
          // Un bug nel motore non deve abbattere il server: lo logghiamo e rispondiamo.
          console.error('[ws] errore nel gestore', esito.messaggio.tipo, e);
          inviaErrore(socket, 'MESSAGGIO_NON_VALIDO', { rif: esito.messaggio.rif, messaggio: 'Errore interno del server' });
        }
      }
    }
    if (ctx.erroriConsecutivi >= P.LIMITI.ERRORI_CONSECUTIVI_MAX) {
      socket.close(1008, 'Troppi messaggi non validi');
    }
  });

  socket.on('close', () => {
    if (ctx.stanza && ctx.giocatoreId) {
      const stanza = ctx.stanza;
      const g = stanza.giocatori.get(ctx.giocatoreId);
      // Se il giocatore si è già riconnesso con un altro socket, non toccarlo.
      if (g && g.socket === socket) {
        const esito = stanze.disconnetti(stanza, ctx.giocatoreId, { ora });
        stanze.diffondiAggiornamento(stanza, esito.eventi);
      }
    }
    ctx.stanza = null;
    ctx.giocatoreId = null;
  });

  socket.on('error', (e) => {
    console.error('[ws] errore socket', e && e.message);
  });

  return ctx;
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

/**
 * Crea il server HTTP (+ WebSocket se disponibile) senza metterlo in ascolto.
 * @param {{publicUrl?: string, random?: Function, ora?: Function}} [opzioni]
 */
function crea(opzioni = {}) {
  const random = opzioni.random || Math.random;
  const ora = opzioni.ora || Date.now;
  const server = http.createServer(gestoreHttp);
  let wss = null;

  if (WebSocketServer) {
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: P.LIMITI.MESSAGGIO_MAX_BYTE });
    wss.on('connection', (socket) => {
      collegaSocket(socket, { publicUrl: opzioni.publicUrl || server.publicUrl || 'http://localhost', random, ora });
    });
  }

  const pulizia = setInterval(() => {
    try { stanze.pulisci({ ora }); } catch (e) { console.error('[stanze] pulizia fallita', e); }
  }, 60 * 1000);
  pulizia.unref();
  server.on('close', () => clearInterval(pulizia));

  return { server, wss };
}

/**
 * Avvia il server in ascolto. Ritorna una Promise con { server, wss, porta, url }.
 */
function avvia({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0', publicUrl } = {}) {
  return new Promise((risolvi, rifiuta) => {
    const { server, wss } = crea({ publicUrl });
    server.once('error', rifiuta);
    server.listen(port, host, () => {
      const porta = server.address().port;
      const url = publicUrl || process.env.PUBLIC_URL || `http://localhost:${porta}`;
      server.publicUrl = url;
      risolvi({ server, wss, porta, url });
    });
  });
}

if (require.main === module) {
  avvia()
    .then(({ porta, url, wss }) => {
      console.log(`Monopoly online v${pacchetto.version} in ascolto sulla porta ${porta}`);
      console.log(`Apri ${url} per creare una stanza`);
      if (!wss) {
        console.warn('ATTENZIONE: dipendenza "ws" non trovata. Esegui `npm install` per abilitare il gioco in rete.');
      }
      if (!fs.existsSync(path.join(RADICE_CLIENT, 'index.html'))) {
        console.warn('ATTENZIONE: client/index.html non trovato: il browser riceverà 404 finché il client non è presente.');
      }
    })
    .catch((e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`La porta ${process.env.PORT || 3000} è già in uso. Imposta PORT=<altra porta>.`);
      } else {
        console.error('Avvio fallito:', e);
      }
      process.exit(1);
    });
}

module.exports = {
  crea,
  avvia,
  gestoreHttp,
  moduloDatiComeEsm,
  collegaSocket,
  linkStanza,
  RADICE_CLIENT,
  MIME,
};
