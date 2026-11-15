'use strict';

/**
 * tests/server.integration.test.js
 * Test di integrazione del server reale: HTTP + WebSocket su una porta libera.
 * Serve la dipendenza `ws` (npm install): se manca, il primo test fallisce
 * spiegando cosa fare e gli altri vengono saltati.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const P = require('../server/protocollo');
const stanze = require('../server/stanze');
const indice = require('../server/index');
const H = require('./aiuti');

let WS = null;
try { ({ WebSocket: WS } = require('ws')); } catch { WS = null; }
const SALTA = WS ? false : 'dipendenza "ws" non installata (esegui npm install)';

// ---------------------------------------------------------------------------
// Strumenti
// ---------------------------------------------------------------------------

/** Client WebSocket che conserva tutti i messaggi ricevuti. */
class Client {
  constructor(url) {
    this.messaggi = [];
    this.attese = [];
    this.chiusura = null;
    this.ws = new WS(url);
    this.apertura = new Promise((risolvi, rifiuta) => {
      this.ws.once('open', risolvi);
      this.ws.once('error', rifiuta);
    });
    this.ws.on('error', () => {});
    this.ws.on('message', (dati, binario) => {
      if (binario) return;
      let m;
      try { m = JSON.parse(dati.toString('utf8')); } catch { return; }
      this.messaggi.push(m);
      for (const a of [...this.attese]) if (a.prova()) this.attese.splice(this.attese.indexOf(a), 1);
    });
    this.fine = new Promise((risolvi) => {
      this.ws.on('close', (codice) => { this.chiusura = codice; risolvi(codice); });
    });
  }

  invia(oggetto) { this.ws.send(typeof oggetto === 'string' ? oggetto : JSON.stringify(oggetto)); }

  /** Attende il primo messaggio (dall'indice `da`) che soddisfa `pred`. */
  attendi(pred, descrizione, da = 0, ms = 4000) {
    return new Promise((risolvi, rifiuta) => {
      const prova = () => {
        const m = this.messaggi.slice(da).find(pred);
        if (!m) return false;
        clearTimeout(timer);
        risolvi(m);
        return true;
      };
      const timer = setTimeout(() => {
        this.attese = this.attese.filter((a) => a.prova !== prova);
        rifiuta(new Error(`Timeout: ${descrizione}. Messaggi ricevuti: ${JSON.stringify(this.messaggi.slice(da).map((x) => x.tipo + (x.codice ? `:${x.codice}` : '')))}`));
      }, ms);
      if (!prova()) this.attese.push({ prova });
    });
  }

  ultimoStato() { return [...this.messaggi].reverse().find((m) => m.tipo === 'stato') || null; }
}

/** Server su porta libera con generatore deterministico; `chiudi` ferma tutto. */
async function avviaServer(opzioni = {}) {
  stanze.azzera();
  const { server, wss } = indice.crea({ random: H.rngDeterministico(42), ora: Date.now, ...opzioni });
  await new Promise((risolvi, rifiuta) => { server.once('error', rifiuta); server.listen(0, '127.0.0.1', risolvi); });
  const porta = server.address().port;
  const clienti = [];
  return {
    porta,
    wss,
    async cliente() {
      const c = new Client(`ws://127.0.0.1:${porta}/ws`);
      clienti.push(c);
      await c.apertura;
      return c;
    },
    async chiudi() {
      for (const c of clienti) c.ws.terminate();
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => server.close(r));
      stanze.azzera();
    },
  };
}

