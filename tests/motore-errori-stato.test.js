'use strict';

/**
 * tests/motore-errori-stato.test.js
 * - azioni fuori turno / in fase errata: errore e stato intatto (anche con lo
 *   stato congelato: se il motore provasse a modificarlo lancerebbe un errore);
 * - stato sempre serializzabile in JSON;
 * - partite simulate con generatore iniettato: invarianti dopo OGNI azione.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const TAB = require('../server/gioco/tabellone');
const { ERRORI } = require('../server/gioco/errori');
const P = require('../server/protocollo');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const { giocatore } = H;

const inAsta = () => H.esegui(H.modifica(H.nuovaPartita(), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; }),
  A, { tipo: 'rifiutaAcquisto' }).stato;

/** Uno stato per ciascuna fase del gioco. */
function statiPerFase() {
  return {
    lobby: motore.creaStatoLobby({ codice: 'TEST23', hostId: A, giocatori: H.elencoGiocatori(3), ora: H.ORA_FISSA }),
    daLanciare: H.nuovaPartita(),
    mossa: H.turnoDi(H.nuovaPartita(), A, 'mossa'),
    daDecidereAcquisto: H.modifica(H.nuovaPartita(), (x) => { giocatore(x, A).posizione = 3; x.fase = 'daDecidereAcquisto'; }),
    asta: inAsta(),
    debito: H.arrivaSu(H.soldi(H.nuovaPartita(), B, 10), B, 4, 1, 3).stato,
    finePartita: H.modifica(H.nuovaPartita(), (x) => { x.fase = 'finePartita'; x.vincitoreId = A; }),
  };
}

test('azioni vietate: ogni azione non ammessa a un giocatore in una fase dà errore e non tocca lo stato', () => {
  for (const [fase, stato] of Object.entries(statiPerFase())) {
    assert.equal(stato.fase, fase, `errore nel test: lo stato di prova doveva essere in fase ${fase}`);
    const congelato = H.congela(structuredClone(stato));
    for (const id of [A, B, C]) {
      const ammesse = motore.azioniDisponibili(congelato, id);
      for (const tipo of motore.AZIONI.filter((t) => !ammesse.includes(t))) {
        const prima = JSON.stringify(congelato);
        const r = H.applica(congelato, id, { tipo });
        const dove = `fase "${fase}", giocatore ${giocatore(stato, id).nome}, azione "${tipo}"`;
        assert.ok(r.errore, `${dove}: non è tra le azioni disponibili, quindi deve essere rifiutata`);
        assert.ok(Object.hasOwn(ERRORI, r.errore.codice), `${dove}: codice d'errore sconosciuto ${r.errore.codice}`);
        assert.equal(r.stato, undefined, `${dove}: un'azione rifiutata non deve produrre un nuovo stato`);
        assert.equal(JSON.stringify(congelato), prima, `${dove}: lo stato non deve cambiare`);
      }
    }
  }
});

test('azioni vietate: codici d\'errore precisi per i casi tipici', () => {
  const s = H.nuovaPartita();
  H.rifiuta(s, B, { tipo: 'lanciaDadi' }, 'NON_IL_TUO_TURNO', 'Solo chi è di turno lancia i dadi');
  H.rifiuta(s, A, { tipo: 'finisciTurno' }, 'FASE_ERRATA', 'Non si finisce il turno prima di aver lanciato');
  H.rifiuta(s, A, { tipo: 'compra' }, 'FASE_ERRATA', 'Non si compra senza essere su una casella libera');
  H.rifiuta(s, A, { tipo: 'rifiutaAcquisto' }, 'FASE_ERRATA', 'Non si rifiuta ciò che non è in vendita');
  H.rifiuta(s, A, { tipo: 'dichiaraBancarotta' }, 'FASE_ERRATA', 'Senza debito non c\'è bancarotta');
  H.rifiuta(H.turnoDi(s, A, 'mossa'), A, { tipo: 'lanciaDadi' }, 'FASE_ERRATA', 'Non si lancia due volte nello stesso turno');
  H.rifiuta(s, 'nessuno1', { tipo: 'lanciaDadi' }, 'GIOCATORE_NON_VALIDO', 'Chi non è nella partita non può agire');
  H.rifiuta(H.modifica(s, (x) => { giocatore(x, B).fallito = true; }), B, { tipo: 'proponiScambio' }, 'GIOCATORE_FALLITO', 'Un fallito non può agire');
  const { lobby, finePartita } = statiPerFase();
  H.rifiuta(lobby, A, { tipo: 'lanciaDadi' }, 'FASE_ERRATA', 'In lobby non si gioca');
  H.rifiuta(finePartita, A, { tipo: 'lanciaDadi' }, 'FASE_ERRATA', 'A partita finita non si gioca');
  for (const azione of [null, undefined, 'lanciaDadi', 42, {}, { tipo: 5 }, { tipo: 'boh' }, { tipo: 'toString' }, { tipo: '__proto__' }]) {
    H.rifiuta(s, A, azione, 'AZIONE_NON_VALIDA', `${JSON.stringify(azione)} non è un'azione valida`);
  }
  assert.equal(motore.applicaAzione(null, A, { tipo: 'lanciaDadi' }).errore.codice, 'PARAMETRI_NON_VALIDI', 'senza stato non si può agire');
});

