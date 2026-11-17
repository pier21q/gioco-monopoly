'use strict';

/**
 * server/gioco/motore.js
 *
 * Motore delle regole: funzione pura su StatoPartita (INTERFACCE.md §1 e §2).
 *   - creaStatoLobby(...)                         → stato in fase 'lobby'
 *   - creaPartita(...)                            → stato in fase 'daLanciare'
 *       (o 'ordine', con `opzioni.lancioIniziale`: prima si decide chi comincia)
 *   - applicaAzione(stato, giocatoreId, azione, contesto)
 *       → { stato, eventi } oppure { errore: { codice, messaggio, dettagli? } }
 *   - gestisciDisconnessione(stato, giocatoreId, contesto)
 *       → { stato, eventi }: fa avanzare la partita se un disconnesso la blocca
 *
 * Nessuno stato interno, nessun I/O: `random` e `ora` sono iniettati.
 * Lo stato in ingresso non viene mai mutato (structuredClone); in caso di
 * errore non si produce nessun evento.
 *
 * Le primitive condivise (pagamenti, debiti, aste, turno) sono in nucleo.js;
 * gli scambi in scambi.js; la bancarotta in bancarotta.js.
 */

const N = require('./nucleo');
const scambi = require('./scambi');
const bancarotta = require('./bancarotta');
const ordine = require('./ordine');
const REG = require('./regole');

const { errore, euro, casella, emetti, trova, nomeDi, voceDi, TAB } = N;

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
  'abbandona',
]);

const FASI = Object.freeze([
  'lobby',
  'ordine',
  'daLanciare',
  'mossa',
  'daDecidereAcquisto',
  'lancioAffitto',
  'asta',
  'debito',
  'finePartita',
]);

/** Fasi in cui il giocatore di turno può gestire il proprio patrimonio. */
const FASI_GESTIONE = Object.freeze(['daLanciare', 'mossa', 'daDecidereAcquisto']);

/**
 * Regola di costruzione scelta dall'host: 'libera' (classica: su ogni gruppo
 * completo, nel proprio turno) oppure 'sosta' (solo sul gruppo della casella
 * su cui la pedina si è fermata in questo turno).
 */
const COSTRUZIONE = Object.freeze(['libera', 'sosta']);

/**
 * Con la regola 'sosta': true se in questo turno g si è fermato su una casella
 * del gruppo. Valgono tutte le soste del turno (`turno.soste`, anche quella
 * prima di un doppio) e la casella dove si trova adesso, se ci è arrivato in
 * questo turno: prima del primo lancio la pedina è ancora dove era arrivata
 * al turno scorso.
 */
function fermoSulGruppo(stato, g, gruppo) {
  if (Array.isArray(stato.turno.soste) && stato.turno.soste.includes(gruppo)) return true;
  const qui = TAB.CASELLE[g.posizione];
  if (!qui || qui.tipo !== 'proprieta' || qui.gruppo !== gruppo) return false;
  return stato.fase !== 'daLanciare' || stato.turno.doppiConsecutivi > 0;
}

/** Ricorda che la pedina di turno si è fermata su una casella del gruppo (regola 'sosta'). */
function registraSosta(stato, g, c) {
  if (c.tipo !== 'proprieta' || !stato.turno || stato.turno.giocatoreId !== g.id) return;
  if (!Array.isArray(stato.turno.soste)) stato.turno.soste = [];
  if (!stato.turno.soste.includes(c.gruppo)) stato.turno.soste.push(c.gruppo);
}

const { CASE_TOTALI, ALBERGHI_TOTALI, NUMERO_CASELLE } = N;

// ---------------------------------------------------------------------------
// Creazione stato
// ---------------------------------------------------------------------------

/** Tutte le 28 caselle acquistabili alla banca, senza costruzioni né ipoteche. */
function proprietaIniziali() {
  const out = {};
  for (const i of N.INDICI_ACQUISTABILI) {
    out[String(i)] = { proprietario: null, caseCostruite: 0, ipotecata: false };
  }
  return out;
}

/** Giocatore nello shape di INTERFACCE.md §1.3 con il denaro dato. */
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
    turno: { giocatoreId: null, numero: 0, doppiConsecutivi: 0, soste: [] },
    dadi: null,
    proprieta: proprietaIniziali(),
    caseDisponibili: CASE_TOTALI,
    alberghiDisponibili: ALBERGHI_TOTALI,
    asta: null,
    scambio: null,
    debito: null,
    debitiInAttesa: [],
    asteInAttesa: [],
    // Carta "società più vicina": chi deve lanciare i dadi per l'affitto (fase 'lancioAffitto').
    lancioAffitto: null,
    cartePrigioneDi: {},
    mazzi: { probabilita: [], imprevisti: [] },
    log: [],
    vincitoreId: null,
    contatoreScambi: 0,
    regole: { ...REG.PREDEFINITE },
    // In sala d'attesa: true dopo che host o admin hanno compilato la finestra delle regole.
    regoleImpostate: false,
    ordine: null,
    // Piatto del Parcheggio gratuito (variante `regole.parcheggio`).
    piatto: 0,
  };
}

/**
 * Crea una partita pronta al primo lancio: denaro iniziale, ordine di turno
 * (mescolato se `opzioni.ordineCasuale`), mazzi mescolati. Con
 * `opzioni.lancioIniziale` la partita parte invece in fase 'ordine': tutti
 * lanciano i dadi, nell'ordine ricevuto, per decidere chi comincia (ordine.js).
 * @param {{codice: string, hostId: string, giocatori: object[], random?: Function, ora?: Function, opzioni?: object}} o
 */
function creaPartita(o) {
  if (!o || typeof o !== 'object') throw new TypeError('creaPartita: opzioni mancanti');
  if (typeof o.codice !== 'string') throw new TypeError('creaPartita: codice obbligatorio');
  if (!Array.isArray(o.giocatori)) throw new TypeError('creaPartita: giocatori deve essere un array');
  if (o.giocatori.length < 2 || o.giocatori.length > 6) {
    throw new TypeError('creaPartita: servono da 2 a 6 giocatori');
  }
  const ids = new Set(o.giocatori.map((g) => g && g.id));
  if (ids.size !== o.giocatori.length || ids.has(undefined)) {
    throw new TypeError('creaPartita: id giocatore mancanti o duplicati');
  }

  const random = typeof o.random === 'function' ? o.random : Math.random;
  const ora = typeof o.ora === 'function' ? o.ora : Date.now;
  const opzioni = { ...REG.PREDEFINITE, ordineCasuale: true, lancioIniziale: false, ...(o.opzioni || {}) };
  if (!COSTRUZIONE.includes(opzioni.costruzione)) {
    throw new TypeError("creaPartita: costruzione deve essere 'libera' o 'sosta'");
  }
  if (!Number.isInteger(opzioni.denaroIniziale) || opzioni.denaroIniziale < 0) {
    throw new TypeError('creaPartita: denaroIniziale deve essere un intero >= 0');
  }
  // Le altre regole devono avere uno dei valori del catalogo (regole.js).
  for (const r of REG.REGOLE) {
    if (r.chiave === 'denaroIniziale') continue;
    if (!r.valori.some((v) => v.valore === opzioni[r.chiave])) {
      throw new TypeError(`creaPartita: valore non ammesso per la regola ${r.chiave}`);
    }
  }
  const regole = Object.fromEntries(REG.REGOLE.map((r) => [r.chiave, opzioni[r.chiave]]));

  const lancioIniziale = opzioni.lancioIniziale === true;
  const fila = opzioni.ordineCasuale && !lancioIniziale ? N.mescola(o.giocatori, random) : o.giocatori.slice();
  const stato = creaStatoLobby({ codice: o.codice, hostId: o.hostId ?? fila[0].id, giocatori: fila, ora });
  stato.giocatori = fila.map((g) => giocatoreBase(g, opzioni.denaroIniziale));
  stato.regole = regole;
  stato.regoleImpostate = true;
  stato.fase = 'daLanciare';
  stato.turno = { giocatoreId: fila[0].id, numero: 1, doppiConsecutivi: 0, soste: [] };
  stato.mazzi = {
    probabilita: N.mescola(N.CARTE.PROBABILITA.map((c) => c.id), random),
    imprevisti: N.mescola(N.CARTE.IMPREVISTI.map((c) => c.id), random),
  };

  const t = ora();
  const primo = stato.giocatori[0];
  const dati = {
    ordine: stato.giocatori.map((g) => g.id),
    denaroIniziale: opzioni.denaroIniziale,
    costruzione: opzioni.costruzione,
    regole: { ...regole },
    lancioIniziale,
  };
  const distribuite = distribuisciProprieta(stato, regole.proprietaIniziali, random);
  if (lancioIniziale) {
    ordine.avvia(stato);
    stato.log.push(N.evento('partitaIniziata', null,
      `La partita inizia: tutti lanciano i dadi, chi fa di più comincia. Primo a lanciare: ${primo.nome}`, dati, t));
  } else {
    stato.log.push(N.evento('partitaIniziata', null, `La partita inizia: tocca ${N.aChi(primo.nome)}`, dati, t));
  }
  for (const [id, caselle] of distribuite) {
    stato.log.push(N.evento('proprietaIniziali', id,
      `${N.nomeDi(stato, id)} riceve ${caselle.map((i) => casella(i).nome).join(', ')}`, { caselle }, t));
  }
  if (!lancioIniziale) {
    stato.log.push(N.evento('turno', primo.id, `Turno 1: tocca ${N.aChi(primo.nome)}`, { giocatoreId: primo.id, numero: 1 }, t));
  }
  return stato;
}