/** Crea una stanza e fa entrare i giocatori indicati; ritorna { codice, giocatori: [{c, id, token}] }. */
async function stanzaConGiocatori(srv, nomi) {
  const primo = await srv.cliente();
  primo.invia({ tipo: 'creaStanza' });
  const { codice } = await primo.attendi((m) => m.tipo === 'stanzaCreata', 'attesa di stanzaCreata');
  const giocatori = [];
  for (let i = 0; i < nomi.length; i += 1) {
    const c = i === 0 ? primo : await srv.cliente();
    c.invia({ tipo: 'entraStanza', codice, nome: nomi[i] });
    const e = await c.attendi((m) => m.tipo === 'entrato', `ingresso di ${nomi[i]}`);
    giocatori.push({ c, id: e.giocatoreId, token: e.token, nome: nomi[i] });
  }
  return { codice, giocatori };
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (porta, percorso) => new Promise((risolvi, rifiuta) => {
  http.get({ host: '127.0.0.1', port: porta, path: percorso, agent: false }, (res) => {
    let corpo = '';
    res.on('data', (d) => { corpo += d; });
    res.on('end', () => risolvi({ stato: res.statusCode, corpo }));
  }).on('error', rifiuta);
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('dipendenze: il pacchetto "ws" deve essere installato per il gioco in rete', () => {
  assert.ok(WS, 'Manca la dipendenza "ws": esegui `npm install` prima di `npm test`, altrimenti il server parte senza WebSocket');
});

test('avvio: il server parte su una porta libera e risponde a /salute', { skip: SALTA, timeout: 20000 }, async () => {
  const uno = await indice.avvia({ port: 0, host: '127.0.0.1' });
  const due = await indice.avvia({ port: 0, host: '127.0.0.1' });
  try {
    assert.ok(uno.porta > 0 && due.porta > 0 && uno.porta !== due.porta, 'con port: 0 ogni server deve ricevere una porta libera diversa');
    const salute = await get(uno.porta, '/salute');
    assert.equal(salute.stato, 200);
    const corpo = JSON.parse(salute.corpo);
    assert.equal(corpo.ok, true);
    assert.equal(corpo.websocket, true, 'il WebSocket deve essere attivo');
    await assert.rejects(indice.avvia({ port: uno.porta, host: '127.0.0.1' }), (e) => e.code === 'EADDRINUSE',
      'avviare un secondo server su una porta occupata deve fallire con EADDRINUSE');
  } finally {
    for (const x of [uno, due]) { for (const s of x.wss.clients) s.terminate(); await new Promise((r) => x.server.close(r)); }
  }
});

test('creazione stanza: codice a 6 caratteri e link condivisibile, senza entrare nella stanza', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer({ publicUrl: 'https://gioca.example.org/' });
  try {
    const c = await srv.cliente();
    c.invia({ tipo: 'creaStanza', rif: 'r1' });
    const m = await c.attendi((x) => x.tipo === 'stanzaCreata', 'risposta a creaStanza');
    assert.match(m.codice, P.REGEX_CODICE, 'il codice stanza deve avere 6 caratteri maiuscoli/cifre');
    assert.equal(m.link, `https://gioca.example.org/?stanza=${m.codice}`, 'il link deve contenere il codice stanza');
    assert.ok(stanze.trova(m.codice), 'la stanza deve esistere nel registro');
    assert.equal(stanze.trova(m.codice).giocatori.size, 0, 'creare la stanza non fa entrare il creatore');
    const da = c.messaggi.length;
    c.invia({ tipo: 'creaStanza' });
    await c.attendi((x) => x.tipo === 'stanzaCreata', 'seconda stanza', da);
    assert.equal(stanze.tutte().length, 2);
    assert.equal(new Set(stanze.tutte().map((s) => s.codice)).size, 2, 'i codici stanza devono essere unici');
  } finally { await srv.chiudi(); }
});

test('ingresso: fino a 6 giocatori, il settimo viene rifiutato; tutti vedono lo stato aggiornato', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const nomi = ['Anna', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio'];
    const { codice, giocatori } = await stanzaConGiocatori(srv, nomi);
    assert.equal(new Set(giocatori.map((g) => g.id)).size, 6, 'ogni giocatore ha un id diverso');
    giocatori.forEach((g) => {
      assert.match(g.id, P.REGEX_ID);
      assert.match(g.token, P.REGEX_TOKEN, 'il token di sessione deve essere esadecimale di 32 caratteri');
    });
    const entrato = giocatori[0].c.messaggi.find((m) => m.tipo === 'entrato');
    assert.equal(entrato.hostId, giocatori[0].id, 'il primo che entra è l\'host');
    assert.equal(entrato.codice, codice);

    for (const g of giocatori) {
      const st = await g.c.attendi((m) => m.tipo === 'stato' && m.stato.giocatori.length === 6, `${g.nome} deve vedere 6 giocatori`);
      assert.equal(st.stato.fase, 'lobby');
      assert.equal(new Set(st.stato.giocatori.map((x) => x.colore)).size, 6, 'i 6 colori assegnati devono essere diversi');
    }

    const settimo = await srv.cliente();
    settimo.invia({ tipo: 'entraStanza', codice: codice.toLowerCase(), nome: 'Gino', rif: 'x7' });
    const err = await settimo.attendi((m) => m.tipo === 'errore', 'rifiuto del settimo giocatore');
    assert.equal(err.codice, 'STANZA_PIENA', 'Regola: la stanza accetta al massimo 6 giocatori');
    assert.equal(err.rif, 'x7', 'l\'errore deve riportare il "rif" della richiesta');
    assert.equal(stanze.trova(codice).giocatori.size, 6);
    assert.equal(settimo.messaggi.some((m) => m.tipo === 'entrato'), false, 'il settimo non deve ricevere "entrato"');
  } finally { await srv.chiudi(); }
});

test('ingresso: nome duplicato, colore occupato, dati non validi e stanza inesistente', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const { codice } = await stanzaConGiocatori(srv, ['Anna']);
    const c = await srv.cliente();
    const prova = async (extra, codiceAtteso, regola) => {
      const da = c.messaggi.length;
      c.invia({ tipo: 'entraStanza', codice, ...extra });
      const e = await c.attendi((m) => m.tipo === 'errore', regola, da);
      assert.equal(e.codice, codiceAtteso, `${regola}: atteso ${codiceAtteso}, ricevuto ${e.codice}`);
      // Un messaggio valido azzera il conteggio degli errori consecutivi (3 di fila chiudono la connessione).
      const p = c.messaggi.length;
      c.invia({ tipo: 'ping' });
      await c.attendi((m) => m.tipo === 'pong', 'pong dopo un errore', p);
    };
    await prova({ nome: 'Anna' }, 'NOME_OCCUPATO', 'Il nome uguale a un altro giocatore deve essere rifiutato');
    await prova({ nome: ' anna ' }, 'NOME_OCCUPATO', 'Il confronto dei nomi ignora maiuscole e spazi');
    await prova({ nome: 'Bruno', colore: '#D62828' }, 'COLORE_OCCUPATO', 'Il colore del primo giocatore (#d62828) è già preso');
    await prova({ nome: 'Bruno', colore: 'rosso' }, 'COLORE_NON_VALIDO', 'Il colore deve essere #rrggbb');
    await prova({ nome: '' }, 'NOME_NON_VALIDO', 'Il nome non può essere vuoto');
    await prova({ nome: 'x'.repeat(17) }, 'NOME_NON_VALIDO', 'Il nome non può superare 16 caratteri');
    await prova({ codice: 'ZZZZZZ', nome: 'Bruno' }, 'STANZA_INESISTENTE', 'Una stanza che non esiste non accetta giocatori');
    await prova({ codice: 'abc', nome: 'Bruno' }, 'STANZA_INESISTENTE', 'Un codice malformato è come una stanza inesistente');
    assert.equal(stanze.trova(codice).giocatori.size, 1, 'nessun tentativo fallito deve aggiungere giocatori');
    // Dopo gli errori lo stesso socket può ancora entrare con un nome valido.
    c.invia({ tipo: 'entraStanza', codice, nome: 'Bruno', colore: '#1D4ED8' });
    const ok = await c.attendi((m) => m.tipo === 'entrato', 'ingresso valido dopo gli errori');
    assert.equal(ok.codice, codice);
    assert.equal(stanze.trova(codice).giocatori.size, 2);
    // Un socket già in stanza non può entrare o creare di nuovo.
    const da = c.messaggi.length;
    c.invia({ tipo: 'creaStanza' });
    c.invia({ tipo: 'entraStanza', codice, nome: 'Altro' });
    const errori = [await c.attendi((m) => m.tipo === 'errore', 'creaStanza da dentro una stanza', da)];
    assert.equal(errori[0].codice, 'GIA_IN_STANZA', 'Regola: un socket appartiene al massimo a una stanza');
  } finally { await srv.chiudi(); }
});

