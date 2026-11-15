/**
 * client/js/tabellone.js
 *
 * Disegno del tabellone in #tabellone: le 40 caselle in griglia 11x11 con
 * nome, fascia colore, prezzo, case/alberghi e proprietario; le pedine dei
 * giocatori con animazione di spostamento; evidenziazione del turno corrente
 * e della casella selezionata (click o tastiera) per vedere il dettaglio.
 *
 * `render` costruisce il DOM una volta sola a partire dall'elenco caselle
 * (`import { CASELLE, GRUPPI } from '/dati/tabellone.js'`, ES module generato
 * dal server dai dati di server/gioco/tabellone.js); `aggiorna` applica le
 * differenze (posizioni, edifici, proprietari, ipoteche) senza ricostruire
 * tutto.
 */

/**
 * Costruisce il tabellone nel contenitore dato.
 *
 * @param {HTMLElement} radice  Contenitore #tabellone.
 * @param {object} stato        Stato corrente (deve contenere le caselle).
 * @param {{
 *   onCasellaSelezionata?: (indice: number) => void,
 *   animazioni?: boolean,
 * }} [opzioni]
 */
export function render(radice, stato, opzioni = {}) {
  // TODO (fase 2): griglia 11x11, caselle, pedine, gestione selezione.
  void radice;
  void stato;
  void opzioni;
}

/**
 * Aggiorna il tabellone già disegnato con il nuovo stato.
 *
 * @param {object} stato  Stato corrente.
 */
export function aggiorna(stato) {
  // TODO (fase 2): diff posizioni pedine, edifici, proprietari, ipoteche.
  void stato;
}
