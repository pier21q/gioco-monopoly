/**
 * client/js/app.js
 *
 * Punto d'ingresso del client. Crea lo store (stato locale della partita +
 * dispatch delle azioni), collega la rete (rete.js) e orchestra i moduli di
 * interfaccia: lobby.js finché la partita non parte, poi tabellone.js e
 * pannelli.js; dialoghi.js per le finestre modali e il contenitore #toast per
 * le notifiche brevi.
 *
 * Lo store segue lo schema "stato immutabile + dispatch": lo stato
 * autorevole arriva dal server via WebSocket, le azioni dell'utente vengono
 * inviate al server e lo stato locale viene sostituito ad ogni aggiornamento.
 */

/**
 * Crea lo store dell'applicazione.
 *
 * @returns {{
 *   getStato: () => object,
 *   dispatch: (azione: { tipo: string, [chiave: string]: unknown }) => void,
 *   sottoscrivi: (ascoltatore: (stato: object) => void) => () => void,
 * }}
 */
export function creaStore() {
  // TODO (fase 2): stato iniziale, riduttore locale, invio azioni alla rete.
  let stato = {};
  const ascoltatori = new Set();

  return {
    getStato: () => stato,
    dispatch: (azione) => {
      void azione;
    },
    sottoscrivi: (ascoltatore) => {
      ascoltatori.add(ascoltatore);
      return () => ascoltatori.delete(ascoltatore);
    },
  };
}