test('riconnessione: con il token si torna nella partita, con token sbagliati si viene rifiutati', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const { codice, giocatori } = await stanzaConGiocatori(srv, ['Anna', 'Bruno']);
    const [anna, bruno] = giocatori;
    anna.c.invia({ tipo: 'avviaPartita' });
    await bruno.c.attendi((m) => m.tipo === 'stato' && m.stato.fase === 'daLanciare', 'inizio partita');

    // Anna cade: Bruno la vede disconnessa.
    const da = bruno.c.messaggi.length;
    anna.c.ws.terminate();
    const giu = await bruno.c.attendi((m) => m.tipo === 'stato' && m.stato.giocatori.find((g) => g.id === anna.id).connesso === false,
      'Bruno deve vedere Anna disconnessa', da);
    assert.equal(giu.stato.fase, 'daLanciare', 'in partita il giocatore disconnesso resta nella partita');
    await bruno.c.attendi((m) => m.tipo === 'evento' && m.evento.tipo === 'connessione' && m.evento.dati.connesso === false, 'evento di disconnessione', da);

    // Anna torna con un nuovo socket e il suo token.
    const nuovo = await srv.cliente();
    nuovo.invia({ tipo: 'riconnetti', codice, token: anna.token });
    const e = await nuovo.attendi((m) => m.tipo === 'entrato', 'risposta a riconnetti');
    assert.equal(e.giocatoreId, anna.id, 'la riconnessione restituisce lo stesso giocatore');
    assert.equal(e.token, anna.token);
    const st = await nuovo.attendi((m) => m.tipo === 'stato', 'stato dopo la riconnessione');
    assert.equal(st.stato.giocatori.find((g) => g.id === anna.id).connesso, true);
    assert.equal(st.stato.giocatori.length, 2);
    await bruno.c.attendi((m) => m.tipo === 'stato' && m.stato.giocatori.find((g) => g.id === anna.id).connesso === true,
      'Bruno deve vedere Anna di nuovo online', da);

    // Token sbagliato, malformato, stanza inesistente.
    const estraneo = await srv.cliente();
    const prova = async (msg, atteso, regola) => {
      const d = estraneo.messaggi.length;
      estraneo.invia({ tipo: 'riconnetti', ...msg });
      const err = await estraneo.attendi((m) => m.tipo === 'errore', regola, d);
      assert.equal(err.codice, atteso, `${regola}: atteso ${atteso}, ricevuto ${err.codice}`);
    };
    await prova({ codice, token: 'a'.repeat(32) }, 'TOKEN_NON_VALIDO', 'Un token inventato non deve dare accesso');
    await prova({ codice, token: 'corto' }, 'TOKEN_NON_VALIDO', 'Un token malformato va rifiutato');
    await prova({ codice }, 'TOKEN_NON_VALIDO', 'Senza token non ci si riconnette');
    await prova({ codice: 'ZZZZZZ', token: anna.token }, 'STANZA_INESISTENTE', 'La stanza deve esistere');

    // Il token non deve mai comparire nello stato trasmesso a nessuno.
    for (const c of [bruno.c, nuovo]) {
      assert.equal(JSON.stringify(c.messaggi.filter((m) => m.tipo === 'stato' || m.tipo === 'evento')).includes(anna.token), false,
        'Regola: i token di sessione sono segreti e non vanno mai trasmessi agli altri');
    }
  } finally { await srv.chiudi(); }
});

