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

test('app.giocaQui: una scheda risponde "sto giocando io" solo se è collegata con quel giocatore', { skip: SALTA }, async () => {
  const app = await C.carica('app.js');
  const stato = { io: { codice: 'K7PQ2M', giocatoreId: 'aaaaaaa1', token: 'x' }, connessione: 'connesso' };
  const domanda = { tipo: 'chi-gioca', codice: 'K7PQ2M', giocatoreId: 'aaaaaaa1' };
  assert.equal(app.giocaQui(stato, null, domanda), true);
  assert.equal(app.giocaQui(stato, 'sostituita', domanda), false, 'una scheda già sostituita non gioca più');
  assert.equal(app.giocaQui({ ...stato, connessione: 'riconnessione' }, null, domanda), false, 'scollegata: la ripresa altrove serve');
  assert.equal(app.giocaQui(stato, null, { ...domanda, giocatoreId: 'bbbbbbb2' }), false, 'un altro giocatore della stessa stanza');
  assert.equal(app.giocaQui(stato, null, { ...domanda, codice: 'ZZZZZZ' }), false);
  assert.equal(app.giocaQui({ io: null, connessione: 'connesso' }, null, domanda), false);
  assert.equal(app.giocaQui(stato, null, null), false);
  assert.equal(app.MESSAGGI_PROTOCOLLO.includes('lasciaAdmin'), true);
  for (const tipo of app.MESSAGGI_PROTOCOLLO) assert.ok(P.MESSAGGI_CLIENT.includes(tipo), `${tipo} esiste anche nel protocollo del server`);
});

test('app.toastPerEvento: nuovo host, abbandono d\'ufficio e scambio scaduto', { skip: SALTA }, async () => {
  const app = await C.carica('app.js');
  const host = { tipo: 'host', giocatoreId: 'b2', testo: 'Bruno è il nuovo host della stanza: Anna ha perso la connessione', dati: { giocatoreId: 'b2', precedenteId: 'a1' } };
  assert.match(app.toastPerEvento(host, null, 'b2').testo, /Ora sei tu l'host/);
  assert.equal(app.toastPerEvento(host, null, 'c3'), null, 'gli altri lo leggono nella cronaca');
  const assente = { tipo: 'abbandono', giocatoreId: 'a1', testo: 'Anna non rientra da troppo tempo ed esce dalla partita', dati: { motivo: 'assente' } };
  assert.equal(app.toastPerEvento(assente, null, 'b2').livello, 'avviso');
  assert.ok(app.toastPerEvento({ ...assente, dati: { motivo: 'debito' } }, null, 'b2'), 'anche il debito non saldato in tempo va spiegato');
  assert.equal(app.toastPerEvento({ tipo: 'abbandono', giocatoreId: 'a1', testo: 'Anna abbandona la partita', dati: {} }, null, 'b2'), null);
  const scaduto = { tipo: 'scambioRifiutato', giocatoreId: null, testo: 'La proposta di scambio di Anna a Bruno è scaduta', dati: { scambio: { daId: 'a1', aId: 'b2' }, daId: null, motivo: 'scaduto' } };
  assert.match(app.toastPerEvento(scaduto, null, 'a1').testo, /scaduta/);
  assert.equal(app.toastPerEvento(scaduto, null, 'c3'), null, 'solo ai due dello scambio');
  const esce = { tipo: 'admin', giocatoreId: null, testo: 'Anna non è più l\'admin della stanza', dati: { giocatoreId: null, precedenteId: 'a1' } };
  assert.equal(app.toastPerEvento(esce, null, 'a1'), null);
});

test('dialoghi: albergo senza 4 case in banca = si vende tutto il gruppo, come fa il motore', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A } = H.ID;
  // Gruppo azzurro (6, 8, 9): due alberghi e 4 case; in banca restano 2 case.
  const base = H.costruito(H.assegna(H.nuovaPartita(2), A, 6, 8, 9), { 6: 5, 8: 5, 9: 4 });
  const povera = motore.statoPubblico(H.modifica(base, (s) => { s.caseDisponibili = 2; }));
  const ricca = motore.statoPubblico(H.modifica(base, (s) => { s.caseDisponibili = 4; }));

  assert.equal(d.venditaInBlocco(ricca, 6), null, 'con 4 case in banca l\'albergo torna a 4 case');
  assert.equal(d.venditaInBlocco(povera, 9), null, 'vendere una casa resta una vendita normale');
  assert.deepEqual(d.venditaInBlocco(povera, 6), { caselle: [6, 8, 9], ricavo: 125 + 125 + 100 });

  // Quello che il client annuncia è quello che il motore fa davvero.
  const prima = H.modifica(base, (s) => { s.caseDisponibili = 2; });
  const dopo = H.esegui(prima, A, { tipo: 'vendiCasa', casella: 6 });
  assert.equal(H.giocatore(dopo.stato, A).denaro - H.giocatore(prima, A).denaro, d.venditaInBlocco(povera, 6).ricavo);
  assert.deepEqual([6, 8, 9].map((i) => dopo.stato.proprieta[String(i)].caseCostruite), [0, 0, 0]);

  // Il piano per saldare un debito lo sa: un passo solo, con il ricavo vero.
  const ipotecato = motore.statoPubblico(H.modifica(prima, (s) => { for (const i of [6, 8, 9]) s.proprieta[String(i)].ipotecata = false; }));
  const piano = d.pianoLiquidazione(ipotecato, A, 300);
  assert.deepEqual(piano.passi[0], { tipo: 'vendiCasa', casella: piano.passi[0].casella, ricavo: 350, gruppo: true });
  assert.equal(piano.copre, true);
  // Eseguendo i passi sul motore si incassa esattamente quanto promesso.
  let stato = prima;
  let incassato = 0;
  for (const passo of piano.passi) {
    const r = H.esegui(stato, A, { tipo: passo.tipo, casella: passo.casella });
    incassato += H.giocatore(r.stato, A).denaro - H.giocatore(stato, A).denaro;
    stato = r.stato;
  }
  assert.equal(incassato, piano.raccolto);
});

