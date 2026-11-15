'use strict';

/**
 * server/gioco/motore.js
 *
 * Motore delle regole: funzione pura su StatoPartita (INTERFACCE.md §1 e §2).
 *   - creaStatoLobby(...)                         → stato in fase 'lobby'
 *   - creaPartita(...)                            → stato in fase 'daLanciare'
 *   - applicaAzione(stato, giocatoreId, azione, contesto)
 *       → { stato, eventi } oppure { errore: { codice, messaggio, dettagli? } }
 *
 * Nessuno stato interno, nessun I/O: `random` e `ora` sono iniettati.
 * Lo stato in ingresso non viene mai mutato (structuredClone).
 *
 * FASE 1 (fondamenta): dispatcher, validazioni comuni, azioniDisponibili e
 * un sottoinsieme minimo di regole (lancio, movimento, stipendio, prigione
 * base, acquisto, fine turno). Le azioni non ancora implementate ritornano
 * l'errore NON_IMPLEMENTATO. I TODO indicano dove entra la fase 2.
 */

const P = require('../protocollo');
const scambi = require('./scambi');
const bancarotta = require('./bancarotta');

// ---------------------------------------------------------------------------
// Costanti
// ---------------------------------------------------------------------------

const AZIONI = Object.freeze([
  'lanciaDadi',
  'compra',
  'rifiutaAcquisto',
  'offertaAsta',
  'passaAsta',
  'costruisci',
  'vendiCasa',
  'ipoteca',
  'disipoteca',
  'proponiScambio',
  'accettaScambio',
  'rifiutaScambio',
  'pagaCauzione',
  'usaCartaPrigione',
  'finisciTurno',
  'dichiaraBancarotta',
]);

const FASI = Object.freeze([
  'lobby',
  'daLanciare',
  'mossa',
  'daDecidereAcquisto',
  'asta',
  'debito',
  'finePartita',
]);

const AZIONI_GESTIONE = Object.freeze(['costruisci', 'vendiCasa', 'ipoteca', 'disipoteca']);

const CASE_TOTALI = 32;
const ALBERGHI_TOTALI = 12;
const NUMERO_CASELLE = 40;

/** Indici delle 28 caselle acquistabili del tabellone standard (fallback). */
const INDICI_ACQUISTABILI_STANDARD = Object.freeze([
  1, 3, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 34, 35, 37, 39,
]);

// ---------------------------------------------------------------------------
// Dati statici (tabellone.js e carte.js sono di un altro modulo: li carichiamo
// in modo tollerante così il server parte anche se non sono ancora presenti).
// ---------------------------------------------------------------------------

