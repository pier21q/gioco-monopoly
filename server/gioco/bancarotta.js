'use strict';

/**
 * server/gioco/bancarotta.js
 *
 * Liquidazione di un giocatore in bancarotta (INTERFACCE.md §1.8, §2.7, §8.10):
 *   1. case e alberghi tornano alla banca, che li paga a metà prezzo;
 *   2. verso un GIOCATORE: denaro, proprietà (le ipotecate restano ipotecate,
 *      e il creditore paga subito il 10% di interesse alla banca) e carte
 *      prigione passano al creditore;
 *   3. verso la BANCA: il denaro sparisce, le carte prigione tornano nei
 *      mazzi, le proprietà tornano libere (senza ipoteca) e vanno all'asta
 *      una dopo l'altra tra i giocatori rimasti;
 *   4. il giocatore diventa `fallito`; se era di turno il turno passa;
 *      se resta un solo giocatore la partita finisce.
 *
 * `patrimonioLiquidabile` non muta lo stato; `liquidaInterno` lo muta ed è
 * usata dal motore (dichiaraBancarotta, abbandona) su uno stato già clonato.
 */

const N = require('./nucleo');

const { errore, euro, casella, trova, voceDi } = N;

/**
 * Denaro che il giocatore potrebbe raccogliere vendendo tutte le costruzioni
 * (a metà prezzo) e ipotecando tutte le proprietà non ipotecate, più la
 * liquidità. Serve a capire se un debito è saldabile senza bancarotta.
 *
 * @param {object} stato
 * @param {string} giocatoreId
 * @returns {number} intero >= 0
 */
function patrimonioLiquidabile(stato, giocatoreId) {
  const g = trova(stato, giocatoreId);
  if (!g || g.fallito) return 0;
  let totale = g.denaro;
  for (const i of N.proprietaDi(stato, giocatoreId)) {
    const voce = voceDi(stato, i);
    totale += N.valoreVenditaCostruzioni(i, voce.caseCostruite);
    if (!voce.ipotecata) totale += casella(i).ipoteca;
  }
  return totale;
}

/**
 * Liquida `giocatoreId` mutando `stato` (già clonato). Se il giocatore è il
 * debitore corrente il debito viene chiuso; i suoi debiti in coda spariscono.
 * @param {object} stato
 * @param {string} giocatoreId
 * @param {string|null} creditoreId  giocatore creditore, o null per la banca
 * @param {object} ctx  contesto del motore (nucleo.creaContesto)
 */
function liquidaInterno(stato, giocatoreId, creditoreId, ctx) {
  const g = trova(stato, giocatoreId);
  const eraDiTurno = stato.turno && stato.turno.giocatoreId === giocatoreId;

  // Il debito corrente del fallito si chiude: si torna alla fase precedente.
  if (stato.debito && stato.debito.giocatoreId === giocatoreId) {
    const f = stato.debito.faseDopo;
    stato.debito = null;
    stato.fase = f || 'mossa';
  }
  stato.debitiInAttesa = stato.debitiInAttesa.filter((d) => d.giocatoreId !== giocatoreId);

  // 1. Costruzioni vendute alla banca a metà prezzo.
  for (const i of N.proprietaDi(stato, giocatoreId)) {
    const voce = voceDi(stato, i);
    if (voce.caseCostruite === 0) continue;
    const ricavo = N.valoreVenditaCostruzioni(i, voce.caseCostruite);
    if (voce.caseCostruite === 5) stato.alberghiDisponibili += 1;
    else stato.caseDisponibili += voce.caseCostruite;
    voce.caseCostruite = 0;
    g.denaro += ricavo;
    N.emetti(ctx, 'vendita', g.id, `Le costruzioni di ${g.nome} su ${casella(i).nome} tornano alla banca per ${euro(ricavo)}`,
      { casella: i, caseCostruite: 0, ricavo });
  }

  // 2-3. Trasferimento dei beni.
  const cred = creditoreId ? trova(stato, creditoreId) : null;
  const versoGiocatore = Boolean(cred && !cred.fallito && cred.id !== giocatoreId);
  const proprieta = N.proprietaDi(stato, giocatoreId);
  const denaro = g.denaro;
  let interessi = 0;

  if (versoGiocatore) {
    cred.denaro += denaro;
    for (const i of proprieta) {
      const voce = voceDi(stato, i);
      voce.proprietario = cred.id;
      if (voce.ipotecata) interessi += N.interesseIpoteca(i);
    }
    N.trasferisciCartePrigione(stato, g.id, cred.id, g.cartePrigione);
  } else {
    for (const i of proprieta) {
      stato.proprieta[String(i)] = { proprietario: null, caseCostruite: 0, ipotecata: false };
      stato.asteInAttesa.push(i);
    }
    while (g.cartePrigione > 0) N.restituisciCartaPrigione(stato, g.id);
  }

  g.denaro = 0;
  g.fallito = true;
  g.inPrigione = false;
  g.turniInPrigione = 0;
  g.cartePrigione = 0;
  const destinatario = versoGiocatore ? cred.nome : 'la banca';
  N.emetti(ctx, 'bancarotta', g.id,
    `${g.nome} fa bancarotta: ${euro(denaro)} e ${proprieta.length} proprietà vanno a ${destinatario}`
      + (versoGiocatore || proprieta.length === 0 ? '' : ', che le mette all\'asta'),
    { creditoreId: versoGiocatore ? cred.id : null, proprieta, denaro });

  // Uno scambio pendente che coinvolge il fallito viene annullato.
  if (stato.scambio && (stato.scambio.daId === giocatoreId || stato.scambio.aId === giocatoreId)) {
    N.emetti(ctx, 'scambioRifiutato', g.id, `Lo scambio proposto è annullato per la bancarotta di ${g.nome}`,
      { scambio: stato.scambio, daId: g.id });
    stato.scambio = null;
  }

  // 4. Fine partita, interessi del creditore, turno, aste in coda.
  if (N.verificaFinePartita(stato, ctx)) return;
  if (versoGiocatore) N.addebita(stato, ctx, cred.id, null, interessi, { motivo: 'interesseBancarotta' });
  if (eraDiTurno) N.passaTurno(stato, ctx);
  N.continuaCatena(stato, ctx);
}

module.exports = {
  patrimonioLiquidabile,
  liquidaInterno,
};