test('pannelli.testoEvento: gli eventi nuovi hanno un testo anche senza quello del server', { skip: SALTA }, async () => {
  const pn = await C.carica('pannelli.js');
  const p = { giocatori: [{ id: 'a1', nome: 'Anna' }] };
  assert.match(pn.testoEvento({ tipo: 'scambioRifiutato', giocatoreId: null, dati: { daId: null, motivo: 'scaduto' } }, p), /scaduta/);
  assert.match(pn.testoEvento({ tipo: 'abbandono', giocatoreId: 'a1', dati: { motivo: 'assente' } }, p), /non rientra/);
  assert.match(pn.testoEvento({ tipo: 'abbandono', giocatoreId: 'a1', dati: { motivo: 'debito' } }, p), /debito/);
  // "ha abbandonato" o "bancarotta": dipende da come è uscito.
  const d = await C.carica('dialoghi.js');
  const esce = (motivo) => ({ log: [{ tipo: 'abbandono', giocatoreId: 'a1', dati: motivo ? { motivo } : {} }] });
  assert.equal(d.haAbbandonato(esce(null), 'a1'), true);
  assert.equal(d.haAbbandonato(esce('assente'), 'a1'), true);
  assert.equal(d.haAbbandonato(esce('debito'), 'a1'), false, 'chi non salda un debito in tempo fa bancarotta');
  assert.equal(d.haAbbandonato(esce(null), 'b2'), false);
  assert.match(pn.testoEvento({ tipo: 'host', giocatoreId: 'a1', dati: {} }, p), /nuovo host/);
});

