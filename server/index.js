'use strict';

/**
 * server/index.js
 *
 * Punto d'ingresso: server HTTP nativo che serve i file statici di `client/`
 * e i dati di gioco come ES module generati, più il server WebSocket (`ws`)
 * su /ws che smista i messaggi del protocollo (INTERFACCE.md §3).
 *
 * Avvio: `npm start` (= node server/index.js). Variabili: PORT, HOST, PUBLIC_URL
 * (se PUBLIC_URL manca, il link della stanza usa l'host con cui il browser ha
 * raggiunto il server). Heartbeat: ping WebSocket ogni 30 s, chi non risponde
 * viene chiuso e segnato `connesso: false` senza essere eliminato.
 * Esporta `avvia()` e `crea()` per i test; parte da solo se eseguito come main.
 */

const http = require('node:http');
const os = require('node:os');
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

/**
 * Content-Security-Policy: tutto dalla stessa origine, nessuno script inline.
 * `style-src 'unsafe-inline'` serve agli attributi style impostati dal client
 * (colori delle pedine); `img-src data:` alla favicon incorporata.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function rispondi(res, codice, corpo, tipo = 'text/plain; charset=utf-8', intestazioni = {}) {
  res.writeHead(codice, {
    'Content-Type': tipo,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CSP,
    ...intestazioni,
  });
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

/** Host ammesso negli header (nome o IPv4/IPv6 con porta opzionale). */
const REGEX_HOST = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;

/**
 * Base del link condiviso. Ordine: PUBLIC_URL configurato → host con cui il
 * browser ha raggiunto il server (così un link aperto da 192.168.1.10:3000 o
 * da un tunnel funziona anche per gli altri) → http://localhost:porta.
 */
