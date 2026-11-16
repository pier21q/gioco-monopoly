'use strict';

/**
 * tests/sicurezza.test.js
 *
 * Difese del server contro un uso ostile: limiti di connessioni e di stanze
 * per indirizzo, registro pieno che si libera delle stanze vuote, controllo
 * dell'origine e intestazioni X-Forwarded-* considerate solo dietro un proxy
 * fidato, nomi con caratteri invisibili, stanze mai usate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../server/protocollo');
const stanze = require('../server/stanze');
const indice = require('../server/index');
const H = require('./aiuti');

let WS = null;
try { ({ WebSocket: WS } = require('ws')); } catch { WS = null; }
const SALTA = WS ? false : 'dipendenza "ws" non installata (esegui npm install)';

async function avviaServer(opzioni = {}) {
  stanze.azzera();
  const { server, wss } = indice.crea({ random: H.rngDeterministico(42), ...opzioni });
  await new Promise((r, e) => { server.once('error', e); server.listen(0, '127.0.0.1', r); });
  const porta = server.address().port;
  const aperti = [];
  return {
    porta,
    wss,
    /** Apre un socket; risolve con { ws, messaggi } oppure rifiuta con il codice HTTP del rifiuto. */
    apri(intestazioni = {}, origin = undefined) {
      return new Promise((risolvi, rifiuta) => {
        const ws = new WS(`ws://127.0.0.1:${porta}/ws`, { headers: intestazioni, origin });
        aperti.push(ws);
        const messaggi = [];
        ws.on('message', (d) => messaggi.push(JSON.parse(d.toString())));
        ws.once('open', () => risolvi({ ws, messaggi }));
        ws.once('unexpected-response', (req, res) => rifiuta(Object.assign(new Error('rifiutato'), { stato: res.statusCode })));
        ws.on('error', () => {});
      });
    },
    async chiudi() {
      for (const ws of aperti) ws.terminate();
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => server.close(r));
      stanze.azzera();
    },
  };
}

/** Invia creaStanza e attende la risposta (stanzaCreata o errore). */
async function creaStanza(c) {
  const da = c.messaggi.length;
  c.ws.send(JSON.stringify({ tipo: 'creaStanza' }));
  for (let i = 0; i < 200; i += 1) {
    const m = c.messaggi.slice(da).find((x) => x.tipo === 'stanzaCreata' || x.tipo === 'errore');
    if (m) return m;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('nessuna risposta a creaStanza');
}

test('connessioni: oltre il limite per indirizzo il server rifiuta con 429, poi si libera', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer({ maxConnessioniPerIp: 3 });
  try {
    const tre = [await srv.apri(), await srv.apri(), await srv.apri()];
    await assert.rejects(srv.apri(), (e) => e.stato === 429, 'la quarta connessione dallo stesso indirizzo va rifiutata');
    tre[0].ws.close();
    let riaperta = null;
    for (let i = 0; i < 50 && !riaperta; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      riaperta = await srv.apri().catch(() => null);
    }
    assert.ok(riaperta, 'chiusa una connessione, se ne può aprire un\'altra');
  } finally {
    await srv.chiudi();
  }
});