test('riconnessione: un nuovo socket con lo stesso token sostituisce quello vecchio (chiuso con codice 4000)', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const { codice, giocatori } = await stanzaConGiocatori(srv, ['Anna', 'Bruno']);
    const [anna] = giocatori;
    const nuovo = await srv.cliente();
    nuovo.invia({ tipo: 'riconnetti', codice, token: anna.token });
    await nuovo.attendi((m) => m.tipo === 'entrato', 'riconnessione');
    assert.equal(await anna.c.fine, 4000, 'il vecchio socket deve essere chiuso con codice 4000');
    await pausa(100);
    assert.equal(stanze.trova(codice).giocatori.get(anna.id).connesso, true,
      'la chiusura del vecchio socket non deve segnare il giocatore come disconnesso');
  } finally { await srv.chiudi(); }
});

test('messaggi malformati: errori chiari, connessione chiusa dopo 3 errori consecutivi', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const c = await srv.cliente();
    const prova = async (grezzo, atteso, regola, extra = {}) => {
      const d = c.messaggi.length;
      c.invia(grezzo);
      const e = await c.attendi((m) => m.tipo === 'errore', regola, d);
      assert.equal(e.codice, atteso, `${regola}: atteso ${atteso}, ricevuto ${e.codice}`);
      assert.ok(typeof e.messaggio === 'string' && e.messaggio.length > 0, `${regola}: l'errore deve avere un messaggio`);
      for (const [k, v] of Object.entries(extra)) assert.equal(e[k], v, `${regola}: campo ${k}`);
      // Un messaggio valido azzera il conteggio degli errori consecutivi.
      const p = c.messaggi.length;
      c.invia({ tipo: 'ping' });
      await c.attendi((m) => m.tipo === 'pong', 'pong dopo un errore', p);
    };
    await prova('questo non è json', 'MESSAGGIO_NON_VALIDO', 'Testo che non è JSON');
    await prova('[1,2,3]', 'MESSAGGIO_NON_VALIDO', 'JSON che non è un oggetto');
    await prova('{"nome":"x"}', 'MESSAGGIO_NON_VALIDO', 'Oggetto senza "tipo"');
    await prova({ tipo: 'boh', rif: 'r9' }, 'TIPO_SCONOSCIUTO', 'Tipo di messaggio sconosciuto', { rif: 'r9' });
    await prova({ tipo: 'toString' }, 'TIPO_SCONOSCIUTO', 'Un nome del prototipo non è un tipo valido');
    await prova({ tipo: 'azione', azione: { tipo: 'lanciaDadi' } }, 'NON_IN_STANZA', 'Un\'azione senza stanza');
    await prova({ tipo: 'azione' }, 'MESSAGGIO_NON_VALIDO', 'Un\'azione senza il campo "azione"');
    await prova({ tipo: 'avviaPartita' }, 'NON_IN_STANZA', 'Avviare senza essere in una stanza');
    await prova({ tipo: 'esciStanza' }, 'NON_IN_STANZA', 'Uscire senza essere in una stanza');
    await prova({ tipo: 'entraStanza', nome: 'Anna' }, 'MESSAGGIO_NON_VALIDO', 'entraStanza senza codice');
    await prova({ tipo: 'azione', azione: 'lanciaDadi' }, 'MESSAGGIO_NON_VALIDO', 'azione deve essere un oggetto');
    await prova(`{"tipo":"ping","x":"${'a'.repeat(20000)}"}`, 'MESSAGGIO_NON_VALIDO', 'Messaggio oltre i 16 KiB');
    // Frame binario: rifiutato.
    const d = c.messaggi.length;
    c.ws.send(Buffer.from([1, 2, 3]));
    const bin = await c.attendi((m) => m.tipo === 'errore', 'frame binario', d);
    assert.equal(bin.codice, 'MESSAGGIO_NON_VALIDO', 'sono ammessi solo frame di testo JSON');
    c.invia({ tipo: 'ping' });
    await c.attendi((m) => m.tipo === 'pong', 'pong dopo il binario', d);
    // Tre errori consecutivi chiudono la connessione (si aspetta che finisca la finestra anti-flood di 1 s).
    await pausa(1100);
    c.invia('uno'); c.invia('due'); c.invia('tre');
    assert.equal(await c.fine, 1008, 'Regola: dopo 3 messaggi non validi consecutivi il server chiude la connessione (1008)');
  } finally { await srv.chiudi(); }
});

