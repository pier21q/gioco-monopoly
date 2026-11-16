'use strict';

/**
 * tests/client.test.js
 *
 * Funzioni pure dei moduli del browser, caricate in Node con tests/aiuti-client.js:
 *   - lobby.normalizzaNome fa le stesse pulizie del server;
 *   - dialoghi.motivo* (che spiegano perché un pulsante è spento) danno "via
 *     libera" esattamente quando il motore accetta l'azione, su stati veri di
 *     partite giocate a caso;
 *   - app.toastPerEvento, app.unisciLog, app.formattaEuro;
 *   - rete.attesaBackoff e rete.connetti con un WebSocket finto.
 * La resa grafica (tabellone 3D, animazioni, pannelli) non è coperta: va
 * provata nel browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./aiuti-client');
const H = require('./aiuti');
const motore = require('../server/gioco/motore');
const TAB = require('../server/gioco/tabellone');
const P = require('../server/protocollo');

const SALTA = C.disponibile ? false : 'serve Node 22.15 o successivo (module.registerHooks)';
const ACQUISTABILI = TAB.CASELLE.filter((c) => TAB.acquistabile(c.indice)).map((c) => c.indice);

/** Stati di partite giocate a caso (deterministiche), per i confronti col motore. */
function statiDiPartite(numeroPartite, passiPerPartita) {
  const out = [];
  for (let n = 0; n < numeroPartite; n += 1) {
    const rnd = H.rngDeterministico(1000 + n);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let s = motore.creaPartita({
      codice: 'K7PQ2M',
      hostId: H.ID.A,
      giocatori: H.elencoGiocatori(2 + (n % 3)),
      random: rnd,
      ora: H.ORA_FISSA,
      opzioni: { costruzione: n % 2 ? 'sosta' : 'libera' },
    });
    for (let passo = 0; passo < passiPerPartita && s.fase !== 'finePartita'; passo += 1) {
      const vivi = s.giocatori.filter((g) => !g.fallito).map((g) => g.id);
      let mosso = false;
      for (let k = 0; k < 30 && !mosso; k += 1) {
        const id = pick(vivi);
        const tipi = motore.azioniDisponibili(s, id).filter((t) => t !== 'abbandona' && t !== 'proponiScambio');
        if (!tipi.length) continue;
        const preferite = tipi.filter((t) => ['lanciaDadi', 'compra', 'costruisci', 'finisciTurno', 'offertaAsta', 'passaAsta'].includes(t));
        const tipo = preferite.length && rnd() < 0.8 ? pick(preferite) : pick(tipi);
        const azione = { tipo };
        if (['costruisci', 'vendiCasa', 'ipoteca', 'disipoteca'].includes(tipo)) azione.casella = pick(ACQUISTABILI);
        if (tipo === 'offertaAsta') azione.importo = s.asta.offertaMassima + 1 + Math.floor(rnd() * 80);
        if (tipo === 'accettaScambio' || tipo === 'rifiutaScambio') azione.scambioId = s.scambio.id;
        const e = motore.applicaAzione(s, id, azione, { random: rnd, ora: H.ORA_FISSA });
        if (!e.errore) { s = e.stato; mosso = true; }
      }
      if (!mosso) break;
      if (passo % 7 === 0) out.push(s);
    }
  }
  return out;
}

/**
 * Casi delicati costruiti a mano, che le partite casuali trovano di rado:
 * regola 'sosta' dopo un doppio, banca senza case, gruppi ipotecati.
 */