test('tabellone.calcolaPercorso: la pedina fa la strada vera, lancio e poi carta, mai all\'indietro per sbaglio', { skip: SALTA }, async () => {
  const t = await C.carica('tabellone.js');
  const { A } = H.ID;
  const libero = { inPrigione: false };
  const g = { id: A, inPrigione: false };
  const mov = (da, a, passi) => ({ tipo: 'movimento', giocatoreId: A, dati: { da, a, passi } });

  // Un lancio normale: 3 → 8.
  assert.deepEqual(t.calcolaPercorso(3, 8, libero, g, [mov(3, 8, 5)]), [4, 5, 6, 7]);
  // Lancio su Imprevisti (casella 7) e carta "Andate fino al Via": si passa
  // dalla casella della carta e poi si fa tutto il giro IN AVANTI, non 2 passi indietro.
  const viaDopoCarta = t.calcolaPercorso(2, 0, libero, g, [mov(2, 7, 5), mov(7, 0, 33)]);
  assert.deepEqual(viaDopoCarta.slice(0, 6), [3, 4, 5, 6, 7, 8]);
  assert.equal(viaDopoCarta.at(-1), 39);
  assert.equal(viaDopoCarta.length, 5 + 32);
  // "Fate tre passi indietro" dalla casella 7: 7 → 6 → 5 → (4).
  assert.deepEqual(t.calcolaPercorso(5, 4, libero, g, [mov(5, 7, 2), mov(7, 4, -3)]), [6, 7, 6, 5]);
  // I movimenti veri del motore: stessa forma, stesso risultato.
  const s = H.arrivaSu(H.nuovaPartita(2), A, 9, 3, 2);
  assert.deepEqual(t.calcolaPercorso(4, 9, libero, g, s.stato.log), [5, 6, 7, 8]);
  // Senza cronaca (o con una cronaca che non torna) vale la via più corta.
  assert.deepEqual(t.calcolaPercorso(3, 6, libero, g, []), [4, 5]);
  assert.deepEqual(t.calcolaPercorso(3, 6, libero, g, [mov(10, 6, 5)]), [4, 5]);
  assert.deepEqual(t.calcolaPercorso(7, 4, libero, g, undefined), [6, 5]);
  // In prigione si va con un salto.
  assert.deepEqual(t.calcolaPercorso(30, 10, libero, { id: A, inPrigione: true }, []), []);
});

test('dialoghi: asta, rilanci rapidi che offrono subito e proprietà dei giocatori colore per colore', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A, B, C: CARLA } = H.ID;
  assert.deepEqual([...d.RILANCI_RAPIDI], [10, 50, 100]);
  // «+n» offre l'offerta più alta più n, mai il contenuto del campo.
  assert.deepEqual(d.rilancioRapido({ offertaMassima: 0, migliorOfferenteId: null }, 1500, 10, A), { importo: 10, motivo: null });
  assert.deepEqual(d.rilancioRapido({ offertaMassima: 20, migliorOfferenteId: B }, 45, 10, A), { importo: 30, motivo: null });
  assert.match(d.rilancioRapido({ offertaMassima: 20, migliorOfferenteId: B }, 45, 50, A).motivo, /ti mancano 25/);
  assert.equal(d.rilancioRapido({ offertaMassima: 20, migliorOfferenteId: A }, 1500, 10, A).motivo, 'Hai già l’offerta più alta',
    'chi è in testa non rilancia su se stesso con un tocco (doppio clic)');

  // Quello che il pulsante promette è quello che il motore accetta.
  const acquisto = H.modifica(H.nuovaPartita(), (x) => { H.giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; });
  let asta = H.esegui(acquisto, A, { tipo: 'rifiutaAcquisto' }).stato;
  asta = H.esegui(asta, B, { tipo: 'offertaAsta', importo: d.rilancioRapido(asta.asta, 1500, 10, B).importo }).stato;
  const rilancio = d.rilancioRapido(asta.asta, 1500, 50, CARLA);
  assert.equal(rilancio.importo, 60);
  assert.equal(H.esegui(asta, CARLA, { tipo: 'offertaAsta', importo: rilancio.importo }).stato.asta.offertaMassima, 60);

  // Chi ha rinunciato vede perché non può offrire; gli altri hanno via libera.
  const pubblico = motore.statoPubblico(asta);
  assert.match(d.motivoAzione(pubblico, A, 'offertaAsta'), /Hai rinunciato all’acquisto/);
  assert.match(d.motivoAzione(pubblico, A, 'passaAsta'), /Hai rinunciato all’acquisto/);
  assert.equal(d.motivoAzione(pubblico, CARLA, 'offertaAsta'), null);

  // Le proprietà nella finestra dell'asta: un'etichetta per colore, con quante su quante.
  const ricco = motore.statoPubblico(H.ipotecate(H.assegna(H.nuovaPartita(), A, 6, 8, 9, 5, 12), 12));
  const gruppi = d.gruppiPosseduti(ricco, A);
  assert.deepEqual(gruppi.map((g) => [g.possedute, g.totale, g.completo]).sort(), [[1, 2, false], [1, 4, false], [3, 3, true]]);
  const celeste = gruppi.find((g) => g.completo);
  assert.deepEqual(celeste.nomi, [6, 8, 9].map((i) => TAB.casella(i).nome));
  assert.match(gruppi.find((g) => g.totale === 2).nomi[0], /\(ipotecata\)$/);
  assert.deepEqual(d.gruppiPosseduti(ricco, B), []);
});

