'use strict';

/**
 * tests/fondamenta.test.js
 *
 * Test di fumo della fase 1: i moduli si caricano, le firme esistono, il
 * motore crea stati conformi a INTERFACCE.md e rifiuta le azioni sbagliate,
 * il protocollo valida i messaggi, le stanze gestiscono lobby e riconnessione,
 * il server HTTP risponde senza bisogno della cartella client/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const P = require('../server/protocollo');
const motore = require('../server/gioco/motore');
const scambi = require('../server/gioco/scambi');
const bancarotta = require('../server/gioco/bancarotta');
const stanze = require('../server/stanze');
const indice = require('../server/index');

/** Generatore pseudo-casuale deterministico (mulberry32) per test ripetibili. */
function rngDeterministico(seme) {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORA_FISSA = () => 1763204073000;

function giocatoriDiProva(n = 3) {
  const nomi = ['Anna', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio'];
  return nomi.slice(0, n).map((nome, i) => ({
    id: `g${i}aaaaaa`.slice(0, 8),
    nome,
    colore: P.COLORI_GIOCATORE[i],
    connesso: true,
  }));
}

// ---------------------------------------------------------------------------
// protocollo.js
// ---------------------------------------------------------------------------

test('protocollo: costanti e normalizzazioni', () => {
  assert.equal(P.LIMITI.MAX_GIOCATORI, 6);
  assert.deepEqual(P.MESSAGGI_CLIENT.slice(0, 5), ['creaStanza', 'entraStanza', 'avviaPartita', 'azione', 'riconnetti']);
  assert.equal(P.normalizzaCodice(' k7pq2m '), 'K7PQ2M');
  assert.equal(P.normalizzaCodice('abc'), null);
  assert.equal(P.normalizzaNome('  Anna   Rossi '), 'Anna Rossi');
  assert.equal(P.normalizzaNome(''), null);
  assert.equal(P.normalizzaNome('x'.repeat(17)), null);
  assert.equal(P.normalizzaColore('#D62828'), '#d62828');
  assert.equal(P.normalizzaColore('rosso'), null);
  assert.match(P.ALFABETO_CODICE, /^[A-Z2-9]+$/);
  assert.ok(!P.ALFABETO_CODICE.includes('O') && !P.ALFABETO_CODICE.includes('I'));
});

test('protocollo: analizza accetta messaggi validi e rifiuta quelli malformati', () => {
  assert.deepEqual(P.analizza('{"tipo":"creaStanza"}'), { ok: true, messaggio: { tipo: 'creaStanza' } });

  const entra = P.analizza(JSON.stringify({ tipo: 'entraStanza', codice: 'k7pq2m', nome: ' Anna ', colore: '#D62828', rif: 'r1' }));
  assert.equal(entra.ok, true);
  assert.deepEqual(entra.messaggio, { tipo: 'entraStanza', codice: 'K7PQ2M', nome: 'Anna', colore: '#d62828', rif: 'r1' });

  const azione = P.analizza(JSON.stringify({ tipo: 'azione', azione: { tipo: 'costruisci', casella: 1 } }));
  assert.equal(azione.ok, true);
  assert.deepEqual(azione.messaggio.azione, { tipo: 'costruisci', casella: 1 });

  assert.equal(P.analizza('non json').errore, 'MESSAGGIO_NON_VALIDO');
  assert.equal(P.analizza('[1,2]').errore, 'MESSAGGIO_NON_VALIDO');
  assert.equal(P.analizza('{"tipo":"boh"}').errore, 'TIPO_SCONOSCIUTO');
  assert.equal(P.analizza('{"tipo":"azione","azione":"lanciaDadi"}').errore, 'MESSAGGIO_NON_VALIDO');
  assert.equal(P.analizza(JSON.stringify({ tipo: 'entraStanza', codice: 'K7PQ2M', nome: '' })).errore, 'NOME_NON_VALIDO');
  assert.equal(P.analizza(JSON.stringify({ tipo: 'riconnetti', codice: 'K7PQ2M', token: 'corto' })).errore, 'TOKEN_NON_VALIDO');
  assert.equal(P.analizza('x'.repeat(P.LIMITI.MESSAGGIO_MAX_BYTE + 1)).errore, 'MESSAGGIO_NON_VALIDO');

  const err = P.errore('NON_IL_TUO_TURNO', { rif: 'a1' });
  assert.deepEqual(err, { tipo: 'errore', codice: 'NON_IL_TUO_TURNO', messaggio: P.ERRORI.NON_IL_TUO_TURNO, rif: 'a1' });
});

// ---------------------------------------------------------------------------
// motore.js
// ---------------------------------------------------------------------------

test('motore: esporta le 17 azioni e le 7 fasi previste', () => {
  // INTERFACCE.md §2.4: le 16 azioni di gioco più `abbandona` (uscita volontaria).
  assert.deepEqual([...motore.AZIONI], [
    'lanciaDadi', 'compra', 'rifiutaAcquisto', 'offertaAsta', 'passaAsta', 'costruisci', 'vendiCasa',
    'ipoteca', 'disipoteca', 'proponiScambio', 'accettaScambio', 'rifiutaScambio', 'pagaCauzione',
    'usaCartaPrigione', 'finisciTurno', 'dichiaraBancarotta', 'abbandona',
  ]);
  assert.deepEqual([...motore.FASI], ['lobby', 'daLanciare', 'mossa', 'daDecidereAcquisto', 'asta', 'debito', 'finePartita']);
  for (const nome of ['creaStatoLobby', 'creaPartita', 'applicaAzione', 'azioniDisponibili', 'statoPubblico', 'prossimoGiocatore']) {
    assert.equal(typeof motore[nome], 'function', nome);
  }
});

test('motore: creaStatoLobby ha lo shape di INTERFACCE.md §1', () => {
  const s = motore.creaStatoLobby({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(2), ora: ORA_FISSA });
  assert.equal(s.fase, 'lobby');
  assert.equal(s.versione, 0);
  assert.equal(s.turno.giocatoreId, null);
  assert.equal(s.dadi, null);
  assert.equal(s.giocatori.length, 2);
  assert.equal(s.giocatori[0].denaro, 0);
  assert.equal(Object.keys(s.proprieta).length, 28);
  assert.deepEqual(s.proprieta['1'], { proprietario: null, caseCostruite: 0, ipotecata: false });
  assert.equal(s.caseDisponibili, 32);
  assert.equal(s.alberghiDisponibili, 12);
  assert.equal(s.asta, null);
  assert.equal(s.scambio, null);
  assert.equal(s.debito, null);
  assert.deepEqual(s.log, []);
  assert.equal(s.vincitoreId, null);
  for (const campo of ['id', 'nome', 'colore', 'denaro', 'posizione', 'inPrigione', 'turniInPrigione', 'cartePrigione', 'connesso', 'fallito']) {
    assert.ok(campo in s.giocatori[0], `giocatore.${campo}`);
  }
});

test('motore: creaPartita è deterministica con random iniettato e valida i giocatori', () => {
  const opz = { codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(4), ora: ORA_FISSA };
  const a = motore.creaPartita({ ...opz, random: rngDeterministico(7) });
  const b = motore.creaPartita({ ...opz, random: rngDeterministico(7) });
  assert.deepEqual(a, b);
  assert.equal(a.fase, 'daLanciare');
  assert.equal(a.turno.numero, 1);
  assert.equal(a.turno.giocatoreId, a.giocatori[0].id);
  assert.ok(a.giocatori.every((g) => g.denaro === 1500 && g.posizione === 0));
  assert.equal(a.log[0].tipo, 'partitaIniziata');

  const ordinata = motore.creaPartita({ ...opz, random: rngDeterministico(1), opzioni: { ordineCasuale: false, denaroIniziale: 1000 } });
  assert.deepEqual(ordinata.giocatori.map((g) => g.id), opz.giocatori.map((g) => g.id));
  assert.equal(ordinata.giocatori[0].denaro, 1000);

  assert.throws(() => motore.creaPartita({ ...opz, giocatori: giocatoriDiProva(1) }), TypeError);
  assert.throws(() => motore.creaPartita({ ...opz, giocatori: [...giocatoriDiProva(6), { id: 'extra123', nome: 'G', colore: '#000000' }] }), TypeError);
  assert.throws(() => motore.creaPartita({ ...opz, giocatori: [opz.giocatori[0], opz.giocatori[0]] }), TypeError);
});

test('motore: statoPubblico toglie i mazzi senza toccare l\'originale', () => {
  const s = motore.creaPartita({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(2), random: rngDeterministico(3), ora: ORA_FISSA });
  const pub = motore.statoPubblico(s);
  assert.equal('mazzi' in pub, false);
  assert.ok('mazzi' in s);
  assert.equal(pub.codice, s.codice);
  assert.doesNotThrow(() => JSON.stringify(pub));
});

test('motore: applicaAzione rifiuta azioni sconosciute, giocatori fuori turno e fasi errate', () => {
  const s = motore.creaPartita({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(3), random: rngDeterministico(5), ora: ORA_FISSA, opzioni: { ordineCasuale: false } });
  const [primo, secondo] = s.giocatori.map((g) => g.id);

  assert.equal(motore.applicaAzione(s, primo, { tipo: 'boh' }).errore.codice, 'AZIONE_NON_VALIDA');
  assert.equal(motore.applicaAzione(s, primo, null).errore.codice, 'AZIONE_NON_VALIDA');
  assert.equal(motore.applicaAzione(s, 'nessuno1', { tipo: 'lanciaDadi' }).errore.codice, 'GIOCATORE_NON_VALIDO');
  assert.equal(motore.applicaAzione(s, secondo, { tipo: 'lanciaDadi' }).errore.codice, 'NON_IL_TUO_TURNO');
  assert.equal(motore.applicaAzione(s, primo, { tipo: 'finisciTurno' }).errore.codice, 'FASE_ERRATA');
  assert.equal(motore.applicaAzione(s, primo, { tipo: 'compra' }).errore.codice, 'FASE_ERRATA');
  assert.equal(motore.applicaAzione(s, primo, { tipo: 'pagaCauzione' }).errore.codice, 'NON_IN_PRIGIONE');

  const lobby = motore.creaStatoLobby({ codice: 'K7PQ2M', hostId: primo, giocatori: giocatoriDiProva(2), ora: ORA_FISSA });
  assert.equal(motore.applicaAzione(lobby, primo, { tipo: 'lanciaDadi' }).errore.codice, 'FASE_ERRATA');
  assert.deepEqual(motore.azioniDisponibili(lobby, primo), []);
});

test('motore: lanciaDadi muove il giocatore, non muta lo stato in ingresso e produce eventi', () => {
  const s = motore.creaPartita({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(2), random: rngDeterministico(11), ora: ORA_FISSA, opzioni: { ordineCasuale: false } });
  const primo = s.turno.giocatoreId;
  const copia = structuredClone(s);
  const disponibili = motore.azioniDisponibili(s, primo);
  assert.ok(disponibili.includes('lanciaDadi'));
  assert.ok(disponibili.includes('proponiScambio'));
  assert.ok(!disponibili.includes('finisciTurno'));

  // Dadi forzati (random al centro dell'intervallo): 4 e 6 → posizione 10
  // (Prigione / Transito: nessun effetto) → fase mossa.
  const valori = [3.5 / 6, 5.5 / 6];
  const ris = motore.applicaAzione(s, primo, { tipo: 'lanciaDadi' }, { random: () => valori.shift(), ora: ORA_FISSA });
  assert.equal(ris.errore, undefined);
  assert.deepEqual(s, copia, 'lo stato originale non deve cambiare');
  assert.deepEqual(ris.stato.dadi, [4, 6]);
  assert.equal(ris.stato.giocatori[0].posizione, 10);
  assert.equal(ris.stato.fase, 'mossa');
  assert.equal(ris.stato.versione, s.versione + 1);
  assert.deepEqual(ris.eventi.map((e) => e.tipo), ['dadi', 'movimento']);
  assert.equal(ris.stato.log.length, s.log.length + 2);

  // Chiusura del turno → passa al secondo giocatore.
  const fine = motore.applicaAzione(ris.stato, primo, { tipo: 'finisciTurno' }, { ora: ORA_FISSA });
  assert.equal(fine.errore, undefined);
  assert.equal(fine.stato.turno.giocatoreId, s.giocatori[1].id);
  assert.equal(fine.stato.turno.numero, 2);
  assert.equal(fine.stato.fase, 'daLanciare');
  assert.equal(fine.eventi[0].tipo, 'turno');
});

test('motore: arrivo su casella libera → daDecidereAcquisto → compra', () => {
  const s = motore.creaPartita({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(2), random: rngDeterministico(2), ora: ORA_FISSA, opzioni: { ordineCasuale: false } });
  const primo = s.turno.giocatoreId;
  // Dadi 1 e 2 → posizione 3 (Vicolo Stretto, acquistabile).
  const valori = [0.5 / 6, 1.5 / 6];
  const r1 = motore.applicaAzione(s, primo, { tipo: 'lanciaDadi' }, { random: () => valori.shift(), ora: ORA_FISSA });
  assert.equal(r1.stato.fase, 'daDecidereAcquisto');
  assert.ok(motore.azioniDisponibili(r1.stato, primo).includes('compra'));

  const r2 = motore.applicaAzione(r1.stato, primo, { tipo: 'compra' }, { ora: ORA_FISSA });
  assert.equal(r2.errore, undefined);
  assert.equal(r2.stato.proprieta['3'].proprietario, primo);
  assert.ok(r2.stato.giocatori[0].denaro < 1500);
  assert.equal(r2.stato.fase, 'mossa');
  assert.equal(r2.eventi[0].tipo, 'acquisto');

  // Dalla fase 2 tutte le azioni sono implementate: con un solo Vicolo non si costruisce.
  const r3 = motore.applicaAzione(r2.stato, primo, { tipo: 'costruisci', casella: 3 }, { ora: ORA_FISSA });
  assert.equal(r3.errore.codice, 'GRUPPO_INCOMPLETO', 'Regola: per costruire serve tutto il gruppo di colore');
});

test('scambi e bancarotta: firme presenti e validazioni di base', () => {
  const s = motore.creaPartita({ codice: 'K7PQ2M', hostId: 'g0aaaaaa', giocatori: giocatoriDiProva(2), random: rngDeterministico(9), ora: ORA_FISSA, opzioni: { ordineCasuale: false } });
  const [a, b] = s.giocatori.map((g) => g.id);
  assert.equal(typeof scambi.validaProposta, 'function');
  assert.equal(scambi.validaProposta(s, a, { aId: b }).errore.codice, 'SCAMBIO_VUOTO');
  assert.equal(scambi.validaProposta(s, a, { aId: a, offre: { denaro: 10 } }).errore.codice, 'GIOCATORE_NON_VALIDO');
  // Chi offre deve possedere le proprietà: a ottiene le caselle 1 e 3 in una copia dello stato.
  const sp = structuredClone(s);
  sp.proprieta['1'].proprietario = a;
  sp.proprieta['3'].proprietario = a;
  const ok = scambi.validaProposta(sp, a, { aId: b, offre: { denaro: 100, proprieta: [3, 1, 1] } }, { ora: ORA_FISSA });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.scambio.offre, { denaro: 100, proprieta: [1, 3], cartePrigione: 0 });
  assert.equal(ok.scambio.id, 's1');

  assert.equal(bancarotta.patrimonioLiquidabile(s, a), 1500);
  const liq = motore.applicaAzione(s, a, { tipo: 'abbandona' }, { ora: ORA_FISSA });
  assert.equal(liq.stato.giocatori[0].fallito, true);
  assert.equal(s.giocatori[0].fallito, false, 'lo stato di partenza non cambia');
});

// ---------------------------------------------------------------------------
// stanze.js
// ---------------------------------------------------------------------------

test('stanze: ciclo lobby → ingresso → avvio → azione → riconnessione', () => {
  stanze.azzera();
  const ora = ORA_FISSA;
  const stanza = stanze.crea({ ora, random: rngDeterministico(4) });
  assert.match(stanza.codice, P.REGEX_CODICE);
  assert.equal(stanza.stato.fase, 'lobby');
  assert.equal(stanze.trova(stanza.codice.toLowerCase()), stanza);

  const e1 = stanze.entra(stanza, { nome: 'Anna', colore: '#d62828', ora });
  assert.equal(e1.errore, undefined);
  assert.match(e1.giocatore.id, P.REGEX_ID);
  assert.match(e1.token, P.REGEX_TOKEN);
  assert.equal(stanza.hostId, e1.giocatore.id);
  assert.equal(stanza.stato.giocatori.length, 1);
  assert.equal(stanza.stato.log.at(-1).tipo, 'giocatoreEntrato');

  assert.equal(stanze.entra(stanza, { nome: 'anna', ora }).errore.codice, 'NOME_OCCUPATO');
  assert.equal(stanze.entra(stanza, { nome: 'Bruno', colore: '#d62828', ora }).errore.codice, 'COLORE_OCCUPATO');
  assert.equal(stanze.avvia(stanza, e1.giocatore.id, { ora }).errore.codice, 'POCHI_GIOCATORI');

  const e2 = stanze.entra(stanza, { nome: 'Bruno', ora });
  assert.equal(e2.giocatore.colore, '#1d4ed8', 'colore libero assegnato dalla palette');
  assert.equal(stanze.avvia(stanza, e2.giocatore.id, { ora }).errore.codice, 'NON_HOST');

  const avvio = stanze.avvia(stanza, e1.giocatore.id, { ora, random: rngDeterministico(1) });
  assert.equal(avvio.errore, undefined);
  assert.equal(stanza.stato.fase, 'daLanciare');
  assert.equal(stanze.entra(stanza, { nome: 'Carla', ora }).errore.codice, 'PARTITA_INIZIATA');

  const pub = stanze.statoPerClient(stanza);
  assert.equal('mazzi' in pub, false);
  assert.equal(JSON.stringify(pub).includes(e1.token), false, 'il token non deve mai finire nello stato');

  const diTurno = stanza.stato.turno.giocatoreId;
  const azione = stanze.applica(stanza, diTurno, { tipo: 'lanciaDadi' }, { ora, random: rngDeterministico(8) });
  assert.equal(azione.errore, undefined);
  assert.equal(stanza.stato.versione, pub.versione + 1);

  stanze.disconnetti(stanza, e1.giocatore.id, { ora });
  assert.equal(stanza.stato.giocatori.find((g) => g.id === e1.giocatore.id).connesso, false);
  assert.equal(stanze.riconnetti(stanza.codice, 'deadbeef'.repeat(4), null).errore.codice, 'TOKEN_NON_VALIDO');
  const ric = stanze.riconnetti(stanza.codice, e1.token, null, { ora });
  assert.equal(ric.giocatore.id, e1.giocatore.id);
  assert.equal(stanza.stato.giocatori.find((g) => g.id === e1.giocatore.id).connesso, true);

  // Pulizia: una stanza con tutti disconnessi da più di 10 minuti viene rimossa.
  stanze.disconnetti(stanza, e1.giocatore.id, { ora });
  stanze.disconnetti(stanza, e2.giocatore.id, { ora });
  assert.equal(stanze.pulisci({ ora: () => ORA_FISSA() + 5 * 60 * 1000 }), 0);
  assert.equal(stanze.pulisci({ ora: () => ORA_FISSA() + 11 * 60 * 1000 }), 1);
  assert.equal(stanze.tutte().length, 0);
});

test('stanze: massimo 6 giocatori e uscita in lobby con passaggio di host', () => {
  stanze.azzera();
  const ora = ORA_FISSA;
  const stanza = stanze.crea({ ora });
  const entrati = [];
  for (let i = 0; i < 6; i += 1) entrati.push(stanze.entra(stanza, { nome: `G${i}`, ora }).giocatore);
  assert.equal(stanze.entra(stanza, { nome: 'Settimo', ora }).errore.codice, 'STANZA_PIENA');
  assert.equal(stanza.hostId, entrati[0].id);
  stanze.esci(stanza, entrati[0].id, { ora });
  assert.equal(stanza.hostId, entrati[1].id);
  assert.equal(stanza.stato.giocatori.length, 5);
  stanze.azzera();
});

// ---------------------------------------------------------------------------
// index.js (HTTP)
// ---------------------------------------------------------------------------

function richiesta(porta, percorso) {
  return new Promise((risolvi, rifiuta) => {
    http.get({ host: '127.0.0.1', port: porta, path: percorso }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => risolvi({ stato: res.statusCode, tipo: res.headers['content-type'], corpo }));
    }).on('error', rifiuta);
  });
}

