/**
 * client/js/rete.js
 *
 * Strato di rete del client (INTERFACCE.md §3 e §4.3).
 *
 * - Apre e mantiene la connessione WebSocket con il server (`/ws`).
 * - Serializza i messaggi in uscita e deserializza quelli in ingresso,
 *   consegnandoli ai callback come oggetti già analizzati.
 * - Riconnessione automatica con backoff esponenziale 1 s → 30 s (×2, jitter
 *   ±20%); riprova subito quando il browser torna online o la scheda torna
 *   visibile.
 * - Coda dei messaggi (max 20) mentre si è offline: vengono inviati alla
 *   riapertura, DOPO il callback onApertura (così app.js può mandare per primo
 *   `riconnetti` con il token salvato e il server sa chi siamo). Chi invia può
 *   rinunciare alla coda con `{ accoda: false }`: app.js lo fa per le azioni di
 *   gioco, che eseguite in ritardo non avrebbero più senso.
 * - Dopo una chiusura definitiva (1008, 1009, 4001 "aperto in un'altra
 *   scheda", 4002 "stanza chiusa") non riprova da solo: serve `riprovaOra()`.
 * - Keep-alive con `ping` ogni 25 s.
 * - Indicatore di connessione accessibile (`aggiornaIndicatore`).
 *
 * Questo modulo non conosce la logica di gioco né la sessione: il ripristino
 * del giocatore (token) è compito di app.js, che lo fa in onApertura.
 */

/** Tempi del backoff e del keep-alive, in millisecondi. */
export const TEMPI = Object.freeze({
  BACKOFF_INIZIALE: 1000,
  BACKOFF_MASSIMO: 30000,
  FATTORE: 2,
  JITTER: 0.2,
  PING: 25000,
  /** Un messaggio rimasto in coda più a lungo di così viene scartato. */
  SCADENZA_CODA: 2 * 60 * 1000,
});

/** Numero massimo di messaggi tenuti in coda mentre si è offline. */
export const MAX_CODA = 20;

/** Codici di chiusura dedicati usati dal server (server/protocollo.js, CHIUSURE). */
export const CHIUSURE = Object.freeze({
  SOSTITUITO: 4001, // lo stesso giocatore si è collegato da un'altra scheda
  STANZA_CHIUSA: 4002, // la stanza è stata eliminata
});

/**
 * Codici di chiusura dopo i quali non si riprova da soli: serve una scelta
 * esplicita dell'utente (`riprovaOra()`). Il 4000 NON è tra questi: lo usa
 * questo modulo per chiudere il socket quando il browser va offline.
 */
const CHIUSURE_DEFINITIVE = new Set([
  1008, // violazione di policy (es. troppi messaggi non validi)
  1009, // messaggio troppo grande
  CHIUSURE.SOSTITUITO,
  CHIUSURE.STANZA_CHIUSA,
]);

/**
 * URL WebSocket predefinito ricavato dalla pagina corrente (§3.1).
 *
 * @param {Location} [posizione=globalThis.location]
 * @returns {string} es. `wss://esempio.it/ws`
 */
export function urlPredefinito(posizione = globalThis.location) {
  const protocollo = posizione.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocollo}://${posizione.host}/ws`;
}

/**
 * Calcola l'attesa prima del tentativo n (1, 2, 3…) con jitter ±20%.
 *
 * @param {number} tentativo
 * @param {() => number} [casuale=Math.random]
 * @returns {number} millisecondi
 */
export function attesaBackoff(tentativo, casuale = Math.random) {
  const base = Math.min(
    TEMPI.BACKOFF_MASSIMO,
    TEMPI.BACKOFF_INIZIALE * TEMPI.FATTORE ** Math.max(0, tentativo - 1),
  );
  const jitter = 1 + (casuale() * 2 - 1) * TEMPI.JITTER;
  return Math.round(base * jitter);
}

/**
 * Apre la connessione al server e la mantiene viva.
 *
 * @param {string} url  URL del WebSocket (vedi `urlPredefinito`).
 * @param {{
 *   onApertura?: () => void,
 *   onMessaggio?: (messaggio: object) => void,
 *   onChiusura?: (evento: CloseEvent) => void,
 *   onErrore?: (errore: unknown) => void,
 *   onRiconnessione?: (tentativo: number, ms: number) => void,
 *   onStato?: (stato: 'connessione'|'connesso'|'riconnessione'|'chiuso',
 *              dettagli: { tentativo: number, prossimoTra: number|null, coda: number }) => void,
 * }} [callbacks]
 * @param {{ WebSocket?: typeof WebSocket, casuale?: () => number }} [ambiente]
 *   Iniezioni per i test (WebSocket finto, generatore casuale).
 * @returns {{
 *   invia: (messaggio: object, opzioni?: { accoda?: boolean }) => boolean,
 *   chiudi: () => void,
 *   stato: () => 'connessione'|'connesso'|'riconnessione'|'chiuso',
 *   riprovaOra: () => void,
 *   inCoda: () => number,
 * }}
 */