/** Gruppo di una casella acquistabile: il colore, oppure 'stazione' / 'societa'. */
function gruppoDi(indice) {
  const c = casella(indice);
  return c.tipo === 'proprieta' ? c.gruppo : c.tipo;
}

/**
 * Regola `proprietaIniziali`: dà `quante` proprietà a caso a ogni giocatore,
 * a giro, senza mai completare un gruppo (niente case dal primo turno).
 * @returns {Map<string, number[]>} caselle ricevute da ciascuno
 */
function distribuisciProprieta(stato, quante, random) {
  const ricevute = new Map();
  if (!(quante > 0)) return ricevute;
  const mazzo = N.mescola(N.INDICI_ACQUISTABILI, random);
  const tutteDelGruppo = (g) => N.INDICI_ACQUISTABILI.filter((i) => gruppoDi(i) === g);
  for (let giro = 0; giro < quante; giro += 1) {
    for (const g of stato.giocatori) {
      const k = mazzo.findIndex((i) => {
        const mie = [...(ricevute.get(g.id) || []), i];
        return !tutteDelGruppo(gruppoDi(i)).every((x) => mie.includes(x));
      });
      if (k === -1) continue;
      const [i] = mazzo.splice(k, 1);
      voceDi(stato, i).proprietario = g.id;
      ricevute.set(g.id, [...(ricevute.get(g.id) || []), i]);
    }
  }
  for (const caselle of ricevute.values()) caselle.sort((a, b) => a - b);
  return ricevute;
}

// ---------------------------------------------------------------------------
// Esportazioni di comodo
// ---------------------------------------------------------------------------

/** Prossimo giocatore non fallito (e connesso, se possibile) dopo quello di turno. */
function prossimoGiocatore(stato) {
  return N.calcolaProssimo(stato).prossimo;
}

/**
 * Copia dello stato destinata ai client: senza mazzi e contatori interni, con
 * `azioni` = { giocatoreId: [tipi ammessi adesso] } calcolato dal motore, così
 * il client non deve ricopiare le regole per sapere quali pulsanti attivare.
 */
function statoPubblico(stato) {
  const pubblico = structuredClone(stato);
  delete pubblico.mazzi;
  delete pubblico.contatoreScambi;
  pubblico.azioni = {};
  for (const g of stato.giocatori || []) pubblico.azioni[g.id] = azioniDisponibili(stato, g.id);
  return pubblico;
}

// ---------------------------------------------------------------------------
// Permessi: chi può fare cosa e quando (INTERFACCE.md §1.2 / §2.4)
// ---------------------------------------------------------------------------

/** Frase che spiega la fase corrente, per i messaggi di FASE_ERRATA. */
function descriviFase(stato) {
  const diTurno = nomeDi(stato, stato.turno && stato.turno.giocatoreId);
  switch (stato.fase) {
    case 'lobby': return 'la partita non è ancora iniziata';
    case 'ordine': return `si lanciano i dadi per decidere chi comincia (tocca ${N.aChi(diTurno)})`;
    case 'finePartita': return 'la partita è finita';
    case 'daLanciare': return `${diTurno} deve ancora lanciare i dadi`;
    case 'mossa': return `${diTurno} ha già lanciato i dadi e deve finire il turno`;
    case 'daDecidereAcquisto':
      return `${diTurno} deve decidere se comprare ${casella(trova(stato, stato.turno.giocatoreId).posizione).nome}`;
    case 'lancioAffitto':
      return `${diTurno} deve lanciare i dadi per l'affitto di ${casella((stato.lancioAffitto || {}).casella ?? trova(stato, stato.turno.giocatoreId).posizione).nome}`;
    case 'asta': return `è in corso l'asta per ${casella(stato.asta.casella).nome}`;
    case 'debito':
      return `${nomeDi(stato, stato.debito.giocatoreId)} deve prima saldare un debito di ${euro(stato.debito.importo)}`;
    default: return `fase ${stato.fase}`;
  }
}

/** Errore FASE_ERRATA con la spiegazione della fase corrente. */
function faseErrata(stato, tipo) {
  return errore('FASE_ERRATA', `Azione non ammessa adesso: ${descriviFase(stato)}`, { fase: stato.fase, azione: tipo });
}

/** Errore NON_IL_TUO_TURNO con il nome di chi deve giocare. */
function nonIlTuoTurno(stato) {
  return errore('NON_IL_TUO_TURNO', `Non è il tuo turno: tocca ${N.aChi(nomeDi(stato, stato.turno.giocatoreId))}`);
}

/** Richiede giocatore di turno e una delle fasi indicate. */
function richiediTurno(stato, g, tipo, fasi) {
  if (stato.turno.giocatoreId !== g.id) return nonIlTuoTurno(stato);
  if (!fasi.includes(stato.fase)) return faseErrata(stato, tipo);
  return null;
}

/** Richiede che g partecipi all'asta in corso e non abbia passato. */
function richiediAstaAttiva(stato, g, tipo) {
  if (stato.fase !== 'asta' || !stato.asta) return faseErrata(stato, tipo);
  if (!stato.asta.partecipanti.includes(g.id)) {
    return errore('GIOCATORE_NON_VALIDO', 'Non partecipi a questa asta');
  }
  if (stato.asta.passati.includes(g.id)) return errore('GIA_PASSATO');
  return null;
}

/**
 * Verifica se `g` può eseguire un'azione di tipo `tipo` nello stato attuale,
 * senza guardare i parametri. Ritorna null se ammessa, altrimenti {errore}.
 * È la fonte unica sia per applicaAzione sia per azioniDisponibili.
 */