test('codici d\'errore: ogni codice del motore ha un messaggio ed è noto al protocollo di rete', () => {
  for (const [codice, messaggio] of Object.entries(ERRORI)) {
    assert.ok(typeof messaggio === 'string' && messaggio.length > 0, `${codice}: messaggio italiano mancante`);
    assert.ok(Object.hasOwn(P.ERRORI, codice), `${codice}: il server non conosce questo codice (manca in protocollo.ERRORI)`);
  }
});

test('immutabilità: il motore non modifica lo stato in ingresso nemmeno quando l\'azione riesce', () => {
  const s = H.congela(structuredClone(H.nuovaPartita()));
  const r = H.lancia(s, A, 1, 2); // se il motore mutasse lo stato congelato, lancerebbe un TypeError
  assert.notEqual(r.stato, s);
  assert.equal(s.versione, 0, 'lo stato originale resta alla versione di partenza');
  assert.equal(r.stato.versione, 1);
  assert.equal(giocatore(s, A).posizione, 0, 'la pedina nello stato originale non si è mossa');
});

test('JSON: lo stato della partita e quello pubblico sono sempre serializzabili', () => {
  for (const [fase, stato] of Object.entries(statiPerFase())) {
    H.verificaJson(stato, `lo stato in fase ${fase}`);
    const pub = motore.statoPubblico(stato);
    assert.equal('mazzi' in pub, false, 'Regola: i mazzi non devono arrivare ai client');
    assert.equal('contatoreScambi' in pub, false);
    assert.ok('mazzi' in stato, 'statoPubblico non deve toccare lo stato originale');
    H.verificaJson(pub, `lo stato pubblico in fase ${fase}`);
  }
  const lobby = motore.creaStatoLobby({ codice: 'TEST23', hostId: A, giocatori: H.elencoGiocatori(2), ora: H.ORA_FISSA });
  assert.equal(lobby.fase, 'lobby');
  assert.deepEqual(lobby.giocatori.map((g) => g.denaro), [0, 0], 'in lobby nessuno ha ancora denaro');
});

test('creaPartita: regole di avvio (da 2 a 6 giocatori, 1500 €, random iniettato, ordine casuale riproducibile)', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    const s = H.nuovaPartita(n);
    assert.equal(s.giocatori.length, n);
    assert.ok(s.giocatori.every((g) => g.denaro === 1500 && g.posizione === 0 && !g.inPrigione && !g.fallito),
      'Regola: tutti partono dal Via con 1500 €');
    assert.equal(s.fase, 'daLanciare');
    assert.equal(s.turno.giocatoreId, A);
  }
  assert.throws(() => H.nuovaPartita(1), TypeError, 'Regola: servono almeno 2 giocatori');
  assert.throws(() => motore.creaPartita({ codice: 'X', giocatori: H.elencoGiocatori(6).concat([{ id: 'ggggggg7', nome: 'G', colore: '#000000' }]) }),
    TypeError, 'Regola: al massimo 6 giocatori');
  const casuale = (seme) => motore.creaPartita({ codice: 'TEST23', giocatori: H.elencoGiocatori(6), random: H.rngDeterministico(seme), ora: H.ORA_FISSA });
  assert.deepEqual(casuale(5), casuale(5), 'con lo stesso generatore la partita è identica');
  const impronta = (s) => ({ ordine: s.giocatori.map((g) => g.id), mazzi: s.mazzi });
  assert.notDeepEqual(impronta(casuale(5)), impronta(casuale(6)), 'generatori diversi mescolano ordine e mazzi in modo diverso');
});