export function connetti(url, callbacks = {}, ambiente = {}) {
  const ClasseWS = ambiente.WebSocket || globalThis.WebSocket;
  const casuale = ambiente.casuale || Math.random;

  /** @type {WebSocket|null} */
  let socket = null;
  /** @type {'connessione'|'connesso'|'riconnessione'|'chiuso'} */
  let statoAttuale = 'connessione';
  let tentativo = 0;
  let prossimoTra = null;
  let timerRiconnessione = null;
  let timerPing = null;
  let chiusoVolontariamente = false;
  /** Vero dopo una chiusura definitiva: niente tentativi automatici. */
  let fermo = false;
  /** @type {{ testo: string, quando: number }[]} */
  let coda = [];

  /** Chiama un callback proteggendo la rete da eccezioni dei moduli UI. */
  function richiama(nome, ...argomenti) {
    const fn = callbacks[nome];
    if (typeof fn !== 'function') return;
    try {
      fn(...argomenti);
    } catch (err) {
      console.error(`[rete] errore nel callback ${nome}:`, err);
    }
  }

  function impostaStato(nuovo) {
    statoAttuale = nuovo;
    richiama('onStato', nuovo, { tentativo, prossimoTra, coda: coda.length });
  }

  function apri() {
    clearTimeout(timerRiconnessione);
    timerRiconnessione = null;
    prossimoTra = null;
    impostaStato(tentativo === 0 ? 'connessione' : 'riconnessione');

    let ws;
    try {
      ws = new ClasseWS(url);
    } catch (err) {
      richiama('onErrore', err);
      programmaRiconnessione();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      if (ws !== socket) return;
      tentativo = 0;
      impostaStato('connesso');
      avviaPing();
      // Prima il callback (che può inviare `riconnetti`), poi la coda.
      richiama('onApertura');
      svuotaCoda();
    });

    ws.addEventListener('message', (e) => {
      if (ws !== socket) return;
      let messaggio;
      try {
        messaggio = JSON.parse(e.data);
      } catch (err) {
        richiama('onErrore', new Error('Messaggio non JSON dal server'));
        return;
      }
      if (!messaggio || typeof messaggio.tipo !== 'string') return;
      if (messaggio.tipo === 'pong') return; // keep-alive: nulla da fare
      richiama('onMessaggio', messaggio);
    });

    ws.addEventListener('error', (e) => {
      if (ws !== socket) return;
      richiama('onErrore', e);
      // Dopo "error" il browser emette sempre anche "close": la riconnessione
      // viene programmata lì.
    });

    ws.addEventListener('close', (e) => {
      if (ws !== socket) return;
      fermaPing();
      socket = null;
      if (chiusoVolontariamente || CHIUSURE_DEFINITIVE.has(e.code)) {
        fermo = true;
        // Le azioni rimaste in coda non hanno più un destinatario.
        coda = [];
        impostaStato('chiuso');
        richiama('onChiusura', e);
        return;
      }
      richiama('onChiusura', e);
      programmaRiconnessione();
    });
  }

  function programmaRiconnessione() {
    if (chiusoVolontariamente || timerRiconnessione) return;
    tentativo += 1;
    prossimoTra = attesaBackoff(tentativo, casuale);
    impostaStato('riconnessione');
    richiama('onRiconnessione', tentativo, prossimoTra);
    timerRiconnessione = setTimeout(() => {
      timerRiconnessione = null;
      apri();
    }, prossimoTra);
  }

  function avviaPing() {
    fermaPing();
    timerPing = setInterval(() => {
      invia({ tipo: 'ping' }, { accoda: false });
    }, TEMPI.PING);
  }

  function fermaPing() {
    clearInterval(timerPing);
    timerPing = null;
  }

  function aperto() {
    return socket !== null && socket.readyState === ClasseWS.OPEN;
  }

  function svuotaCoda() {
    const adesso = Date.now();
    const daInviare = coda.filter((m) => adesso - m.quando <= TEMPI.SCADENZA_CODA);
    coda = [];
    for (const m of daInviare) {
      if (!aperto()) {
        // La connessione è caduta durante lo svuotamento: rimetti in coda.
        coda.push(m);
        continue;
      }
      socket.send(m.testo);
    }
    if (coda.length) impostaStato(statoAttuale);
  }

  /**
   * Invia un messaggio. Se la connessione non è aperta lo accoda (salvo
   * `accoda: false`) e ritorna false.
   */
  function invia(messaggio, opzioni = {}) {
    const testo = JSON.stringify(messaggio);
    if (aperto()) {
      try {
        socket.send(testo);
        return true;
      } catch (err) {
        richiama('onErrore', err);
      }
    }
    if (opzioni.accoda === false || chiusoVolontariamente) return false;
    coda.push({ testo, quando: Date.now() });
    // Coda limitata: si scartano i messaggi più vecchi.
    if (coda.length > MAX_CODA) coda = coda.slice(-MAX_CODA);
    impostaStato(statoAttuale);
    return false;
  }

  /** Chiusura volontaria: niente riconnessione, coda svuotata. */
  function chiudi() {
    chiusoVolontariamente = true;
    clearTimeout(timerRiconnessione);
    timerRiconnessione = null;
    fermaPing();
    coda = [];
    rimuoviAscoltatori();
    if (socket) {
      const s = socket;
      socket = null;
      try {
        s.close(1000, 'chiusura volontaria');
      } catch {
        /* già chiuso */
      }
    }
    impostaStato('chiuso');
  }

  /**
   * Salta l'attesa del backoff e riprova subito. Chiamata dall'utente (pulsante
   * "Riconnetti" / "Usa questa scheda") riparte anche dopo una chiusura
   * definitiva; i tentativi automatici (`automatico: true`) invece no.
   */
  function riprovaOra({ automatico = false } = {}) {
    if (chiusoVolontariamente || socket) return;
    if (fermo && automatico) return;
    fermo = false;
    clearTimeout(timerRiconnessione);
    timerRiconnessione = null;
    apri();
  }

  // Il browser ci dice quando la rete torna o la scheda torna in primo piano:
  // in quei momenti conviene riprovare senza aspettare il backoff.
  const suOnline = () => riprovaOra({ automatico: true });
  const suVisibile = () => {
    if (globalThis.document && document.visibilityState === 'visible') riprovaOra({ automatico: true });
  };
  const suOffline = () => {
    // Il socket potrebbe restare "aperto" a lungo prima di accorgersene:
    // lo chiudiamo noi per passare subito a "riconnessione".
    if (socket) {
      try {
        socket.close(4000, 'offline');
      } catch {
        /* ignora */
      }
    }
  };
  if (globalThis.addEventListener) {
    globalThis.addEventListener('online', suOnline);
    globalThis.addEventListener('offline', suOffline);
  }
  if (globalThis.document) document.addEventListener('visibilitychange', suVisibile);

  function rimuoviAscoltatori() {
    if (globalThis.removeEventListener) {
      globalThis.removeEventListener('online', suOnline);
      globalThis.removeEventListener('offline', suOffline);
    }
    if (globalThis.document) document.removeEventListener('visibilitychange', suVisibile);
  }

  apri();

  return {
    invia,
    chiudi,
    stato: () => statoAttuale,
    riprovaOra,
    inCoda: () => coda.length,
  };
}