function requireOpzionale(percorso) {
  try {
    return require(percorso);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

let cacheDati = null;

/** Ritorna i dati di gioco con fallback minimi se i moduli dati mancano. */
function dati() {
  if (cacheDati) return cacheDati;
  const tab = requireOpzionale('./tabellone') || {};
  const carte = requireOpzionale('./carte') || {};
  const CASELLE = Array.isArray(tab.CASELLE) && tab.CASELLE.length === NUMERO_CASELLE ? tab.CASELLE : null;
  const acquistabili = CASELLE
    ? CASELLE.filter((c) => ['proprieta', 'stazione', 'societa'].includes(c.tipo)).map((c) => c.indice)
    : [...INDICI_ACQUISTABILI_STANDARD];
  cacheDati = {
    CASELLE,
    acquistabili,
    STIPENDIO_VIA: tab.STIPENDIO_VIA ?? 200,
    INDICE_VIA: tab.INDICE_VIA ?? 0,
    INDICE_PRIGIONE: tab.INDICE_PRIGIONE ?? 10,
    INDICE_VAI_IN_PRIGIONE: tab.INDICE_VAI_IN_PRIGIONE ?? 30,
    CAUZIONE_PRIGIONE: tab.CAUZIONE_PRIGIONE ?? 50,
    PROBABILITA: Array.isArray(carte.PROBABILITA) ? carte.PROBABILITA : [],
    IMPREVISTI: Array.isArray(carte.IMPREVISTI) ? carte.IMPREVISTI : [],
  };
  return cacheDati;
}

/**
 * Casella all'indice dato. Senza tabellone.js ritorna un segnaposto con
 * prezzo fisso (100 €) per le caselle acquistabili, così il motore resta
 * utilizzabile in modalità degradata.
 */
function casella(indice) {
  const d = dati();
  if (d.CASELLE) return d.CASELLE[indice];
  const acquistabile = d.acquistabili.includes(indice);
  return {
    indice,
    tipo: acquistabile ? 'proprieta' : 'altro',
    nome: `Casella ${indice}`,
    gruppo: null,
    prezzo: acquistabile ? 100 : null,
    affitti: null,
    costoCasa: null,
    importoTassa: null,
    ipoteca: acquistabile ? 50 : null,
  };
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function errore(codice, dettagli) {
  const out = { codice, messaggio: P.ERRORI[codice] || codice };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return { errore: out };
}

function evento(tipo, giocatoreId, testo, datiEvento, t) {
  return { t, tipo, giocatoreId: giocatoreId ?? null, testo, dati: datiEvento || {} };
}

function mescola(array, random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function proprietaIniziali() {
  const out = {};
  for (const i of dati().acquistabili) {
    out[String(i)] = { proprietario: null, caseCostruite: 0, ipotecata: false };
  }
  return out;
}

function giocatoreBase(g, denaro) {
  return {
    id: g.id,
    nome: g.nome,
    colore: g.colore,
    denaro,
    posizione: 0,
    inPrigione: false,
    turniInPrigione: 0,
    cartePrigione: 0,
    connesso: g.connesso !== false,
    fallito: false,
  };
}

function trovaGiocatore(stato, id) {
  return (stato.giocatori || []).find((g) => g.id === id) || null;
}

function nomeDi(stato, id) {
  const g = trovaGiocatore(stato, id);
  return g ? g.nome : 'Banca';
}

/** Prossimo giocatore non fallito dopo quello di turno (o il primo, in lobby). */
function prossimoGiocatore(stato) {
  const vivi = stato.giocatori.filter((g) => !g.fallito);
  if (vivi.length === 0) return null;
  const corrente = stato.turno && stato.turno.giocatoreId;
  const idx = stato.giocatori.findIndex((g) => g.id === corrente);
  for (let passo = 1; passo <= stato.giocatori.length; passo += 1) {
    const g = stato.giocatori[(idx + passo) % stato.giocatori.length];
    if (!g.fallito) return g.id;
  }
  return vivi[0].id;
}

/** Copia dello stato destinata ai client: senza mazzi e contatori interni. */
function statoPubblico(stato) {
  const { mazzi, contatoreScambi, ...pubblico } = stato;
  void mazzi;
  void contatoreScambi;
  return structuredClone(pubblico);
}

// ---------------------------------------------------------------------------
// Creazione stato
// ---------------------------------------------------------------------------

/**
 * Stato in fase 'lobby' con lo stesso shape della partita.
 * @param {{codice: string, hostId: string|null, giocatori: object[], ora?: Function}} o
 */
function creaStatoLobby(o) {
  if (!o || typeof o.codice !== 'string') throw new TypeError('creaStatoLobby: codice obbligatorio');
  const ora = typeof o.ora === 'function' ? o.ora : Date.now;
  const t = ora();
  return {
    versione: 0,
    codice: o.codice,
    hostId: o.hostId ?? null,
    fase: 'lobby',
    creataIl: t,
    aggiornataIl: t,
    giocatori: (o.giocatori || []).map((g) => giocatoreBase(g, 0)),
    turno: { giocatoreId: null, numero: 0, doppiConsecutivi: 0 },
    dadi: null,
    proprieta: proprietaIniziali(),
    caseDisponibili: CASE_TOTALI,
    alberghiDisponibili: ALBERGHI_TOTALI,
    asta: null,
    scambio: null,
    debito: null,
    mazzi: { probabilita: [], imprevisti: [] },
    log: [],
    vincitoreId: null,
    contatoreScambi: 0,
  };
}

/**
 * Crea una partita pronta al primo lancio.
 * @param {{codice: string, hostId: string, giocatori: object[], random?: Function, ora?: Function, opzioni?: object}} o
 */
function creaPartita(o) {
  if (!o || typeof o !== 'object') throw new TypeError('creaPartita: opzioni mancanti');
  if (typeof o.codice !== 'string') throw new TypeError('creaPartita: codice obbligatorio');
  if (!Array.isArray(o.giocatori)) throw new TypeError('creaPartita: giocatori deve essere un array');
  if (o.giocatori.length < P.LIMITI.MIN_GIOCATORI || o.giocatori.length > P.LIMITI.MAX_GIOCATORI) {
    throw new TypeError(`creaPartita: servono da ${P.LIMITI.MIN_GIOCATORI} a ${P.LIMITI.MAX_GIOCATORI} giocatori`);
  }
  const ids = new Set(o.giocatori.map((g) => g && g.id));
  if (ids.size !== o.giocatori.length || ids.has(undefined)) {
    throw new TypeError('creaPartita: id giocatore mancanti o duplicati');
  }

  const random = typeof o.random === 'function' ? o.random : Math.random;
  const ora = typeof o.ora === 'function' ? o.ora : Date.now;
  const opzioni = { denaroIniziale: 1500, ordineCasuale: true, ...(o.opzioni || {}) };
  const d = dati();

  const ordine = opzioni.ordineCasuale ? mescola(o.giocatori, random) : o.giocatori.slice();
  const stato = creaStatoLobby({ codice: o.codice, hostId: o.hostId ?? ordine[0].id, giocatori: ordine, ora });
  stato.giocatori = ordine.map((g) => giocatoreBase(g, opzioni.denaroIniziale));
  stato.fase = 'daLanciare';
  stato.turno = { giocatoreId: ordine[0].id, numero: 1, doppiConsecutivi: 0 };
  stato.mazzi = {
    probabilita: mescola(d.PROBABILITA.map((c) => c.id), random),
    imprevisti: mescola(d.IMPREVISTI.map((c) => c.id), random),
  };

  const t = ora();
  stato.log.push(evento(
    'partitaIniziata',
    null,
    `La partita inizia: tocca a ${stato.giocatori[0].nome}`,
    { ordine: stato.giocatori.map((g) => g.id), denaroIniziale: opzioni.denaroIniziale },
    t,
  ));
  stato.log.push(evento('turno', ordine[0].id, `Turno 1: ${stato.giocatori[0].nome}`, { numero: 1 }, t));
  return stato;
}

// ---------------------------------------------------------------------------
// Azioni disponibili (tabella INTERFACCE.md §1.2 / §2.4)
// ---------------------------------------------------------------------------

/**
 * I tipi di azione che `giocatoreId` può eseguire adesso. Non valuta i
 * parametri (es. quale casella) né la liquidità: quello lo fa il gestore.
 */
function azioniDisponibili(stato, giocatoreId) {
  const g = trovaGiocatore(stato, giocatoreId);
  if (!g || g.fallito) return [];
  const { fase } = stato;
  if (fase === 'lobby' || fase === 'finePartita') return [];

  const mio = stato.turno.giocatoreId === giocatoreId;
  const out = new Set();

  if (fase === 'daLanciare' && mio) {
    out.add('lanciaDadi');
    if (g.inPrigione) {
      out.add('pagaCauzione');
      if (g.cartePrigione > 0) out.add('usaCartaPrigione');
    }
  }
  if (fase === 'mossa' && mio) out.add('finisciTurno');
  if (fase === 'daDecidereAcquisto' && mio) {
    out.add('compra');
    out.add('rifiutaAcquisto');
  }
  if (['daLanciare', 'mossa', 'daDecidereAcquisto'].includes(fase) && mio) {
    AZIONI_GESTIONE.forEach((a) => out.add(a));
  }
  if (fase === 'asta' && stato.asta) {
    const partecipa = stato.asta.partecipanti.includes(giocatoreId);
    const passato = stato.asta.passati.includes(giocatoreId);
    if (partecipa && !passato) {
      out.add('offertaAsta');
      if (stato.asta.migliorOfferenteId !== giocatoreId) out.add('passaAsta');
    }
    if (partecipa) {
      out.add('vendiCasa');
      out.add('ipoteca');
    }
  }
  if (fase === 'debito' && stato.debito && stato.debito.giocatoreId === giocatoreId) {
    out.add('vendiCasa');
    out.add('ipoteca');
    out.add('dichiaraBancarotta');
  }
  if (fase !== 'asta') {
    if (!stato.scambio) out.add('proponiScambio');
    else {
      if (stato.scambio.aId === giocatoreId) {
        out.add('accettaScambio');
        out.add('rifiutaScambio');
      }
      if (stato.scambio.daId === giocatoreId) out.add('rifiutaScambio');
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Primitive di gioco usate dai gestori
// ---------------------------------------------------------------------------

/** Sposta il giocatore in avanti di `passi`, gestendo lo stipendio del Via. */
function avanza(stato, g, passi, ctx, causa) {
  const d = dati();
  const da = g.posizione;
  const a = (da + passi) % NUMERO_CASELLE;
  const passatoDalVia = da + passi >= NUMERO_CASELLE;
  g.posizione = a;
  ctx.eventi.push(evento('movimento', g.id, `${g.nome} si sposta da ${casella(da).nome} a ${casella(a).nome}`,
    { da, a, passi, passatoDalVia, causa }, ctx.t));
  if (passatoDalVia) {
    g.denaro += d.STIPENDIO_VIA;
    ctx.eventi.push(evento('passaggioVia', g.id, `${g.nome} passa dal Via e riscuote ${d.STIPENDIO_VIA} €`,
      { importo: d.STIPENDIO_VIA }, ctx.t));
  }
}

function mandaInPrigione(stato, g, ctx, motivo) {
  const d = dati();
  g.posizione = d.INDICE_PRIGIONE;
  g.inPrigione = true;
  g.turniInPrigione = 0;
  stato.turno.doppiConsecutivi = 0;
  stato.fase = 'mossa';
  ctx.eventi.push(evento('prigione', g.id, `${g.nome} va in prigione`, { motivo }, ctx.t));
}

/**
 * Risolve la casella su cui il giocatore è appena arrivato.
 * FASE 1: casella libera acquistabile → daDecidereAcquisto; 'vaiInPrigione' →
 * prigione; tutto il resto → nessun effetto (fase 'mossa').
 * TODO fase 2: affitti, tasse, carte Probabilità/Imprevisti, debito.
 */
function risolviCasella(stato, g, ctx, doppio) {
  const d = dati();
  const c = casella(g.posizione);
  const voce = stato.proprieta[String(g.posizione)];

  if (g.posizione === d.INDICE_VAI_IN_PRIGIONE) {
    mandaInPrigione(stato, g, ctx, 'casella');
    return;
  }
  if (voce && voce.proprietario === null && c.prezzo !== null && c.prezzo !== undefined) {
    stato.fase = 'daDecidereAcquisto';
    return;
  }
  // TODO fase 2: affitto se posseduta da altri e non ipotecata; tassa; carte.
  stato.fase = doppio ? 'daLanciare' : 'mossa';
}

function passaTurno(stato, ctx) {
  const prossimo = prossimoGiocatore(stato);
  stato.turno = { giocatoreId: prossimo, numero: stato.turno.numero + 1, doppiConsecutivi: 0 };
  stato.fase = 'daLanciare';
  ctx.eventi.push(evento('turno', prossimo, `Turno ${stato.turno.numero}: ${nomeDi(stato, prossimo)}`,
    { numero: stato.turno.numero }, ctx.t));
}

// ---------------------------------------------------------------------------
// Gestori delle azioni: (stato clonato, giocatore, azione, ctx) → undefined | {errore}
// ---------------------------------------------------------------------------

function nonImplementato(tipo) {
  return () => errore('NON_IMPLEMENTATO', { azione: tipo });
}

const GESTORI = {
  lanciaDadi(stato, g, azione, ctx) {
    const d = dati();
    const d1 = 1 + Math.floor(ctx.random() * 6);
    const d2 = 1 + Math.floor(ctx.random() * 6);
    const doppio = d1 === d2;
    stato.dadi = [d1, d2];

    if (g.inPrigione) {
      ctx.eventi.push(evento('dadi', g.id, `${g.nome} lancia ${d1} e ${d2} dalla prigione`,
        { dadi: [d1, d2], doppio, inPrigione: true, doppiConsecutivi: 0 }, ctx.t));
      if (doppio) {
        g.inPrigione = false;
        g.turniInPrigione = 0;
        ctx.eventi.push(evento('uscitaPrigione', g.id, `${g.nome} esce di prigione con un doppio`, { modo: 'doppio' }, ctx.t));
        avanza(stato, g, d1 + d2, ctx, 'dadi');
        risolviCasella(stato, g, ctx, false); // dalla prigione non si rilancia
        if (stato.fase === 'daLanciare') stato.fase = 'mossa';
        return undefined;
      }
      g.turniInPrigione += 1;
      if (g.turniInPrigione >= 3) {
        if (g.denaro < d.CAUZIONE_PRIGIONE) {
          // TODO fase 2: aprire un debito verso la banca invece di rifiutare.
          return errore('NON_IMPLEMENTATO', { motivo: 'debito cauzione' });
        }
        g.denaro -= d.CAUZIONE_PRIGIONE;
        g.inPrigione = false;
        g.turniInPrigione = 0;
        ctx.eventi.push(evento('pagamento', g.id, `${g.nome} paga ${d.CAUZIONE_PRIGIONE} € di cauzione`,
          { daId: g.id, aId: null, importo: d.CAUZIONE_PRIGIONE, motivo: 'cauzione' }, ctx.t));
        ctx.eventi.push(evento('uscitaPrigione', g.id, `${g.nome} esce di prigione al terzo turno`, { modo: 'terzoTurno' }, ctx.t));
        avanza(stato, g, d1 + d2, ctx, 'dadi');
        risolviCasella(stato, g, ctx, false);
        if (stato.fase === 'daLanciare') stato.fase = 'mossa';
        return undefined;
      }
      stato.fase = 'mossa';
      return undefined;
    }

    const doppiConsecutivi = doppio ? stato.turno.doppiConsecutivi + 1 : 0;
    stato.turno.doppiConsecutivi = doppiConsecutivi;
    ctx.eventi.push(evento('dadi', g.id, `${g.nome} lancia ${d1} e ${d2}${doppio ? ' (doppio!)' : ''}`,
      { dadi: [d1, d2], doppio, inPrigione: false, doppiConsecutivi }, ctx.t));

    if (doppiConsecutivi >= 3) {
      mandaInPrigione(stato, g, ctx, 'treDoppi');
      return undefined;
    }
    avanza(stato, g, d1 + d2, ctx, 'dadi');
    risolviCasella(stato, g, ctx, doppio);
    return undefined;
  },

  compra(stato, g, azione, ctx) {
    const c = casella(g.posizione);
    const voce = stato.proprieta[String(g.posizione)];
    if (!voce || voce.proprietario !== null || c.prezzo == null) return errore('CASELLA_NON_VALIDA');
    if (g.denaro < c.prezzo) return errore('FONDI_INSUFFICIENTI', { prezzo: c.prezzo, denaro: g.denaro });
    g.denaro -= c.prezzo;
    voce.proprietario = g.id;
    ctx.eventi.push(evento('acquisto', g.id, `${g.nome} compra ${c.nome} per ${c.prezzo} €`,
      { casella: g.posizione, prezzo: c.prezzo, tramite: 'banca' }, ctx.t));
    stato.fase = stato.turno.doppiConsecutivi > 0 ? 'daLanciare' : 'mossa';
    return undefined;
  },

  // TODO fase 2: avvio dell'asta (INTERFACCE.md §1.6).
  rifiutaAcquisto: nonImplementato('rifiutaAcquisto'),
  offertaAsta: nonImplementato('offertaAsta'),
  passaAsta: nonImplementato('passaAsta'),

  // TODO fase 2: costruzioni e ipoteche (INTERFACCE.md §8.4, §8.5).
  costruisci: nonImplementato('costruisci'),
  vendiCasa: nonImplementato('vendiCasa'),
  ipoteca: nonImplementato('ipoteca'),
  disipoteca: nonImplementato('disipoteca'),

  // TODO fase 2: scambi tramite ./scambi.js.
  proponiScambio(stato, g, azione) {
    const esito = scambi.validaProposta(stato, g.id, azione);
    if (esito.errore) return esito;
    return errore('NON_IMPLEMENTATO', { azione: 'proponiScambio' });
  },
  accettaScambio: nonImplementato('accettaScambio'),
  rifiutaScambio: nonImplementato('rifiutaScambio'),

  pagaCauzione(stato, g, azione, ctx) {
    const d = dati();
    if (!g.inPrigione) return errore('NON_IN_PRIGIONE');
    if (g.denaro < d.CAUZIONE_PRIGIONE) return errore('FONDI_INSUFFICIENTI');
    g.denaro -= d.CAUZIONE_PRIGIONE;
    g.inPrigione = false;
    g.turniInPrigione = 0;
    ctx.eventi.push(evento('pagamento', g.id, `${g.nome} paga ${d.CAUZIONE_PRIGIONE} € di cauzione`,
      { daId: g.id, aId: null, importo: d.CAUZIONE_PRIGIONE, motivo: 'cauzione' }, ctx.t));
    ctx.eventi.push(evento('uscitaPrigione', g.id, `${g.nome} esce di prigione pagando la cauzione`, { modo: 'cauzione' }, ctx.t));
    return undefined;
  },

  // TODO fase 2: rimettere la carta in coda al mazzo giusto.
  usaCartaPrigione: nonImplementato('usaCartaPrigione'),

  finisciTurno(stato, g, azione, ctx) {
    passaTurno(stato, ctx);
    return undefined;
  },

  // TODO fase 2: bancarotta tramite ./bancarotta.js (liquida).
  dichiaraBancarotta(stato, g) {
    void bancarotta;
    return errore('NON_IMPLEMENTATO', { azione: 'dichiaraBancarotta', giocatoreId: g.id });
  },
};

// ---------------------------------------------------------------------------
// applicaAzione
// ---------------------------------------------------------------------------

const AZIONI_DI_TURNO = new Set([
  'lanciaDadi', 'compra', 'rifiutaAcquisto', 'costruisci', 'disipoteca',
  'pagaCauzione', 'usaCartaPrigione', 'finisciTurno',
]);

/**
 * Applica un'azione e ritorna il nuovo stato con gli eventi prodotti.
 *
 * @param {object} stato         StatoPartita (non mutato)
 * @param {string} giocatoreId   chi agisce (ricavato dal server dal socket)
 * @param {object} azione        { tipo, ...parametri }
 * @param {{random?: Function, ora?: Function}} [contesto]
 * @returns {{stato: object, eventi: object[]} | {errore: {codice: string, messaggio: string, dettagli?: object}}}
 */
function applicaAzione(stato, giocatoreId, azione, contesto = {}) {
  if (!stato || typeof stato !== 'object') return errore('PARAMETRI_NON_VALIDI', { motivo: 'stato mancante' });
  if (!azione || typeof azione !== 'object' || typeof azione.tipo !== 'string') {
    return errore('AZIONE_NON_VALIDA');
  }
  if (!AZIONI.includes(azione.tipo)) return errore('AZIONE_NON_VALIDA', { tipo: azione.tipo });

  const g0 = trovaGiocatore(stato, giocatoreId);
  if (!g0) return errore('GIOCATORE_NON_VALIDO');
  if (g0.fallito) return errore('GIOCATORE_FALLITO');
  if (stato.fase === 'lobby' || stato.fase === 'finePartita') return errore('FASE_ERRATA', { fase: stato.fase });

  const ammesse = azioniDisponibili(stato, giocatoreId);
  if (!ammesse.includes(azione.tipo)) {
    if (AZIONI_DI_TURNO.has(azione.tipo) && stato.turno.giocatoreId !== giocatoreId) {
      return errore('NON_IL_TUO_TURNO');
    }
    return errore('FASE_ERRATA', { fase: stato.fase, azione: azione.tipo });
  }

  const nuovo = structuredClone(stato);
  const g = trovaGiocatore(nuovo, giocatoreId);
  const ctx = {
    random: typeof contesto.random === 'function' ? contesto.random : Math.random,
    ora: typeof contesto.ora === 'function' ? contesto.ora : Date.now,
    eventi: [],
  };
  ctx.t = ctx.ora();

  const esito = GESTORI[azione.tipo](nuovo, g, azione, ctx);
  if (esito && esito.errore) return esito;

  // TODO fase 2: saldo automatico del debito, verifica fine partita.

  nuovo.versione = (stato.versione || 0) + 1;
  nuovo.aggiornataIl = ctx.t;
  nuovo.log = [...(nuovo.log || []), ...ctx.eventi].slice(-P.LIMITI.LOG_MAX);
  return { stato: nuovo, eventi: ctx.eventi };
}

module.exports = {
  AZIONI,
  FASI,
  CASE_TOTALI,
  ALBERGHI_TOTALI,
  creaStatoLobby,
  creaPartita,
  applicaAzione,
  azioniDisponibili,
  statoPubblico,
  prossimoGiocatore,
  // esposti per i test
  _interni: { dati, casella, mescola, evento, proprietaIniziali },
};