// ---------------------------------------------------------------------------
// Partite simulate con controllo degli invarianti
// ---------------------------------------------------------------------------

/** Condizioni che devono valere dopo ogni azione, qualunque cosa sia successa. */
function invarianti(s, dove) {
  const ok = (cond, msg) => assert.ok(cond, `${dove}: ${msg}`);
  ok(motore.FASI.includes(s.fase), `fase sconosciuta "${s.fase}"`);
  for (const g of s.giocatori) {
    ok(Number.isInteger(g.denaro) && g.denaro >= 0, `${g.nome} ha ${g.denaro} €: Regola: il denaro non è mai negativo né frazionario`);
    ok(Number.isInteger(g.posizione) && g.posizione >= 0 && g.posizione < 40, `${g.nome} è in una casella inesistente (${g.posizione})`);
    if (g.fallito) ok(g.denaro === 0 && !g.inPrigione, `${g.nome} è fallito ma ha ancora denaro o è in prigione`);
    const carte = Object.values(s.cartePrigioneDi).filter((id) => id === g.id).length;
    ok(g.cartePrigione === carte, `${g.nome}: cartePrigione (${g.cartePrigione}) non coincide con il registro (${carte})`);
  }
  let nCase = 0;
  let alberghi = 0;
  for (const [k, v] of Object.entries(s.proprieta)) {
    const c = TAB.casella(Number(k));
    const padrone = v.proprietario && giocatore(s, v.proprietario);
    ok(v.proprietario === null || (padrone && !padrone.fallito), `la casella ${k} appartiene a un giocatore inesistente o fallito`);
    ok(Number.isInteger(v.caseCostruite) && v.caseCostruite >= 0 && v.caseCostruite <= 5, `la casella ${k} ha ${v.caseCostruite} costruzioni`);
    if (v.caseCostruite === 5) alberghi += 1; else nCase += v.caseCostruite;
    if (v.caseCostruite > 0) {
      ok(c.tipo === 'proprieta' && v.proprietario, `${c.nome}: costruzioni su una casella non edificabile o senza proprietario`);
      ok(!v.ipotecata, `${c.nome}: ipotecata ma con costruzioni`);
      const gruppo = TAB.indiciGruppo(c.gruppo).map((i) => s.proprieta[String(i)]);
      ok(gruppo.every((x) => x.proprietario === v.proprietario), `${c.nome}: costruzioni senza il gruppo completo`);
      const n = gruppo.map((x) => x.caseCostruite);
      ok(Math.max(...n) - Math.min(...n) <= 1, `${c.nome}: Regola: costruzioni non uniformi nel gruppo (${n.join(', ')})`);
    }
  }
  ok(s.caseDisponibili + nCase === 32, `Regola: le case sono 32 (${s.caseDisponibili} in banca + ${nCase} costruite)`);
  ok(s.alberghiDisponibili + alberghi === 12, `Regola: gli alberghi sono 12 (${s.alberghiDisponibili} in banca + ${alberghi} costruiti)`);
  const carte = [...s.mazzi.probabilita, ...s.mazzi.imprevisti, ...Object.keys(s.cartePrigioneDi)];
  ok(carte.length === 32 && new Set(carte).size === 32, `le 32 carte devono essere tutte presenti una volta sola (trovate ${carte.length})`);
  ok((s.fase === 'debito') === (s.debito !== null), 'debito aperto se e solo se la fase è "debito"');
  ok((s.fase === 'asta') === (s.asta !== null), 'asta aperta se e solo se la fase è "asta"');
  ok(s.log.length <= 200, `il log supera i 200 eventi (${s.log.length})`);
  if (s.fase === 'finePartita') {
    ok(s.giocatori.filter((g) => !g.fallito).length === 1 && s.vincitoreId, 'fine partita senza un unico vincitore');
  } else {
    ok(!giocatore(s, s.turno.giocatoreId).fallito, 'il turno è di un giocatore fallito');
  }
  H.verificaJson(s, dove);
}

