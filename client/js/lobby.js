/**
 * client/js/lobby.js
 *
 * Schermata iniziale montata in #lobby: creazione di una nuova stanza,
 * ingresso in una stanza esistente tramite link condiviso o codice, scelta del
 * nome e della pedina, elenco dei giocatori presenti (max 6), pulsante
 * "Inizia la partita" per chi ha creato la stanza, link da copiare per
 * invitare gli amici.
 *
 * Il modulo non tiene stato proprio: riceve lo stato dallo store e invia le
 * intenzioni dell'utente tramite `dispatch`.
 */

/**
 * Disegna (o ridisegna) la lobby.
 *
 * @param {HTMLElement} radice  Contenitore #lobby.
 * @param {object} stato        Stato corrente dello store.
 * @param {(azione: object) => void} dispatch
 */
export function render(radice, stato, dispatch) {
  // TODO (fase 2): form stanza/nome/pedina, elenco giocatori, link invito.
  void radice;
  void stato;
  void dispatch;
}
