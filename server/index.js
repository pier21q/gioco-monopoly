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
 * raggiunto il server), PROXY_FIDATO (intestazioni X-Forwarded-*),
 * PROXY_INTESTAZIONE_IP (intestazione con l'indirizzo vero del client),
 * SALVATAGGIO (file delle partite, vedi salvataggio.js). Heartbeat: ping WebSocket ogni
 * 30 s, chi non risponde viene chiuso e segnato `connesso: false`.
 * Esporta `avvia()` e `crea()` per i test; parte da solo se eseguito come main.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const P = require('./protocollo');
const stanze = require('./stanze');
const salvataggio = require('./salvataggio');
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

/** Quando è partito questo processo: /salute lo dice al lanciatore. */
const AVVIATO_IL = Date.now();

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

// ---------------------------------------------------------------------------
// HTTP: file statici con ETag (risposta 304) e gzip
// ---------------------------------------------------------------------------

/** Tipi di testo: gli unici per cui la compressione vale la pena. */
const COMPRIMIBILI = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.webmanifest']);
/** Sotto questa dimensione il gzip non fa risparmiare niente. */
const GZIP_MINIMO_BYTE = 1024;

/** Contenuti già letti: chiave → { firma, corpo, etag, gzip }. Solo file esistenti di client/ e i moduli dati. */
const cacheContenuti = new Map();

/** ETag debole: lo stesso contenuto vale sia compresso sia no. */
function etagDi(corpo) {
  return `W/"${crypto.createHash('sha1').update(corpo).digest('base64url')}"`;
}

/** Il client accetta gzip? (`Accept-Encoding: gzip`, non `gzip;q=0`) */
function accettaGzip(req) {
  const valore = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  return valore.split(',').some((parte) => {
    const [nome, ...parametri] = parte.trim().split(';').map((x) => x.trim());
    if (nome !== 'gzip' && nome !== '*') return false;
    const q = parametri.find((x) => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

/** `If-None-Match` contiene l'ETag della risposta? (confronto debole) */
function etagCoincide(req, etag) {
  const valore = String((req && req.headers && req.headers['if-none-match']) || '').trim();
  if (!valore) return false;
  if (valore === '*') return true;
  const nudo = (x) => x.trim().replace(/^W\//, '');
  return valore.split(',').some((x) => nudo(x) === nudo(etag));
}

/** Mette in cache `corpo` per `chiave` (con la `firma` che dice se è ancora buono) e ritorna la voce. */
function mettiInCache(chiave, firma, corpo) {
  const dati = Buffer.from(corpo);
  const voce = { firma, corpo: dati, etag: etagDi(dati), gzip: undefined };
  cacheContenuti.set(chiave, voce);
  return voce;
}

/**
 * Invia un contenuto con ETag: 304 senza corpo se il browser l'ha già, gzip
 * se lo accetta e il tipo è testo. `Cache-Control: no-cache` resta: il browser
 * richiede ogni volta, ma riscarica solo quello che è cambiato.
 */
function inviaContenuto(req, res, voce, tipo, estensione) {
  const comprimibile = COMPRIMIBILI.has(estensione) && voce.corpo.length >= GZIP_MINIMO_BYTE;
  const intestazioni = { ETag: voce.etag };
  if (comprimibile) intestazioni.Vary = 'Accept-Encoding';
  if (etagCoincide(req, voce.etag)) return rispondi(res, 304, undefined, tipo, intestazioni);
  if (comprimibile && accettaGzip(req)) {
    if (voce.gzip === undefined) {
      const compresso = zlib.gzipSync(voce.corpo);
      voce.gzip = compresso.length < voce.corpo.length ? compresso : null;
    }
    if (voce.gzip) return rispondi(res, 200, voce.gzip, tipo, { ...intestazioni, 'Content-Encoding': 'gzip' });
  }
  return rispondi(res, 200, voce.corpo, tipo, intestazioni);
}

/**
 * Serve un file sotto `radice` (di norma RADICE_CLIENT) impedendo di uscire
 * dalla cartella. I nomi che iniziano con un punto (.DS_Store, .git…) non si
 * servono mai.
 */
function serviStatico(req, percorsoUrl, res, radice = RADICE_CLIENT) {
  let decodificato;
  try {
    decodificato = decodeURIComponent(percorsoUrl);
  } catch {
    return rispondi(res, 400, 'Percorso non valido');
  }
  const segmenti = decodificato.split(/[\\/]/);
  if (decodificato.includes('\0') || segmenti.includes('..')) {
    return rispondi(res, 403, 'Accesso negato');
  }
  if (segmenti.some((segmento) => segmento.startsWith('.'))) {
    return rispondi(res, 404, 'Non trovato');
  }
  let relativo = decodificato === '/' ? '/index.html' : decodificato;
  let assoluto = path.normalize(path.join(radice, relativo));
  if (!assoluto.startsWith(radice + path.sep) && assoluto !== radice) {
    return rispondi(res, 403, 'Accesso negato');
  }

  const nonTrovato = () => {
    if (relativo === '/index.html' || relativo === path.join('/', 'index.html')) {
      return rispondi(res, 404, 'Il client non è ancora disponibile: manca client/index.html.');
    }
    return rispondi(res, 404, 'Non trovato');
  };
  // Il file si rilegge solo se è cambiato (data o dimensione), e sempre senza
  // fermare il server: su un disco lento una lettura può durare secondi.
  const servi = (info) => {
    const estensione = path.extname(assoluto).toLowerCase();
    const tipo = MIME[estensione] || 'application/octet-stream';
    const firma = `${info.mtimeMs}|${info.size}`;
    const nota = cacheContenuti.get(assoluto);
    if (nota && nota.firma === firma) return inviaContenuto(req, res, nota, tipo, estensione);
    return fs.readFile(assoluto, (errLettura, contenuto) => {
      try {
        if (errLettura) return nonTrovato();
        return inviaContenuto(req, res, mettiInCache(assoluto, firma, contenuto), tipo, estensione);
      } catch (e) {
        return erroreInterno(req, res, e);
      }
    });
  };

  fs.stat(assoluto, (err, info) => {
    try {
      if (!err && info.isDirectory()) {
        assoluto = path.join(assoluto, 'index.html');
        relativo = path.join(relativo, 'index.html');
        return fs.stat(assoluto, (errIndice, infoIndice) => {
          try {
            return errIndice || !infoIndice.isFile() ? nonTrovato() : servi(infoIndice);
          } catch (e) {
            return erroreInterno(req, res, e);
          }
        });
      }
      return err || !info.isFile() ? nonTrovato() : servi(info);
    } catch (e) {
      return erroreInterno(req, res, e);
    }
  });
  return undefined;
}

function erroreInterno(req, res, e) {
  console.error('[http] errore', req.method, req.url, e && e.message);
  if (!res.headersSent) return rispondi(res, 500, 'Errore interno del server');
  return res.end();
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
  '/dati/regole.js': 'regole.js',
});

function gestoreHttp(req, res, radice = RADICE_CLIENT) {
  try {
    return smistaHttp(req, res, radice);
  } catch (e) {
    return erroreInterno(req, res, e);
  }
}

function smistaHttp(req, res, radice) {
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
      // Il lanciatore riconosce da qui che sulla porta c'è davvero questo
      // gioco, e da `avviatoIl` se il server è più vecchio dei file.
      gioco: 'monopoly',
      avviatoIl: AVVIATO_IL,
      stanze: stanze.tutte().length,
      versione: pacchetto.version,
      websocket: Boolean(WebSocketServer),
    });
  }

  if (DATI_ESPOSTI[percorso]) {
    // I dati non cambiano finché il processo è acceso: si generano una volta.
    let voce = cacheContenuti.get(`dati:${percorso}`);
    if (!voce) {
      let sorgente;
      try {
        sorgente = moduloDatiComeEsm(DATI_ESPOSTI[percorso]);
      } catch (e) {
        return rispondi(res, 500, `Errore nel modulo dati: ${e.message}`);
      }
      if (sorgente === null) return rispondi(res, 404, 'Modulo dati non ancora disponibile');
      voce = mettiInCache(`dati:${percorso}`, 'fisso', sorgente);
    }
    return inviaContenuto(req, res, voce, MIME['.js'], '.js');
  }

  return serviStatico(req, percorso, res, radice);
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
 * Il server sta dietro un proxy di cui ci si può fidare per le intestazioni
 * X-Forwarded-*? Sì con PROXY_FIDATO=1, e su Render (che imposta RENDER) salvo
 * PROXY_FIDATO=0. Senza proxy quelle intestazioni le scrive il client: si ignorano.
 */
function proxyFidato() {
  if (process.env.PROXY_FIDATO === '1') return true;
  if (process.env.PROXY_FIDATO === '0') return false;
  return Boolean(process.env.RENDER);
}

/**
 * Intestazione in cui il proxy scrive da sé l'indirizzo vero del client,
 * cancellando quella eventualmente inviata dal client. Si sceglie con
 * PROXY_INTESTAZIONE_IP; su Render (che sta dietro Cloudflare) è
 * `CF-Connecting-IP`. Vale solo dietro un proxy fidato.
 */
function intestazioneIp() {
  const scelta = String(process.env.PROXY_INTESTAZIONE_IP || '').trim().toLowerCase();
  if (scelta) return /^[a-z0-9-]{1,64}$/.test(scelta) ? scelta : null;
  return process.env.RENDER ? 'cf-connecting-ip' : null;
}

/**
 * Indirizzo del client, per i limiti per indirizzo. Dietro un proxy fidato è
 * quello dell'intestazione dedicata (vedi intestazioneIp) oppure l'ULTIMO di
 * X-Forwarded-For: il proxy accoda l'indirizzo che vede davvero a quelli
 * ricevuti dal client, quindi i primi della lista li può inventare chiunque e
 * solo l'ultimo è scritto dal proxy.
 */
function ipDi(req, fidato = proxyFidato(), intestazione = intestazioneIp()) {
  const intestazioni = (req && req.headers) || {};
  if (fidato) {
    const dedicata = intestazione ? String(intestazioni[intestazione] || '').trim() : '';
    if (dedicata && !dedicata.includes(',')) return dedicata.toLowerCase();
    const inoltrati = String(intestazioni['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (inoltrati.length) return inoltrati[inoltrati.length - 1].toLowerCase();
  }
  const diretto = req && req.socket && req.socket.remoteAddress;
  return diretto ? String(diretto).replace(/^::ffff:/, '').toLowerCase() : 'sconosciuto';
}

/**
 * Base del link condiviso. Ordine: PUBLIC_URL configurato → host con cui il
 * browser ha raggiunto il server (così un link aperto da 192.168.1.10:3000 o
 * da un tunnel funziona anche per gli altri) → http://localhost:porta.
 * X-Forwarded-Host/Proto contano solo dietro un proxy fidato.
 */
function baseLink(configurato, req, portaLocale, fidato = proxyFidato()) {
  if (configurato) return configurato;
  const intestazioni = (req && req.headers) || {};
  const inoltrato = fidato ? String(intestazioni['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const host = inoltrato || String(intestazioni.host || '').trim();
  if (host && REGEX_HOST.test(host)) {
    const proto = fidato ? String(intestazioni['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
    const cifrato = proto === 'https' || Boolean(req.socket && req.socket.encrypted);
    return `${cifrato ? 'https' : 'http'}://${host.toLowerCase()}`;
  }
  return `http://localhost${portaLocale ? `:${portaLocale}` : ''}`;
}

/**
 * Controllo dell'origine dell'handshake WebSocket: un sito terzo non deve
 * poter usare i propri visitatori per aprire connessioni verso questo server.
 * Passano le richieste senza `Origin` (client non browser, test) e quelle la
 * cui origine coincide con l'host della richiesta, con PUBLIC_URL o, dietro un
 * proxy fidato, con `X-Forwarded-Host`. `ORIGINE_LIBERA=1` disattiva il controllo.
 */
function origineAmmessa(req, configurato, fidato = proxyFidato()) {
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
  for (const nome of fidato ? ['host', 'x-forwarded-host'] : ['host']) {
    for (const h of String(intestazioni[nome] || '').split(',')) {
      if (h.trim()) ammessi.add(h.trim().toLowerCase());
    }
  }
  if (configurato) {
    try { ammessi.add(new URL(configurato).host.toLowerCase()); } catch { /* PUBLIC_URL malformato */ }
  }
  return ammessi.has(hostOrigine);
}

/**
 * Confronta a tempo costante la chiave admin ricevuta con quella configurata.
 * Senza chiave configurata (o troppo corta) l'admin non esiste.
 */
function chiaveAdminValida(ricevuta, configurata) {
  if (typeof ricevuta !== 'string' || typeof configurata !== 'string') return false;
  if (!P.REGEX_CHIAVE_ADMIN.test(configurata)) return false;
  const a = crypto.createHash('sha256').update(ricevuta).digest();
  const b = crypto.createHash('sha256').update(configurata).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Chiave admin per il server locale: ADMIN_CHIAVE se c'è, altrimenti una chiave
 * generata una volta e conservata in `cartella/chiave-admin` (permessi 600).
 * Ritorna null se non si può né leggere né creare.
 */
function chiaveAdminLocale(cartella) {
  if (process.env.ADMIN_CHIAVE) return process.env.ADMIN_CHIAVE;
  if (!cartella) return null;
  const file = path.join(cartella, 'chiave-admin');
  try {
    const letta = fs.readFileSync(file, 'utf8').trim();
    if (P.REGEX_CHIAVE_ADMIN.test(letta)) return letta;
  } catch { /* non c'è ancora */ }
  try {
    const nuova = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(cartella, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${nuova}\n`, { mode: 0o600 });
    return nuova;
  } catch (e) {
    console.error('Chiave admin non salvata:', e.message);
    return null;
  }
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
 * @param {{publicUrl: string, random: Function, ora: Function, ip?: string, chiaveAdmin?: string|null}} opzioni
 */
function collegaSocket(socket, { publicUrl, random, ora, ip = null, chiaveAdmin = null }) {
  const ctx = {
    stanza: null,
    giocatoreId: null,
    admin: false,
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
      // L'admin non ha limiti di stanze per connessione o per indirizzo.
      const troppeMie = !ctx.admin && (ctx.stanzeCreate >= P.LIMITI.MAX_STANZE_PER_SOCKET
        || (ip && stanze.aperteDa(ip) >= P.LIMITI.MAX_STANZE_PER_IP));
      if (troppeMie) {
        return inviaErrore(socket, 'TROPPE_STANZE', {
          rif: m.rif,
          messaggio: 'Hai già creato diverse stanze: usa una di quelle o riprova più tardi',
        });
      }
      // Registro pieno: si fa posto chiudendo la stanza vuota più vecchia; se
      // tutte hanno qualcuno dentro, si rifiuta.
      if (stanze.tutte().length >= P.LIMITI.MAX_STANZE && !stanze.liberaPosto()) {
        return inviaErrore(socket, 'TROPPE_STANZE', { rif: m.rif });
      }
      ctx.stanzeCreate += 1;
      const stanza = stanze.crea({ ora, random, ip });
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
      const eventi = [...esito.eventi, ...(ctx.admin ? stanze.rendiAdmin(stanza, ctx.giocatoreId, { ora }) : [])];
      invia(socket, messaggioEntrato(stanza, esito.giocatore));
      return stanze.diffondiAggiornamento(stanza, eventi);
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
      if (ctx.admin) esito.eventi.push(...stanze.rendiAdmin(esito.stanza, ctx.giocatoreId, { ora }));
      invia(socket, messaggioEntrato(esito.stanza, esito.giocatore));
      // Prima lo stato con la cronaca completa a chi rientra, poi il broadcast
      // (che include anche questo socket): evento connessione + stato breve.
      statoAlMittente(esito.stanza);
      return stanze.diffondiAggiornamento(esito.stanza, esito.eventi);
    },

    impostaRegole(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const esito = stanze.impostaRegole(ctx.stanza, ctx.giocatoreId, m.regole, { ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      return stanze.diffondiAggiornamento(ctx.stanza, esito.eventi);
    },

    avviaPartita(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const esito = stanze.avvia(ctx.stanza, ctx.giocatoreId, { random, ora, regole: m.regole });
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

    autenticaAdmin(m) {
      if (!chiaveAdminValida(m.chiave, chiaveAdmin)) {
        // Pochi tentativi per connessione: indovinare una chiave a caso è comunque impossibile.
        ctx.tentativiAdmin = (ctx.tentativiAdmin || 0) + 1;
        inviaErrore(socket, 'ADMIN_NON_VALIDO', { rif: m.rif });
        if (ctx.tentativiAdmin >= 5) socket.close(1008, 'Troppi tentativi admin');
        return undefined;
      }
      ctx.admin = true;
      // `indirizzo` è quello con cui il server conta i limiti: all'admin serve
      // per controllare, dietro un proxy, che sia il suo e non quello del proxy.
      invia(socket, { tipo: 'admin', ok: true, rif: m.rif, indirizzo: ip });
      if (inStanza()) {
        const eventi = stanze.rendiAdmin(ctx.stanza, ctx.giocatoreId, { ora });
        if (eventi.length) stanze.diffondiAggiornamento(ctx.stanza, eventi);
      }
      return undefined;
    },

    lasciaAdmin(m) {
      // Questa connessione torna quella di un giocatore qualunque.
      ctx.admin = false;
      invia(socket, { tipo: 'admin', ok: false, rif: m.rif });
      if (inStanza()) {
        const eventi = stanze.lasciaAdmin(ctx.stanza, ctx.giocatoreId, { ora });
        if (eventi.length) stanze.diffondiAggiornamento(ctx.stanza, eventi);
      }
      return undefined;
    },

    chiudiStanza(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      if (!stanze.puoComandare(ctx.stanza, ctx.giocatoreId)) return inviaErrore(socket, 'NON_ADMIN', { rif: m.rif });
      const chi = ctx.stanza.adminId === ctx.giocatoreId ? 'dall\'admin' : 'dall\'host';
      stanze.rimuovi(ctx.stanza.codice, `La stanza è stata chiusa ${chi}`);
      return undefined;
    },

    cacciaGiocatore(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const stanza = ctx.stanza;
      const esito = stanze.caccia(stanza, ctx.giocatoreId, m.giocatoreId, { ora, random });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      if (esito.socket) {
        invia(esito.socket, P.errore('CACCIATO'));
        try { esito.socket.close(P.CHIUSURE.CACCIATO, 'Tolto dalla stanza'); } catch { /* già chiuso */ }
      }
      return stanze.diffondiAggiornamento(stanza, esito.eventi);
    },

    cediAdmin(m) {
      if (!inStanza()) return inviaErrore(socket, 'NON_IN_STANZA', { rif: m.rif });
      const stanza = ctx.stanza;
      const esito = stanze.cediAdmin(stanza, ctx.giocatoreId, m.giocatoreId, { ora });
      if (esito.errore) return inviaErrore(socket, esito.errore.codice, extraErrore(esito.errore, m.rif));
      return stanze.diffondiAggiornamento(stanza, esito.eventi);
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
 * @param {{publicUrl?: string, random?: Function, ora?: Function, heartbeatMs?: number,
 *   proxyFidato?: boolean, chiaveAdmin?: string|null, maxConnessioniPerIp?: number, maxConnessioni?: number,
 *   radiceClient?: string}} [opzioni]  `radiceClient` (per i test) è la cartella dei file statici.
 */
function crea(opzioni = {}) {
  const random = opzioni.random || stanze.casualeSicuro;
  const ora = opzioni.ora || Date.now;
  const configurato = opzioni.publicUrl || process.env.PUBLIC_URL || null;
  const fidato = opzioni.proxyFidato ?? proxyFidato();
  const chiaveAdmin = opzioni.chiaveAdmin !== undefined ? opzioni.chiaveAdmin : (process.env.ADMIN_CHIAVE || null);
  const maxPerIp = opzioni.maxConnessioniPerIp ?? P.LIMITI.MAX_CONNESSIONI_PER_IP;
  const maxConnessioni = opzioni.maxConnessioni ?? P.LIMITI.MAX_CONNESSIONI;
  const radiceClient = opzioni.radiceClient ? path.resolve(opzioni.radiceClient) : RADICE_CLIENT;
  const server = http.createServer((req, res) => gestoreHttp(req, res, radiceClient));
  let wss = null;
  let heartbeat = null;
  /** Connessioni WebSocket aperte per indirizzo. */
  const connessioni = new Map();

  if (WebSocketServer) {
    wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: P.LIMITI.FRAME_MAX_BYTE,
      verifyClient: (info, rispondiVerifica) => {
        if (!origineAmmessa(info.req, configurato, fidato)) return rispondiVerifica(false, 403, 'Origine non ammessa');
        // Tetto globale: il limite per indirizzo da solo non basta contro chi
        // di indirizzi ne ha tanti.
        if (wss.clients.size >= maxConnessioni) return rispondiVerifica(false, 503, 'Server pieno: riprova tra poco');
        if ((connessioni.get(ipDi(info.req, fidato)) || 0) >= maxPerIp) {
          return rispondiVerifica(false, 429, 'Troppe connessioni da questo indirizzo');
        }
        return rispondiVerifica(true);
      },
    });
    wss.on('connection', (socket, req) => {
      const ip = ipDi(req, fidato);
      connessioni.set(ip, (connessioni.get(ip) || 0) + 1);
      socket.once('close', () => {
        const n = (connessioni.get(ip) || 1) - 1;
        if (n > 0) connessioni.set(ip, n);
        else connessioni.delete(ip);
      });
      try {
        const indirizzo = server.address();
        const porta = indirizzo && typeof indirizzo === 'object' ? indirizzo.port : null;
        collegaSocket(socket, { publicUrl: baseLink(configurato, req, porta, fidato), random, ora, ip, chiaveAdmin });
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
function avvia({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0', publicUrl, chiaveAdmin, radiceClient } = {}) {
  return new Promise((risolvi, rifiuta) => {
    const { server, wss } = crea({ publicUrl, chiaveAdmin, radiceClient });
    server.once('error', rifiuta);
    server.listen(port, host, () => {
      const porta = server.address().port;
      const url = publicUrl || process.env.PUBLIC_URL || `http://localhost:${porta}`;
      risolvi({ server, wss, porta, url });
    });
  });
}

/** Chiusura ordinata su SIGINT/SIGTERM: salva le partite, avvisa i client e libera la porta. */
function arrestoOrdinato(server, wss, salvataggioAttivo = null) {
  let inCorso = false;
  const arresta = (segnale) => {
    if (inCorso) process.exit(1);
    inCorso = true;
    console.log(`\n${segnale}: chiusura del server…`);
    if (salvataggioAttivo) salvataggioAttivo.salvaOra();
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

  // Partite salvate su file: sopravvivono a un riavvio del server su questo
  // computer (non su Render gratuito, dove il disco si azzera).
  let fileSalvataggio = salvataggio.percorsoDaAmbiente(process.env.SALVATAGGIO, path.resolve(__dirname, '..'));
  const cartellaSalvataggio = fileSalvataggio ? path.dirname(fileSalvataggio) : null;
  let salvataggioAttivo = null;
  if (fileSalvataggio) {
    const esito = salvataggio.caricaSenzaPerdere(fileSalvataggio, stanze);
    if (esito.ripristinate > 0) console.log(`Partite ripristinate dal salvataggio: ${esito.ripristinate}`);
    if (esito.errore) {
      console.error(`Salvataggio illeggibile (${fileSalvataggio}): si riparte senza partite.`, esito.errore.message);
      if (esito.messoDaParte) console.error(`Il file non è stato toccato: lo trovi in ${esito.messoDaParte}`);
    }
    if (esito.sicuro) {
      salvataggioAttivo = salvataggio.avvia(fileSalvataggio, stanze);
    } else {
      console.error('Non riesco a mettere da parte il file illeggibile: per non sovrascriverlo, in questa sessione le partite NON vengono salvate.');
      fileSalvataggio = null;
    }
  }

  // Chiave admin: su Render arriva da ADMIN_CHIAVE (generata da Render); in
  // locale, se manca, se ne genera una accanto al salvataggio.
  const chiaveAdmin = process.env.ADMIN_CHIAVE
    || chiaveAdminLocale(cartellaSalvataggio);
  if (chiaveAdmin && !P.REGEX_CHIAVE_ADMIN.test(chiaveAdmin)) {
    console.warn('ATTENZIONE: ADMIN_CHIAVE deve avere da 16 a 128 caratteri (lettere, cifre, + / = _ -): admin disattivato.');
  }

  avvia({ chiaveAdmin })
    .then(({ server, porta, url, wss }) => {
      arrestoOrdinato(server, wss, salvataggioAttivo);
      const host = process.env.HOST || '0.0.0.0';
      const suTutteLeReti = host === '0.0.0.0' || host === '::';
      console.log(`Monopoly online v${pacchetto.version} in ascolto sulla porta ${porta}`);
      console.log(`Su questo computer:        http://localhost:${porta}`);
      if (fileSalvataggio) console.log(`Partite salvate in:        ${fileSalvataggio}`);
      // Il link da admin si stampa solo in locale: su Render i log li vede il pannello.
      if (chiaveAdmin && P.REGEX_CHIAVE_ADMIN.test(chiaveAdmin) && !process.env.RENDER) {
        console.log(`Il tuo link da admin:      http://localhost:${porta}/#admin=${encodeURIComponent(chiaveAdmin)}  (non condividerlo)`);
      }
      if (process.env.PUBLIC_URL) {
        console.log(`Indirizzo pubblico (PUBLIC_URL): ${url}`);
      } else if (!suTutteLeReti) {
        const locale = ['127.0.0.1', 'localhost', '::1'].includes(host);
        console.log(locale
          ? `HOST=${host}: il gioco è raggiungibile solo da questo computer.`
          : `HOST=${host}: il gioco è raggiungibile solo da http://${host}:${porta}`);
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
  proxyFidato,
  intestazioneIp,
  ipDi,
  chiaveAdminValida,
  chiaveAdminLocale,
  indirizziDiRete,
  RADICE_CLIENT,
  MIME,
};
