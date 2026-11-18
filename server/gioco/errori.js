'use strict';

/**
 * server/gioco/errori.js
 *
 * Codici di errore del motore con il messaggio italiano predefinito
 * (INTERFACCE.md §7). Il motore non dipende da server/protocollo.js: così
 * resta un modulo puro e testabile da solo. È `protocollo.ERRORI` a includere
 * questi codici (non il contrario): si scrivono solo qui. I gestori spesso
 * sostituiscono il messaggio predefinito con uno più preciso ("Ti servono
 * 200 €, ne hai 150 €").
 */

const ERRORI = Object.freeze({
  AZIONE_NON_VALIDA: 'Azione sconosciuta',
  PARAMETRI_NON_VALIDI: 'Parametri dell\'azione non validi',
  GIOCATORE_NON_VALIDO: 'Giocatore inesistente',
  GIOCATORE_FALLITO: 'Il giocatore è fallito',
  NON_IL_TUO_TURNO: 'Non è il tuo turno',
  FASE_ERRATA: 'Azione non ammessa in questa fase',
  FONDI_INSUFFICIENTI: 'Denaro insufficiente',
  CASELLA_NON_VALIDA: 'Casella non valida',
  PROPRIETA_NON_TUA: 'Non possiedi questa proprietà',
  NON_EDIFICABILE: 'Su questa casella non si può costruire',
  GRUPPO_INCOMPLETO: 'Devi possedere tutto il gruppo di colore',
  NON_SULLA_CASELLA: 'In questa partita costruisci solo sul colore su cui ti sei fermato in questo turno',
  LIMITE_COSTRUZIONI: 'In questa partita hai già costruito il massimo consentito in un turno su questo terreno',
  COSTRUZIONE_NON_UNIFORME: 'Le costruzioni devono essere distribuite in modo uniforme',
  CASE_ESAURITE: 'La banca non ha più case disponibili',
  ALBERGHI_ESAURITI: 'La banca non ha più alberghi disponibili',
  NESSUNA_COSTRUZIONE: 'Non ci sono costruzioni da vendere',
  HA_COSTRUZIONI: 'Prima vendi le costruzioni',
  IPOTECATA: 'La proprietà (o una del gruppo) è ipotecata',
  GIA_IPOTECATA: 'La proprietà è già ipotecata',
  NON_IPOTECATA: 'La proprietà non è ipotecata',
  OFFERTA_BASSA: 'L\'offerta deve superare quella attuale',
  GIA_PASSATO: 'Hai già passato in questa asta',
  MIGLIOR_OFFERENTE: 'Il miglior offerente non può passare',
  SCAMBIO_IN_CORSO: 'C\'è già uno scambio in attesa di risposta',
  SCAMBIO_NON_TROVATO: 'Scambio non trovato',
  SCAMBIO_VUOTO: 'Lo scambio deve includere almeno qualcosa',
  NON_DESTINATARIO: 'Solo il destinatario può rispondere allo scambio',
  NON_COINVOLTO: 'Non fai parte di questo scambio',
  NON_IN_PRIGIONE: 'Non sei in prigione',
  NESSUNA_CARTA_PRIGIONE: 'Non hai carte "Uscite gratis di prigione"',
  NON_DEBITORE: 'Non hai debiti da saldare',
  NON_IMPLEMENTATO: 'Funzione non ancora disponibile in questa versione',
});

/**
 * Costruisce il risultato d'errore del motore.
 * @param {string} codice     uno dei codici di ERRORI
 * @param {string} [messaggio] testo italiano specifico (altrimenti quello predefinito)
 * @param {object} [dettagli]  dati utili al client (importi, caselle…)
 * @returns {{errore: {codice: string, messaggio: string, dettagli?: object}}}
 */
function errore(codice, messaggio, dettagli) {
  const out = { codice, messaggio: messaggio || ERRORI[codice] || codice };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return { errore: out };
}

module.exports = { ERRORI, errore };
