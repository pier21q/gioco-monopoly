/**
 * client/js/app.js
 *
 * Punto d'ingresso del client (INTERFACCE.md §4.2 e §4.8).
 *
 * - `creaStore()`: stato locale dell'interfaccia (StatoClient) con
 *   getState / setState / subscribe / dispatch. Lo stato di partita
 *   autorevole arriva dal server e sostituisce quello locale.
 * - Collega la rete (rete.js): instrada le azioni `dispatch` verso il server,
 *   riprende la sessione salvata (token) dopo un refresh o una caduta di rete,
 *   smista i messaggi in arrivo.
 * - Orchestra l'interfaccia: lobby.js finché la partita non parte, poi
 *   tabellone.js e pannelli.js; dialoghi.js per le finestre modali e i toast.
 * - Gestisce le transizioni lobby → partita → fine partita.
 *
 * Confini concordati con gli altri moduli:
 *   tabellone.render(#tabellone, partita, { caselle, gruppi, mioId, animazioni })
 *     una volta all'ingresso in partita, poi tabellone.aggiorna(partita);
 *   pannelli.render(#pannelli, statoClient, dispatch) a ogni cambio di stato
 *     (pannelli apre da sé i dialoghi automatici: acquisto, asta, debito…);
 *   dialoghi.apri / chiudiTutti / toast per ui:apriDialogo, ui:chiudiDialogo,
 *     ui:toast.
 */

/** I 16 tipi di azione di gioco (§2.4): vanno al server come `{ tipo: 'azione', azione }`. */
export const AZIONI_GIOCO = Object.freeze([
  'lanciaDadi', 'compra', 'rifiutaAcquisto', 'offertaAsta', 'passaAsta',
  'costruisci', 'vendiCasa', 'ipoteca', 'disipoteca', 'proponiScambio',
  'accettaScambio', 'rifiutaScambio', 'pagaCauzione', 'usaCartaPrigione',
  'finisciTurno', 'dichiaraBancarotta',
]);

/** Messaggi di protocollo inviati così come sono (§3.2). */
export const MESSAGGI_PROTOCOLLO = Object.freeze([
  'creaStanza', 'entraStanza', 'avviaPartita', 'riconnetti', 'esciStanza',
]);

/** Quanti eventi tenere nello store (per toast e cronaca). */
export const MAX_EVENTI = 100;

/** Chiavi di salvataggio nel browser. */
export const CHIAVE_SESSIONE = 'monopoly.sessione';
export const CHIAVE_PREFERENZE = 'monopoly.preferenze';