test('connessioni dietro un proxy: inventare indirizzi in X-Forwarded-For non aggira il limite', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer({ proxyFidato: true });
  try {
    // 60 tentativi, ognuno con un indirizzo inventato diverso davanti; l'ultimo
    // (quello che aggiunge il proxy) è sempre lo stesso.
    let aperte = 0;
    let rifiutate = 0;
    for (let i = 0; i < 60; i += 1) {
      try {
        await srv.apri({ 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.50` });
        aperte += 1;
      } catch (e) {
        assert.equal(e.stato, 429);
        rifiutate += 1;
      }
    }
    assert.equal(aperte, P.LIMITI.MAX_CONNESSIONI_PER_IP, 'passano solo le prime 20');
    assert.equal(rifiutate, 60 - P.LIMITI.MAX_CONNESSIONI_PER_IP);
    assert.ok(await srv.apri({ 'X-Forwarded-For': '198.51.100.1, 203.0.113.51' }), 'un altro indirizzo vero passa');
  } finally {
    await srv.chiudi();
  }
});

test('connessioni: oltre il tetto globale il server rifiuta con 503, da qualunque indirizzo', { skip: SALTA, timeout: 20000 }, async () => {
  assert.equal(P.LIMITI.MAX_CONNESSIONI, 600);
  const srv = await avviaServer({ proxyFidato: true, maxConnessioni: 4 });
  try {
    for (let i = 0; i < 4; i += 1) await srv.apri({ 'X-Forwarded-For': `203.0.113.${i}` });
    await assert.rejects(srv.apri({ 'X-Forwarded-For': '203.0.113.99' }), (e) => e.stato === 503);
  } finally {
    await srv.chiudi();
  }
});

test('stanze: al massimo 10 stanze aperte per indirizzo, anche cambiando socket', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const esiti = [];
    for (let s = 0; s < 3; s += 1) {
      const c = await srv.apri();
      for (let k = 0; k < 4; k += 1) esiti.push(await creaStanza(c));
    }
    assert.equal(esiti.filter((m) => m.tipo === 'stanzaCreata').length, P.LIMITI.MAX_STANZE_PER_IP);
    assert.equal(esiti.at(-1).codice, 'TROPPE_STANZE');
  } finally {
    await srv.chiudi();
  }
});

test('registro pieno di stanze vuote: chi arriva ne crea comunque una (si chiude la più vecchia)', { skip: SALTA, timeout: 30000 }, async () => {
  const srv = await avviaServer({ proxyFidato: true });
  try {
    // 20 indirizzi diversi (dietro il proxy) × 10 stanze = il registro pieno.
    for (let ip = 0; ip < P.LIMITI.MAX_STANZE / P.LIMITI.MAX_STANZE_PER_IP; ip += 1) {
      const intestazioni = { 'X-Forwarded-For': `10.0.0.${ip}` };
      const a = await srv.apri(intestazioni);
      const b = await srv.apri(intestazioni);
      for (let k = 0; k < 5; k += 1) assert.equal((await creaStanza(a)).tipo, 'stanzaCreata');
      for (let k = 0; k < 5; k += 1) assert.equal((await creaStanza(b)).tipo, 'stanzaCreata');
      a.ws.close();
      b.ws.close();
    }
    assert.equal(stanze.tutte().length, P.LIMITI.MAX_STANZE);
    const legittimo = await srv.apri({ 'X-Forwarded-For': '192.0.2.7' });
    const m = await creaStanza(legittimo);
    assert.equal(m.tipo, 'stanzaCreata', 'il registro pieno di stanze vuote non blocca chi arriva');
    assert.equal(stanze.tutte().length, P.LIMITI.MAX_STANZE);
  } finally {
    await srv.chiudi();
  }
});

test('registro pieno di stanze con giocatori: liberaPosto non chiude niente', () => {
  stanze.azzera();
  try {
    for (let i = 0; i < 5; i += 1) {
      const s = stanze.crea({ ora: H.ORA_FISSA });
      stanze.entra(s, { nome: 'Anna', ora: H.ORA_FISSA });
    }
    assert.equal(stanze.liberaPosto(), false);
    stanze.crea({ ora: H.ORA_FISSA });
    assert.equal(stanze.liberaPosto(), true, 'una stanza senza giocatori si può chiudere');
    assert.equal(stanze.tutte().length, 5);
  } finally {
    stanze.azzera();
  }
});

test('origine: X-Forwarded-Host conta solo dietro un proxy fidato', { skip: SALTA, timeout: 20000 }, async () => {
  const diretto = await avviaServer({ proxyFidato: false });
  try {
    await assert.rejects(diretto.apri({ 'X-Forwarded-Host': 'cattivo.example' }, 'https://cattivo.example'),
      (e) => e.stato === 403, 'senza proxy l\'intestazione la scrive il client: non vale');
    await assert.rejects(diretto.apri({}, 'https://cattivo.example'), (e) => e.stato === 403);
    assert.ok(await diretto.apri({}, `http://127.0.0.1:${diretto.porta}`), 'la stessa origine passa');
  } finally {
    await diretto.chiudi();
  }
  const dietroProxy = await avviaServer({ proxyFidato: true });
  try {
    assert.ok(await dietroProxy.apri({ 'X-Forwarded-Host': 'gioco.example' }, 'https://gioco.example'),
      'dietro un proxy fidato l\'host pubblico arriva da X-Forwarded-Host');
  } finally {
    await dietroProxy.chiudi();
  }
});

test('indirizzo e link: X-Forwarded-For/Host ignorati senza proxy fidato', () => {
  const req = {
    headers: { host: 'localhost:3000', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-forwarded-host': 'cattivo.example' },
    socket: { remoteAddress: '::ffff:192.168.1.20' },
  };
  assert.equal(indice.ipDi(req, false), '192.168.1.20');
  // Dietro il proxy vale l'ULTIMO indirizzo (l'ha scritto il proxy): quelli
  // davanti li manda il client e li può inventare.
  assert.equal(indice.ipDi(req, true, null), '10.0.0.1');
  // Con un'intestazione dedicata (su Render: CF-Connecting-IP) vale quella.
  const conCf = { ...req, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.7' } };
  assert.equal(indice.ipDi(conCf, true, 'cf-connecting-ip'), '198.51.100.7');
  assert.equal(indice.ipDi(conCf, false, 'cf-connecting-ip'), '192.168.1.20', 'senza proxy fidato non conta nemmeno quella');
  assert.equal(indice.ipDi(req, true, 'cf-connecting-ip'), '10.0.0.1', 'se manca si torna all\'ultimo di X-Forwarded-For');
  assert.equal(indice.baseLink(null, req, 3000, false), 'http://localhost:3000');
  assert.equal(indice.baseLink(null, req, 3000, true), 'http://cattivo.example');
  const salvato = { RENDER: process.env.RENDER, PROXY_FIDATO: process.env.PROXY_FIDATO, PROXY_INTESTAZIONE_IP: process.env.PROXY_INTESTAZIONE_IP };
  try {
    delete process.env.PROXY_FIDATO;
    delete process.env.RENDER;
    delete process.env.PROXY_INTESTAZIONE_IP;
    assert.equal(indice.proxyFidato(), false);
    assert.equal(indice.intestazioneIp(), null);
    process.env.RENDER = 'true';
    assert.equal(indice.proxyFidato(), true, 'su Render il proxy è fidato');
    assert.equal(indice.intestazioneIp(), 'cf-connecting-ip', 'su Render l\'indirizzo vero lo scrive Cloudflare');
    process.env.PROXY_INTESTAZIONE_IP = 'X-Real-IP';
    assert.equal(indice.intestazioneIp(), 'x-real-ip');
    process.env.PROXY_FIDATO = '0';
    assert.equal(indice.proxyFidato(), false, 'PROXY_FIDATO=0 vince');
  } finally {
    for (const [k, v] of Object.entries(salvato)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('nomi: caratteri invisibili tolti, niente doppioni camuffati', () => {
  stanze.azzera();
  try {
    const s = stanze.crea({ ora: H.ORA_FISSA });
    assert.ok(stanze.entra(s, { nome: 'Anna', ora: H.ORA_FISSA }).giocatore);
    for (const finto of ['Anna​', '​Anna', 'An­na', 'ANNA⁠', 'Ánna']) {
      assert.equal(stanze.entra(s, { nome: finto, ora: H.ORA_FISSA }).errore.codice, 'NOME_OCCUPATO', JSON.stringify(finto));
    }
    assert.equal(P.normalizzaNome('‮annA'), 'annA', 'niente inversione del verso del testo');
    assert.equal(P.normalizzaNome('​​'), null, 'un nome fatto solo di invisibili non è un nome');
  } finally {
    stanze.azzera();
  }
});

test('stanze mai usate: chiuse dopo 2 minuti; codici generati con crypto', () => {
  stanze.azzera();
  try {
    const t0 = H.ORA_FISSA();
    const mai = stanze.crea({ ora: () => t0 });
    const usata = stanze.crea({ ora: () => t0 });
    const g = stanze.entra(usata, { nome: 'Anna', ora: () => t0 }).giocatore;
    stanze.esci(usata, g.id, { ora: () => t0 });
    assert.match(mai.codice, P.REGEX_CODICE);
    const dopo = t0 + stanze.TEMPI.STANZA_MAI_USATA_MS + 1000;
    stanze.pulisci({ ora: () => dopo });
    assert.equal(stanze.trova(mai.codice), undefined, 'dopo 2 minuti la stanza mai usata è chiusa');
    const v = stanze.casualeSicuro();
    assert.ok(v >= 0 && v < 1);
  } finally {
    stanze.azzera();
  }
});
