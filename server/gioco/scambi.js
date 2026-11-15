'use strict';

/**
 * server/gioco/scambi.js
 *
 * Proposta, validazione e applicazione degli scambi tra giocatori
 * (INTERFACCE.md §1.7 e §2.6). Si scambiano denaro, proprietà senza
 * costruzioni nel gruppo (anche ipotecate) e carte "Uscite gratis di
 * prigione". Chi riceve una proprietà ipotecata paga subito alla banca il
 * 10% del valore d'ipoteca; se non può, entra in debito ('interesseScambio').
 *
 * Le funzioni pubbliche non mutano lo stato ricevuto; `eseguiScambio` è la
 * versione interna (mutante) usata dal motore su uno stato già clonato.
 */

const N = require('./nucleo');

const { errore, euro, casella, trova, voceDi } = N;

/**
 * Porta una metà di scambio alla forma canonica in modo tollerante (valori
 * non validi → 0 / []). Conservata per compatibilità: la validazione delle
 * azioni usa `leggiParte`, che invece rifiuta i parametri malformati.
 */
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
 * Legge in modo rigoroso una metà di scambio ({denaro, proprieta, cartePrigione}).
 * I campi mancanti valgono 0 / []; quelli del tipo sbagliato danno errore.
 * @returns {{parte: object} | {errore: object}}
 */
function leggiParte(parte, etichetta) {
  if (parte === undefined || parte === null) return { parte: { denaro: 0, proprieta: [], cartePrigione: 0 } };
  if (typeof parte !== 'object' || Array.isArray(parte)) {
    return errore('PARAMETRI_NON_VALIDI', `"${etichetta}" deve essere un oggetto { denaro, proprieta, cartePrigione }`);
  }
  const intero = (v) => v === undefined || (Number.isInteger(v) && v >= 0);
  if (!intero(parte.denaro)) {
    return errore('PARAMETRI_NON_VALIDI', `Il denaro in "${etichetta}" deve essere un numero intero di euro maggiore o uguale a 0`);
  }
  if (!intero(parte.cartePrigione)) {
    return errore('PARAMETRI_NON_VALIDI', `Le carte prigione in "${etichetta}" devono essere un numero intero maggiore o uguale a 0`);
  }
  if (parte.proprieta !== undefined
    && (!Array.isArray(parte.proprieta) || !parte.proprieta.every((i) => Number.isInteger(i) && i >= 0 && i < N.NUMERO_CASELLE))) {
    return errore('PARAMETRI_NON_VALIDI', `Le proprietà in "${etichetta}" devono essere un elenco di indici di casella (0-39)`);
  }
  return {
    parte: {
      denaro: parte.denaro || 0,
      proprieta: [...new Set(parte.proprieta || [])].sort((a, b) => a - b),
      cartePrigione: parte.cartePrigione || 0,
    },
  };
}

/** Vero se la metà di scambio non contiene nulla. */
function parteVuota(p) {
  return p.denaro === 0 && p.proprieta.length === 0 && p.cartePrigione === 0;
}

/**
 * Verifica che ciascuna parte possieda ciò che mette nello scambio: denaro,
 * carte prigione e proprietà senza costruzioni nel gruppo.
 * @returns {null | {errore: object}}
 */
function verificaPossessi(stato, scambio) {
  const da = trova(stato, scambio.daId);
  const a = trova(stato, scambio.aId);
  if (!da || !a) return errore('GIOCATORE_NON_VALIDO', 'Uno dei giocatori dello scambio non esiste più');
  if (da.fallito || a.fallito) return errore('GIOCATORE_NON_VALIDO', 'Non si può scambiare con un giocatore fallito');

  for (const [chi, parte] of [[da, scambio.offre], [a, scambio.chiede]]) {
    if (parte.denaro > chi.denaro) {
      return errore('FONDI_INSUFFICIENTI', `${chi.nome} non ha ${euro(parte.denaro)} (ne ha ${euro(chi.denaro)})`,
        { giocatoreId: chi.id, richiesto: parte.denaro, denaro: chi.denaro });
    }
    if (parte.cartePrigione > chi.cartePrigione) {
      return errore('NESSUNA_CARTA_PRIGIONE',
        `${chi.nome} ha ${chi.cartePrigione} carte "Uscite gratis di prigione", non ${parte.cartePrigione}`,
        { giocatoreId: chi.id });
    }
    for (const i of parte.proprieta) {
      if (!N.TAB.acquistabile(i)) {
        return errore('CASELLA_NON_VALIDA', `${casella(i).nome} non è una proprietà scambiabile`, { casella: i });
      }
      if (voceDi(stato, i).proprietario !== chi.id) {
        return errore('PROPRIETA_NON_TUA', `${casella(i).nome} non appartiene a ${chi.nome}`, { casella: i });
      }
      if (N.gruppoHaCostruzioni(stato, i)) {
        return errore('HA_COSTRUZIONI',
          `Per scambiare ${casella(i).nome} vanno prima vendute tutte le case e gli alberghi del suo gruppo`, { casella: i });
      }
    }
  }
  return null;
}

/**
 * Valida una proposta di scambio e costruisce l'oggetto `scambio`.
 *
 * @param {object} stato      StatoPartita
 * @param {string} daId       proponente
 * @param {object} proposta   { aId, offre, chiede }
 * @param {object} [contesto] { ora } oppure un ctx del motore (con `t`)
 * @returns {{ok: true, scambio: object} | {errore: object}}
 */