/**
 * Aggiorna l'indicatore di connessione nella barra superiore.
 *
 * Il contenitore ha `role="status"`: il testo cambia solo quando cambia lo
 * stato (non a ogni secondo), così gli screen reader non vengono inondati.
 *
 * @param {HTMLElement|null} elemento  `#connessione`
 * @param {'connessione'|'connesso'|'riconnessione'|'chiuso'} stato
 * @param {{ tentativo?: number, prossimoTra?: number|null, coda?: number }} [dettagli]
 */
export function aggiornaIndicatore(elemento, stato, dettagli = {}) {
  if (!elemento) return;
  const testi = {
    connessione: 'Connessione in corso…',
    connesso: 'Connesso',
    riconnessione: 'Connessione persa, riprovo…',
    chiuso: 'Disconnesso',
  };
  let testo = testi[stato] || stato;
  if (stato === 'riconnessione' && dettagli.prossimoTra) {
    const secondi = Math.max(1, Math.round(dettagli.prossimoTra / 1000));
    testo = `Connessione persa: nuovo tentativo tra ${secondi} s`;
  }
  if (dettagli.coda && stato !== 'connesso') {
    testo += ` · ${dettagli.coda} ${dettagli.coda === 1 ? 'azione' : 'azioni'} in attesa`;
  }

  elemento.dataset.stato = stato;
  const nodoTesto = elemento.querySelector('.indicatore-connessione__testo') || elemento;
  if (nodoTesto.textContent !== testo) nodoTesto.textContent = testo;
  elemento.title = testo;
}