function statiCostruiti() {
  const { A } = H.ID;
  const out = [];
  const sosta = H.assegna(H.nuovaPartita(2, { costruzione: 'sosta' }), A, 1, 3, 6, 8, 9);
  // Fermo sulle marroni con un doppio, poi ha rilanciato ed è altrove.
  out.push(H.modifica(H.turnoDi(H.inCasella(sosta, A, 7), A, 'mossa'), (s) => { s.turno.soste = ['marrone']; }));
  out.push(H.modifica(H.turnoDi(H.inCasella(sosta, A, 7), A, 'daLanciare'), (s) => { s.turno.soste = ['marrone']; s.turno.doppiConsecutivi = 1; }));
  out.push(H.turnoDi(H.inCasella(sosta, A, 3), A, 'daLanciare'));
  out.push(H.turnoDi(H.inCasella(sosta, A, 3), A, 'mossa'));
  const libera = H.assegna(H.nuovaPartita(2), A, 1, 3, 6, 8, 9);
  out.push(H.modifica(H.turnoDi(libera, A, 'mossa'), (s) => { s.caseDisponibili = 0; }));
  out.push(H.modifica(H.turnoDi(libera, A, 'mossa'), (s) => {
    for (const i of [1, 3]) s.proprieta[i].caseCostruite = 4;
    s.caseDisponibili -= 8;
  }));
  out.push(H.modifica(H.turnoDi(libera, A, 'mossa'), (s) => {
    for (const i of [6, 8, 9]) s.proprieta[i].caseCostruite = 5;
    s.alberghiDisponibili -= 3;
    s.caseDisponibili = 2;
  }));
  out.push(H.modifica(H.turnoDi(libera, A, 'mossa'), (s) => { s.proprieta[8].ipotecata = true; }));
  // Lancio iniziale: all'inizio, dopo un lancio, durante uno spareggio.
  const ordine = H.nuovaPartita(3, { lancioIniziale: true });
  out.push(ordine);
  const dopoUno = H.lancia(ordine, A, 5, 5).stato;
  out.push(dopoUno);
  out.push(H.lancia(H.lancia(dopoUno, H.ID.B, 4, 6).stato, H.ID.C, 1, 1).stato);
  return out;
}

test('lobby.normalizzaNome pulisce i nomi esattamente come il server', { skip: SALTA }, async () => {
  const lobby = await C.carica('lobby.js');
  const prove = ['Anna', '  Anna  ', 'Anna​', '‮annA', 'Bo  b', '​', 'A\tB\nC', 'Ánna', 'é', 'x'.repeat(17), '', 'Zoë 🎲'];
  for (const nome of prove) {
    assert.equal(lobby.normalizzaNome(nome), P.normalizzaNome(nome), `nome ${JSON.stringify(nome)}`);
  }
});

test('dialoghi: i pulsanti sono attivi esattamente quando il motore accetta l\'azione', { skip: SALTA, timeout: 60000 }, async () => {
  const d = await C.carica('dialoghi.js');
  const motivi = { costruisci: d.motivoCostruisci, vendiCasa: d.motivoVendi, ipoteca: d.motivoIpoteca, disipoteca: d.motivoDisipoteca };
  const stati = [...statiDiPartite(24, 400), ...statiCostruiti()];
  assert.ok(stati.length > 300, 'servono abbastanza stati di partita');
  let confronti = 0;
  let costruzioniPossibili = 0;
  for (const s of stati) {
    const pubblico = motore.statoPubblico(s);
    for (const g of s.giocatori) {
      // Azioni senza parametri: stesso elenco del motore.
      for (const tipo of motore.AZIONI) {
        const client = d.motivoAzione(pubblico, g.id, tipo) === null;
        const server = motore.azioniDisponibili(s, g.id).includes(tipo);
        assert.equal(client, server, `${tipo} per ${g.id} in fase ${s.fase}`);
      }
      for (const [tipo, motivo] of Object.entries(motivi)) {
        for (const casella of ACQUISTABILI) {
          const client = motivo(pubblico, g.id, casella);
          const server = motore.applicaAzione(s, g.id, { tipo, casella }, { ora: H.ORA_FISSA });
          confronti += 1;
          if (tipo === 'costruisci' && !server.errore) costruzioniPossibili += 1;
          assert.equal(client === null, !server.errore,
            `${tipo} su ${casella} per ${g.id} (fase ${s.fase}, regola ${s.regole.costruzione}): `
            + `client ${JSON.stringify(client)}, server ${server.errore ? server.errore.codice : 'ok'}`);
        }
      }
    }
  }
  assert.ok(confronti > 10000);
  assert.ok(costruzioniPossibili > 0, 'il confronto deve includere costruzioni ammesse');
});