test('dialoghi: prima di costruire si vede il conto, uguale a quello che fa il motore', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A } = H.ID;
  const base = H.turnoDi(H.assegna(H.nuovaPartita(2), A, 6, 8, 9), A, 'mossa');
  const prima = d.riepilogoCostruzione(motore.statoPubblico(base), A, 8);
  assert.deepEqual([prima.cosa, prima.costo, prima.resta], ['la prima casa', 50, 1450]);
  assert.match(prima.testo, /Costruire la prima casa su .+ costa 50\s€: ti resteranno 1\.450\s€\./);
  const costruita = H.esegui(base, A, { tipo: 'costruisci', casella: 8 });
  assert.equal(H.giocatore(costruita.stato, A).denaro, prima.resta, 'il resto annunciato è quello vero');

  const quattro = H.costruito(base, { 6: 4, 8: 4, 9: 4 });
  const albergo = d.riepilogoCostruzione(motore.statoPubblico(quattro), A, 8);
  assert.equal(albergo.cosa, 'un albergo');
  assert.match(albergo.testo, /Le 4 case tornano alla banca\.$/);
  assert.equal(d.riepilogoCostruzione(motore.statoPubblico(H.costruito(base, { 6: 2, 8: 2, 9: 1 })), A, 9).cosa, 'la seconda casa');
});