function verificaPermesso(stato, g, tipo) {
  const { fase } = stato;
  if (fase === 'ordine' && tipo !== 'lanciaDadi' && tipo !== 'abbandona' && AZIONI.includes(tipo)) {
    return errore('FASE_ERRATA', 'Prima si lanciano i dadi per decidere chi comincia', { fase, azione: tipo });
  }
  switch (tipo) {
    case 'lanciaDadi':
      return richiediTurno(stato, g, tipo, ['daLanciare', 'ordine', 'lancioAffitto']);
    case 'compra':
    case 'rifiutaAcquisto':
      return richiediTurno(stato, g, tipo, ['daDecidereAcquisto']);
    case 'costruisci':
    case 'disipoteca':
      return richiediTurno(stato, g, tipo, FASI_GESTIONE);
    case 'finisciTurno':
      return richiediTurno(stato, g, tipo, ['mossa']);
    case 'pagaCauzione':
    case 'usaCartaPrigione': {
      const e = richiediTurno(stato, g, tipo, ['daLanciare']);
      if (e) return e;
      if (!g.inPrigione) return errore('NON_IN_PRIGIONE');
      if (tipo === 'usaCartaPrigione' && !(g.cartePrigione > 0)) return errore('NESSUNA_CARTA_PRIGIONE');
      return null;
    }
    case 'offertaAsta':
      return richiediAstaAttiva(stato, g, tipo);
    case 'passaAsta': {
      const e = richiediAstaAttiva(stato, g, tipo);
      if (e) return e;
      if (stato.asta.migliorOfferenteId === g.id) {
        return errore('MIGLIOR_OFFERENTE', 'Hai l\'offerta più alta: non puoi passare, aspetta gli altri');
      }
      return null;
    }
    case 'vendiCasa':
    case 'ipoteca':
      if (FASI_GESTIONE.includes(fase)) {
        return stato.turno.giocatoreId === g.id ? null : nonIlTuoTurno(stato);
      }
      if (fase === 'debito') {
        return stato.debito.giocatoreId === g.id ? null
          : errore('NON_DEBITORE', `Ora può farlo solo ${nomeDi(stato, stato.debito.giocatoreId)}, che deve saldare un debito`);
      }
      if (fase === 'asta') {
        return stato.asta.partecipanti.includes(g.id) ? null : errore('GIOCATORE_NON_VALIDO', 'Non partecipi a questa asta');
      }
      return faseErrata(stato, tipo);
    case 'proponiScambio':
      if (fase === 'asta') return errore('FASE_ERRATA', 'Durante un\'asta non si possono proporre scambi', { fase, azione: tipo });
      if (stato.scambio) return errore('SCAMBIO_IN_CORSO', 'C\'è già uno scambio in attesa di risposta: aspetta che si concluda');
      return null;
    case 'accettaScambio':
      if (fase === 'asta') return errore('FASE_ERRATA', 'Durante un\'asta non si possono concludere scambi', { fase, azione: tipo });
      if (!stato.scambio) return errore('SCAMBIO_NON_TROVATO', 'Non c\'è nessuno scambio in attesa');
      if (stato.scambio.aId !== g.id) return errore('NON_DESTINATARIO');
      return null;
    case 'rifiutaScambio':
      if (!stato.scambio) return errore('SCAMBIO_NON_TROVATO', 'Non c\'è nessuno scambio in attesa');
      if (stato.scambio.aId !== g.id && stato.scambio.daId !== g.id) return errore('NON_COINVOLTO');
      return null;
    case 'dichiaraBancarotta':
      if (fase !== 'debito' || !stato.debito) {
        return errore('FASE_ERRATA', 'Puoi dichiarare bancarotta solo quando hai un debito che non riesci a pagare', { fase, azione: tipo });
      }
      if (stato.debito.giocatoreId !== g.id) return errore('NON_DEBITORE');
      return null;
    case 'abbandona':
      // Bancarotta volontaria: ammessa a ogni giocatore in gioco, in qualunque fase.
      return null;
    default:
      return errore('AZIONE_NON_VALIDA', `Azione sconosciuta: ${tipo}`);
  }
}

/**
 * I tipi di azione che `giocatoreId` può eseguire adesso. Non valuta i
 * parametri (es. quale casella) né la liquidità: quello lo fa il gestore.
 */
function azioniDisponibili(stato, giocatoreId) {
  const g = stato && trova(stato, giocatoreId);
  if (!g || g.fallito) return [];
  if (stato.fase === 'lobby' || stato.fase === 'finePartita') return [];
  return AZIONI.filter((tipo) => verificaPermesso(stato, g, tipo) === null);
}

// ---------------------------------------------------------------------------
// Movimento e risoluzione delle caselle
// ---------------------------------------------------------------------------

/** Avanza di `passi` caselle; con `incassaVia` riscuote 200 € se passa o arriva sul Via. */
function avanza(stato, g, ctx, passi, causa, incassaVia = true) {
  const da = g.posizione;
  const a = (da + passi) % NUMERO_CASELLE;
  const passatoDalVia = da + passi >= NUMERO_CASELLE;
  g.posizione = a;
  emetti(ctx, 'movimento', g.id, `${g.nome} va da ${casella(da).nome} a ${casella(a).nome}`,
    { da, a, passi, passatoDalVia, causa });
  if (passatoDalVia && incassaVia) {
    // Variante `viaDoppio`: fermandosi proprio sul Via lo stipendio raddoppia.
    const doppio = a === TAB.INDICE_VIA && REG.valore(stato, 'viaDoppio') === true;
    const importo = doppio ? 2 * TAB.STIPENDIO_VIA : TAB.STIPENDIO_VIA;
    g.denaro += importo;
    emetti(ctx, 'passaggioVia', g.id,
      `${g.nome} ${a === TAB.INDICE_VIA ? 'arriva sul' : 'passa dal'} Via e riscuote ${euro(importo)}${doppio ? ' (stipendio doppio)' : ''}`,
      { importo, doppio });
  }
}

/** Avanza (sempre in avanti) fino alla casella `destinazione`. */
function avanzaFino(stato, g, ctx, destinazione, causa, incassaVia = true) {
  let passi = (destinazione - g.posizione + NUMERO_CASELLE) % NUMERO_CASELLE;
  if (passi === 0) passi = NUMERO_CASELLE; // giro completo: non succede con le carte standard
  avanza(stato, g, ctx, passi, causa, incassaVia);
}

/** Arretra di `passi` caselle senza mai riscuotere dal Via. */
function arretra(stato, g, ctx, passi) {
  const da = g.posizione;
  const a = (((da - passi) % NUMERO_CASELLE) + NUMERO_CASELLE) % NUMERO_CASELLE;
  g.posizione = a;
  emetti(ctx, 'movimento', g.id, `${g.nome} torna indietro da ${casella(da).nome} a ${casella(a).nome}`,
    { da, a, passi: -passi, passatoDalVia: false, causa: 'carta' });
}

/**
 * Applica l'effetto della casella su cui `g` è appena arrivato.
 * Prima di chiamarla il chiamante imposta la fase "normale" (mossa o
 * daLanciare): qui la si cambia solo se serve (acquisto, prigione, debito).
 * opz: { moltiplicatoreStazione, moltiplicatoreDadi } dalle carte "più vicina".
 */
function risolviCasella(stato, g, ctx, opz = {}) {
  const c = casella(g.posizione);
  registraSosta(stato, g, c);
  switch (c.tipo) {
    case 'vaiInPrigione':
      N.mandaInPrigione(stato, g, ctx, 'casella');
      return;
    case 'tassa':
      N.addebita(stato, ctx, g.id, null, c.importoTassa, { motivo: 'tassa', casella: c.indice });
      return;
    case 'probabilita':
    case 'imprevisti':
      pescaCarta(stato, g, ctx, c.tipo);
      return;
    case 'proprieta':
    case 'stazione':
    case 'societa':
      risolviProprieta(stato, g, ctx, c, opz);
      return;
    case 'parcheggio':
      // Variante `parcheggio`: chi si ferma qui vince il piatto.
      if (REG.valore(stato, 'parcheggio') === true && stato.piatto > 0) {
        const vinto = stato.piatto;
        stato.piatto = 0;
        g.denaro += vinto;
        emetti(ctx, 'piatto', g.id, `${g.nome} si ferma al Parcheggio gratuito e vince il piatto: ${euro(vinto)}`,
          { importo: vinto });
      }
      return;
    default:
      // Via, prigione (solo transito): non succede nulla.
  }
}

/**
 * Chi incassa l'affitto di `c` da `g`, oppure null se non è dovuto: casella
 * della banca o sua, ipotecata, proprietario in prigione con la variante
 * `affittoInPrigione` spenta (in questi ultimi due casi con l'evento che lo dice).
 */