test('index: il server parte, risponde a /salute e protegge i percorsi', async () => {
  const { server, porta } = await indice.avvia({ port: 0, host: '127.0.0.1', publicUrl: 'http://test.local' });
  try {
    const salute = await richiesta(porta, '/salute');
    assert.equal(salute.stato, 200);
    const corpo = JSON.parse(salute.corpo);
    assert.equal(corpo.ok, true);
    assert.equal(typeof corpo.stanze, 'number');

    const radice = await richiesta(porta, '/');
    assert.ok([200, 404].includes(radice.stato), 'index.html presente (200) o non ancora (404)');

    const traversal = await richiesta(porta, '/../package.json');
    assert.ok([403, 404].includes(traversal.stato));
    const traversalCodificato = await richiesta(porta, '/%2e%2e/package.json');
    assert.ok([403, 404].includes(traversalCodificato.stato));

    const dati = await richiesta(porta, '/dati/tabellone.js');
    assert.ok([200, 404].includes(dati.stato));
    if (dati.stato === 200) {
      assert.match(dati.tipo, /javascript/);
      assert.match(dati.corpo, /export const CASELLE = \[/);
    }
    assert.equal(indice.linkStanza('http://test.local/', 'K7PQ2M'), 'http://test.local/?stanza=K7PQ2M');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('index: moduloDatiComeEsm converte un modulo di dati in ES module', () => {
  const sorgente = indice.moduloDatiComeEsm('motore.js');
  assert.equal(typeof sorgente, 'string');
  assert.match(sorgente, /export const AZIONI = \["lanciaDadi"/);
  assert.equal(sorgente.includes('applicaAzione'), false, 'le funzioni non vengono esportate');
  assert.equal(indice.moduloDatiComeEsm('inesistente.js'), null);
});