function baseLink(configurato, req, portaLocale) {
  if (configurato) return configurato;
  const intestazioni = (req && req.headers) || {};
  const inoltrato = String(intestazioni['x-forwarded-host'] || '').split(',')[0].trim();
  const host = inoltrato || String(intestazioni.host || '').trim();
  if (host && REGEX_HOST.test(host)) {
    const proto = String(intestazioni['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const cifrato = proto === 'https' || Boolean(req.socket && req.socket.encrypted);
    return `${cifrato ? 'https' : 'http'}://${host.toLowerCase()}`;
  }
  return `http://localhost${portaLocale ? `:${portaLocale}` : ''}`;
}

/**
 * Controllo dell'origine dell'handshake WebSocket: un sito terzo non deve
 * poter usare i propri visitatori per aprire connessioni verso questo server.
 * Passano le richieste senza `Origin` (client non browser, test) e quelle la
 * cui origine coincide con l'host della richiesta, con `X-Forwarded-Host`
 * (proxy/tunnel) o con PUBLIC_URL. `ORIGINE_LIBERA=1` disattiva il controllo.
 */
function origineAmmessa(req, configurato) {
  if (process.env.ORIGINE_LIBERA === '1') return true;
  const intestazioni = (req && req.headers) || {};
  const origine = intestazioni.origin;
  if (!origine) return true;
  let hostOrigine;
  try {
    hostOrigine = new URL(origine).host.toLowerCase();
  } catch {
    return false;
  }
  const ammessi = new Set();
  for (const nome of ['host', 'x-forwarded-host']) {
    for (const h of String(intestazioni[nome] || '').split(',')) {
      if (h.trim()) ammessi.add(h.trim().toLowerCase());
    }
  }
  if (configurato) {
    try { ammessi.add(new URL(configurato).host.toLowerCase()); } catch { /* PUBLIC_URL malformato */ }
  }
  return ammessi.has(hostOrigine);
}

/** Indirizzi IPv4 di rete locale del computer (per il messaggio di avvio). */
function indirizziDiRete() {
  const out = [];
  for (const interfacce of Object.values(os.networkInterfaces())) {
    for (const i of interfacce || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const APERTO = 1;

function invia(socket, messaggio) {
  if (socket.readyState === APERTO) {
    try { socket.send(JSON.stringify(messaggio)); } catch { /* chiusura in corso */ }
  }
}

function inviaErrore(socket, codice, extra) {
  invia(socket, P.errore(codice, extra));
}

/** Estrae da un esito `{ errore: { codice, messaggio, dettagli } }` i campi per P.errore. */
function extraErrore(errore, rif) {
  const extra = { rif };
  if (errore.messaggio) extra.messaggio = errore.messaggio;
  if (errore.dettagli !== undefined) extra.dettagli = errore.dettagli;
  return extra;
}

/**
 * Collega i gestori di protocollo a un socket. `ctx` è lo stato per connessione.
 * @param {import('ws').WebSocket} socket
 * @param {{publicUrl: string, random: Function, ora: Function}} opzioni
 */
function collegaSocket(socket, { publicUrl, random, ora }) {
  const ctx = {
    stanza: null,
    giocatoreId: null,
    erroriConsecutivi: 0,
    stanzeCreate: 0,
    finestra: { inizio: 0, conteggio: 0, avvisato: false },
  };
  socket.vivo = true;

  /** Il socket è in una stanza ancora registrata? (pulisci() può chiuderla) */
  const inStanza = () => {
    if (ctx.stanza && ctx.stanza.chiusa) {
      ctx.stanza = null;
      ctx.giocatoreId = null;
    }
    return Boolean(ctx.stanza);
  };

  const messaggioEntrato = (stanza, giocatore) => ({
    tipo: 'entrato',
    giocatoreId: giocatore.id,
    token: giocatore.token,
    codice: stanza.codice,
    link: linkStanza(publicUrl, stanza.codice),
    hostId: stanza.hostId,
  });

  /** Stato con il log completo: solo a chi entra o si riconnette (cronaca intera). */
  const statoAlMittente = (stanza) => {
    const stato = stanze.statoPerClient(stanza, { completo: true });
    invia(socket, { tipo: 'stato', versione: stato.versione, stato });
  };

  const gestori = {
    creaStanza(m) {
      if (inStanza()) return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      if (stanze.tutte().length >= P.LIMITI.MAX_STANZE || ctx.stanzeCreate >= P.LIMITI.MAX_STANZE_PER_SOCKET) {
        return inviaErrore(socket, 'TROPPE_STANZE', {
          rif: m.rif,
          ...(ctx.stanzeCreate >= P.LIMITI.MAX_STANZE_PER_SOCKET
            ? { messaggio: 'Hai già creato diverse stanze: usa una di quelle o riprova più tardi' }
            : {}),
        });
      }
      ctx.stanzeCreate += 1;
      const stanza = stanze.crea({ ora, random });
      return invia(socket, { tipo: 'stanzaCreata', codice: stanza.codice, link: linkStanza(publicUrl, stanza.codice) });
    },

    entraStanza(m) {
      if (inStanza()) return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      const stanza = stanze.trova(m.codice);
      if (!stanza) {
        return inviaErrore(socket, 'STANZA_INESISTENTE', {
          rif: m.rif,
          messaggio: `La stanza ${m.codice} non esiste o è stata chiusa`,
        });
      }
      const esito = stanze.entra(stanza, { nome: m.nome, colore: m.colore, socket, ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      ctx.stanza = stanza;
      ctx.giocatoreId = esito.giocatore.id;
      invia(socket, messaggioEntrato(stanza, esito.giocatore));
      return stanze.diffondiAggiornamento(stanza, esito.eventi);
    },

    riconnetti(m) {
      if (inStanza()) {
        // Stesso giocatore che ripete riconnetti sullo stesso socket: rimandiamo
        // semplicemente entrato + stato invece di rispondere con un errore.
        const g = ctx.stanza.giocatori.get(ctx.giocatoreId);
        if (g && ctx.stanza.codice === m.codice && g.token === m.token) {
          invia(socket, messaggioEntrato(ctx.stanza, g));
          return statoAlMittente(ctx.stanza);
        }
        return inviaErrore(socket, 'GIA_IN_STANZA', { rif: m.rif });
      }
      const esito = stanze.riconnetti(m.codice, m.token, socket, { ora });
      if (esito.errore) {
        const messaggio = esito.errore.codice === 'STANZA_INESISTENTE'
          ? 'La stanza non esiste più: creane una nuova o entra con un altro codice'
          : undefined;
        return inviaErrore(socket, esito.errore.codice, { ...extraErrore(esito.errore, m.rif), ...(messaggio ? { messaggio } : {}) });
      }
      ctx.stanza = esito.stanza;
      ctx.giocatoreId = esito.giocatore.id;
      invia(socket, messaggioEntrato(esito.stanza, esito.giocatore));
      // Prima lo stato con la cronaca completa a chi rientra, poi il broadcast
      // (che include anche questo socket): evento connessione + stato breve.
      statoAlMittente(esito.stanza);
      return stanze.diffondiAggiornamento(esito.stanza, esito.eventi);
    },

    avviaPartita(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const esito = stanze.avvia(ctx.stanza, ctx.giocatoreId, { random, ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      return stanze.diffondiAggiornamento(ctx.stanza, esito.eventi);
    },

    azione(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      // giocatoreId viene dal socket, mai dal messaggio (INTERFACCE.md §3.2).
      const esito = stanze.applica(ctx.stanza, ctx.giocatoreId, m.azione, { random, ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      return stanze.diffondiAggiornamento(ctx.stanza, esito.eventi);
    },

    esciStanza(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const stanza = ctx.stanza;
      const esito = stanze.esci(stanza, ctx.giocatoreId, { ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      ctx.stanza = null;
      ctx.giocatoreId = null;
      // Chi esce non è più tra i destinatari: gli confermiamo l'uscita con l'evento.
      for (const ev of esito.eventi) invia(socket, { tipo: 'evento', versione: stanza.stato.versione, evento: ev });
      if (!esito.chiusa) stanze.diffondiAggiornamento(stanza, esito.eventi);
      return undefined;
    },

    ping() {
      return invia(socket, { tipo: 'pong' });
    },
  };

  /** Anti-flood: true se il messaggio va scartato. */
  const troppiMessaggi = () => {
    const t = Date.now();
    const f = ctx.finestra;
    if (t - f.inizio >= 1000) {
      f.inizio = t;
      f.conteggio = 0;
      f.avvisato = false;
    }
    f.conteggio += 1;
    if (f.conteggio <= P.LIMITI.MESSAGGI_AL_SECONDO_MAX) return false;
    if (f.conteggio > P.LIMITI.MESSAGGI_AL_SECONDO_MAX * 4) {
      socket.close(1008, 'Troppi messaggi');
    } else if (!f.avvisato) {
      f.avvisato = true;
      inviaErrore(socket, 'TROPPI_MESSAGGI');
    }
    return true;
  };

  socket.on('message', (grezzo, eBinario) => {
    socket.vivo = true;
    if (troppiMessaggi()) return;
    if (eBinario) {
      ctx.erroriConsecutivi += 1;
      inviaErrore(socket, 'MESSAGGIO_NON_VALIDO', { messaggio: 'Messaggio non valido: sono ammessi solo frame di testo JSON' });
    } else {
      const testo = Array.isArray(grezzo) ? Buffer.concat(grezzo).toString('utf8') : Buffer.from(grezzo).toString('utf8');
      const esito = P.analizza(testo);
      if (!esito.ok) {
        ctx.erroriConsecutivi += 1;
        inviaErrore(socket, esito.errore, { rif: esito.rif, messaggio: esito.messaggio, dettagli: esito.dettagli });
      } else {
        ctx.erroriConsecutivi = 0;
        try {
          gestori[esito.messaggio.tipo](esito.messaggio);
        } catch (e) {
          // Un bug non deve abbattere il server: lo logghiamo e rispondiamo al mittente.
          console.error('[ws] errore nel gestore', esito.messaggio.tipo, e);
          inviaErrore(socket, 'ERRORE_INTERNO', { rif: esito.messaggio.rif });
        }
      }
    }
    if (ctx.erroriConsecutivi >= P.LIMITI.ERRORI_CONSECUTIVI_MAX) {
      socket.close(1008, 'Troppi messaggi non validi');
    }
  });

  // Risposta al ping di heartbeat (livello WebSocket, gestito dal browser).
  socket.on('pong', () => { socket.vivo = true; });

  socket.on('close', () => {
    if (ctx.stanza && ctx.giocatoreId && !ctx.stanza.chiusa) {
      const stanza = ctx.stanza;
      const g = stanza.giocatori.get(ctx.giocatoreId);
      // Se il giocatore si è già riconnesso con un altro socket, non toccarlo.
      if (g && g.socket === socket) {
        try {
          const esito = stanze.disconnetti(stanza, ctx.giocatoreId, { ora, random });
          stanze.diffondiAggiornamento(stanza, esito.eventi);
        } catch (e) {
          console.error('[ws] errore alla disconnessione', e);
        }
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

/**
 * Heartbeat: ogni `intervallo` ms manda un ping WebSocket a ogni client; chi
 * non ha risposto (pong o qualunque messaggio) dal giro precedente viene
 * terminato, e l'evento 'close' lo segna come non connesso nella stanza.
 */
function avviaHeartbeat(wss, intervallo = P.LIMITI.HEARTBEAT_MS) {
  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.vivo === false) {
        socket.terminate();
        continue;
      }
      socket.vivo = false;
      try { socket.ping(); } catch { /* il socket si sta chiudendo */ }
    }
  }, intervallo);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

/**
 * Crea il server HTTP (+ WebSocket se disponibile) senza metterlo in ascolto.
 * @param {{publicUrl?: string, random?: Function, ora?: Function, heartbeatMs?: number}} [opzioni]
 */
function crea(opzioni = {}) {
  const random = opzioni.random || Math.random;
  const ora = opzioni.ora || Date.now;
  const configurato = opzioni.publicUrl || process.env.PUBLIC_URL || null;
  const server = http.createServer(gestoreHttp);
  let wss = null;
  let heartbeat = null;

  if (WebSocketServer) {
    wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: P.LIMITI.FRAME_MAX_BYTE,
      verifyClient: (info) => origineAmmessa(info.req, configurato),
    });
    wss.on('connection', (socket, req) => {
      try {
        const indirizzo = server.address();
        const porta = indirizzo && typeof indirizzo === 'object' ? indirizzo.port : null;
        collegaSocket(socket, { publicUrl: baseLink(configurato, req, porta), random, ora });
      } catch (e) {
        console.error('[ws] errore nel collegamento di un socket', e);
        try { socket.close(1011, 'Errore interno'); } catch { /* ignora */ }
      }
    });
    wss.on('error', (e) => console.error('[ws] errore del server WebSocket', e && e.message));
    heartbeat = avviaHeartbeat(wss, opzioni.heartbeatMs);
  }

  const pulizia = setInterval(() => {
    try { stanze.pulisci({ ora }); } catch (e) { console.error('[stanze] pulizia fallita', e); }
  }, 60 * 1000);
  pulizia.unref();
  server.on('close', () => {
    clearInterval(pulizia);
    if (heartbeat) clearInterval(heartbeat);
    if (wss) {
      for (const s of wss.clients) s.terminate();
      wss.close();
    }
  });

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
      risolvi({ server, wss, porta, url });
    });
  });
}

/** Chiusura ordinata su SIGINT/SIGTERM: avvisa i client e libera la porta. */
function arrestoOrdinato(server, wss) {
  let inCorso = false;
  const arresta = (segnale) => {
    if (inCorso) process.exit(1);
    inCorso = true;
    console.log(`\n${segnale}: chiusura del server…`);
    if (wss) for (const s of wss.clients) { try { s.close(1001, 'Server in arresto'); } catch { /* ignora */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => arresta('SIGINT'));
  process.on('SIGTERM', () => arresta('SIGTERM'));
}

if (require.main === module) {
  // Lo stato delle partite vive solo in memoria: un errore imprevisto in un
  // gestore o in un timer viene registrato, ma non deve chiudere tutte le stanze.
  process.on('uncaughtException', (e) => console.error('[server] eccezione non gestita', e));
  process.on('unhandledRejection', (e) => console.error('[server] promise rifiutata non gestita', e));

  avvia()
    .then(({ server, porta, url, wss }) => {
      arrestoOrdinato(server, wss);
      console.log(`Monopoly online v${pacchetto.version} in ascolto sulla porta ${porta}`);
      console.log(`Su questo computer:        http://localhost:${porta}`);
      if (process.env.PUBLIC_URL) {
        console.log(`Indirizzo pubblico (PUBLIC_URL): ${url}`);
      } else {
        const rete = indirizziDiRete();
        for (const ip of rete) console.log(`Amici sulla stessa rete:   http://${ip}:${porta}`);
        console.log(rete.length
          ? 'Per invitare gli amici apri il gioco da uno degli indirizzi di rete: il link della stanza userà quell\'indirizzo.'
          : 'Nessun indirizzo di rete trovato: gli amici non possono raggiungere "localhost".');
        console.log('Per giocare via Internet usa un tunnel (es. cloudflared, ngrok) e imposta PUBLIC_URL: vedi README.md.');
      }
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
  avviaHeartbeat,
  baseLink,
  linkStanza,
  origineAmmessa,
  indirizziDiRete,
  RADICE_CLIENT,
  MIME,
};