function creditoreAffitto(stato, g, ctx, c) {
  const voce = voceDi(stato, c.indice);
  if (!voce || voce.proprietario === null || voce.proprietario === g.id) return null;
  const owner = trova(stato, voce.proprietario);
  if (!owner || owner.fallito) return null;
  if (voce.ipotecata) {
    // Affitto non dovuto: stesso tipo 'affitto' con importo 0 e il motivo (INTERFACCE.md §6).
    emetti(ctx, 'affitto', g.id, `${c.nome} è ipotecata: ${g.nome} non paga l'affitto ${N.aChi(owner.nome)}`,
      { daId: g.id, aId: owner.id, casella: c.indice, importo: 0, ipotecata: true });
    return null;
  }
  if (owner.inPrigione && REG.valore(stato, 'affittoInPrigione') === false) {
    emetti(ctx, 'affitto', g.id, `${owner.nome} è in prigione: ${g.nome} non paga l'affitto di ${c.nome}`,
      { daId: g.id, aId: owner.id, casella: c.indice, importo: 0, inPrigione: true });
    return null;
  }
  return owner;
}

/** Casella acquistabile: offerta d'acquisto se libera, affitto se di un altro. */
function risolviProprieta(stato, g, ctx, c, opz) {
  const voce = voceDi(stato, c.indice);
  if (voce.proprietario === null) {
    N.impostaFase(stato, 'daDecidereAcquisto');
    return;
  }
  const owner = creditoreAffitto(stato, g, ctx, c);
  if (!owner) return;
  if (c.tipo === 'societa' && opz.moltiplicatoreDadi) {
    // Carta "società più vicina": i dadi dell'affitto li lancia il giocatore
    // (azione `lanciaDadi` in fase 'lancioAffitto'), non il gioco al posto suo.
    stato.lancioAffitto = { giocatoreId: g.id, casella: c.indice, creditoreId: owner.id, moltiplicatore: opz.moltiplicatoreDadi };
    N.impostaFase(stato, 'lancioAffitto');
    emetti(ctx, 'affittoDaLanciare', g.id,
      `${g.nome} deve lanciare i dadi: pagherà ${opz.moltiplicatoreDadi} volte il risultato ${N.aChi(owner.nome)} per ${c.nome}`,
      { daId: g.id, aId: owner.id, casella: c.indice, moltiplicatore: opz.moltiplicatoreDadi });
    return;
  }
  const dadi = c.tipo === 'societa' ? (stato.dadi || [0, 0]).slice() : undefined;
  const { importo, moltiplicatore } = N.calcolaAffitto(stato, c.indice, {
    moltiplicatore: opz.moltiplicatoreStazione,
    dadi,
  });
  N.addebita(stato, ctx, g.id, owner.id, importo, { motivo: 'affitto', casella: c.indice, moltiplicatore, dadi });
}

/**
 * Il lancio chiesto dalla carta "società più vicina": i dadi restano sul
 * tabellone, il doppio non conta e l'affitto è il totale per il moltiplicatore
 * della carta. `motivo` ('disconnesso' | 'inattivo') quando lancia il gioco al
 * posto del giocatore. Se nel frattempo la società ha cambiato mano (scambio,
 * bancarotta del proprietario) si rifanno i conti con il proprietario di adesso.
 */
function lanciaPerAffitto(stato, g, ctx, motivo = null) {
  const l = stato.lancioAffitto;
  stato.lancioAffitto = null;
  N.impostaFase(stato, N.faseDopoMossa(stato));
  if (!l) return;
  const dadi = [N.tiraDado(ctx), N.tiraDado(ctx)];
  stato.dadi = dadi.slice();
  const perche = { disconnesso: ' (è disconnesso: lancia il gioco)', inattivo: ' (non ha lanciato in tempo: lancia il gioco)' }[motivo] || '';
  const dati = { dadi, doppio: dadi[0] === dadi[1], inPrigione: false, doppiConsecutivi: stato.turno.doppiConsecutivi, perAffitto: true };
  if (motivo) dati.motivo = motivo;
  emetti(ctx, 'dadi', g.id, `${g.nome} lancia ${dadi[0]} e ${dadi[1]} per l'affitto della società${perche}`, dati);
  const c = casella(l.casella);
  const owner = creditoreAffitto(stato, g, ctx, c);
  if (!owner) return;
  const { importo, moltiplicatore } = N.calcolaAffitto(stato, c.indice, { moltiplicatoreDadi: l.moltiplicatore, dadi });
  N.addebita(stato, ctx, g.id, owner.id, importo, { motivo: 'affitto', casella: c.indice, moltiplicatore, dadi });
}

// ---------------------------------------------------------------------------
// Carte Probabilità e Imprevisti
// ---------------------------------------------------------------------------

/** Pesca la prima carta del mazzo, la rimette in coda (tranne esciGratis) e ne applica l'effetto. */
function pescaCarta(stato, g, ctx, mazzo) {
  const ids = stato.mazzi[mazzo];
  if (!Array.isArray(ids) || ids.length === 0) return;
  const id = ids.shift();
  const carta = N.CARTE_PER_ID.get(id);
  if (!carta) return;
  if (carta.effetto.tipo === 'esciGratis') stato.cartePrigioneDi[id] = g.id;
  else ids.push(id);
  emetti(ctx, 'carta', g.id, `${g.nome} pesca ${N.NOMI_MAZZO[mazzo]}: «${carta.testo}»`,
    { mazzo, carta: { id: carta.id, testo: carta.testo, effetto: { ...carta.effetto } } });
  applicaEffetto(stato, g, ctx, carta);
}

/** Applica l'effetto di una carta (tipi di carte.js / INTERFACCE.md §5.2). */
function applicaEffetto(stato, g, ctx, carta) {
  const e = carta.effetto;
  const altri = () => stato.giocatori.filter((x) => !x.fallito && x.id !== g.id);
  switch (e.tipo) {
    case 'denaro':
      if (e.importo > 0) {
        g.denaro += e.importo;
        emetti(ctx, 'pagamento', g.id, `${g.nome} riscuote ${euro(e.importo)} dalla banca`,
          { daId: null, aId: g.id, importo: e.importo, motivo: 'carta' });
      } else if (e.importo < 0) {
        N.addebita(stato, ctx, g.id, null, -e.importo, { motivo: 'carta' });
      }
      return;
    case 'vaiA':
      avanzaFino(stato, g, ctx, e.casella, 'carta', e.incassaVia !== false);
      risolviCasella(stato, g, ctx);
      return;
    case 'vaiInPrigione':
      N.mandaInPrigione(stato, g, ctx, 'carta');
      return;
    case 'esciGratis':
      g.cartePrigione += 1;
      return;
    case 'indietro':
      arretra(stato, g, ctx, e.passi);
      risolviCasella(stato, g, ctx);
      return;
    case 'pagaPerCasa': {
      const { case: nCase, alberghi } = N.contaCostruzioni(stato, g.id);
      const totale = nCase * e.perCasa + alberghi * e.perAlbergo;
      N.addebita(stato, ctx, g.id, null, totale, { motivo: 'carta' });
      return;
    }
    case 'riscuotiDaTutti':
      for (const altro of altri()) N.addebita(stato, ctx, altro.id, g.id, e.importo, { motivo: 'carta' });
      return;
    case 'pagaATutti':
      for (const altro of altri()) N.addebita(stato, ctx, g.id, altro.id, e.importo, { motivo: 'pagaATutti' });
      return;
    case 'vaiAllaStazionePiuVicina':
      avanzaFino(stato, g, ctx, TAB.prossimaCasellaDiTipo(g.posizione, 'stazione'), 'carta', true);
      risolviCasella(stato, g, ctx, { moltiplicatoreStazione: e.moltiplicatoreAffitto || 2 });
      return;
    case 'vaiAllaSocietaPiuVicina':
      avanzaFino(stato, g, ctx, TAB.prossimaCasellaDiTipo(g.posizione, 'societa'), 'carta', true);
      risolviCasella(stato, g, ctx, { moltiplicatoreDadi: e.moltiplicatoreDadi || 10 });
      return;
    default:
      // Tipo sconosciuto: la carta non ha effetto (i dati sono validati dai test).
  }
}

// ---------------------------------------------------------------------------
// Validazione dei parametri
// ---------------------------------------------------------------------------

/**
 * Chi rinuncia all'acquisto apre l'asta fra gli altri (lui non partecipa); con
 * la variante `aste: false` la casella resta alla banca.
 */
