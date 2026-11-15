/**
 * client/js/pannelli.js
 *
 * Pannelli laterali montati in #pannelli: elenco giocatori (nome, pedina,
 * saldo, proprietà, stato prigione/bancarotta), controlli del turno (tira i
 * dadi, compra, costruisci, ipoteca, proponi scambio, passa il turno),
 * risultato dei dadi, registro cronologico degli eventi della partita e
 * scheda della casella selezionata sul tabellone.
 *
 * Come la lobby, il modulo è senza stato: riceve lo stato e usa `dispatch`.
 */

/**
 * Disegna (o ridisegna) i pannelli.
 *
 * @param {HTMLElement} radice  Contenitore #pannelli.
 * @param {object} stato        Stato corrente dello store.
 * @param {(azione: object) => void} dispatch
 */
export function render(radice, stato, dispatch) {
  // TODO (fase 2): giocatori, azioni del turno, dadi, registro eventi.
  void radice;
  void stato;
  void dispatch;
}
