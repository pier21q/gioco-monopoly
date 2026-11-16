'use strict';

/**
 * server/gioco/nucleo.js
 *
 * Primitive condivise da motore.js, scambi.js e bancarotta.js: dati del
 * tabellone, eventi, pagamenti, debiti (con coda), aste (con coda), passaggio
 * del turno e fine partita. Tutte le funzioni che ricevono `stato` lo
 * MUTANO: vanno chiamate solo su una copia già clonata (lo fanno i wrapper
 * pubblici di motore/scambi/bancarotta).
 *
 * `ctx` = { random, ora, t, eventi } — contesto di una singola azione:
 * `random` e `ora` sono iniettati (test deterministici), `eventi` raccoglie
 * gli eventi prodotti nell'ordine in cui accadono.
 *
 * Campi di stato aggiuntivi gestiti qui (oltre a INTERFACCE.md §1):
 *   debitiInAttesa  debiti nati mentre un altro era già aperto (es. "ricevete
 *                   10 € da ogni giocatore" con più giocatori senza liquidità)
 *   asteInAttesa    caselle da mettere all'asta dopo una bancarotta verso la banca
 *   cartePrigioneDi { idCarta: giocatoreId } per sapere in quale mazzo far
 *                   tornare una carta "Uscite gratis di prigione" usata
 */

const TAB = require('./tabellone');
const CARTE = require('./carte');
const { errore } = require('./errori');

const NUMERO_CASELLE = TAB.CASELLE.length;
const CASE_TOTALI = 32;
const ALBERGHI_TOTALI = 12;
const LOG_MAX = 200;
const INCREMENTO_MINIMO_ASTA = 1;
const TENTATIVI_PRIGIONE = 3;

/** Indici delle 28 caselle acquistabili, in ordine di tabellone. */
const INDICI_ACQUISTABILI = Object.freeze(
  TAB.CASELLE.filter((c) => TAB.acquistabile(c.indice)).map((c) => c.indice),
);

/** Tutte le carte dei due mazzi indicizzate per id ('P01', 'I08', …). */
const CARTE_PER_ID = new Map([...CARTE.PROBABILITA, ...CARTE.IMPREVISTI].map((c) => [c.id, c]));

const NOMI_MAZZO = Object.freeze({ probabilita: 'Probabilità', imprevisti: 'Imprevisti' });

// ---------------------------------------------------------------------------
// Utilità generiche
// ---------------------------------------------------------------------------

/** Formatta un importo per i testi della cronaca: 1500 → "1.500 €". */
function euro(n) {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
}

/** Casella all'indice dato (oggetto di tabellone.js). */
function casella(indice) {
  return TAB.casella(indice);
}

/** Crea il contesto di un'azione a partire da { random, ora } opzionali. */
function creaContesto(contesto = {}) {
  const random = typeof contesto.random === 'function' ? contesto.random : Math.random;
  const ora = typeof contesto.ora === 'function' ? contesto.ora : Date.now;
  return { random, ora, t: ora(), eventi: [] };
}

/** Costruisce un Evento (INTERFACCE.md §6). */
function evento(tipo, giocatoreId, testo, dati, t) {
  return { t, tipo, giocatoreId: giocatoreId ?? null, testo, dati: dati || {} };
}

/** Aggiunge un evento al contesto. */
function emetti(ctx, tipo, giocatoreId, testo, dati) {
  ctx.eventi.push(evento(tipo, giocatoreId, testo, dati, ctx.t));
}