function rinunciaAllAcquisto(stato, g, ctx, motivo = null) {
  if (REG.valore(stato, 'aste') === false) {
    emetti(ctx, 'acquistoRifiutato', g.id,
      `${g.nome} ${motivo === 'inattivo' ? 'non decide in tempo e non compra' : 'non compra'} ${casella(g.posizione).nome}: resta alla banca`,
      { casella: g.posizione, motivo });
    N.impostaFase(stato, N.faseDopoMossa(stato));
    return;
  }
  N.avviaAsta(stato, ctx, g.posizione, N.faseDopoMossa(stato), { esclusoId: g.id });
}

/** Legge `azione.casella` e verifica che sia una casella acquistabile. */
function leggiCasella(azione) {
  const i = azione.casella;
  if (!Number.isInteger(i) || i < 0 || i >= NUMERO_CASELLE) {
    return errore('PARAMETRI_NON_VALIDI', 'Indica la casella con il suo indice (numero intero da 0 a 39)');
  }
  if (!TAB.acquistabile(i)) {
    return errore('CASELLA_NON_VALIDA', `${casella(i).nome} non è una proprietà`, { casella: i });
  }
  return { indice: i };
}

/** Verifica che la casella sia di `g`. */
function richiediProprietario(stato, g, indice) {
  if (voceDi(stato, indice).proprietario !== g.id) {
    return errore('PROPRIETA_NON_TUA', `${casella(indice).nome} non è tua`, { casella: indice });
  }
  return null;
}

/** Errore FONDI_INSUFFICIENTI con importi espliciti. */
function fondiInsufficienti(g, serve, cosa) {
  return errore('FONDI_INSUFFICIENTI', `${cosa} costa ${euro(serve)}, ma hai solo ${euro(g.denaro)}`,
    { richiesto: serve, denaro: g.denaro });
}

// ---------------------------------------------------------------------------
// Gestori delle azioni: (stato clonato, giocatore, azione, ctx) → undefined | {errore}
// Il permesso (turno, fase, ruolo) è già stato verificato da verificaPermesso.
// ---------------------------------------------------------------------------