test('client: i dadi della carta «società più vicina» li lancia il giocatore, e il client lo dice', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const pn = await C.carica('pannelli.js');
  const app = await C.carica('app.js');
  const { A, B } = H.ID;
  const base = H.modifica(H.assegna(H.nuovaPartita(), B, 28), (x) => {
    x.mazzi.imprevisti = ['I04', ...x.mazzi.imprevisti.filter((id) => id !== 'I04')];
  });
  const pescata = H.arrivaSu(base, A, 22, 1, 2);
  const p = motore.statoPubblico(pescata.stato);
  assert.equal(p.fase, 'lancioAffitto');

  assert.equal(d.motivoAzione(p, A, 'lanciaDadi'), null, 'il pulsante dei dadi è acceso per chi ha pescato');
  assert.match(d.motivoAzione(p, A, 'finisciTurno'), /Prima lancia i dadi per l’affitto/);
  assert.match(d.motivoAzione(p, A, 'costruisci'), /Prima lancia i dadi per l’affitto/);
  assert.match(d.motivoAzione(p, B, 'ipoteca'), /Anna deve prima lanciare i dadi/);
  assert.equal(pn.puoLanciare({ partita: p, io: { giocatoreId: A } }), true, 'anche i dadi sul tabellone si possono toccare');
  assert.equal(pn.puoLanciare({ partita: p, io: { giocatoreId: B } }), false);

  const richiesta = pescata.eventi.find((e) => e.tipo === 'affittoDaLanciare');
  assert.match(pn.testoEvento(richiesta, p), /Anna deve lanciare i dadi: pagherà 10 volte il risultato a Bruno/);
  assert.match(app.toastPerEvento(richiesta, p, A).testo, /Lancia i dadi: pagherai 10 volte il risultato a Bruno/);
  assert.equal(app.toastPerEvento(richiesta, p, B), null);

  const lanciata = H.lancia(pescata.stato, A, 3, 3);
  const dadi = lanciata.eventi.find((e) => e.tipo === 'dadi');
  assert.match(dadi.testo, /per l'affitto della società$/);
  // Senza il testo del server (cronaca ricostruita) il client non scrive «doppio»: per l'affitto non conta.
  assert.equal(pn.testoEvento({ ...dadi, testo: undefined }, p), 'Anna lancia 3 e 3 per l’affitto della società');
  assert.match(pn.testoEvento({ ...richiesta, testo: undefined }, p), /pagherà 10 volte il risultato a Bruno per /);
  const apertura = { tipo: 'astaInizio', giocatoreId: null, dati: { casella: 3, esclusoId: A } };
  assert.match(pn.testoEvento(apertura, p), /Anna ha rinunciato e non partecipa/);
});

test('pannelli.tempoFineTurno: il conto alla rovescia per finire il turno, per tutti', { skip: SALTA }, async () => {
  const pn = await C.carica('pannelli.js');
  const { A, B } = H.ID;
  const p = motore.statoPubblico(H.turnoDi(H.nuovaPartita(2), A, 'mossa'));
  assert.equal(pn.tempoFineTurno(p, A), null, 'senza scadenza dal server niente timer');
  p.scadenza = { traMs: 15000, durataMs: 15000, giocatori: [A], alle: 1000 };
  assert.deepEqual(pn.tempoFineTurno(p, A), { alle: 1000, durataMs: 15000, etichetta: 'Il turno finisce da solo tra' });
  assert.equal(pn.tempoFineTurno(p, B).etichetta, 'Il turno di Anna finisce tra');
  assert.equal(pn.tempoFineTurno({ ...p, fase: 'daLanciare' }, A), null, 'prima di lanciare non c’è');
  assert.ok(pn.tempoFineTurno({ ...p, scambio: { id: 'x' } }, A), 'una proposta di scambio non ferma il turno');
});

test('dialoghi: chiedere tempo per decidere e prendere tempo su una proposta', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A, B } = H.ID;
  const p = motore.statoPubblico(H.turnoDi(H.nuovaPartita(2), A, 'mossa'));
  p.scadenza = { traMs: 15000, durataMs: 15000, giocatori: [A] };
  assert.equal(d.serveTempo(p, A, 'gestione'), true, 'aprire la gestione chiede il minuto');
  assert.equal(d.serveTempo(p, A, 'dettaglioCasella'), true);
  assert.equal(d.serveTempo(p, A, 'scambio', { nuovo: true }), true);
  assert.equal(d.serveTempo(p, A, 'scambio'), false, 'guardare una proposta non conta');
  assert.equal(d.serveTempo(p, A, 'regole'), false);
  assert.equal(d.serveTempo(p, B, 'gestione'), false, 'solo chi è di turno');
  assert.equal(d.serveTempo({ ...p, fase: 'daLanciare' }, A, 'gestione'), false);
  assert.equal(d.serveTempo({ ...p, scadenza: { ...p.scadenza, durataMs: 60000 } }, A, 'gestione'), false, 'già lungo');

  assert.equal(d.formattaSecondi(45), '45 s');
  assert.equal(d.formattaSecondi(90), '1:30');
  assert.equal(d.formattaSecondi(150), '2:30');
  assert.equal(d.motivoTempoScambio({ scadenzaScambio: { durataMs: 90000, massimoMs: 150000 } }), null);
  assert.match(d.motivoTempoScambio({ scadenzaScambio: { durataMs: 150000, massimoMs: 150000 } }), /al massimo 2:30/);
});

