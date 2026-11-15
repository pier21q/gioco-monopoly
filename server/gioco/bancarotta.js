'use strict';

/**
 * server/gioco/bancarotta.js
 *
 * Liquidazione di un giocatore in bancarotta e trasferimento dei beni al
 * creditore (giocatore) o alla banca. Usato dal motore
 * (`dichiaraBancarotta`); esportato anche per i test.
 * Contratto in INTERFACCE.md §1.8, §2.7 e §8.10.
 *
 * STUB (fase 1): firme definitive, logica in fase 2.
 * Le funzioni non mutano mai lo stato ricevuto.
 */

const { ERRORI } = require('../protocollo');

function errore(codice, dettagli) {
  const out = { codice, messaggio: ERRORI[codice] || codice };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return { errore: out };
}

/**
 * Denaro che il giocatore potrebbe raccogliere vendendo tutte le costruzioni
 * (a metà prezzo) e ipotecando tutte le proprietà libere, più la liquidità.
 * Serve a decidere se un debito è saldabile senza bancarotta.
 *
 * @param {object} stato
 * @param {string} giocatoreId
 * @returns {number} intero >= 0
 */
function patrimonioLiquidabile(stato, giocatoreId) {
  const g = (stato.giocatori || []).find((x) => x.id === giocatoreId);
  if (!g) return 0;
  // TODO fase 2: sommare metà costruzioni e valori d'ipoteca leggendo CASELLE.
  return g.denaro;
}

/**
 * Liquida `giocatoreId`: vende le costruzioni alla banca, trasferisce denaro,
 * proprietà e carte prigione al creditore (o libera tutto alla banca), marca
 * `fallito: true`, passa il turno se necessario e chiude la partita se resta
 * un solo giocatore.
 *
 * @param {object} stato         StatoPartita (non mutato)
 * @param {string} giocatoreId   chi fallisce
 * @param {string|null} creditoreId  giocatore creditore, o null per la banca
 * @param {object} [contesto]    { ora }
 * @returns {{stato: object, eventi: object[]} | {errore: object}}
 */
function liquida(stato, giocatoreId, creditoreId, contesto = {}) {
  const g = (stato.giocatori || []).find((x) => x.id === giocatoreId);
  if (!g) return errore('GIOCATORE_NON_VALIDO');
  if (g.fallito) return errore('GIOCATORE_FALLITO');

  // TODO fase 2: liquidazione completa con eventi 'vendita', 'bancarotta',
  // 'turno', 'finePartita'.
  const nuovo = structuredClone(stato);
  const nuovoG = nuovo.giocatori.find((x) => x.id === giocatoreId);
  nuovoG.fallito = true;
  nuovo.debito = null;
  void creditoreId;
  void contesto;
  return { stato: nuovo, eventi: [] };
}

module.exports = {
  patrimonioLiquidabile,
  liquida,
};