const GESTORI = {
  /** Lancio dei dadi: movimento, doppi, tre doppi, tentativi in prigione. */
  lanciaDadi(stato, g, azione, ctx) {
    if (stato.fase === 'ordine') {
      ordine.lancia(stato, g, ctx);
      return undefined;
    }
    if (stato.fase === 'lancioAffitto') {
      lanciaPerAffitto(stato, g, ctx);
      return undefined;
    }
    const d1 = N.tiraDado(ctx);
    const d2 = N.tiraDado(ctx);
    const doppio = d1 === d2;
    stato.dadi = [d1, d2];

    if (g.inPrigione) {
      const tentativo = g.turniInPrigione + 1;
      emetti(ctx, 'dadi', g.id, `${g.nome} lancia ${d1} e ${d2} dalla prigione${doppio ? ' (doppio!)' : ''}`,
        { dadi: [d1, d2], doppio, inPrigione: true, doppiConsecutivi: 0 });
      N.impostaFase(stato, 'mossa'); // dalla prigione non si rilancia mai
      if (doppio) {
        g.inPrigione = false;
        g.turniInPrigione = 0;
        emetti(ctx, 'uscitaPrigione', g.id, `${g.nome} esce di prigione con un doppio`, { modo: 'doppio' });
      } else if (tentativo < N.TENTATIVI_PRIGIONE) {
        g.turniInPrigione = tentativo;
        return undefined; // resta in prigione, il turno finisce
      } else {
        // Terzo tentativo fallito: paga la cauzione (o entra in debito) ed esce.
        g.inPrigione = false;
        g.turniInPrigione = 0;
        emetti(ctx, 'uscitaPrigione', g.id, `${g.nome} esce di prigione al terzo tentativo pagando la cauzione`,
          { modo: 'terzoTurno' });
        N.addebita(stato, ctx, g.id, null, TAB.CAUZIONE_PRIGIONE, { motivo: 'cauzione' });
      }
      avanza(stato, g, ctx, d1 + d2, 'dadi');
      risolviCasella(stato, g, ctx);
      return undefined;
    }

    const doppiConsecutivi = doppio ? stato.turno.doppiConsecutivi + 1 : 0;
    stato.turno.doppiConsecutivi = doppiConsecutivi;
    emetti(ctx, 'dadi', g.id, `${g.nome} lancia ${d1} e ${d2}${doppio ? ' (doppio!)' : ''}`,
      { dadi: [d1, d2], doppio, inPrigione: false, doppiConsecutivi });

    if (doppiConsecutivi >= 3) {
      N.mandaInPrigione(stato, g, ctx, 'treDoppi');
      return undefined;
    }
    N.impostaFase(stato, doppio ? 'daLanciare' : 'mossa');
    avanza(stato, g, ctx, d1 + d2, 'dadi');
    risolviCasella(stato, g, ctx);
    return undefined;
  },

  /** Acquisto dalla banca della casella libera su cui si trova il giocatore. */
  compra(stato, g, azione, ctx) {
    const c = casella(g.posizione);
    const voce = voceDi(stato, g.posizione);
    if (!voce || voce.proprietario !== null || c.prezzo == null) {
      return errore('CASELLA_NON_VALIDA', `${c.nome} non è in vendita`);
    }
    if (g.denaro < c.prezzo) {
      return errore('FONDI_INSUFFICIENTI',
        `${c.nome} costa ${euro(c.prezzo)}, ma hai solo ${euro(g.denaro)}: puoi ipotecare o vendere, oppure rinunciare e aprire l'asta`,
        { prezzo: c.prezzo, denaro: g.denaro });
    }
    g.denaro -= c.prezzo;
    voce.proprietario = g.id;
    emetti(ctx, 'acquisto', g.id, `${g.nome} compra ${c.nome} per ${euro(c.prezzo)}`,
      { casella: g.posizione, prezzo: c.prezzo, tramite: 'banca' });
    N.impostaFase(stato, N.faseDopoMossa(stato));
    return undefined;
  },

  /** Rinuncia all'acquisto: la casella va all'asta tra gli altri (o resta alla banca, se le aste sono spente). */
  rifiutaAcquisto(stato, g, azione, ctx) {
    rinunciaAllAcquisto(stato, g, ctx);
    return undefined;
  },

  /** Offerta all'asta: almeno offerta massima + incremento, entro il proprio denaro. */
  offertaAsta(stato, g, azione, ctx) {
    const { importo } = azione;
    if (!Number.isInteger(importo) || importo <= 0) {
      return errore('PARAMETRI_NON_VALIDI', 'L\'offerta deve essere un numero intero di euro maggiore di 0');
    }
    const a = stato.asta;
    const minimo = a.offertaMassima + a.incrementoMinimo;
    if (importo < minimo) {
      return errore('OFFERTA_BASSA', `L'offerta minima ora è ${euro(minimo)}`, { minimo });
    }
    if (importo > g.denaro) {
      return errore('FONDI_INSUFFICIENTI', `Non puoi offrire ${euro(importo)}: hai solo ${euro(g.denaro)}`,
        { richiesto: importo, denaro: g.denaro });
    }
    a.offertaMassima = importo;
    a.migliorOfferenteId = g.id;
    emetti(ctx, 'astaOfferta', g.id, `${g.nome} offre ${euro(importo)} per ${casella(a.casella).nome}`,
      { casella: a.casella, importo });
    N.verificaChiusuraAsta(stato, ctx);
    return undefined;
  },

  /** Esce dall'asta; quando resta solo il miglior offerente l'asta si chiude. */
  passaAsta(stato, g, azione, ctx) {
    const a = stato.asta;
    a.passati.push(g.id);
    emetti(ctx, 'astaPasso', g.id, `${g.nome} passa`, { casella: a.casella });
    N.verificaChiusuraAsta(stato, ctx);
    return undefined;
  },

  /** Costruisce una casa (o l'albergo sopra 4 case) rispettando tutte le condizioni. */
  costruisci(stato, g, azione, ctx) {
    const l = leggiCasella(azione);
    if (l.errore) return l;
    const i = l.indice;
    const c = casella(i);
    if (c.tipo !== 'proprieta') {
      return errore('NON_EDIFICABILE', `Su ${c.nome} non si possono costruire case: si costruisce solo sulle proprietà a colori`, { casella: i });
    }
    const nonTua = richiediProprietario(stato, g, i);
    if (nonTua) return nonTua;
    const gruppo = N.indiciGruppo(c.gruppo);
    const nomeGruppo = TAB.GRUPPI[c.gruppo].nome;
    if (!N.possiedeGruppo(stato, g.id, c.gruppo)) {
      return errore('GRUPPO_INCOMPLETO', `Per costruire su ${c.nome} devi possedere tutto il gruppo ${nomeGruppo}`, { casella: i });
    }
    if (stato.regole && stato.regole.costruzione === 'sosta' && !fermoSulGruppo(stato, g, c.gruppo)) {
      return errore('NON_SULLA_CASELLA',
        `In questa partita costruisci sul gruppo ${nomeGruppo} solo nel turno in cui ti fermi su una sua casella`, { casella: i });
    }
    const ipotecata = gruppo.find((j) => voceDi(stato, j).ipotecata);
    if (ipotecata !== undefined) {
      return errore('IPOTECATA', `Non puoi costruire: ${casella(ipotecata).nome} (gruppo ${nomeGruppo}) è ipotecata`, { casella: ipotecata });
    }
    const voce = voceDi(stato, i);
    if (voce.caseCostruite >= 5) {
      return errore('NON_EDIFICABILE', `Su ${c.nome} c'è già un albergo`, { casella: i });
    }
    const minimo = Math.min(...gruppo.map((j) => voceDi(stato, j).caseCostruite));
    if (voce.caseCostruite > minimo) {
      return errore('COSTRUZIONE_NON_UNIFORME',
        `Costruisci in modo uniforme: prima porta le altre proprietà del gruppo ${nomeGruppo} a ${voce.caseCostruite} ${voce.caseCostruite === 1 ? 'casa' : 'case'}`,
        { casella: i });
    }
    const albergo = voce.caseCostruite === 4;
    if (albergo && stato.alberghiDisponibili < 1) {
      return errore('ALBERGHI_ESAURITI', 'La banca non ha più alberghi disponibili (sono 12 in tutto)');
    }
    if (!albergo && stato.caseDisponibili < 1) {
      return errore('CASE_ESAURITE', 'La banca non ha più case disponibili (sono 32 in tutto)');
    }
    if (g.denaro < c.costoCasa) return fondiInsufficienti(g, c.costoCasa, albergo ? 'Un albergo' : 'Una casa');

    g.denaro -= c.costoCasa;
    if (albergo) {
      stato.alberghiDisponibili -= 1;
      stato.caseDisponibili += 4; // le 4 case tornano alla banca
      voce.caseCostruite = 5;
    } else {
      stato.caseDisponibili -= 1;
      voce.caseCostruite += 1;
    }
    emetti(ctx, 'costruzione', g.id,
      `${g.nome} costruisce ${albergo ? 'un albergo' : 'una casa'} su ${c.nome} per ${euro(c.costoCasa)}`,
      { casella: i, caseCostruite: voce.caseCostruite, costo: c.costoCasa });
    return undefined;
  },

  /**
   * Vende alla banca una casa (o l'albergo, che torna a 4 case) a metà prezzo.
   * Albergo senza 4 case in banca: si vendono tutte le costruzioni del gruppo.
   */
  vendiCasa(stato, g, azione, ctx) {
    const l = leggiCasella(azione);
    if (l.errore) return l;
    const i = l.indice;
    const c = casella(i);
    const nonTua = richiediProprietario(stato, g, i);
    if (nonTua) return nonTua;
    const voce = voceDi(stato, i);
    if (c.tipo !== 'proprieta' || voce.caseCostruite === 0) {
      return errore('NESSUNA_COSTRUZIONE', `Su ${c.nome} non ci sono case né alberghi da vendere`, { casella: i });
    }
    const gruppo = N.indiciGruppo(c.gruppo);
    const massimo = Math.max(...gruppo.map((j) => voceDi(stato, j).caseCostruite));
    if (voce.caseCostruite < massimo) {
      return errore('COSTRUZIONE_NON_UNIFORME',
        'Vendi in modo uniforme: prima vendi dalle proprietà del gruppo con più costruzioni', { casella: i });
    }
    const albergo = voce.caseCostruite === 5;
    // Se la banca non ha 4 case da dare in cambio, l'albergo non può tornare a
    // 4 case. Venderne uno solo per intero lascerebbe il gruppo sbilanciato
    // (albergo, albergo, terreno vuoto): si vendono insieme tutte le
    // costruzioni del gruppo, a metà prezzo, e i terreni restano vuoti.
    if (albergo && stato.caseDisponibili < 4) {
      const nomeGruppo = TAB.GRUPPI[c.gruppo].nome;
      for (const j of gruppo) {
        const v = voceDi(stato, j);
        if (v.caseCostruite === 0) continue;
        const ricavoLotto = N.valoreVenditaCostruzioni(j, v.caseCostruite);
        const cosaLotto = v.caseCostruite === 5 ? 'l\'albergo' : `${v.caseCostruite} ${v.caseCostruite === 1 ? 'casa' : 'case'}`;
        if (v.caseCostruite === 5) stato.alberghiDisponibili += 1;
        else stato.caseDisponibili += v.caseCostruite;
        v.caseCostruite = 0;
        g.denaro += ricavoLotto;
        emetti(ctx, 'vendita', g.id,
          `${g.nome} vende ${cosaLotto} su ${casella(j).nome} e incassa ${euro(ricavoLotto)} `
          + `(tutto il gruppo ${nomeGruppo} insieme: la banca non ha 4 case da dare in cambio di un albergo)`,
          { casella: j, caseCostruite: 0, ricavo: ricavoLotto, gruppoIntero: true });
      }
      return undefined;
    }
    const ricavo = c.costoCasa / 2;
    if (albergo) {
      stato.alberghiDisponibili += 1;
      stato.caseDisponibili -= 4;
      voce.caseCostruite = 4;
    } else {
      stato.caseDisponibili += 1;
      voce.caseCostruite -= 1;
    }
    g.denaro += ricavo;
    emetti(ctx, 'vendita', g.id,
      `${g.nome} vende ${albergo ? 'l\'albergo' : 'una casa'} su ${c.nome} e incassa ${euro(ricavo)}`,
      { casella: i, caseCostruite: voce.caseCostruite, ricavo });
    return undefined;
  },

  /** Ipoteca una proprietà senza costruzioni nel gruppo: incassa metà del prezzo. */
  ipoteca(stato, g, azione, ctx) {
    const l = leggiCasella(azione);
    if (l.errore) return l;
    const i = l.indice;
    const c = casella(i);
    const nonTua = richiediProprietario(stato, g, i);
    if (nonTua) return nonTua;
    const voce = voceDi(stato, i);
    if (voce.ipotecata) return errore('GIA_IPOTECATA', `${c.nome} è già ipotecata`, { casella: i });
    if (N.gruppoHaCostruzioni(stato, i)) {
      return errore('HA_COSTRUZIONI', `Per ipotecare ${c.nome} vendi prima tutte le case e gli alberghi del suo gruppo`, { casella: i });
    }
    voce.ipotecata = true;
    g.denaro += c.ipoteca;
    emetti(ctx, 'ipoteca', g.id, `${g.nome} ipoteca ${c.nome} e incassa ${euro(c.ipoteca)}`, { casella: i, importo: c.ipoteca });
    return undefined;
  },

  /** Toglie l'ipoteca pagando il valore d'ipoteca più il 10%. */
  disipoteca(stato, g, azione, ctx) {
    const l = leggiCasella(azione);
    if (l.errore) return l;
    const i = l.indice;
    const c = casella(i);
    const nonTua = richiediProprietario(stato, g, i);
    if (nonTua) return nonTua;
    const voce = voceDi(stato, i);
    if (!voce.ipotecata) return errore('NON_IPOTECATA', `${c.nome} non è ipotecata`, { casella: i });
    const costo = N.costoDisipoteca(i);
    if (g.denaro < costo) return fondiInsufficienti(g, costo, `Togliere l'ipoteca su ${c.nome}`);
    g.denaro -= costo;
    voce.ipotecata = false;
    emetti(ctx, 'disipoteca', g.id, `${g.nome} toglie l'ipoteca su ${c.nome} pagando ${euro(costo)}`, { casella: i, importo: costo });
    return undefined;
  },

  /** Propone uno scambio (uno solo pendente per partita). */
  proponiScambio(stato, g, azione, ctx) {
    const esito = scambi.validaProposta(stato, g.id, azione, ctx);
    if (esito.errore) return esito;
    stato.scambio = esito.scambio;
    stato.contatoreScambi = (stato.contatoreScambi || 0) + 1;
    emetti(ctx, 'scambioProposto', g.id, `${g.nome} propone uno scambio ${N.aChi(nomeDi(stato, esito.scambio.aId))}`,
      { scambio: structuredClone(esito.scambio) });
    return undefined;
  },

  /** Il destinatario accetta: si riverificano i possessi e si trasferisce tutto. */
  accettaScambio(stato, g, azione, ctx) {
    if (typeof azione.scambioId !== 'string') return errore('PARAMETRI_NON_VALIDI', 'Manca l\'id dello scambio (scambioId)');
    const sc = stato.scambio;
    if (sc.id !== azione.scambioId) return errore('SCAMBIO_NON_TROVATO', 'Lo scambio indicato non è più in attesa');
    const possessi = scambi.verificaPossessi(stato, sc);
    if (possessi) return possessi;
    scambi.eseguiScambio(stato, sc, ctx);
    return undefined;
  },

  /** Il destinatario rifiuta, oppure il proponente ritira la proposta. */
  rifiutaScambio(stato, g, azione, ctx) {
    if (typeof azione.scambioId !== 'string') return errore('PARAMETRI_NON_VALIDI', 'Manca l\'id dello scambio (scambioId)');
    const sc = stato.scambio;
    if (sc.id !== azione.scambioId) return errore('SCAMBIO_NON_TROVATO', 'Lo scambio indicato non è più in attesa');
    stato.scambio = null;
    const testo = g.id === sc.daId
      ? `${g.nome} ritira la proposta di scambio ${N.aChi(nomeDi(stato, sc.aId))}`
      : `${g.nome} rifiuta lo scambio proposto da ${nomeDi(stato, sc.daId)}`;
    emetti(ctx, 'scambioRifiutato', g.id, testo, { scambio: structuredClone(sc), daId: g.id });
    return undefined;
  },

  /** Paga 50 € ed esce di prigione; poi lancia normalmente. */
  pagaCauzione(stato, g, azione, ctx) {
    const cauzione = TAB.CAUZIONE_PRIGIONE;
    if (g.denaro < cauzione) return fondiInsufficienti(g, cauzione, 'La cauzione');
    g.denaro -= cauzione;
    N.alPiatto(stato, 'cauzione', cauzione);
    g.inPrigione = false;
    g.turniInPrigione = 0;
    emetti(ctx, 'pagamento', g.id, `${g.nome} paga ${euro(cauzione)} di cauzione`,
      { daId: g.id, aId: null, importo: cauzione, motivo: 'cauzione' });
    emetti(ctx, 'uscitaPrigione', g.id, `${g.nome} esce di prigione pagando la cauzione`, { modo: 'cauzione' });
    return undefined;
  },

  /** Usa una carta "Uscite gratis di prigione": torna in fondo al suo mazzo. */
  usaCartaPrigione(stato, g, azione, ctx) {
    const id = N.restituisciCartaPrigione(stato, g.id);
    g.inPrigione = false;
    g.turniInPrigione = 0;
    emetti(ctx, 'uscitaPrigione', g.id, `${g.nome} esce di prigione usando la carta "Uscite gratis"`,
      { modo: 'carta', carta: id });
    return undefined;
  },

  /** Chiude il turno e passa al prossimo giocatore (saltando i disconnessi). */
  finisciTurno(stato, g, azione, ctx) {
    N.passaTurno(stato, ctx);
    return undefined;
  },

  /** Bancarotta del debitore: beni al creditore o alla banca (all'asta). */
  dichiaraBancarotta(stato, g, azione, ctx) {
    bancarotta.liquidaInterno(stato, g.id, stato.debito.creditoreId, ctx);
    return undefined;
  },

  /**
   * Abbandono volontario: bancarotta verso il creditore del proprio debito
   * aperto (se c'è) altrimenti verso la banca. Se partecipa a un'asta ne esce;
   * se era il miglior offerente l'asta riparte da zero fra gli altri: chi
   * aveva passato davanti alla sua offerta torna a poter offrire (restano
   * fuori i falliti e i disconnessi).
   */
  abbandona(stato, g, azione, ctx) {
    const creditoreId = stato.debito && stato.debito.giocatoreId === g.id ? stato.debito.creditoreId : null;
    const a = stato.asta;
    let astaRipartita = false;
    if (a && a.partecipanti.includes(g.id)) {
      if (a.migliorOfferenteId === g.id) {
        a.migliorOfferenteId = null;
        a.offertaMassima = 0;
        const prima = a.passati.length;
        a.passati = a.passati.filter((id) => {
          const x = trova(stato, id);
          return !x || x.fallito || x.connesso === false;
        });
        astaRipartita = a.passati.length < prima;
        // Per i client è un'asta nuova: la finestra si riapre a chi aveva passato.
        if (astaRipartita) a.iniziataIl = ctx.t;
      }
      if (!a.passati.includes(g.id)) a.passati.push(g.id);
    }
    // `ctx.motivo` lo imposta solo il server quando agisce al posto del
    // giocatore: 'assente' (non rientra da troppo tempo) o 'debito' (non ha
    // saldato in tempo). Senza motivo è un abbandono voluto.
    const dUfficio = {
      assente: `${g.nome} non rientra da troppo tempo ed esce dalla partita`,
      debito: `${g.nome} non ha saldato il debito in tempo ed esce dalla partita`,
    };
    const motivo = Object.hasOwn(dUfficio, ctx.motivo) ? ctx.motivo : null;
    emetti(ctx, 'abbandono', g.id, motivo ? dUfficio[motivo] : `${g.nome} abbandona la partita`,
      { creditoreId: creditoreId ?? null, ...(motivo ? { motivo } : {}) });
    bancarotta.liquidaInterno(stato, g.id, creditoreId ?? null, ctx, { abbandono: true });
    if (stato.asta === a && astaRipartita) {
      emetti(ctx, 'astaInizio', null,
        `L'asta per ${casella(a.casella).nome} riparte da zero: ${g.nome} aveva l'offerta più alta`,
        { casella: a.casella, partecipanti: a.partecipanti.slice(), riparte: true });
    }
    if (stato.asta) N.verificaChiusuraAsta(stato, ctx);
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// applicaAzione
// ---------------------------------------------------------------------------

/** Chiude l'azione: saldo automatico dei debiti, versione, log. */
function concludi(stato, nuovo, ctx) {
  N.saldaDebiti(nuovo, ctx);
  nuovo.versione = (stato.versione || 0) + 1;
  nuovo.aggiornataIl = ctx.t;
  N.appendiLog(nuovo, ctx.eventi);
  return { stato: nuovo, eventi: ctx.eventi };
}

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
  if (!stato || typeof stato !== 'object') return errore('PARAMETRI_NON_VALIDI', 'Stato di partita mancante');
  if (!azione || typeof azione !== 'object' || typeof azione.tipo !== 'string') {
    return errore('AZIONE_NON_VALIDA', 'L\'azione deve essere un oggetto con il campo "tipo"');
  }
  if (!AZIONI.includes(azione.tipo)) return errore('AZIONE_NON_VALIDA', `Azione sconosciuta: ${azione.tipo}`, { tipo: azione.tipo });

  const g0 = trova(stato, giocatoreId);
  if (!g0) return errore('GIOCATORE_NON_VALIDO', 'Non fai parte di questa partita');
  if (g0.fallito) return errore('GIOCATORE_FALLITO', 'Sei in bancarotta: puoi solo guardare la partita');
  if (stato.fase === 'lobby' || stato.fase === 'finePartita') return faseErrata(stato, azione.tipo);

  const permesso = verificaPermesso(stato, g0, azione.tipo);
  if (permesso) return permesso;

  const nuovo = N.normalizzaStato(structuredClone(stato));
  const g = trova(nuovo, giocatoreId);
  const ctx = N.creaContesto(contesto);
  if (typeof contesto.motivo === 'string') ctx.motivo = contesto.motivo;

  const esito = GESTORI[azione.tipo](nuovo, g, azione, ctx);
  if (esito && esito.errore) return esito;
  return concludi(stato, nuovo, ctx);
}

/**
 * Fa avanzare la partita quando `giocatoreId` la tiene ferma. In ordine:
 *   - nel lancio iniziale (fase 'ordine') lancia i dadi al posto suo;
 *   - (solo se disconnesso) annulla lo scambio pendente che lo coinvolge;
 *   - se partecipa a un'asta e non è il miglior offerente, passa;
 *   - se è di turno in 'lancioAffitto' il gioco lancia i dadi dell'affitto per lui;
 *   - se è di turno in 'daDecidereAcquisto' rinuncia (la casella va all'asta);
 *   - se è di turno in 'daLanciare' o 'mossa' il turno passa al prossimo.
 * Un debito aperto non viene toccato: la bancarotta d'ufficio la decide il
 * server con l'azione `abbandona`. Ritorna sempre { stato, eventi }: se non
 * c'è nulla da fare `eventi` è vuoto e lo stato è quello ricevuto.
 */
function sblocca(stato, giocatoreId, contesto, motivo) {
  const g0 = stato && trova(stato, giocatoreId);
  if (!g0 || g0.fallito || stato.fase === 'lobby' || stato.fase === 'finePartita') return { stato, eventi: [] };

  const nuovo = N.normalizzaStato(structuredClone(stato));
  const g = trova(nuovo, giocatoreId);
  const ctx = N.creaContesto(contesto);
  const disconnesso = motivo === 'disconnesso';
  const perche = disconnesso ? 'è disconnesso' : 'non ha giocato in tempo';

  if (nuovo.fase === 'ordine') {
    if (nuovo.turno.giocatoreId !== g.id) return { stato, eventi: [] };
    ordine.lancia(nuovo, g, ctx, motivo);
    return concludi(stato, nuovo, ctx);
  }

  const sc = nuovo.scambio;
  if (disconnesso && sc && (sc.daId === g.id || sc.aId === g.id)) {
    nuovo.scambio = null;
    emetti(ctx, 'scambioRifiutato', g.id, `Lo scambio è annullato perché ${g.nome} si è disconnesso`,
      { scambio: structuredClone(sc), daId: g.id });
  }
  const a = nuovo.asta;
  if (nuovo.fase === 'asta' && a && a.partecipanti.includes(g.id) && !a.passati.includes(g.id)
    && a.migliorOfferenteId !== g.id) {
    a.passati.push(g.id);
    emetti(ctx, 'astaPasso', g.id, `${g.nome} ${perche} e passa`, { casella: a.casella, motivo });
    N.verificaChiusuraAsta(nuovo, ctx);
  }
  if (nuovo.turno.giocatoreId === g.id) {
    // Il lancio per l'affitto lo fa il gioco; poi il turno passa come sotto.
    if (nuovo.fase === 'lancioAffitto') lanciaPerAffitto(nuovo, g, ctx, motivo);
    if (nuovo.fase === 'daDecidereAcquisto') {
      const conAsta = REG.valore(nuovo, 'aste') !== false;
      if (!disconnesso && conAsta) {
        emetti(ctx, 'turnoSaltato', g.id, `${g.nome} non decide in tempo: ${casella(g.posizione).nome} va all'asta`,
          { giocatoreId: g.id, motivo });
      }
      rinunciaAllAcquisto(nuovo, g, ctx, motivo);
    } else if (nuovo.fase === 'daLanciare' || nuovo.fase === 'mossa') {
      // In `mossa` i dadi li ha già lanciati: non salta nulla, il turno finisce.
      const testo = nuovo.fase === 'mossa'
        ? `${g.nome} ${disconnesso ? 'è disconnesso' : 'non ha finito il turno in tempo'}: il turno passa`
        : `${g.nome} ${perche} e salta il turno`;
      emetti(ctx, 'turnoSaltato', g.id, testo, { giocatoreId: g.id, motivo });
      N.passaTurno(nuovo, ctx);
    }
  }
  if (ctx.eventi.length === 0) return { stato, eventi: [] };
  return concludi(stato, nuovo, ctx);
}

/** Il giocatore è disconnesso e la partita lo aspetta (dopo la tolleranza). */
function gestisciDisconnessione(stato, giocatoreId, contesto = {}) {
  return sblocca(stato, giocatoreId, contesto, 'disconnesso');
}

/**
 * Il giocatore è connesso ma non agisce da troppo tempo: passa all'asta,
 * rinuncia all'acquisto o salta il turno. Gli scambi pendenti restano.
 */
function gestisciInattivita(stato, giocatoreId, contesto = {}) {
  return sblocca(stato, giocatoreId, contesto, 'inattivo');
}

/**
 * Lo scambio in attesa `scambioId` non ha avuto risposta in tempo: decade,
 * così gli altri possono proporne di nuovi. Ritorna sempre { stato, eventi }
 * (eventi vuoto se quello scambio non è più in attesa).
 */
function scadeScambio(stato, scambioId, contesto = {}) {
  const sc = stato && stato.scambio;
  if (!sc || sc.id !== scambioId) return { stato, eventi: [] };
  const nuovo = N.normalizzaStato(structuredClone(stato));
  const ctx = N.creaContesto(contesto);
  nuovo.scambio = null;
  const dopo = Number.isFinite(contesto.secondi) ? ` in ${contesto.secondi} secondi` : '';
  emetti(ctx, 'scambioRifiutato', null,
    `La proposta di scambio di ${nomeDi(nuovo, sc.daId)} ${N.aChi(nomeDi(nuovo, sc.aId))} è scaduta: nessuna risposta${dopo}`,
    { scambio: structuredClone(sc), daId: null, motivo: 'scaduto' });
  return concludi(stato, nuovo, ctx);
}

/**
 * Chi deve agire perché la partita vada avanti: il debitore, i partecipanti
 * all'asta che non hanno passato (escluso il miglior offerente) oppure il
 * giocatore di turno (anche nel lancio iniziale). Lista vuota in lobby e a
 * partita finita.
 */
function chiDeveAgire(stato) {
  if (!stato || stato.fase === 'lobby' || stato.fase === 'finePartita') return [];
  if (stato.fase === 'debito' && stato.debito) return [stato.debito.giocatoreId];
  if (stato.fase === 'ordine') return stato.turno.giocatoreId ? [stato.turno.giocatoreId] : [];
  if (stato.fase === 'asta' && stato.asta) {
    const a = stato.asta;
    return a.partecipanti.filter((id) => !a.passati.includes(id) && id !== a.migliorOfferenteId);
  }
  if ((FASI_GESTIONE.includes(stato.fase) || stato.fase === 'lancioAffitto') && stato.turno.giocatoreId) {
    return [stato.turno.giocatoreId];
  }
  return [];
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
  gestisciDisconnessione,
  gestisciInattivita,
  scadeScambio,
  chiDeveAgire,
  statoPubblico,
  prossimoGiocatore,
  // esposti per i test e per chi vuole mostrare valori calcolati
  calcolaAffitto: N.calcolaAffitto,
  patrimonioLiquidabile: bancarotta.patrimonioLiquidabile,
};

// Non enumerabile: così il generatore di /dati/*.js non prova a serializzarlo.
Object.defineProperty(module.exports, '_interni', {
  value: { verificaPermesso, risolviCasella, pescaCarta, proprietaIniziali, nucleo: N },
  enumerable: false,
});