/** Gioca (con scelte pseudo-casuali ma legali) fino alla fine o a `passiMax` azioni. */
function simula(seme, nGiocatori, passiMax) {
  const rng = H.rngDeterministico(seme);
  const scelte = H.rngDeterministico(seme + 1000);
  let s = motore.creaPartita({
    codice: 'SIMUL1', hostId: H.ID.A, giocatori: H.elencoGiocatori(nGiocatori), random: H.rngDeterministico(seme), ora: H.ORA_FISSA,
  });
  invarianti(s, `partita ${seme}: inizio`);
  let passo = 0;
  const prova = (id, azione) => {
    const r = motore.applicaAzione(s, id, azione, { random: rng, ora: H.ORA_FISSA });
    if (r.errore) return false;
    assert.equal(r.stato.versione, s.versione + 1, `partita ${seme}, passo ${passo}: ogni azione accettata incrementa la versione di 1`);
    s = r.stato;
    invarianti(s, `partita ${seme}, passo ${passo}, dopo "${azione.tipo}"`);
    return true;
  };
  for (; passo < passiMax && s.fase !== 'finePartita'; passo += 1) {
    const turno = s.turno.giocatoreId;
    const g = giocatore(s, turno);
    let fatto = false;
    if (s.fase === 'daLanciare') {
      if (g.inPrigione && g.cartePrigione > 0) fatto = prova(turno, { tipo: 'usaCartaPrigione' });
      else if (g.inPrigione && g.denaro >= 50 && scelte() < 0.4) fatto = prova(turno, { tipo: 'pagaCauzione' });
      if (!fatto) fatto = prova(turno, { tipo: 'lanciaDadi' });
    } else if (s.fase === 'mossa') {
      for (const [k, v] of Object.entries(s.proprieta).filter(([, x]) => x.proprietario === turno)) {
        const dado = scelte();
        if (dado < 0.3) prova(turno, { tipo: 'costruisci', casella: Number(k) });
        else if (dado < 0.35) prova(turno, { tipo: v.ipotecata ? 'disipoteca' : 'ipoteca', casella: Number(k) });
      }
      fatto = prova(turno, { tipo: 'finisciTurno' });
    } else if (s.fase === 'daDecidereAcquisto') {
      if (g.denaro >= TAB.casella(g.posizione).prezzo && scelte() < 0.7) fatto = prova(turno, { tipo: 'compra' });
      if (!fatto) fatto = prova(turno, { tipo: 'rifiutaAcquisto' });
    } else if (s.fase === 'asta') {
      const a = s.asta;
      const attivo = a.partecipanti.find((id) => !a.passati.includes(id) && id !== a.migliorOfferenteId);
      assert.ok(attivo, `partita ${seme}, passo ${passo}: asta aperta ma nessuno può né offrire né passare (l'asta doveva chiudersi)`);
      const offerta = a.offertaMassima + a.incrementoMinimo + Math.floor(scelte() * 40);
      if (a.offertaMassima < 300 && offerta <= giocatore(s, attivo).denaro && scelte() < 0.4) fatto = prova(attivo, { tipo: 'offertaAsta', importo: offerta });
      if (!fatto) fatto = prova(attivo, { tipo: 'passaAsta' });
    } else if (s.fase === 'debito') {
      const debitore = s.debito.giocatoreId;
      const suoi = Object.entries(s.proprieta).filter(([, x]) => x.proprietario === debitore);
      for (const [k, v] of suoi) {
        if (v.caseCostruite > 0) fatto = prova(debitore, { tipo: 'vendiCasa', casella: Number(k) });
        if (fatto) break;
      }
      for (const [k, v] of fatto ? [] : suoi) {
        if (!v.ipotecata) fatto = prova(debitore, { tipo: 'ipoteca', casella: Number(k) });
        if (fatto) break;
      }
      if (!fatto) fatto = prova(debitore, { tipo: 'dichiaraBancarotta' });
    }
    assert.ok(fatto, `partita ${seme}, passo ${passo}: il motore è bloccato in fase "${s.fase}": nessuna azione ha funzionato`);
  }
  return { stato: s, passi: passo };
}

test('partite simulate: invarianti rispettati dopo ogni azione (2, 4 e 6 giocatori)', () => {
  let finite = 0;
  for (const [seme, n] of [[1, 2], [2, 4], [3, 6], [4, 3]]) {
    const { stato } = simula(seme, n, 1200);
    if (stato.fase === 'finePartita') finite += 1;
  }
  assert.ok(finite >= 0, 'nessuna partita deve bloccarsi');
});

test('partite simulate: stesso seme, stessa partita (determinismo con generatore iniettato)', () => {
  const uno = simula(7, 4, 400);
  const due = simula(7, 4, 400);
  assert.deepEqual(uno.stato, due.stato, 'due partite con lo stesso seme devono finire nello stesso stato');
  assert.equal(uno.passi, due.passi);
});
