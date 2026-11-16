'use strict';

/**
 * tests/motore-varianti.test.js
 *
 * Regole scelte nella finestra "Regole della partita" (server/gioco/regole.js):
 * denaro e proprietà iniziali, Via doppio, piatto del Parcheggio gratuito,
 * niente affitti dalla prigione, proprietà non comprate che restano alla banca.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const motore = require('../server/gioco/motore');
const REGOLE = require('../server/gioco/regole');
const TAB = require('../server/gioco/tabellone');
const H = require('./aiuti');

const { A, B, C } = H.ID;
const denaro = (s, id) => H.giocatore(s, id).denaro;

test('regole: il catalogo ha un predefinito valido per ogni voce; normalizza completa e rifiuta', () => {
  for (const r of REGOLE.REGOLE) {
    assert.ok(r.valori.some((v) => v.valore === r.predefinito), `${r.chiave}: il predefinito deve essere tra i valori`);
    assert.ok(r.titolo && r.descrizione && r.valori.every((v) => v.etichetta && v.descrizione), `${r.chiave}: testi per la finestra`);
  }
  assert.deepEqual(REGOLE.normalizza({ parcheggio: true }).regole, { ...REGOLE.PREDEFINITE, parcheggio: true });
  assert.deepEqual(REGOLE.normalizza(undefined).regole, REGOLE.PREDEFINITE);
  assert.equal(REGOLE.normalizza({ boh: 1 }).errore.campo, 'regole.boh');
  assert.equal(REGOLE.normalizza({ proprietaIniziali: 4 }).errore.campo, 'regole.proprietaIniziali');
  assert.equal(REGOLE.normalizza({ aste: 'no' }).errore.campo, 'regole.aste');
  assert.ok(REGOLE.normalizza([]).errore);
  assert.throws(() => H.nuovaPartita(2, { parcheggio: 'si' }), TypeError);
  assert.throws(() => H.nuovaPartita(2, { proprietaIniziali: 7 }), TypeError);
});

test('regole: lo stato della partita ricorda tutte le regole scelte', () => {
  const s = H.nuovaPartita(3, { denaroIniziale: 2500, viaDoppio: true });
  assert.deepEqual(s.regole, { ...REGOLE.PREDEFINITE, denaroIniziale: 2500, viaDoppio: true });
  assert.ok(s.giocatori.every((g) => g.denaro === 2500));
  assert.equal(s.piatto, 0);
  assert.deepEqual(s.log[0].dati.regole, s.regole, 'le regole sono anche nell\'evento di inizio partita');
});

test('proprietà iniziali: n a testa, gratis, a caso, mai un gruppo completo', () => {
  assert.equal(H.nuovaPartita(4).log.some((e) => e.tipo === 'proprietaIniziali'), false, 'con 0 non si distribuisce nulla');
  for (let seme = 1; seme <= 60; seme += 1) {
    const n = 1 + (seme % 3);
    const giocatori = 2 + (seme % 5);
    const s = motore.creaPartita({
      codice: 'TEST23', hostId: A, giocatori: H.elencoGiocatori(giocatori), random: H.rngDeterministico(seme), ora: H.ORA_FISSA,
      opzioni: { ordineCasuale: false, proprietaIniziali: n },
    });
    for (const g of s.giocatori) {
      const mie = Object.entries(s.proprieta).filter(([, v]) => v.proprietario === g.id).map(([i]) => Number(i));
      assert.equal(mie.length, n, `seme ${seme}: ${g.nome} deve avere ${n} proprietà`);
      assert.equal(g.denaro, 1500, 'le proprietà iniziali non si pagano');
      for (const i of mie) {
        const c = TAB.CASELLE[i];
        const gruppo = TAB.CASELLE.filter((x) => (c.tipo === 'proprieta' ? x.gruppo === c.gruppo : x.tipo === c.tipo));
        assert.ok(!gruppo.every((x) => mie.includes(x.indice)), `seme ${seme}: ${g.nome} non deve avere un gruppo completo`);
      }
      const ev = s.log.find((e) => e.tipo === 'proprietaIniziali' && e.giocatoreId === g.id);
      assert.deepEqual(ev.dati.caselle, mie.sort((a, b) => a - b));
    }
  }
  // Con il lancio iniziale le proprietà arrivano subito, prima di decidere chi comincia.
  const conLancio = H.nuovaPartita(3, { proprietaIniziali: 2, lancioIniziale: true });
  assert.equal(conLancio.fase, 'ordine');
  assert.equal(Object.values(conLancio.proprieta).filter((v) => v.proprietario).length, 6);
});

test('Via doppio: fermarsi proprio sul Via vale 400 €, passarci sopra 200 €', () => {
  const doppio = H.nuovaPartita(2, { viaDoppio: true });
  const sopra = H.lancia(H.turnoDi(H.inCasella(doppio, A, 37), A), A, 1, 2).stato;
  assert.equal(H.giocatore(sopra, A).posizione, 0);
  assert.equal(denaro(sopra, A), 1900);
  const oltre = H.lancia(H.turnoDi(H.inCasella(doppio, A, 37), A), A, 2, 3).stato;
  assert.equal(denaro(oltre, A), 1700);
  const classico = H.lancia(H.turnoDi(H.inCasella(H.nuovaPartita(2), A, 37), A), A, 1, 2).stato;
  assert.equal(denaro(classico, A), 1700, 'con la regola classica sempre 200 €');
});

test('Parcheggio gratuito: tasse e cauzioni vanno nel piatto, chi si ferma lì lo vince', () => {
  let s = H.nuovaPartita(2, { parcheggio: true });
  s = H.arrivaSu(s, A, 4, 1, 3).stato; // Tassa patrimoniale: 200 €
  assert.equal(s.piatto, 200);
  assert.equal(denaro(s, A), 1300);
  s = H.esegui(s, A, { tipo: 'finisciTurno' }).stato;
  s = H.esegui(H.inPrigione(s, B), B, { tipo: 'pagaCauzione' }).stato;
  assert.equal(s.piatto, 250, 'anche la cauzione finisce nel piatto');
  s = H.arrivaSu(H.modifica(s, (x) => { H.giocatore(x, B).inPrigione = false; }), B, 20, 3, 4).stato;
  assert.equal(s.piatto, 0);
  assert.equal(denaro(s, B), 1500 - 50 + 250);
  const ev = s.log.find((e) => e.tipo === 'piatto');
  assert.equal(ev.dati.importo, 250);

  const classico = H.arrivaSu(H.nuovaPartita(2), A, 4, 1, 3).stato;
  assert.equal(classico.piatto, 0, 'senza la variante la tassa va alla banca');
  const vuoto = H.arrivaSu(H.nuovaPartita(2, { parcheggio: true }), A, 20, 3, 4).stato;
  assert.equal(vuoto.log.some((e) => e.tipo === 'piatto'), false, 'con il piatto vuoto non succede niente');
});

test('Parcheggio gratuito: anche un debito con la banca saldato più tardi finisce nel piatto', () => {
  let s = H.soldi(H.nuovaPartita(2, { parcheggio: true }), A, 150);
  s = H.assegna(s, A, 39);
  s = H.arrivaSu(s, A, 4, 1, 3).stato; // 200 € di tassa con 150 €: debito
  assert.equal(s.fase, 'debito');
  assert.equal(s.piatto, 0);
  s = H.esegui(s, A, { tipo: 'ipoteca', casella: 39 }, undefined, 'Ipoteca per pagare la tassa').stato;
  assert.equal(s.debito, null);
  assert.equal(s.piatto, 200);
});

test('affitti dalla prigione: con la variante chi è in prigione non riscuote', () => {
  const base = (opz) => H.inPrigione(H.assegna(H.nuovaPartita(2, opz), B, 6), B);
  const senza = H.arrivaSu(base({ affittoInPrigione: false }), A, 6, 2, 3).stato;
  assert.equal(denaro(senza, A), 1500);
  const ev = senza.log.filter((e) => e.tipo === 'affitto').at(-1);
  assert.equal(ev.dati.importo, 0);
  assert.equal(ev.dati.inPrigione, true);
  const classico = H.arrivaSu(base(), A, 6, 2, 3).stato;
  assert.ok(denaro(classico, A) < 1500, 'regola classica: si paga anche se il proprietario è in prigione');
});

test('niente aste: la proprietà rifiutata resta alla banca, anche per inattività o bancarotta', () => {
  const s = H.arrivaSu(H.nuovaPartita(3, { aste: false }), A, 6, 2, 3).stato;
  assert.equal(s.fase, 'daDecidereAcquisto');
  const r = H.esegui(s, A, { tipo: 'rifiutaAcquisto' }).stato;
  assert.equal(r.fase, 'mossa');
  assert.equal(r.asta, null);
  assert.equal(H.voce(r, 6).proprietario, null);
  assert.match(r.log.at(-1).testo, /non compra .*: resta alla banca/);

  const inattivo = motore.gestisciInattivita(s, A, { ora: H.ORA_FISSA });
  assert.equal(inattivo.stato.fase, 'mossa');
  assert.equal(inattivo.stato.asta, null);
  assert.equal(inattivo.eventi.some((e) => e.tipo === 'acquistoRifiutato' && e.dati.motivo === 'inattivo'), true);

  const fallito = H.esegui(H.assegna(H.nuovaPartita(3, { aste: false }), C, 6, 8), C, { tipo: 'abbandona' }).stato;
  assert.deepEqual(fallito.asteInAttesa, []);
  assert.equal(fallito.asta, null);
  assert.equal(H.voce(fallito, 6).proprietario, null);

  // Con le aste (classico) la stessa rinuncia apre l'asta.
  const conAsta = H.esegui(H.arrivaSu(H.nuovaPartita(3), A, 6, 2, 3).stato, A, { tipo: 'rifiutaAcquisto' }).stato;
  assert.equal(conAsta.fase, 'asta');
});

test('lancio iniziale: chi abbandona con le proprietà iniziali le restituisce alla banca senza aste', () => {
  const s = H.nuovaPartita(3, { proprietaIniziali: 2, lancioIniziale: true });
  const r = H.esegui(s, B, { tipo: 'abbandona' }).stato;
  assert.equal(r.fase, 'ordine');
  assert.deepEqual(r.asteInAttesa, []);
  assert.equal(Object.values(r.proprieta).filter((v) => v.proprietario === B).length, 0);
});