/** Mescola una copia dell'array (Fisher–Yates) con il generatore iniettato. */
function mescola(array, random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Un dado a sei facce con il generatore iniettato. */
function tiraDado(ctx) {
  const v = 1 + Math.floor(ctx.random() * 6);
  return Math.min(6, Math.max(1, v));
}

/** Giocatore con l'id dato, o null. */
function trova(stato, id) {
  return (stato.giocatori || []).find((g) => g.id === id) || null;
}

/** Nome del giocatore, oppure "la banca" per null/sconosciuto. */
function nomeDi(stato, id) {
  const g = id ? trova(stato, id) : null;
  return g ? g.nome : 'la banca';
}

/** Voce di `stato.proprieta` per un indice di casella. */
function voceDi(stato, indice) {
  return stato.proprieta[String(indice)] || null;
}

/** Garantisce i campi aggiuntivi su stati creati da versioni precedenti. */
function normalizzaStato(stato) {
  if (!Array.isArray(stato.debitiInAttesa)) stato.debitiInAttesa = [];
  if (!Array.isArray(stato.asteInAttesa)) stato.asteInAttesa = [];
  if (!stato.cartePrigioneDi || typeof stato.cartePrigioneDi !== 'object') stato.cartePrigioneDi = {};
  if (!stato.mazzi) stato.mazzi = { probabilita: [], imprevisti: [] };
  return stato;
}

/** Appende gli eventi al log mantenendo gli ultimi LOG_MAX. */
function appendiLog(stato, eventi) {
  stato.log = [...(stato.log || []), ...eventi].slice(-LOG_MAX);
}

// ---------------------------------------------------------------------------
// Gruppi, costruzioni, valori
// ---------------------------------------------------------------------------

/** Indici delle caselle del gruppo (colore, 'stazione' o 'societa'). */
function indiciGruppo(gruppo) {
  return TAB.indiciGruppo(gruppo);
}

/** Vero se `giocatoreId` possiede tutte le caselle del gruppo. */
function possiedeGruppo(stato, giocatoreId, gruppo) {
  if (!giocatoreId || !gruppo) return false;
  return indiciGruppo(gruppo).every((i) => voceDi(stato, i).proprietario === giocatoreId);
}

/** Quante caselle del gruppo possiede il giocatore (per stazioni e società). */
function quanteNelGruppo(stato, giocatoreId, gruppo) {
  return indiciGruppo(gruppo).filter((i) => voceDi(stato, i).proprietario === giocatoreId).length;
}

/** Vero se nel gruppo della casella c'è almeno una casa o un albergo. */
function gruppoHaCostruzioni(stato, indice) {
  const c = casella(indice);
  if (c.tipo !== 'proprieta') return false;
  return indiciGruppo(c.gruppo).some((i) => voceDi(stato, i).caseCostruite > 0);
}

/** Indici delle caselle possedute dal giocatore. */
function proprietaDi(stato, giocatoreId) {
  return INDICI_ACQUISTABILI.filter((i) => voceDi(stato, i).proprietario === giocatoreId);
}

/** Case e alberghi posseduti dal giocatore: { case, alberghi }. */
function contaCostruzioni(stato, giocatoreId) {
  let nCase = 0;
  let alberghi = 0;
  for (const i of proprietaDi(stato, giocatoreId)) {
    const n = voceDi(stato, i).caseCostruite;
    if (n === 5) alberghi += 1;
    else nCase += n;
  }
  return { case: nCase, alberghi };
}

/** Ricavo della vendita alla banca (metà prezzo) di tutte le costruzioni su una casella. */
function valoreVenditaCostruzioni(indice, caseCostruite) {
  const c = casella(indice);
  if (!c.costoCasa || !caseCostruite) return 0;
  return (caseCostruite * c.costoCasa) / 2; // albergo = 5 × costoCasa (4 case + 1)
}

/** Interesse del 10% sull'ipoteca, arrotondato per eccesso (INTERFACCE.md §0.3). */
function interesseIpoteca(indice) {
  return Math.ceil(casella(indice).ipoteca / 10);
}

/** Costo per togliere l'ipoteca: valore d'ipoteca + 10%. */
function costoDisipoteca(indice) {
  return casella(indice).ipoteca + interesseIpoteca(indice);
}

/**
 * Affitto dovuto per la casella `indice` (posseduta e non ipotecata).
 * opz: { moltiplicatore } per la carta "stazione più vicina" (×2),
 *      { moltiplicatoreDadi, dadi } per le società.
 * @returns {{importo: number, moltiplicatore?: number}}
 */
function calcolaAffitto(stato, indice, opz = {}) {
  const c = casella(indice);
  const voce = voceDi(stato, indice);
  const owner = voce && voce.proprietario;
  if (!owner || voce.ipotecata) return { importo: 0 };

  if (c.tipo === 'proprieta') {
    if (voce.caseCostruite > 0) return { importo: c.affitti[voce.caseCostruite] };
    if (possiedeGruppo(stato, owner, c.gruppo)) return { importo: c.affitti[0] * 2, moltiplicatore: 2 };
    return { importo: c.affitti[0] };
  }
  if (c.tipo === 'stazione') {
    const n = quanteNelGruppo(stato, owner, 'stazione');
    const base = c.affitti[Math.max(0, n - 1)];
    const m = opz.moltiplicatore || 1;
    return m > 1 ? { importo: base * m, moltiplicatore: m } : { importo: base };
  }
  if (c.tipo === 'societa') {
    const n = quanteNelGruppo(stato, owner, 'societa');
    const m = opz.moltiplicatoreDadi || c.affitti[Math.max(0, n - 1)];
    const dadi = opz.dadi || stato.dadi || [0, 0];
    return { importo: (dadi[0] + dadi[1]) * m, moltiplicatore: m };
  }
  return { importo: 0 };
}

// ---------------------------------------------------------------------------
// Fasi
// ---------------------------------------------------------------------------

/**
 * Imposta la fase "normale" del gioco. Se è aperto un debito o un'asta la
 * fase reale resta quella, e il valore diventa la fase in cui tornare dopo.
 */
function impostaFase(stato, fase) {
  if (stato.fase === 'finePartita') return;
  if (stato.debito) stato.debito.faseDopo = fase;
  else if (stato.asta) stato.asta.faseDopo = fase;
  else stato.fase = fase;
}

/** Fase dopo un acquisto/asta del giocatore di turno: rilancia se ha fatto doppio. */
function faseDopoMossa(stato) {
  return stato.turno.doppiConsecutivi > 0 ? 'daLanciare' : 'mossa';
}

// ---------------------------------------------------------------------------
// Pagamenti e debiti
// ---------------------------------------------------------------------------

/** Vero se il giocatore ha già un debito aperto o in coda. */
function haDebiti(stato, giocatoreId) {
  return (stato.debito && stato.debito.giocatoreId === giocatoreId)
    || stato.debitiInAttesa.some((d) => d.giocatoreId === giocatoreId);
}

/** Sposta denaro da un giocatore a un altro (null = banca, che assorbe o crea denaro). */
function trasferisci(stato, daId, aId, importo) {
  const da = daId ? trova(stato, daId) : null;
  const a = aId ? trova(stato, aId) : null;
  if (da) da.denaro -= importo;
  if (a && !a.fallito) a.denaro += importo;
}

const DESCRIZIONE_MOTIVO = Object.freeze({
  affitto: 'affitto',
  tassa: 'tassa',
  carta: 'carta',
  cauzione: 'cauzione',
  pagaATutti: 'carta',
  interesseScambio: 'interessi sulle ipoteche ricevute',
  interesseBancarotta: 'interessi sulle ipoteche ricevute',
});

/** Emette l'evento di un pagamento appena eseguito, col tipo adatto al motivo. */
function emettiPagamento(stato, ctx, daId, aId, importo, opz) {
  const chi = nomeDi(stato, daId);
  const verso = nomeDi(stato, aId);
  if (opz.motivo === 'affitto') {
    const dati = { daId, aId, casella: opz.casella, importo };
    if (opz.moltiplicatore) dati.moltiplicatore = opz.moltiplicatore;
    if (opz.dadi) dati.dadi = opz.dadi;
    emetti(ctx, 'affitto', daId, `${chi} paga ${euro(importo)} a ${verso} per ${casella(opz.casella).nome}`, dati);
    return;
  }
  if (opz.motivo === 'tassa') {
    emetti(ctx, 'tassa', daId, `${chi} paga ${euro(importo)} di ${casella(opz.casella).nome}`,
      { casella: opz.casella, importo });
    return;
  }
  emetti(ctx, 'pagamento', daId, `${chi} paga ${euro(importo)} a ${verso} (${DESCRIZIONE_MOTIVO[opz.motivo] || opz.motivo})`,
    { daId, aId: aId ?? null, importo, motivo: opz.motivo });
}

/**
 * Fa pagare `importo` da `daId` a `aId` (null = banca). Se il giocatore ha
 * liquidità e nessun debito precedente paga subito; altrimenti si apre (o si
 * accoda) un debito che dovrà saldare vendendo/ipotecando o con la bancarotta.
 * opz: { motivo, casella?, moltiplicatore?, dadi? }
 */
function addebita(stato, ctx, daId, aId, importo, opz) {
  if (!(importo > 0)) return;
  const g = trova(stato, daId);
  if (!g || g.fallito) return;
  const creditore = aId ? trova(stato, aId) : null;
  if (aId && (!creditore || creditore.fallito)) return;

  if (!haDebiti(stato, daId) && g.denaro >= importo) {
    trasferisci(stato, daId, aId, importo);
    emettiPagamento(stato, ctx, daId, aId, importo, opz);
    return;
  }
  apriDebito(stato, ctx, { giocatoreId: daId, creditoreId: aId ?? null, importo, motivo: opz.motivo, casella: opz.casella });
}

/** Apre un debito (fase 'debito') o lo accoda se ce n'è già uno aperto. */
function apriDebito(stato, ctx, d) {
  const g = trova(stato, d.giocatoreId);
  const voce = { giocatoreId: d.giocatoreId, creditoreId: d.creditoreId ?? null, importo: d.importo, motivo: d.motivo };
  if (Number.isInteger(d.casella)) voce.casella = d.casella;
  emetti(ctx, 'debito', g.id,
    `${g.nome} deve ${euro(d.importo)} a ${nomeDi(stato, voce.creditoreId)} ma ha solo ${euro(g.denaro)}: `
      + 'deve vendere, ipotecare, scambiare o dichiarare bancarotta',
    { creditoreId: voce.creditoreId, importo: voce.importo, motivo: voce.motivo });
  if (stato.debito || stato.asta) {
    stato.debitiInAttesa.push(voce);
    return;
  }
  attivaDebito(stato, voce, stato.fase);
}

/** Rende `voce` il debito corrente, ricordando la fase in cui tornare. */
function attivaDebito(stato, voce, faseDopo) {
  stato.debito = { ...voce, faseDopo };
  stato.fase = 'debito';
}

/**
 * Salda automaticamente il debito corrente (e i successivi in coda) finché
 * il debitore ha abbastanza denaro. Chiamata dopo ogni azione.
 */
function saldaDebiti(stato, ctx) {
  while (stato.fase === 'debito' && stato.debito) {
    const d = stato.debito;
    const g = trova(stato, d.giocatoreId);
    const creditore = d.creditoreId ? trova(stato, d.creditoreId) : null;
    if (!g || g.fallito || (d.creditoreId && (!creditore || creditore.fallito))) {
      chiudiDebito(stato, ctx);
      continue;
    }
    if (g.denaro < d.importo) break;
    trasferisci(stato, g.id, d.creditoreId, d.importo);
    emetti(ctx, 'debitoSaldato', g.id, `${g.nome} salda il debito di ${euro(d.importo)} con ${nomeDi(stato, d.creditoreId)}`,
      { creditoreId: d.creditoreId, importo: d.importo });
    chiudiDebito(stato, ctx);
  }
}

/** Chiude il debito corrente, torna alla fase precedente e prosegue la catena. */
function chiudiDebito(stato, ctx) {
  const f = stato.debito ? stato.debito.faseDopo : stato.fase;
  stato.debito = null;
  stato.fase = f || 'mossa';
  continuaCatena(stato, ctx);
}

/**
 * Dopo la chiusura di un debito o di un'asta: attiva il prossimo debito in
 * coda (scartando quelli di giocatori falliti o verso falliti), poi la
 * prossima asta in coda. La fase corrente diventa la fase di ritorno.
 */
function continuaCatena(stato, ctx) {
  if (stato.fase === 'finePartita') return;
  while (!stato.debito && !stato.asta && stato.debitiInAttesa.length > 0) {
    const v = stato.debitiInAttesa.shift();
    const g = trova(stato, v.giocatoreId);
    const creditore = v.creditoreId ? trova(stato, v.creditoreId) : null;
    if (!g || g.fallito) continue;
    if (v.creditoreId && (!creditore || creditore.fallito)) continue;
    attivaDebito(stato, v, stato.fase);
  }
  if (!stato.debito && !stato.asta && stato.asteInAttesa.length > 0) {
    avviaAsta(stato, ctx, stato.asteInAttesa.shift(), stato.fase);
  }
}

// ---------------------------------------------------------------------------
// Aste
// ---------------------------------------------------------------------------

/**
 * Avvia un'asta all'inglese per `indice`. Partecipano tutti i non falliti;
 * chi è disconnesso parte già "passato" per non bloccare la partita.
 */
function avviaAsta(stato, ctx, indice, faseDopo) {
  const vivi = stato.giocatori.filter((g) => !g.fallito);
  stato.asta = {
    casella: indice,
    offertaMassima: 0,
    migliorOfferenteId: null,
    partecipanti: vivi.map((g) => g.id),
    passati: vivi.filter((g) => g.connesso === false).map((g) => g.id),
    incrementoMinimo: INCREMENTO_MINIMO_ASTA,
    iniziataIl: ctx.t,
    faseDopo,
  };
  stato.fase = 'asta';
  emetti(ctx, 'astaInizio', null, `Asta per ${casella(indice).nome}`,
    { casella: indice, partecipanti: stato.asta.partecipanti.slice() });
  verificaChiusuraAsta(stato, ctx);
}

/** Chiude l'asta se tutti tranne il miglior offerente hanno passato (o tutti senza offerte). */
function verificaChiusuraAsta(stato, ctx) {
  const a = stato.asta;
  if (!a) return;
  const attivi = a.partecipanti.filter((id) => !a.passati.includes(id));
  if (a.migliorOfferenteId && attivi.length === 1 && attivi[0] === a.migliorOfferenteId) {
    chiudiAsta(stato, ctx, a.migliorOfferenteId);
  } else if (attivi.length === 0) {
    chiudiAsta(stato, ctx, a.migliorOfferenteId);
  }
}

/** Assegna la casella al vincitore (o la lascia alla banca) e prosegue. */
function chiudiAsta(stato, ctx, vincitoreId) {
  const a = stato.asta;
  const c = casella(a.casella);
  const g = vincitoreId ? trova(stato, vincitoreId) : null;
  const importo = g ? a.offertaMassima : 0;
  if (g && !g.fallito && g.denaro >= importo) {
    g.denaro -= importo;
    voceDi(stato, a.casella).proprietario = g.id;
    emetti(ctx, 'acquisto', g.id, `${g.nome} si aggiudica ${c.nome} all'asta per ${euro(importo)}`,
      { casella: a.casella, prezzo: importo, tramite: 'asta' });
    emetti(ctx, 'astaFine', g.id, `Asta chiusa: ${c.nome} va a ${g.nome} per ${euro(importo)}`,
      { casella: a.casella, vincitoreId: g.id, importo });
  } else {
    emetti(ctx, 'astaFine', null, `Asta chiusa senza offerte: ${c.nome} resta alla banca`,
      { casella: a.casella, vincitoreId: null, importo: 0 });
  }
  stato.asta = null;
  stato.fase = a.faseDopo || 'mossa';
  continuaCatena(stato, ctx);
}

// ---------------------------------------------------------------------------
// Turno, prigione, fine partita
// ---------------------------------------------------------------------------

/**
 * Calcola chi gioca dopo il giocatore di turno: il prossimo non fallito e
 * connesso; i disconnessi vengono saltati (elencati in `saltati`). Se nessun
 * altro è connesso si prende il prossimo non fallito (la partita lo aspetta).
 * @returns {{prossimo: string|null, saltati: string[]}}
 */
function calcolaProssimo(stato) {
  const n = stato.giocatori.length;
  const corrente = stato.turno && stato.turno.giocatoreId;
  const idx = stato.giocatori.findIndex((g) => g.id === corrente);
  const candidati = [];
  for (let passo = 1; passo <= n; passo += 1) {
    const g = stato.giocatori[(((idx + passo) % n) + n) % n];
    if (!g.fallito && g.id !== corrente) candidati.push(g);
  }
  if (candidati.length === 0) {
    const io = trova(stato, corrente);
    return { prossimo: io && !io.fallito ? io.id : null, saltati: [] };
  }
  const primoConnesso = candidati.findIndex((g) => g.connesso !== false);
  if (primoConnesso === -1) return { prossimo: candidati[0].id, saltati: [] };
  return {
    prossimo: candidati[primoConnesso].id,
    saltati: candidati.slice(0, primoConnesso).map((g) => g.id),
  };
}

/** Passa il turno al prossimo giocatore (saltando i disconnessi). */
function passaTurno(stato, ctx) {
  const { prossimo, saltati } = calcolaProssimo(stato);
  for (const id of saltati) {
    emetti(ctx, 'turnoSaltato', id, `${nomeDi(stato, id)} è disconnesso e salta il turno`,
      { giocatoreId: id, motivo: 'disconnesso' });
  }
  const numero = (stato.turno.numero || 0) + 1;
  stato.turno = { giocatoreId: prossimo, numero, doppiConsecutivi: 0, soste: [] };
  impostaFase(stato, 'daLanciare');
  emetti(ctx, 'turno', prossimo, `Turno ${numero}: tocca a ${nomeDi(stato, prossimo)}`,
    { giocatoreId: prossimo, numero });
}

/** Manda il giocatore in prigione: casella 10, niente Via, mossa finita. */
function mandaInPrigione(stato, g, ctx, motivo) {
  g.posizione = TAB.INDICE_PRIGIONE;
  g.inPrigione = true;
  g.turniInPrigione = 0;
  stato.turno.doppiConsecutivi = 0;
  impostaFase(stato, 'mossa');
  const perche = { casella: 'è finito sulla casella "In prigione!"', carta: 'per una carta', treDoppi: 'per tre doppi consecutivi' };
  emetti(ctx, 'prigione', g.id, `${g.nome} va in prigione ${perche[motivo] || ''}`.trim(), { motivo });
}

/** Se resta un solo giocatore non fallito chiude la partita. Ritorna true se finita. */
function verificaFinePartita(stato, ctx) {
  const vivi = stato.giocatori.filter((g) => !g.fallito);
  if (vivi.length > 1) return false;
  stato.fase = 'finePartita';
  stato.vincitoreId = vivi.length === 1 ? vivi[0].id : null;
  stato.asta = null;
  stato.debito = null;
  stato.scambio = null;
  stato.debitiInAttesa = [];
  stato.asteInAttesa = [];
  emetti(ctx, 'finePartita', stato.vincitoreId,
    stato.vincitoreId ? `${nomeDi(stato, stato.vincitoreId)} vince la partita!` : 'La partita è finita senza vincitori',
    { vincitoreId: stato.vincitoreId });
  return true;
}

// ---------------------------------------------------------------------------
// Carte "Uscite gratis di prigione"
// ---------------------------------------------------------------------------

/** Mazzo di appartenenza di una carta dal prefisso dell'id. */
function mazzoDiCarta(id) {
  return String(id).startsWith('P') ? 'probabilita' : 'imprevisti';
}

/** Id delle carte prigione possedute dal giocatore (Probabilità prima). */
function carteEsciGratisDi(stato, giocatoreId) {
  return Object.keys(stato.cartePrigioneDi)
    .filter((id) => stato.cartePrigioneDi[id] === giocatoreId)
    .sort();
}

/** Usa (o restituisce) una carta prigione: torna in fondo al suo mazzo. */
function restituisciCartaPrigione(stato, giocatoreId) {
  const g = trova(stato, giocatoreId);
  if (!g || g.cartePrigione <= 0) return null;
  g.cartePrigione -= 1;
  let id = carteEsciGratisDi(stato, giocatoreId)[0];
  if (id) {
    delete stato.cartePrigioneDi[id];
  } else {
    // Stato senza registro: rimette una carta esciGratis che manca dai mazzi.
    const nelMazzo = new Set([...stato.mazzi.probabilita, ...stato.mazzi.imprevisti]);
    const assegnate = new Set(Object.keys(stato.cartePrigioneDi));
    const carta = [...CARTE_PER_ID.values()].find((c) => c.effetto.tipo === 'esciGratis'
      && !nelMazzo.has(c.id) && !assegnate.has(c.id));
    id = carta ? carta.id : null;
  }
  if (id) stato.mazzi[mazzoDiCarta(id)].push(id);
  return id;
}

/** Trasferisce `n` carte prigione da un giocatore a un altro. */
function trasferisciCartePrigione(stato, daId, aId, n) {
  const da = trova(stato, daId);
  const a = trova(stato, aId);
  if (!da || !a || n <= 0) return;
  const ids = carteEsciGratisDi(stato, daId).slice(0, n);
  for (const id of ids) stato.cartePrigioneDi[id] = aId;
  da.cartePrigione -= n;
  a.cartePrigione += n;
}

module.exports = {
  // costanti
  NUMERO_CASELLE,
  CASE_TOTALI,
  ALBERGHI_TOTALI,
  LOG_MAX,
  INCREMENTO_MINIMO_ASTA,
  TENTATIVI_PRIGIONE,
  INDICI_ACQUISTABILI,
  CARTE_PER_ID,
  NOMI_MAZZO,
  TAB,
  CARTE,
  // utilità
  errore,
  euro,
  casella,
  creaContesto,
  evento,
  emetti,
  mescola,
  tiraDado,
  trova,
  nomeDi,
  voceDi,
  normalizzaStato,
  appendiLog,
  // gruppi e valori
  indiciGruppo,
  possiedeGruppo,
  quanteNelGruppo,
  gruppoHaCostruzioni,
  proprietaDi,
  contaCostruzioni,
  valoreVenditaCostruzioni,
  interesseIpoteca,
  costoDisipoteca,
  calcolaAffitto,
  // fasi, pagamenti, debiti
  impostaFase,
  faseDopoMossa,
  haDebiti,
  trasferisci,
  addebita,
  apriDebito,
  saldaDebiti,
  chiudiDebito,
  continuaCatena,
  // aste
  avviaAsta,
  verificaChiusuraAsta,
  chiudiAsta,
  // turno
  calcolaProssimo,
  passaTurno,
  mandaInPrigione,
  verificaFinePartita,
  // carte prigione
  mazzoDiCarta,
  carteEsciGratisDi,
  restituisciCartaPrigione,
  trasferisciCartePrigione,
};
