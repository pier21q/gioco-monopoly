'use strict';

/**
 * tests/admin.test.js
 *
 * Link da admin (ADMIN_CHIAVE): chi si autentica diventa admin e host in
 * qualunque stanza in cui entra, anche creata da altri; può togliere un
 * giocatore (in lobby esce, in partita fa bancarotta e non rientra) e chiudere
 * la stanza. Gli altri continuano a creare stanze come sempre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../server/protocollo');
const stanze = require('../server/stanze');
const indice = require('../server/index');
const H = require('./aiuti');

let WS = null;
try { ({ WebSocket: WS } = require('ws')); } catch { WS = null; }
const SALTA = WS ? false : 'dipendenza "ws" non installata (esegui npm install)';
const CHIAVE = 'chiave-di-prova-ABCDEFGH12345678';

async function avviaServer() {
  stanze.azzera();
  const { server, wss } = indice.crea({ random: H.rngDeterministico(42), chiaveAdmin: CHIAVE });
  await new Promise((r, e) => { server.once('error', e); server.listen(0, '127.0.0.1', r); });
  const porta = server.address().port;
  const aperti = [];
  return {
    async cliente() {
      const ws = new WS(`ws://127.0.0.1:${porta}/ws`);
      aperti.push(ws);
      const c = { ws, messaggi: [], chiusura: null };
      ws.on('message', (d) => c.messaggi.push(JSON.parse(d.toString())));
      c.fine = new Promise((r) => ws.on('close', (codice) => { c.chiusura = codice; r(codice); }));
      c.invia = (m) => ws.send(JSON.stringify(m));
      c.attendi = async (pred, cosa, da = 0) => {
        for (let i = 0; i < 400; i += 1) {
          const m = c.messaggi.slice(da).find(pred);
          if (m) return m;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`Timeout: ${cosa} (${c.messaggi.map((x) => x.tipo + (x.codice ? `:${x.codice}` : '')).join(', ')})`);
      };
      await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });
      return c;
    },
    async chiudi() {
      for (const ws of aperti) ws.terminate();
      for (const s of wss.clients) s.terminate();
      await new Promise((r) => server.close(r));
      stanze.azzera();
    },
  };
}

async function entra(c, codice, nome) {
  const da = c.messaggi.length;
  c.invia({ tipo: 'entraStanza', codice, nome });
  return c.attendi((m) => m.tipo === 'entrato' || m.tipo === 'errore', `ingresso di ${nome}`, da);
}

const ultimoStato = (c) => [...c.messaggi].reverse().find((m) => m.tipo === 'stato').stato;

test('admin: chiave sbagliata rifiutata; con quella giusta si diventa admin e host nella stanza di un amico', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const amico = await srv.cliente();
    amico.invia({ tipo: 'creaStanza' });
    const { codice } = await amico.attendi((m) => m.tipo === 'stanzaCreata', 'stanza dell\'amico');
    const bruno = await entra(amico, codice, 'Bruno');
    assert.equal(ultimoStato(amico).hostId, bruno.giocatoreId, 'chi crea la stanza ne è l\'host');

    const io = await srv.cliente();
    io.invia({ tipo: 'autenticaAdmin', chiave: 'sbagliata-sbagliata-123' });
    assert.equal((await io.attendi((m) => m.tipo === 'errore', 'rifiuto')).codice, 'ADMIN_NON_VALIDO');
    io.invia({ tipo: 'chiudiStanza' });
    assert.equal((await io.attendi((m) => m.codice === 'NON_IN_STANZA', 'fuori stanza')).codice, 'NON_IN_STANZA');

    io.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    await io.attendi((m) => m.tipo === 'admin' && m.ok, 'conferma admin');
    const pier = await entra(io, codice, 'Pier');
    await amico.attendi((m) => m.tipo === 'stato' && m.stato.adminId === pier.giocatoreId, 'stato con l\'admin');
    const da = amico.messaggi.length;
    const stato = ultimoStato(amico);
    assert.equal(stato.adminId, pier.giocatoreId);
    assert.equal(stato.hostId, pier.giocatoreId, 'l\'admin diventa host anche se la stanza l\'ha creata un altro');

    // L'amico non ha i comandi admin.
    amico.invia({ tipo: 'chiudiStanza' });
    assert.equal((await amico.attendi((m) => m.codice === 'NON_ADMIN', 'chiudi rifiutato', da)).codice, 'NON_ADMIN');
    amico.invia({ tipo: 'cacciaGiocatore', giocatoreId: pier.giocatoreId });
    await amico.attendi((m, i) => m.codice === 'NON_ADMIN' && amico.messaggi.filter((x) => x.codice === 'NON_ADMIN').length === 2, 'caccia rifiutato', da);
    assert.equal(stanze.trova(codice).giocatori.size, 2);
  } finally {
    await srv.chiudi();
  }
});

test('admin: togliere un giocatore in lobby lo chiude fuori con il codice 4003', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const io = await srv.cliente();
    io.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    io.invia({ tipo: 'creaStanza' });
    const { codice } = await io.attendi((m) => m.tipo === 'stanzaCreata', 'stanza');
    await entra(io, codice, 'Pier');
    const disturbo = await srv.cliente();
    const intruso = await entra(disturbo, codice, 'Intruso');

    io.invia({ tipo: 'cacciaGiocatore', giocatoreId: io.messaggi.find((m) => m.tipo === 'entrato').giocatoreId });
    assert.equal((await io.attendi((m) => m.tipo === 'errore', 'non si toglie se stessi')).codice, 'GIOCATORE_NON_VALIDO');

    io.invia({ tipo: 'cacciaGiocatore', giocatoreId: intruso.giocatoreId });
    assert.equal(await disturbo.fine, P.CHIUSURE.CACCIATO);
    assert.ok(disturbo.messaggi.some((m) => m.codice === 'CACCIATO'), 'chi viene tolto riceve la spiegazione');
    const stanza = stanze.trova(codice);
    assert.equal(stanza.giocatori.size, 1);
    assert.equal(stanza.giocatori.has(intruso.giocatoreId), false);
  } finally {
    await srv.chiudi();
  }
});

test('admin: in partita il giocatore tolto fa bancarotta e non può rientrare; l\'admin resta admin dopo un ricaricamento', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const io = await srv.cliente();
    io.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    io.invia({ tipo: 'creaStanza' });
    const { codice } = await io.attendi((m) => m.tipo === 'stanzaCreata', 'stanza');
    const pier = await entra(io, codice, 'Pier');
    const altri = [await srv.cliente(), await srv.cliente()];
    const anna = await entra(altri[0], codice, 'Anna');
    await entra(altri[1], codice, 'Bruno');
    io.invia({ tipo: 'avviaPartita', regole: {} });
    await io.attendi((m) => m.tipo === 'stato' && m.stato.fase !== 'lobby', 'partita avviata');

    io.invia({ tipo: 'cacciaGiocatore', giocatoreId: anna.giocatoreId });
    assert.equal(await altri[0].fine, P.CHIUSURE.CACCIATO);
    const stanza = stanze.trova(codice);
    const statoAnna = stanza.stato.giocatori.find((g) => g.id === anna.giocatoreId);
    assert.equal(statoAnna.fallito, true, 'in partita chi viene tolto esce come per un abbandono');
    assert.equal(stanze.riconnetti(codice, anna.token, null).errore.codice, 'TOKEN_NON_VALIDO', 'il vecchio token non vale più');
    assert.equal(stanza.stato.fase === 'finePartita', false, 'restano due giocatori: si continua');

    // Ricaricamento della pagina dell'admin: nuova connessione, chiave, riconnetti.
    io.ws.terminate();
    const di = await srv.cliente();
    di.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    di.invia({ tipo: 'riconnetti', codice, token: pier.token });
    await di.attendi((m) => m.tipo === 'stato', 'stato dopo il rientro');
    assert.equal(stanza.adminId, pier.giocatoreId);

    di.invia({ tipo: 'chiudiStanza' });
    assert.equal(await altri[1].fine, P.CHIUSURE.STANZA_CHIUSA);
    assert.ok(altri[1].messaggi.some((m) => m.codice === 'STANZA_INESISTENTE' && /admin/.test(m.messaggio)));
    assert.equal(stanze.trova(codice), undefined, 'la stanza non esiste più');
  } finally {
    await srv.chiudi();
  }
});

test('admin: senza limiti di stanze per connessione; senza chiave configurata nessuno è admin', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const io = await srv.cliente();
    io.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    for (let i = 0; i < P.LIMITI.MAX_STANZE_PER_SOCKET + 2; i += 1) io.invia({ tipo: 'creaStanza' });
    await io.attendi((m) => m.tipo === 'stanzaCreata' && io.messaggi.filter((x) => x.tipo === 'stanzaCreata').length === P.LIMITI.MAX_STANZE_PER_SOCKET + 2, 'tutte le stanze');
    assert.equal(io.messaggi.some((m) => m.codice === 'TROPPE_STANZE'), false);
  } finally {
    await srv.chiudi();
  }
  assert.equal(indice.chiaveAdminValida(CHIAVE, null), false);
  assert.equal(indice.chiaveAdminValida(CHIAVE, 'corta'), false, 'una chiave configurata troppo corta non vale');
  assert.equal(indice.chiaveAdminValida(CHIAVE, CHIAVE), true);
  assert.equal(indice.chiaveAdminValida(`${CHIAVE}x`, CHIAVE), false);
});

test('admin: in locale la chiave si genera una volta sola, con permessi 600', () => {
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-admin-'));
  const salvata = process.env.ADMIN_CHIAVE;
  delete process.env.ADMIN_CHIAVE;
  try {
    const prima = indice.chiaveAdminLocale(cartella);
    assert.match(prima, P.REGEX_CHIAVE_ADMIN);
    assert.equal(indice.chiaveAdminLocale(cartella), prima, 'al riavvio la chiave resta la stessa');
    assert.equal(fs.statSync(path.join(cartella, 'chiave-admin')).mode & 0o777, 0o600);
  } finally {
    if (salvata === undefined) delete process.env.ADMIN_CHIAVE;
    else process.env.ADMIN_CHIAVE = salvata;
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});

test('host: anche senza admin chi guida la stanza toglie giocatori e la chiude; gli altri no', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const host = await srv.cliente();
    host.invia({ tipo: 'creaStanza' });
    const { codice } = await host.attendi((m) => m.tipo === 'stanzaCreata', 'stanza');
    const anna = await entra(host, codice, 'Anna');
    const altri = [await srv.cliente(), await srv.cliente()];
    const bruno = await entra(altri[0], codice, 'Bruno');
    await entra(altri[1], codice, 'Carla');

    altri[0].invia({ tipo: 'cacciaGiocatore', giocatoreId: anna.giocatoreId });
    assert.equal((await altri[0].attendi((m) => m.tipo === 'errore', 'non host')).codice, 'NON_ADMIN');
    altri[0].invia({ tipo: 'chiudiStanza' });
    await altri[0].attendi((m) => altri[0].messaggi.filter((x) => x.codice === 'NON_ADMIN').length === 2, 'chiudi rifiutato');

    host.invia({ tipo: 'cacciaGiocatore', giocatoreId: bruno.giocatoreId });
    assert.equal(await altri[0].fine, P.CHIUSURE.CACCIATO, 'l\'host toglie un giocatore');
    host.invia({ tipo: 'chiudiStanza' });
    assert.equal(await altri[1].fine, P.CHIUSURE.STANZA_CHIUSA, 'l\'host chiude la stanza');
    assert.ok(altri[1].messaggi.some((m) => m.codice === 'STANZA_INESISTENTE' && /host/.test(m.messaggio)));
  } finally {
    await srv.chiudi();
  }
});

test('host: l\'admin non si può togliere; in partita, se l\'host fa bancarotta il ruolo passa al successivo', () => {
  stanze.azzera();
  try {
    const ora = H.ORA_FISSA;
    const s = stanze.crea({ ora });
    const ids = ['Anna', 'Bruno', 'Carla'].map((nome) => stanze.entra(s, { nome, ora }).giocatore.id);
    const [anna, bruno, carla] = ids;
    stanze.rendiAdmin(s, carla, { ora });
    assert.equal(s.hostId, carla, 'entrando, l\'admin diventa host');
    assert.equal(stanze.caccia(s, carla, carla).errore.codice, 'GIOCATORE_NON_VALIDO');
    s.hostId = anna; // l'admin non è più host (caso limite): resta comunque intoccabile
    assert.equal(stanze.caccia(s, anna, carla).errore.codice, 'NON_ADMIN');

    // Senza admin: Anna host, la partita parte, Anna abbandona → host a chi resta.
    s.adminId = null;
    stanze.avvia(s, anna, { ora, random: H.rngDeterministico(5), regole: {} });
    stanze.applica(s, anna, { tipo: 'abbandona' }, { ora, random: H.rngDeterministico(6) });
    assert.notEqual(s.hostId, anna);
    assert.ok([bruno, carla].includes(s.hostId));
    assert.equal(s.stato.hostId, s.hostId, 'lo stato inviato ai client conosce il nuovo host');
    assert.equal(stanze.puoComandare(s, s.hostId), true);
    assert.equal(stanze.puoComandare(s, anna), false);
  } finally {
    stanze.azzera();
  }
});

test('admin: resta il primo che entra con la chiave; può cedere il ruolo a un altro giocatore', () => {
  stanze.azzera();
  try {
    const ora = H.ORA_FISSA;
    const s = stanze.crea({ ora });
    const [anna, bruno, carla] = ['Anna', 'Bruno', 'Carla'].map((nome) => stanze.entra(s, { nome, ora }).giocatore.id);

    assert.equal(stanze.rendiAdmin(s, anna, { ora }).length, 1, 'il primo con la chiave diventa admin');
    assert.deepEqual(stanze.rendiAdmin(s, bruno, { ora }), [], 'il secondo con la chiave non ruba il ruolo');
    assert.equal(s.adminId, anna);
    assert.equal(s.hostId, anna);

    // Solo l'admin cede, e solo a un altro giocatore della stanza.
    assert.equal(stanze.cediAdmin(s, bruno, carla, { ora }).errore.codice, 'NON_ADMIN');
    assert.equal(stanze.cediAdmin(s, anna, anna, { ora }).errore.codice, 'GIOCATORE_NON_VALIDO');
    assert.equal(stanze.cediAdmin(s, anna, 'inesistente', { ora }).errore.codice, 'GIOCATORE_NON_VALIDO');
    const ceduto = stanze.cediAdmin(s, anna, carla, { ora });
    assert.equal(ceduto.eventi[0].tipo, 'admin');
    assert.match(ceduto.eventi[0].testo, /Anna cede l'admin a Carla/);
    assert.equal(s.adminId, carla);
    assert.equal(s.hostId, carla, 'chi riceve l\'admin diventa anche host');
    assert.deepEqual(stanze.rendiAdmin(s, anna, { ora }), [], 'chi ha ceduto non lo riprende con la chiave');

    // In partita: lo stato inviato ai client conosce il nuovo host, e non si cede a chi è fuori.
    stanze.avvia(s, carla, { ora, random: H.rngDeterministico(5), regole: {} });
    stanze.applica(s, bruno, { tipo: 'abbandona' }, { ora, random: H.rngDeterministico(6) });
    assert.equal(stanze.cediAdmin(s, carla, bruno, { ora }).errore.codice, 'GIOCATORE_NON_VALIDO');
    stanze.cediAdmin(s, carla, anna, { ora });
    assert.equal(s.adminId, anna);
    assert.equal(s.stato.hostId, anna);

    // Se l'admin esce dalla sala d'attesa, il prossimo con la chiave torna admin.
    const s2 = stanze.crea({ ora });
    const [x, y] = ['Xena', 'Yuri'].map((nome) => stanze.entra(s2, { nome, ora }).giocatore.id);
    stanze.rendiAdmin(s2, x, { ora });
    stanze.esci(s2, x, { ora });
    assert.equal(stanze.rendiAdmin(s2, y, { ora }).length, 1);
    assert.equal(s2.adminId, y);
  } finally {
    stanze.azzera();
  }
});

test('protocollo: cediAdmin vuole un giocatoreId valido', () => {
  assert.deepEqual(P.analizza(JSON.stringify({ tipo: 'cediAdmin', giocatoreId: 'g8ewr39d' })),
    { ok: true, messaggio: { tipo: 'cediAdmin', giocatoreId: 'g8ewr39d' } });
  assert.equal(P.analizza(JSON.stringify({ tipo: 'cediAdmin' })).ok, false);
});

test('admin: chi viene tolto in partita non "perde la connessione": la cronaca dice chi l\'ha tolto', () => {
  stanze.azzera();
  try {
    const ora = H.ORA_FISSA;
    const s = stanze.crea({ ora });
    const [anna, bruno] = ['Anna', 'Bruno', 'Carla'].map((nome) => stanze.entra(s, { nome, ora }).giocatore.id);
    stanze.rendiAdmin(s, anna, { ora });
    stanze.avvia(s, anna, { ora, random: H.rngDeterministico(5), regole: {} });
    const esito = stanze.caccia(s, anna, bruno, { ora, random: H.rngDeterministico(6) });
    const testi = esito.eventi.map((e) => e.testo);
    assert.ok(testi.includes('L\'admin toglie Bruno dalla partita'));
    assert.ok(!testi.some((t) => /perso la connessione/.test(t)));
    assert.ok(s.stato.log.some((e) => e.testo === 'L\'admin toglie Bruno dalla partita'), 'resta nella cronaca');
    assert.ok(!s.stato.log.some((e) => /perso la connessione/.test(e.testo)), 'neanche nella cronaca');
    assert.ok(!testi.some((t) => /fa bancarotta/.test(t)), 'chi è tolto non "fa bancarotta"');
  } finally {
    stanze.azzera();
  }
});

test('admin: "Esci da admin" toglie il ruolo alla connessione e alla stanza; chi esce resta host', { skip: SALTA, timeout: 20000 }, async () => {
  const srv = await avviaServer();
  try {
    const anna = await srv.cliente();
    anna.invia({ tipo: 'autenticaAdmin', chiave: CHIAVE });
    const conferma = await anna.attendi((m) => m.tipo === 'admin', 'conferma admin');
    assert.equal(conferma.ok, true);
    assert.equal(typeof conferma.indirizzo, 'string', 'all\'admin il server dice da che indirizzo lo vede arrivare');
    anna.invia({ tipo: 'creaStanza' });
    const creata = await anna.attendi((m) => m.tipo === 'stanzaCreata', 'stanza creata');
    anna.invia({ tipo: 'entraStanza', codice: creata.codice, nome: 'Anna' });
    const io = await anna.attendi((m) => m.tipo === 'entrato', 'ingresso');
    const stanza = stanze.trova(creata.codice);
    assert.equal(stanza.adminId, io.giocatoreId);

    const da = anna.messaggi.length;
    anna.invia({ tipo: 'lasciaAdmin', rif: 'x1' });
    const uscita = await anna.attendi((m) => m.tipo === 'admin', 'conferma di uscita', da);
    assert.deepEqual(uscita, { tipo: 'admin', ok: false, rif: 'x1' });
    const stato = await anna.attendi((m) => m.tipo === 'stato' && m.stato.adminId === null, 'stato senza admin', da);
    assert.equal(stato.stato.hostId, io.giocatoreId, 'resta host, come chi crea una stanza normale');
    assert.equal(stanza.adminId, null);
    const evento = stanza.stato.log.at(-1);
    assert.equal(evento.tipo, 'admin');
    assert.deepEqual(evento.dati, { giocatoreId: null, precedenteId: io.giocatoreId });

    // La connessione non è più admin: in un'altra stanza entra come giocatore qualunque.
    anna.invia({ tipo: 'esciStanza' });
    const altra = stanze.crea({});
    stanze.entra(altra, { nome: 'Bruno' });
    const prima = anna.messaggi.length;
    anna.invia({ tipo: 'entraStanza', codice: altra.codice, nome: 'Anna' });
    await anna.attendi((m) => m.tipo === 'entrato', 'ingresso nella seconda stanza', prima);
    assert.equal(altra.adminId, null);
    assert.notEqual(altra.hostId, null);

    // Chi non è admin e manda lasciaAdmin non cambia niente.
    assert.deepEqual(stanze.lasciaAdmin(altra, altra.hostId), []);
    assert.equal(P.analizza(JSON.stringify({ tipo: 'lasciaAdmin' })).ok, true);
  } finally {
    await srv.chiudi();
  }
});
