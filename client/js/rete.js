/**
 * client/js/rete.js
 *
 * Strato di rete del client: apre e mantiene la connessione WebSocket con il
 * server, serializza i messaggi in uscita (azioni del giocatore), deserializza
 * quelli in ingresso (stato della partita, eventi, errori) e li consegna ai
 * callback forniti. Gestisce la riconnessione automatica con backoff e il
 * ripristino della sessione tramite token della stanza.
 *
 * Il formato dei messaggi è definito in INTERFACCE.md (protocollo WebSocket).
 * Endpoint: ws(s)://host/ws. Il link di invito a una stanza è /?stanza=ABC123.
 */

/**
 * Apre la connessione al server.
 *
 * @param {string} url  URL del WebSocket (es. `wss://host/ws`).
 * @param {{
 *   onApertura?: () => void,
 *   onMessaggio?: (messaggio: object) => void,
 *   onChiusura?: (motivo: { codice: number, pulita: boolean }) => void,
 *   onErrore?: (errore: unknown) => void,
 * }} callbacks
 * @returns {{
 *   invia: (messaggio: object) => void,
 *   chiudi: () => void,
 *   connesso: () => boolean,
 * }}
 */
export function connetti(url, callbacks = {}) {
  // TODO (fase 2): WebSocket reale, coda dei messaggi, riconnessione.
  void url;
  void callbacks;

  return {
    invia: (messaggio) => {
      void messaggio;
    },
    chiudi: () => {},
    connesso: () => false,
  };
}