test('dialoghi: riepilogo e pulizia delle regole usano lo stesso catalogo del server', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const REGOLE = require('../server/gioco/regole');
  assert.deepEqual(d.regoleValide({ parcheggio: true, boh: 1, aste: 'no' }), { ...REGOLE.PREDEFINITE, parcheggio: true },
    'chiavi sconosciute e valori non ammessi vengono scartati');
  const righe = d.riepilogoRegole({ ...REGOLE.PREDEFINITE, proprietaIniziali: 2 });
  assert.equal(righe.length, REGOLE.REGOLE.length);
  assert.deepEqual(righe.filter((r) => r.variante).map((r) => [r.chiave, r.etichetta]), [['proprietaIniziali', '2 a testa']]);
  // In sala d'attesa, finché host o admin non le scelgono, si propongono quelle salvate (qui nessuna: le classiche).
  assert.deepEqual(d.regoleDiPartenza({ fase: 'lobby', regoleImpostate: false, regole: { aste: false } }), REGOLE.PREDEFINITE);
  assert.equal(d.regoleDiPartenza({ fase: 'lobby', regoleImpostate: true, regole: { ...REGOLE.PREDEFINITE, aste: false } }).aste, false);
});

test('dialoghi.righeOrdine: posti provvisori, punteggi e chi deve lanciare nel lancio iniziale', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A, B, C: Ci } = H.ID;
  let s = H.nuovaPartita(3, { lancioIniziale: true });
  s = H.lancia(s, A, 5, 5).stato;
  s = H.lancia(s, B, 4, 6).stato;
  s = H.lancia(s, Ci, 1, 1).stato; // Anna e Bruno pari a 10, Carla terza
  s = H.lancia(s, A, 1, 2).stato; // spareggio: Anna 3, tocca a Bruno
  const righe = d.righeOrdine(motore.statoPubblico(s));
  assert.deepEqual(righe.map((r) => [r.id, r.posto, r.lanci, r.stato]), [
    [A, '1–2°', [10, 3], 'lanciato'],
    [B, '1–2°', [10], 'tocca'],
    [Ci, '3°', [2], 'deciso'],
  ]);
  const inizio = d.righeOrdine(motore.statoPubblico(H.nuovaPartita(3, { lancioIniziale: true })));
  assert.deepEqual(inizio.map((r) => r.posto), ['', '', ''], 'prima dei lanci nessuno ha un posto');
  assert.deepEqual(d.righeOrdine(motore.statoPubblico(H.nuovaPartita(2))), [], 'fuori dal lancio iniziale non ci sono righe');
});

test('app.toastPerEvento: il preavviso d\'inattività arriva solo a chi deve agire', { skip: SALTA }, async () => {
  const app = await C.carica('app.js');
  const ev = { tipo: 'avvisoInattivita', giocatoreId: null, testo: 'Anna: ancora 30 secondi', dati: { giocatori: ['a1'], secondi: 30, debito: false } };
  const mio = app.toastPerEvento(ev, null, 'a1');
  assert.equal(mio.livello, 'errore');
  assert.match(mio.testo, /30 secondi/);
  assert.equal(app.toastPerEvento(ev, null, 'b2'), null, 'gli altri non ricevono il toast');
  const debito = app.toastPerEvento({ ...ev, dati: { ...ev.dati, debito: true } }, null, 'a1');
  assert.match(debito.testo, /bancarotta/);
  const saltato = { tipo: 'turnoSaltato', giocatoreId: 'a1', testo: 'Anna non ha giocato in tempo', dati: { motivo: 'inattivo' } };
  assert.ok(app.toastPerEvento(saltato, null, 'a1'));
  assert.equal(app.toastPerEvento({ ...saltato, dati: { motivo: 'disconnesso' } }, null, 'a1'), null);
});

