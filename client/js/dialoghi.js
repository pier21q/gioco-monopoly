/**
 * client/js/dialoghi.js
 *
 * Finestre di dialogo modali montate in #dialoghi, una per ogni decisione di
 * gioco che richiede conferma o input: acquisto di una proprietà, asta,
 * proposta e risposta a uno scambio, costruzione/vendita di case e alberghi,
 * ipoteca e riscatto, carta Probabilità/Imprevisti pescata, pagamento
 * dell'affitto, scelta in prigione (paga, carta, tira), bancarotta, fine
 * partita. Usa l'elemento <dialog> nativo per focus trap, chiusura con Esc e
 * annuncio agli screen reader.
 */

/**
 * Apre un dialogo del tipo indicato.
 *
 * @param {'acquisto'|'asta'|'scambio'|'costruzione'|'ipoteca'|'carta'|
 *         'affitto'|'prigione'|'bancarotta'|'finePartita'|string} tipo
 * @param {object} dati  Dati specifici del dialogo (casella, offerta, carta...).
 * @param {(azione: object) => void} dispatch
 * @returns {{ chiudi: () => void }}
 */
export function apri(tipo, dati, dispatch) {
  // TODO (fase 2): un template per tipo, montaggio in #dialoghi, showModal().
  void tipo;
  void dati;
  void dispatch;

  return { chiudi: () => {} };
}