test('messaggi malformati: un frame oltre il limite assoluto chiude la connessione e il server resta in piedi', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const c = await srv.cliente();
    c.invia('x'.repeat(P.LIMITI.FRAME_MAX_BYTE + 10));
    const codice = await c.fine;
    assert.ok([1009, 1006].includes(codice), `un frame troppo grande deve chiudere la connessione (1009), ricevuto ${codice}`);
    const altro = await srv.cliente();
    altro.invia({ tipo: 'ping' });
    await altro.attendi((m) => m.tipo === 'pong', 'il server deve continuare a rispondere agli altri client');
  } finally { await srv.chiudi(); }
});

test('anti-flood: troppi messaggi al secondo vengono scartati con un avviso', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const c = await srv.cliente();
    for (let i = 0; i < 60; i += 1) c.invia({ tipo: 'ping' });
    const e = await c.attendi((m) => m.tipo === 'errore', 'avviso di troppi messaggi');
    assert.equal(e.codice, 'TROPPI_MESSAGGI', 'Regola: oltre 30 messaggi al secondo il server avvisa e scarta');
    await pausa(150);
    assert.ok(c.messaggi.filter((m) => m.tipo === 'pong').length <= P.LIMITI.MESSAGGI_AL_SECONDO_MAX * 2, 'i messaggi in eccesso non vanno elaborati');
  } finally { await srv.chiudi(); }
});