test('dialoghi.motivoCostruisci: con «Case per turno» il pulsante si spegne al limite, come nel motore', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A } = H.ID;
  let s = H.soldi(H.assegna(H.nuovaPartita(2, { limiteCostruzioni: 2 }), A, 1, 3, 6, 8, 9), A, 5000);
  s = H.turnoDi(s, A, 'mossa');
  for (const casella of [1, 3, 1]) s = H.esegui(s, A, { tipo: 'costruisci', casella }).stato;
  let p = motore.statoPubblico(s);
  assert.match(d.motivoCostruisci(p, A, 1), /hai già costruito 2 case su Vicolo Corto/);
  assert.equal(d.motivoCostruisci(p, A, 3), null, 'sull\'altro terreno la seconda si può ancora');
  s = H.esegui(s, A, { tipo: 'costruisci', casella: 3 }).stato;
  p = motore.statoPubblico(s);
  assert.match(d.motivoCostruisci(p, A, 3), /hai già costruito 2 case su Vicolo Stretto/);
  H.rifiuta(s, A, { tipo: 'costruisci', casella: 1 }, 'LIMITE_COSTRUZIONI');
  assert.equal(d.motivoCostruisci(p, A, 6), null, 'sugli altri colori si costruisce ancora');
  assert.deepEqual(d.costruzioniDelTurno(p, 1), { fatte: 2, limite: 2 });
  assert.deepEqual(d.costruzioniDelTurnoSulGruppo(p, 'marrone'), { fatte: 4, limite: 4 });
  assert.deepEqual(d.costruzioniDelTurnoSulGruppo(p, 'celeste'), { fatte: 0, limite: 6 });
  assert.equal(d.costruzioniDelTurno({ ...p, regole: { ...p.regole, limiteCostruzioni: 0 } }, 1), null, 'senza la variante niente conto');
  const uno = { ...p, regole: { ...p.regole, limiteCostruzioni: 1 }, turno: { ...p.turno, costruite: { 6: 1 } } };
  assert.match(d.motivoCostruisci(uno, A, 6), /hai già costruito una casa su /);
});

test('dialoghi.scorteBanca: con «Senza tetto» la banca non finisce mai, e il client non spegne i pulsanti', { skip: SALTA }, async () => {
  const d = await C.carica('dialoghi.js');
  const { A } = H.ID;
  const base = (opzioni) => H.modifica(H.turnoDi(H.soldi(H.assegna(H.nuovaPartita(2, opzioni), A, 1, 3), A, 5000), A, 'mossa'),
    (x) => { x.caseDisponibili = 0; x.alberghiDisponibili = 0; });
  const classica = motore.statoPubblico(base());
  assert.deepEqual(d.scorteBanca(classica), { case: 0, alberghi: 0 });
  assert.equal(d.motivoCostruisci(classica, A, 1), 'La banca ha finito le case');
  const libera = motore.statoPubblico(base({ scorteIllimitate: true }));
  assert.deepEqual(d.scorteBanca(libera), { case: Infinity, alberghi: Infinity });
  assert.equal(d.motivoCostruisci(libera, A, 1), null);
  // Albergo da vendere con la banca a zero: con «Senza tetto» torna a 4 case, niente vendita in blocco.
  const alberghi = (opzioni) => motore.statoPubblico(H.modifica(H.costruito(base(opzioni), { 1: 5, 3: 5 }), (x) => { x.caseDisponibili = 0; }));
  assert.ok(d.venditaInBlocco(alberghi(), 1));
  assert.equal(d.venditaInBlocco(alberghi({ scorteIllimitate: true }), 1), null);
});