function validaProposta(stato, daId, proposta, contesto = {}) {
  if (!stato || !proposta || typeof proposta !== 'object') return errore('PARAMETRI_NON_VALIDI');
  if (stato.scambio) return errore('SCAMBIO_IN_CORSO', 'C\'è già uno scambio in attesa di risposta: aspetta che si concluda');
  if (typeof proposta.aId !== 'string') {
    return errore('PARAMETRI_NON_VALIDI', 'Indica a quale giocatore proponi lo scambio (aId)');
  }

  const da = trova(stato, daId);
  const a = trova(stato, proposta.aId);
  if (!da) return errore('GIOCATORE_NON_VALIDO');
  if (!a) return errore('GIOCATORE_NON_VALIDO', 'Il giocatore a cui proponi lo scambio non esiste');
  if (da.id === a.id) return errore('GIOCATORE_NON_VALIDO', 'Non puoi proporre uno scambio a te stesso');
  if (da.fallito) return errore('GIOCATORE_FALLITO', 'Sei fallito: non puoi più scambiare');
  if (a.fallito) return errore('GIOCATORE_NON_VALIDO', `${a.nome} non è più in gioco (bancarotta): non si può scambiare`);

  const offre = leggiParte(proposta.offre, 'offre');
  if (offre.errore) return offre;
  const chiede = leggiParte(proposta.chiede, 'chiede');
  if (chiede.errore) return chiede;
  if (parteVuota(offre.parte) && parteVuota(chiede.parte)) {
    return errore('SCAMBIO_VUOTO', 'Lo scambio è vuoto: offri o chiedi almeno qualcosa');
  }

  const contatore = (stato.contatoreScambi || 0) + 1;
  let ora;
  if (Number.isFinite(contesto.t)) ora = contesto.t;
  else ora = typeof contesto.ora === 'function' ? contesto.ora() : Date.now();

  const scambio = {
    id: `s${contatore}`,
    daId: da.id,
    aId: a.id,
    offre: offre.parte,
    chiede: chiede.parte,
    propostoIl: ora,
  };
  const possessi = verificaPossessi(stato, scambio);
  if (possessi) return possessi;
  return { ok: true, scambio };
}

/** Breve descrizione di una metà di scambio per la cronaca. */
function descriviParte(p) {
  const pezzi = [];
  if (p.denaro) pezzi.push(euro(p.denaro));
  for (const i of p.proprieta) pezzi.push(casella(i).nome);
  if (p.cartePrigione) pezzi.push(`${p.cartePrigione} carta/e prigione`);
  return pezzi.length ? pezzi.join(', ') : 'niente';
}

/**
 * Esegue (mutando `stato`) uno scambio già validato: denaro, proprietà, carte;
 * poi addebita l'interesse del 10% sulle ipotecate ricevute.
 */
function eseguiScambio(stato, scambio, ctx) {
  const da = trova(stato, scambio.daId);
  const a = trova(stato, scambio.aId);
  const { offre, chiede } = scambio;

  da.denaro -= offre.denaro;
  a.denaro += offre.denaro;
  a.denaro -= chiede.denaro;
  da.denaro += chiede.denaro;
  for (const i of offre.proprieta) voceDi(stato, i).proprietario = a.id;
  for (const i of chiede.proprieta) voceDi(stato, i).proprietario = da.id;
  N.trasferisciCartePrigione(stato, da.id, a.id, offre.cartePrigione);
  N.trasferisciCartePrigione(stato, a.id, da.id, chiede.cartePrigione);

  if (stato.scambio && stato.scambio.id === scambio.id) stato.scambio = null;
  N.emetti(ctx, 'scambioAccettato', a.id,
    `${a.nome} accetta lo scambio con ${da.nome}: ${da.nome} dà ${descriviParte(offre)}, riceve ${descriviParte(chiede)}`,
    { scambio: structuredClone(scambio) });

  const interessi = (indici) => indici
    .filter((i) => voceDi(stato, i).ipotecata)
    .reduce((s, i) => s + N.interesseIpoteca(i), 0);
  N.addebita(stato, ctx, a.id, null, interessi(offre.proprieta), { motivo: 'interesseScambio' });
  N.addebita(stato, ctx, da.id, null, interessi(chiede.proprieta), { motivo: 'interesseScambio' });
}

/**
 * Applica uno scambio già accettato su una copia dello stato.
 *
 * @param {object} stato     StatoPartita (non mutato)
 * @param {object} scambio   come in stato.scambio
 * @param {object} [contesto] { ora }
 * @returns {{stato: object, eventi: object[]} | {errore: object}}
 */
function applicaScambio(stato, scambio, contesto = {}) {
  if (!stato || !scambio) return errore('SCAMBIO_NON_TROVATO');
  const nuovo = N.normalizzaStato(structuredClone(stato));
  const sc = {
    ...scambio,
    offre: normalizzaParte(scambio.offre),
    chiede: normalizzaParte(scambio.chiede),
  };
  const possessi = verificaPossessi(nuovo, sc);
  if (possessi) return possessi;
  const ctx = N.creaContesto(contesto);
  eseguiScambio(nuovo, sc, ctx);
  N.saldaDebiti(nuovo, ctx);
  N.appendiLog(nuovo, ctx.eventi);
  return { stato: nuovo, eventi: ctx.eventi };
}

module.exports = {
  normalizzaParte,
  leggiParte,
  verificaPossessi,
  validaProposta,
  eseguiScambio,
  applicaScambio,
};