test('trasmissione: avvio, lancio dei dadi e errori — tutti i client ricevono eventi e stato identici', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const { giocatori } = await stanzaConGiocatori(srv, ['Anna', 'Bruno', 'Carla']);
    const [host, secondo] = giocatori;

    // Solo l'host avvia; non basta un giocatore; non si avvia due volte.
    secondo.c.invia({ tipo: 'avviaPartita', rif: 'a1' });
    const nonHost = await secondo.c.attendi((m) => m.tipo === 'errore' && m.rif === 'a1', 'avvio da non-host');
    assert.equal(nonHost.codice, 'NON_HOST', 'Regola: solo chi ha creato la stanza avvia la partita');

    const da = giocatori.map((g) => g.c.messaggi.length);
    host.c.invia({ tipo: 'avviaPartita' });
    for (const g of giocatori) {
      await g.c.attendi((m) => m.tipo === 'stato' && m.stato.fase === 'daLanciare', `${g.nome} deve ricevere lo stato di inizio partita`);
    }
    const dopoAvvio = giocatori.map((g) => g.c.ultimoStato());
    const versione = dopoAvvio[0].versione;
    for (const s of dopoAvvio) {
      assert.equal(JSON.stringify(s), JSON.stringify(dopoAvvio[0]), 'tutti i giocatori devono ricevere lo stesso stato');
      assert.equal('mazzi' in s.stato, false, 'i mazzi non devono arrivare ai client');
      assert.ok(s.stato.giocatori.every((g) => g.denaro === 1500));
    }
    const tipiAvvio = host.c.messaggi.slice(da[0]).map((m) => (m.tipo === 'evento' ? `evento:${m.evento.tipo}` : m.tipo));
    assert.ok(tipiAvvio.indexOf('evento:partitaIniziata') >= 0 && tipiAvvio.indexOf('evento:partitaIniziata') < tipiAvvio.indexOf('stato'),
      'Regola: prima gli eventi, poi lo stato che li riassume');

    // Chi non è di turno viene rifiutato e gli altri non ricevono nulla.
    const diTurnoId = dopoAvvio[0].stato.turno.giocatoreId;
    const diTurno = giocatori.find((g) => g.id === diTurnoId);
    const altro = giocatori.find((g) => g.id !== diTurnoId);
    const spettatore = giocatori.find((g) => g.id !== diTurnoId && g.id !== altro.id);
    const mark = giocatori.map((g) => g.c.messaggi.length);
    altro.c.invia({ tipo: 'azione', rif: 'f1', giocatoreId: diTurnoId, azione: { tipo: 'lanciaDadi' } });
    const rif = await altro.c.attendi((m) => m.tipo === 'errore' && m.rif === 'f1', 'azione fuori turno');
    assert.equal(rif.codice, 'NON_IL_TUO_TURNO', 'Regola: il giocatore è quello del socket, non quello scritto nel messaggio');
    await pausa(150);
    assert.equal(spettatore.c.messaggi.length, mark[giocatori.indexOf(spettatore)], 'un\'azione rifiutata non deve generare messaggi per gli altri');
    assert.equal(diTurno.c.messaggi.length, mark[giocatori.indexOf(diTurno)]);

    // Il giocatore di turno lancia: tutti ricevono evento "dadi" e poi lo stato con versione + 1.
    const m2 = giocatori.map((g) => g.c.messaggi.length);
    diTurno.c.invia({ tipo: 'azione', azione: { tipo: 'lanciaDadi' } });
    for (const g of giocatori) {
      const st = await g.c.attendi((m) => m.tipo === 'stato' && m.versione === versione + 1, `${g.nome} deve ricevere lo stato dopo il lancio`, m2[giocatori.indexOf(g)]);
      assert.ok(Array.isArray(st.stato.dadi) && st.stato.dadi.length === 2, 'lo stato deve contenere i dadi lanciati');
      const msgs = g.c.messaggi.slice(m2[giocatori.indexOf(g)]);
      const iDadi = msgs.findIndex((m) => m.tipo === 'evento' && m.evento.tipo === 'dadi');
      const iStato = msgs.findIndex((m) => m.tipo === 'stato');
      assert.ok(iDadi >= 0 && iDadi < iStato, `${g.nome}: l'evento "dadi" deve arrivare prima dello stato`);
    }
    const finali = giocatori.map((g) => g.c.ultimoStato());
    for (const s of finali) assert.equal(JSON.stringify(s), JSON.stringify(finali[0]), 'dopo il lancio tutti devono avere lo stesso stato');

    // Dopo l'avvio non si entra più, e non si riavvia.
    const tardivo = await srv.cliente();
    tardivo.invia({ tipo: 'entraStanza', codice: dopoAvvio[0].stato.codice, nome: 'Tardi' });
    assert.equal((await tardivo.attendi((m) => m.tipo === 'errore', 'ingresso a partita iniziata')).codice, 'PARTITA_INIZIATA');
    host.c.invia({ tipo: 'avviaPartita' });
    assert.equal((await host.c.attendi((m) => m.tipo === 'errore' && m.codice === 'PARTITA_INIZIATA', 'secondo avvio')).codice, 'PARTITA_INIZIATA');
  } finally { await srv.chiudi(); }
});

test('lobby: la partita non parte con un solo giocatore; uscendo l\'host passa al successivo', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer();
  try {
    const { codice, giocatori } = await stanzaConGiocatori(srv, ['Anna', 'Bruno']);
    const [anna, bruno] = giocatori;
    bruno.c.invia({ tipo: 'esciStanza' });
    await anna.c.attendi((m) => m.tipo === 'stato' && m.stato.giocatori.length === 1, 'Anna deve vedere che Bruno è uscito');
    anna.c.invia({ tipo: 'avviaPartita' });
    assert.equal((await anna.c.attendi((m) => m.tipo === 'errore', 'avvio con un solo giocatore')).codice, 'POCHI_GIOCATORI',
      'Regola: servono almeno 2 giocatori per iniziare');
    const da = anna.c.messaggi.length;
    anna.c.invia({ tipo: 'esciStanza' });
    await anna.c.attendi((m) => m.tipo === 'evento' && m.evento.tipo === 'giocatoreUscito', 'conferma di uscita', da);
    await pausa(100);
    assert.equal(stanze.trova(codice), undefined, 'una stanza svuotata si chiude e il codice torna libero');
  } finally { await srv.chiudi(); }
});
