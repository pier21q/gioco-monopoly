'use strict';

/**
 * server/gioco/scambi.js
 *
 * Proposta, validazione e applicazione degli scambi tra giocatori.
 * Usato dal motore (`proponiScambio`, `accettaScambio`); esportato anche per
 * i test. Contratto in INTERFACCE.md §1.7 e §2.6.
 *
 * STUB (fase 1): le firme sono definitive, la logica arriva in fase 2.
 * Le funzioni non mutano mai lo stato ricevuto.
 */

const { ERRORI } = require('../protocollo');

function errore(codice, dettagli) {
  const out = { codice, messaggio: ERRORI[codice] || codice };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return { errore: out };
}

/** Porta una metà di scambio ({denaro, proprieta, cartePrigione}) alla forma canonica. */
function normalizzaParte(parte) {
  const p = parte && typeof parte === 'object' ? parte : {};
  const denaro = Number.isInteger(p.denaro) && p.denaro >= 0 ? p.denaro : 0;
  const proprieta = Array.isArray(p.proprieta)
    ? [...new Set(p.proprieta.filter((i) => Number.isInteger(i) && i >= 0 && i < 40))].sort((a, b) => a - b)
    : [];
  const cartePrigione = Number.isInteger(p.cartePrigione) && p.cartePrigione >= 0 ? p.cartePrigione : 0;
  return { denaro, proprieta, cartePrigione };
}

/**
 * Valida una proposta di scambio.
 *
 * @param {object} stato      StatoPartita
 * @param {string} daId       proponente
 * @param {object} proposta   { aId, offre, chiede }
 * @param {object} [contesto] { ora }
 * @returns {{ok: true, scambio: object} | {errore: object}}
 */
function validaProposta(stato, daId, proposta, contesto = {}) {
  if (!stato || !proposta || typeof proposta !== 'object') return errore('PARAMETRI_NON_VALIDI');
  if (stato.scambio) return errore('SCAMBIO_IN_CORSO');

  const da = (stato.giocatori || []).find((g) => g.id === daId);
  const a = (stato.giocatori || []).find((g) => g.id === proposta.aId);
  if (!da || !a || da.id === a.id) return errore('GIOCATORE_NON_VALIDO');
  if (da.fallito || a.fallito) return errore('GIOCATORE_FALLITO');

  const offre = normalizzaParte(proposta.offre);
  const chiede = normalizzaParte(proposta.chiede);
  const vuoto = (p) => p.denaro === 0 && p.proprieta.length === 0 && p.cartePrigione === 0;
  if (vuoto(offre) && vuoto(chiede)) return errore('SCAMBIO_VUOTO');

  // TODO fase 2: verificare possessi (denaro, proprietà senza costruzioni, carte).

  const contatore = (stato.contatoreScambi || 0) + 1;
  const ora = typeof contesto.ora === 'function' ? contesto.ora() : Date.now();
  return {
    ok: true,
    scambio: {
      id: `s${contatore}`,
      daId: da.id,
      aId: a.id,
      offre,
      chiede,
      propostoIl: ora,
    },
  };
}

/**
 * Applica uno scambio già accettato: trasferisce denaro, proprietà e carte.
 *
 * @param {object} stato     StatoPartita (non mutato)
 * @param {object} scambio   come in stato.scambio
 * @param {object} [contesto] { ora }
 * @returns {{stato: object, eventi: object[]} | {errore: object}}
 */
function applicaScambio(stato, scambio, contesto = {}) {
  if (!stato || !scambio) return errore('SCAMBIO_NON_TROVATO');
  // TODO fase 2: trasferimenti, interesse 10% sulle ipotecate ricevute, eventi.
  const nuovo = structuredClone(stato);
  nuovo.scambio = null;
  void contesto;
  return { stato: nuovo, eventi: [] };
}

module.exports = {
  normalizzaParte,
  validaProposta,
  applicaScambio,
};