test('app.chiaveAdminDaFrammento legge solo un #admin= valido', { skip: SALTA }, async () => {
  const app = await C.carica('app.js');
  assert.equal(app.chiaveAdminDaFrammento('#admin=abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.equal(app.chiaveAdminDaFrammento('#admin=ab%2Bcd%2Fefghijklmnop'), 'ab+cd/efghijklmnop', 'la chiave base64 di Render si decodifica');
  assert.equal(app.chiaveAdminDaFrammento('#admin=corta'), null);
  assert.equal(app.chiaveAdminDaFrammento('#stanza=K7PQ2M'), null);
  assert.equal(app.chiaveAdminDaFrammento(''), null);
  assert.equal(app.chiaveAdminDaFrammento('#admin=<script>alert(1)</script>xx'), null);
});

test('app.unisciLog ricuce il log accorciato senza doppioni; formattaEuro', { skip: SALTA }, async () => {
  const app = await C.carica('app.js');
  const ev = (t, testo) => ({ t, tipo: 'x', giocatoreId: null, testo, dati: {} });
  const prima = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c')];
  const dopo = [ev(2, 'b'), ev(3, 'c'), ev(4, 'd')];
  assert.deepEqual(app.unisciLog(prima, dopo).map((e) => e.testo), ['a', 'b', 'c', 'd']);
  assert.deepEqual(app.unisciLog([], dopo).map((e) => e.testo), ['b', 'c', 'd']);
  assert.equal(app.formattaEuro(1500), '1.500 €');
  assert.equal(app.formattaEuro(-20), '−20 €');
  assert.equal(app.vistaPer({ fase: 'finePartita' }), 'fine');
});

/** WebSocket finto: registra i messaggi inviati e si apre/chiude a comando. */
function wsFinto() {
  const istanze = [];
  class Finto {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.inviati = [];
      this.ascoltatori = {};
      istanze.push(this);
    }

    addEventListener(tipo, fn) { (this.ascoltatori[tipo] ||= []).push(fn); }

    emetti(tipo, ev = {}) { for (const fn of this.ascoltatori[tipo] || []) fn(ev); }

    apri() { this.readyState = 1; this.emetti('open'); }

    send(testo) { this.inviati.push(JSON.parse(testo)); }

    close(code = 1000) { this.readyState = 3; this.emetti('close', { code }); }
  }
  Finto.OPEN = 1;
  return { Finto, istanze };
}

test('rete: backoff limitato; coda inviata dopo onApertura; niente riconnessione dopo 4001', { skip: SALTA }, async () => {
  const rete = await C.carica('rete.js');
  assert.equal(rete.attesaBackoff(1, () => 0.5), 1000);
  assert.equal(rete.attesaBackoff(30, () => 0.5), 30000, 'il backoff non supera i 30 secondi');
  assert.ok(rete.attesaBackoff(1, () => 1) <= 1200 && rete.attesaBackoff(1, () => 0) >= 800, 'jitter ±20%');

  const { Finto, istanze } = wsFinto();
  const ordine = [];
  const conn = rete.connetti('ws://prova/ws', {
    onApertura: () => { ordine.push('apertura'); conn.invia({ tipo: 'riconnetti' }); },
  }, { WebSocket: Finto, casuale: () => 0.5 });
  assert.equal(conn.invia({ tipo: 'creaStanza' }), false, 'offline: in coda');
  assert.equal(conn.invia({ tipo: 'azione' }, { accoda: false }), false, 'le azioni di gioco non vanno in coda');
  assert.equal(conn.inCoda(), 1);
  istanze[0].apri();
  assert.deepEqual(istanze[0].inviati.map((m) => m.tipo), ['riconnetti', 'creaStanza'], 'prima riconnetti, poi la coda');
  assert.deepEqual(ordine, ['apertura']);

  istanze[0].close(4001);
  assert.equal(conn.stato(), 'chiuso', 'sostituito da un\'altra scheda: non riprova da solo');
  assert.equal(istanze.length, 1);
  conn.riprovaOra();
  assert.equal(istanze.length, 2, 'su richiesta dell\'utente riprova');
  conn.chiudi();
});

test('testi: "ad Anna", "alla banca"; niente messaggi doppi per carte e aste', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  assert.equal(d.aChi('Anna'), 'ad Anna');
  assert.equal(d.aChi('Bruno'), 'a Bruno');
  assert.equal(d.aChi('la banca'), 'alla banca');
  const N = require('../server/gioco/nucleo');
  assert.equal(N.aChi('Anna'), 'ad Anna');
  assert.equal(N.aChi('la banca'), 'alla banca');

  const app = await C.carica('app.js');
  const carta = { tipo: 'carta', giocatoreId: 'a1', testo: 'Andate in prigione', dati: { carta: { testo: 'Andate in prigione' } } };
  assert.equal(app.toastPerEvento(carta, null, 'a1'), null, 'la carta si vede già sul tabellone');
  const all = { tipo: 'acquisto', giocatoreId: 'a1', testo: 'Anna compra X all\'asta', dati: { tramite: 'asta' } };
  assert.equal(app.toastPerEvento(all, null, 'a1'), null, 'lo dice già "Asta chiusa"');
  const banca = { tipo: 'acquisto', giocatoreId: 'a1', testo: 'Anna compra X', dati: { tramite: 'banca' } };
  assert.equal(app.toastPerEvento(banca, null, 'a1').testo, 'Anna compra X');
});