/** StatoClient iniziale (§4.2, più i campi `lobby` e `preferenze` usati da lobby.js). */
export function statoIniziale() {
  return {
    connessione: 'connessione',
    io: null,
    partita: null,
    eventi: [],
    errore: null,
    selezione: null,
    dialogo: null,
    lobby: { codiceUrl: null, inAttesa: false, ripresa: false, link: null },
    preferenze: { nome: '', colore: null },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Crea lo store dell'applicazione.
 *
 * @param {object} [iniziale]  Campi che sovrascrivono lo stato iniziale.
 * @param {{
 *   invia?: (messaggio: object) => void,          // azioni di gioco già incapsulate
 *   protocollo?: (messaggio: object) => void,     // creaStanza, entraStanza, …
 *   apriDialogo?: (tipo: string, dati: object, dispatch: Function) => unknown,
 *   chiudiDialogo?: () => void,
 *   toast?: (testo: string, opzioni: { livello?: string, durata?: number }) => void,
 *   altro?: (azione: object) => boolean,          // azioni ui:* aggiuntive
 * }} [gestori]  Collegamenti verso rete e interfaccia (iniettati, così lo
 *   store resta testabile da solo).
 * @returns {{
 *   getState: () => object,
 *   setState: (parziale: object) => void,
 *   subscribe: (fn: (stato: object, precedente: object) => void) => () => void,
 *   dispatch: (azione: { tipo: string }) => void,
 * }}
 */
export function creaStore(iniziale = {}, gestori = {}) {
  let stato = { ...statoIniziale(), ...iniziale };
  const ascoltatori = new Set();

  function getState() {
    return stato;
  }

  /** Merge superficiale + notifica a tutti gli ascoltatori. */
  function setState(parziale) {
    if (!parziale || typeof parziale !== 'object') return;
    const precedente = stato;
    stato = { ...stato, ...parziale };
    for (const fn of [...ascoltatori]) {
      try {
        fn(stato, precedente);
      } catch (err) {
        console.error('[store] errore in un ascoltatore:', err);
      }
    }
  }

  function subscribe(fn) {
    ascoltatori.add(fn);
    return () => ascoltatori.delete(fn);
  }

  function dispatch(azione) {
    if (!azione || typeof azione.tipo !== 'string') {
      console.warn('[store] azione non valida:', azione);
      return;
    }
    const { tipo } = azione;

    if (AZIONI_GIOCO.includes(tipo)) {
      gestori.invia?.({ tipo: 'azione', azione });
      return;
    }
    if (MESSAGGI_PROTOCOLLO.includes(tipo)) {
      (gestori.protocollo || gestori.invia)?.(azione);
      return;
    }

    switch (tipo) {
      case 'ui:seleziona':
        setState({ selezione: Number.isInteger(azione.indice) ? azione.indice : null });
        return;
      case 'ui:apriDialogo':
        gestori.apriDialogo?.(azione.dialogo, azione.dati || {}, dispatch);
        setState({ dialogo: azione.dialogo || null });
        return;
      case 'ui:chiudiDialogo':
        gestori.chiudiDialogo?.();
        setState({ dialogo: null });
        return;
      case 'ui:toast':
        gestori.toast?.(azione.testo, { livello: azione.livello || 'info', durata: azione.durata });
        return;
      case 'ui:errore':
        setState({ errore: azione.errore || null });
        return;
      case 'ui:pulisciErrore':
        if (stato.errore) setState({ errore: null });
        return;
      default:
        if (!gestori.altro || !gestori.altro(azione)) {
          console.warn('[store] azione sconosciuta:', tipo);
        }
    }
  }

  return {
    getState,
    setState,
    subscribe,
    dispatch,
    // Alias in italiano usati negli stub della fase 1.
    getStato: getState,
    sottoscrivi: subscribe,
  };
}

// ---------------------------------------------------------------------------
// Sessione e preferenze salvate nel browser
// ---------------------------------------------------------------------------

/**
 * La sessione `{ codice, giocatoreId, token }` sta in localStorage (sopravvive
 * alla chiusura della scheda) e in sessionStorage (che ha la precedenza, così
 * due schede diverse nella stessa sessione di browser restano distinte dopo
 * un refresh).
 */
export function leggiSessione() {
  for (const archivio of archivi()) {
    try {
      const s = JSON.parse(archivio.getItem(CHIAVE_SESSIONE) || 'null');
      if (s && typeof s.codice === 'string' && typeof s.token === 'string' && typeof s.giocatoreId === 'string') {
        return { codice: s.codice, giocatoreId: s.giocatoreId, token: s.token };
      }
    } catch {
      /* dato corrotto o archivio non accessibile */
    }
  }
  return null;
}

export function salvaSessione(io) {
  const testo = JSON.stringify({ codice: io.codice, giocatoreId: io.giocatoreId, token: io.token });
  for (const archivio of archivi()) {
    try {
      archivio.setItem(CHIAVE_SESSIONE, testo);
    } catch {
      /* navigazione privata o quota piena: si gioca lo stesso, senza ripresa */
    }
  }
}

export function cancellaSessione() {
  for (const archivio of archivi()) {
    try {
      archivio.removeItem(CHIAVE_SESSIONE);
    } catch {
      /* ignora */
    }
  }
}

function leggiPreferenze() {
  try {
    const p = JSON.parse(globalThis.localStorage?.getItem(CHIAVE_PREFERENZE) || 'null');
    if (p && typeof p === 'object') {
      return { nome: typeof p.nome === 'string' ? p.nome : '', colore: typeof p.colore === 'string' ? p.colore : null };
    }
  } catch {
    /* ignora */
  }
  return { nome: '', colore: null };
}

function salvaPreferenze(preferenze) {
  try {
    globalThis.localStorage?.setItem(CHIAVE_PREFERENZE, JSON.stringify(preferenze));
  } catch {
    /* ignora */
  }
}

/** sessionStorage prima di localStorage; quelli non disponibili sono saltati. */
function archivi() {
  const lista = [];
  try { if (globalThis.sessionStorage) lista.push(globalThis.sessionStorage); } catch { /* bloccato */ }
  try { if (globalThis.localStorage) lista.push(globalThis.localStorage); } catch { /* bloccato */ }
  return lista;
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

/** Formatta un importo intero in euro: 1500 → "1.500 €". */
export function formattaEuro(importo) {
  return `${Number(importo || 0).toLocaleString('it-IT')} €`;
}

/** Importa un modulo senza far cadere l'app se manca o ha un errore. */
async function caricaModulo(percorso) {
  try {
    return await import(percorso);
  } catch (err) {
    console.error(`[app] impossibile caricare ${percorso}:`, err);
    return null;
  }
}

/** Fase → vista dell'app. */
export function vistaPer(partita) {
  if (!partita || partita.fase === 'lobby') return 'lobby';
  return partita.fase === 'finePartita' ? 'fine' : 'partita';
}

/** Codici di errore che riguardano la lobby (mostrati nel form, non come toast). */
const ERRORI_LOBBY = new Set([
  'STANZA_INESISTENTE', 'STANZA_PIENA', 'PARTITA_INIZIATA', 'NOME_NON_VALIDO',
  'NOME_OCCUPATO', 'COLORE_NON_VALIDO', 'COLORE_OCCUPATO', 'GIA_IN_STANZA',
]);

/**
 * Decide se e come notificare un evento con un toast. La cronaca completa è
 * già in #pannelli (role="log"): qui solo ciò che merita attenzione, per non
 * far leggere tutto due volte agli screen reader.
 *
 * @returns {{ testo: string, livello: string, durata?: number } | null}
 */
export function toastPerEvento(evento, partita, mioId) {
  if (!evento || typeof evento.tipo !== 'string') return null;
  const d = evento.dati || {};
  const nome = (id) => partita?.giocatori?.find((g) => g.id === id)?.nome || 'Un giocatore';
  const testo = evento.testo || '';
  const suDiMe = evento.giocatoreId === mioId;

  switch (evento.tipo) {
    case 'partitaIniziata':
      return { testo: 'La partita è iniziata! Buon divertimento.', livello: 'successo' };
    case 'turno':
      return d.giocatoreId === mioId || (d.giocatoreId === undefined && suDiMe)
        ? { testo: 'Tocca a te: lancia i dadi!', livello: 'successo' }
        : null;
    case 'giocatoreEntrato':
      return suDiMe ? null : { testo: testo || `${d.nome || 'Un giocatore'} è entrato nella stanza`, livello: 'info' };
    case 'giocatoreUscito':
      return { testo: testo || `${nome(d.giocatoreId)} è uscito dalla stanza`, livello: 'info' };
    case 'connessione':
      if (d.giocatoreId === mioId) return null;
      return {
        testo: testo || `${nome(d.giocatoreId)} ${d.connesso ? 'è di nuovo connesso' : 'si è disconnesso'}`,
        livello: d.connesso ? 'info' : 'avviso',
      };
    case 'affitto': {
      const livello = d.daId === mioId ? 'avviso' : d.aId === mioId ? 'successo' : 'info';
      return { testo, livello };
    }
    case 'acquisto':
    case 'astaInizio':
    case 'astaFine':
    case 'scambioAccettato':
      return { testo, livello: 'info' };
    case 'carta':
      return { testo: testo || d.carta?.testo || 'Carta pescata', livello: 'info', durata: 7000 };
    case 'tassa':
      return suDiMe ? { testo, livello: 'avviso' } : null;
    case 'passaggioVia':
      return suDiMe ? { testo: testo || `Passi dal Via: ritiri ${formattaEuro(d.importo)}`, livello: 'successo' } : null;
    case 'prigione':
      return { testo, livello: suDiMe ? 'avviso' : 'info' };
    case 'scambioProposto':
      return d.scambio?.aId === mioId
        ? { testo: `${nome(d.scambio.daId)} ti propone uno scambio`, livello: 'avviso', durata: 6000 }
        : null;
    case 'scambioRifiutato':
      return d.scambio && (d.scambio.daId === mioId || d.scambio.aId === mioId) ? { testo, livello: 'info' } : null;
    case 'debito':
      return suDiMe
        ? { testo: testo || `Devi pagare ${formattaEuro(d.importo)}: vendi, ipoteca o scambia per raccogliere i soldi`, livello: 'errore', durata: 7000 }
        : { testo, livello: 'avviso' };
    case 'bancarotta':
      return { testo, livello: 'errore', durata: 7000 };
    case 'finePartita':
      return {
        testo: d.vincitoreId === mioId ? 'Hai vinto la partita! 🎉' : testo || `${nome(d.vincitoreId)} vince la partita`,
        livello: 'successo',
        durata: 10000,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Avvio dell'applicazione nel browser
// ---------------------------------------------------------------------------

async function avvia() {
  const el = {
    app: document.getElementById('app'),
    lobby: document.getElementById('lobby'),
    tabellone: document.getElementById('tabellone'),
    pannelli: document.getElementById('pannelli'),
    dialoghi: document.getElementById('dialoghi'),
    toast: document.getElementById('toast'),
    connessione: document.getElementById('connessione'),
    barraStanza: document.getElementById('barra-stanza'),
    barraAzioni: document.getElementById('barra-azioni'),
  };

  // Moduli caricati in parallelo; se uno manca il resto funziona comunque.
  const [rete, lobby, tabellone, pannelli, dialoghi, dati] = await Promise.all([
    caricaModulo('/js/rete.js'),
    caricaModulo('/js/lobby.js'),
    caricaModulo('/js/tabellone.js'),
    caricaModulo('/js/pannelli.js'),
    caricaModulo('/js/dialoghi.js'),
    caricaModulo('/dati/tabellone.js'),
  ]);

  if (!rete || !lobby) {
    el.lobby.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'messaggio messaggio--errore',
      textContent: 'Non riesco a caricare il gioco. Ricarica la pagina; se il problema continua, il server potrebbe essere irraggiungibile.',
    }));
    return;
  }

  const CASELLE = dati?.CASELLE || [];
  const GRUPPI = dati?.GRUPPI || {};

  // ----- Parametri iniziali: ?stanza= e sessione salvata ------------------
  const parametri = new URLSearchParams(location.search);
  const codiceUrl = lobby.normalizzaCodice(parametri.get('stanza'));
  const salvata = leggiSessione();
  // Si riprende la sessione salvata solo se il link non punta a un'altra stanza.
  let daRiprendere = salvata && (!codiceUrl || codiceUrl === salvata.codice) ? salvata : null;

  /** @type {ReturnType<typeof rete.connetti>|null} */
  let conn = null;
  /** Nome e colore in attesa del codice dopo `creaStanza`. */
  let creazioneInAttesa = null;
  let contatoreRif = 0;
  let eraCaduta = false;

  const movimentoRidotto = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

  // ----- Toast -------------------------------------------------------------
  function mostraToast(testo, opzioni = {}) {
    if (!testo) return;
    if (typeof dialoghi?.toast === 'function') {
      try {
        dialoghi.toast(testo, { livello: opzioni.livello || 'info', durata: opzioni.durata || 4000 });
        return;
      } catch (err) {
        console.error('[app] dialoghi.toast:', err);
      }
    }
    toastDiRiserva(el.toast, testo, opzioni);
  }

  // ----- Invio verso il server --------------------------------------------
  function invia(messaggio) {
    if (!conn) return false;
    const inviato = conn.invia(messaggio);
    // Durante la prima connessione l'attesa è normale: niente avviso.
    if (!inviato && conn.stato() !== 'connessione') {
      mostraToast('Sei offline: invierò la richiesta appena torna la connessione.', { livello: 'avviso' });
    }
    return inviato;
  }

  function aggiornaLobby(parziale) {
    store.setState({ lobby: { ...store.getState().lobby, ...parziale } });
  }

  /** Gestione dei messaggi di protocollo emessi da lobby.js. */
  function gestisciProtocollo(azione) {
    switch (azione.tipo) {
      case 'creaStanza':
        salvaPreferenze({ nome: azione.nome, colore: azione.colore });
        creazioneInAttesa = { nome: azione.nome, colore: azione.colore };
        store.setState({ errore: null, preferenze: { nome: azione.nome, colore: azione.colore } });
        aggiornaLobby({ inAttesa: true });
        invia({ tipo: 'creaStanza', rif: 'crea' });
        return;
      case 'entraStanza':
        salvaPreferenze({ nome: azione.nome, colore: azione.colore });
        store.setState({ errore: null, preferenze: { nome: azione.nome, colore: azione.colore } });
        aggiornaLobby({ inAttesa: true });
        invia({ tipo: 'entraStanza', codice: azione.codice, nome: azione.nome, colore: azione.colore || undefined, rif: 'entra' });
        return;
      case 'avviaPartita':
        aggiornaLobby({ inAttesa: true });
        invia({ tipo: 'avviaPartita', rif: 'avvia' });
        return;
      case 'esciStanza':
        invia({ tipo: 'esciStanza', rif: 'esci' });
        tornaAllInizio({ mantieniConnessione: true });
        return;
      case 'riconnetti':
        invia({ ...azione, rif: 'riconnetti' });
        return;
      default:
        invia(azione);
    }
  }

  /** Dimentica stanza e sessione e torna al form iniziale. */
  function tornaAllInizio({ mantieniConnessione = false } = {}) {
    cancellaSessione();
    daRiprendere = null;
    creazioneInAttesa = null;
    history.replaceState(null, '', location.pathname);
    if (!mantieniConnessione) {
      // Un socket già associato a una stanza non può crearne un'altra
      // (GIA_IN_STANZA): si riparte da una pagina pulita.
      location.replace(location.pathname);
      return;
    }
    store.setState({
      io: null,
      partita: null,
      eventi: [],
      errore: null,
      selezione: null,
      lobby: { codiceUrl: null, inAttesa: false, ripresa: false, link: null },
    });
  }

  // ----- Store ---------------------------------------------------------------
  const store = creaStore(
    {
      lobby: { codiceUrl, inAttesa: false, ripresa: Boolean(daRiprendere), link: null },
      preferenze: leggiPreferenze(),
    },
    {
      invia: (messaggio) => {
        contatoreRif += 1;
        invia({ ...messaggio, rif: `a${contatoreRif}` });
      },
      protocollo: gestisciProtocollo,
      apriDialogo: (tipo, datiDialogo, dispatch) => {
        if (typeof dialoghi?.apri === 'function') return dialoghi.apri(tipo, datiDialogo, dispatch);
        return null;
      },
      chiudiDialogo: () => dialoghi?.chiudiTutti?.(),
      toast: mostraToast,
      altro: (azione) => {
        if (azione.tipo === 'ui:abbandonaSessione' || azione.tipo === 'ui:nuovaPartita') {
          tornaAllInizio();
          return true;
        }
        return false;
      },
    },
  );
  const { dispatch } = store;

  // ----- Messaggi dal server --------------------------------------------------
  function gestisciMessaggio(msg) {
    const s = store.getState();
    switch (msg.tipo) {
      case 'stanzaCreata': {
        aggiornaLobby({ link: msg.link || null });
        const dati = creazioneInAttesa;
        creazioneInAttesa = null;
        if (dati) {
          invia({ tipo: 'entraStanza', codice: msg.codice, nome: dati.nome, colore: dati.colore || undefined, rif: 'entra' });
        } else {
          aggiornaLobby({ inAttesa: false });
        }
        return;
      }

      case 'entrato': {
        const io = { giocatoreId: msg.giocatoreId, token: msg.token, codice: msg.codice };
        salvaSessione(io);
        daRiprendere = io;
        const cambioStanza = !s.io || s.io.codice !== io.codice;
        store.setState({
          io,
          errore: null,
          ...(cambioStanza ? { partita: null, eventi: [] } : {}),
          lobby: { ...s.lobby, inAttesa: false, ripresa: false, link: msg.link || s.lobby.link, codiceUrl: io.codice },
        });
        // L'URL diventa il link della stanza: un refresh o un copia-incolla
        // dalla barra degli indirizzi portano allo stesso posto.
        const url = `${location.pathname}?stanza=${encodeURIComponent(io.codice)}`;
        if (location.pathname + location.search !== url) history.replaceState(null, '', url);
        return;
      }

      case 'stato': {
        const nuova = msg.stato;
        if (!nuova || !s.io) return; // non siamo (più) in una stanza
        if (nuova.codice && nuova.codice !== s.io.codice) return;
        if (s.partita && s.partita.codice === nuova.codice && nuova.versione < s.partita.versione) return;
        const parziale = { partita: nuova };
        if (s.lobby.inAttesa && nuova.fase !== 'lobby') parziale.lobby = { ...s.lobby, inAttesa: false };
        store.setState(parziale);
        return;
      }

      case 'evento': {
        const evento = msg.evento;
        if (!evento) return;
        const eventi = [...s.eventi, evento].slice(-MAX_EVENTI);
        store.setState({ eventi });
        const t = toastPerEvento(evento, s.partita, s.io?.giocatoreId);
        if (t) mostraToast(t.testo, t);
        return;
      }

      case 'errore':
        gestisciErrore(msg);
        return;

      default:
        // `pong` è gestito da rete.js; tipi futuri sono ignorati.
    }
  }

  function gestisciErrore(msg) {
    const s = store.getState();
    const errore = {
      codice: msg.codice,
      messaggio: msg.messaggio || 'Errore',
      campo: msg.dettagli?.campo,
      dettagli: msg.dettagli,
    };

    // Ripresa fallita: la stanza non c'è più o il token è scaduto.
    if (msg.rif === 'riconnetti' || msg.codice === 'TOKEN_NON_VALIDO') {
      const eraInPartita = Boolean(s.partita);
      cancellaSessione();
      daRiprendere = null;
      store.setState({
        io: null,
        partita: null,
        eventi: [],
        lobby: { ...s.lobby, ripresa: false, inAttesa: false },
      });
      mostraToast(
        eraInPartita || s.lobby.ripresa
          ? 'La partita salvata non è più disponibile: puoi crearne una nuova o entrare con un codice.'
          : errore.messaggio,
        { livello: 'avviso', durata: 6000 },
      );
      return;
    }

    // Errori del form d'ingresso: mostrati accanto ai campi (role="alert").
    if (msg.rif === 'crea' || msg.rif === 'entra' || (ERRORI_LOBBY.has(msg.codice) && !s.io)) {
      creazioneInAttesa = null;
      store.setState({ errore, lobby: { ...s.lobby, inAttesa: false } });
      return;
    }

    // Tutti gli altri (avvio, azioni di gioco): toast d'errore.
    if (s.lobby.inAttesa) aggiornaLobby({ inAttesa: false });
    mostraToast(errore.messaggio, { livello: 'errore', durata: 5000 });
  }

  // ----- Rendering -------------------------------------------------------------
  let vistaCorrente = null;
  let tabelloneDi = null; // codice della stanza per cui il tabellone è montato
  let pianificato = false;

  function pianificaRender() {
    if (pianificato) return;
    pianificato = true;
    queueMicrotask(() => {
      pianificato = false;
      disegna();
    });
  }

  let precedente = null;
  function disegna() {
    const stato = store.getState();
    const prima = precedente;
    precedente = stato;
    const partita = stato.partita;
    const vista = vistaPer(partita);
    const mioId = stato.io?.giocatoreId || null;

    // Transizione di vista: mostra/nasconde i contenitori.
    if (vista !== vistaCorrente) {
      const daLobby = vistaCorrente === 'lobby' || vistaCorrente === null;
      vistaCorrente = vista;
      el.app.dataset.vista = vista;
      el.lobby.hidden = vista !== 'lobby';
      el.tabellone.hidden = vista === 'lobby';
      el.pannelli.hidden = vista === 'lobby';
      if (vista === 'lobby') {
        tabelloneDi = null;
        dialoghi?.chiudiTutti?.();
      } else if (daLobby && prima && prima.partita) {
        // Si arriva in partita dalla sala d'attesa: focus sul contenuto.
        el.app.focus({ preventScroll: true });
      }
    }

    if (vista === 'lobby') {
      lobby.render(el.lobby, stato, dispatch);
    } else {
      // Tabellone: costruito una volta per stanza, poi aggiornato.
      if (tabellone && tabelloneDi !== partita.codice) {
        tabelloneDi = partita.codice;
        chiama(() => tabellone.render(el.tabellone, partita, {
          caselle: CASELLE,
          gruppi: GRUPPI,
          mioId,
          animazioni: !movimentoRidotto?.matches,
        }), 'tabellone.render');
      } else if (tabellone && (!prima || prima.partita !== partita)) {
        chiama(() => tabellone.aggiorna(partita), 'tabellone.aggiorna');
      }
      // Evidenzia la casella scelta (ui:seleziona) se tabellone.js lo supporta.
      if (typeof tabellone?.seleziona === 'function' && (!prima || prima.selezione !== stato.selezione)) {
        chiama(() => tabellone.seleziona(stato.selezione), 'tabellone.seleziona');
      }
      if (pannelli) chiama(() => pannelli.render(el.pannelli, stato, dispatch), 'pannelli.render');
    }

    disegnaBarra(stato, vista);
    aggiornaTitolo(stato, vista);
  }

  /** Esegue un render di un altro modulo isolando eventuali eccezioni. */
  function chiama(fn, nome) {
    try {
      fn();
    } catch (err) {
      console.error(`[app] errore in ${nome}:`, err);
    }
  }

  /** Barra superiore: codice stanza, turno, pulsante "Nuova partita" a fine gioco. */
  function disegnaBarra(stato, vista) {
    const partita = stato.partita;
    const codice = partita?.codice || stato.io?.codice;
    if (codice && stato.io) {
      el.barraStanza.hidden = false;
      const turno = vista === 'partita' && partita.turno?.numero ? ` · turno ${partita.turno.numero}` : '';
      const firma = `${codice}${turno}`;
      if (el.barraStanza.dataset.firma !== firma) {
        el.barraStanza.dataset.firma = firma;
        const forte = document.createElement('strong');
        forte.textContent = codice;
        el.barraStanza.replaceChildren('Stanza ', forte, turno);
      }
    } else {
      el.barraStanza.hidden = true;
      delete el.barraStanza.dataset.firma;
    }

    const voluto = vista === 'fine' ? 'fine' : '';
    if (el.barraAzioni.dataset.contenuto !== voluto) {
      el.barraAzioni.dataset.contenuto = voluto;
      el.barraAzioni.replaceChildren();
      if (voluto === 'fine') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pulsante pulsante--primario pulsante--piccolo';
        b.textContent = 'Nuova partita';
        b.addEventListener('click', () => dispatch({ tipo: 'ui:nuovaPartita' }));
        el.barraAzioni.append(b);
      }
    }
  }

  /** Il titolo della scheda avvisa quando tocca a me (utile con la scheda in secondo piano). */
  function aggiornaTitolo(stato, vista) {
    const base = 'Monopoly online';
    const p = stato.partita;
    const mio = stato.io?.giocatoreId;
    let titolo = `${base} · gioca con gli amici`;
    if (vista === 'lobby' && p) titolo = `Stanza ${p.codice} · ${base}`;
    if (vista === 'partita') {
      const tocca = p.turno?.giocatoreId === mio
        || (p.fase === 'debito' && p.debito?.giocatoreId === mio)
        || (p.fase === 'asta' && p.asta?.partecipanti?.includes(mio) && !p.asta?.passati?.includes(mio));
      titolo = tocca ? `● Tocca a te · ${base}` : `Partita ${p.codice} · ${base}`;
    }
    if (vista === 'fine') titolo = `Partita finita · ${base}`;
    if (document.title !== titolo) document.title = titolo;
  }

  store.subscribe(pianificaRender);

  // Selezione di una casella sul tabellone (il dettaglio lo apre pannelli.js).
  el.tabellone.addEventListener('casella-selezionata', (e) => {
    if (e.detail && Number.isInteger(e.detail.indice)) dispatch({ tipo: 'ui:seleziona', indice: e.detail.indice });
  });

  // Se l'utente cambia la preferenza sul movimento, il tabellone si ricostruisce.
  movimentoRidotto?.addEventListener?.('change', () => {
    tabelloneDi = null;
    pianificaRender();
  });

  // ----- Connessione -----------------------------------------------------------
  conn = rete.connetti(rete.urlPredefinito(), {
    onApertura() {
      // Dopo un refresh o una caduta di rete riprendiamo il nostro giocatore.
      const io = store.getState().io || daRiprendere;
      if (io) invia({ tipo: 'riconnetti', codice: io.codice, token: io.token, rif: 'riconnetti' });
      if (eraCaduta) {
        eraCaduta = false;
        mostraToast('Connessione ripristinata', { livello: 'successo', durata: 2500 });
      }
    },
    onMessaggio: gestisciMessaggio,
    onErrore(err) {
      console.warn('[rete]', err);
    },
    onRiconnessione(tentativo) {
      if (tentativo === 1 && store.getState().io) {
        eraCaduta = true;
        mostraToast('Connessione persa: provo a riconnettermi…', { livello: 'avviso' });
      }
    },
    onStato(statoRete, dettagli) {
      rete.aggiornaIndicatore(el.connessione, statoRete, dettagli);
      const connessione = statoRete === 'chiuso' ? 'disconnesso' : statoRete;
      if (store.getState().connessione !== connessione) store.setState({ connessione });
    },
  });

  // Primo disegno (la lobby o la schermata di ripresa).
  disegna();

  // Accesso comodo dalla console per il debug.
  globalThis.monopoly = { store, conn };
}

/**
 * Toast minimale usato solo se dialoghi.js non è disponibile.
 */
function toastDiRiserva(contenitore, testo, { livello = 'info', durata = 4000 } = {}) {
  if (!contenitore) return;
  const nodo = document.createElement('div');
  nodo.className = `toast toast--${livello}`;
  // Il contenitore #toast è già una regione live: basta aggiungere il testo.
  nodo.textContent = testo;
  contenitore.append(nodo);
  while (contenitore.children.length > 4) contenitore.firstElementChild.remove();
  setTimeout(() => {
    nodo.classList.add('toast--uscita');
    setTimeout(() => nodo.remove(), 300);
  }, durata);
}

// Nel browser si avvia da solo; importato altrove (test, altri moduli) no.
if (typeof document !== 'undefined' && document.getElementById('app')) {
  avvia().catch((err) => console.error('[app] avvio fallito:', err));
}
