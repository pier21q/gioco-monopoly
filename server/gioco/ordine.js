'use strict';

/**
 * server/gioco/ordine.js
 *
 * Lancio iniziale per decidere chi comincia (fase 'ordine').
 *
 * Tutti lanciano i due dadi, uno alla volta: chi fa di più gioca per primo,
 * poi gli altri in ordine di punteggio. Chi pareggia rilancia, ma solo
 * contro chi ha fatto il suo stesso punteggio, e lo spareggio decide le loro
 * posizioni (non quelle degli altri). Si va avanti finché ogni posizione è
 * decisa, dalla prima all'ultima.
 *
 * Stato (`stato.ordine`, null fuori da questa fase):
 *   giro    1 al primo lancio, poi 2, 3... a ogni spareggio
 *   gruppi  posizioni ancora da decidere, dalla più alta: [[A], [B, C], [D]]
 *           vuol dire A primo, B e C da spareggiare per il 2° e 3° posto, D ultimo
 *   lanci   { giocatoreId: [d1, d2] } del giro in corso
 *   storico [{ giro, lanci }] dei giri già chiusi, per mostrarli ai giocatori
 *
 * Il giocatore che deve lanciare è `stato.turno.giocatoreId` (turno.numero 0),
 * così il resto del server (inattività, disconnessioni, "tocca a te") funziona
 * come per un turno normale. Tutte le funzioni MUTANO lo stato ricevuto.
 */

const N = require('./nucleo');

const { emetti, nomeDi, trova } = N;

/** "Anna", "Anna e Bruno", "Anna, Bruno e Carla". */
function elencoNomi(stato, ids) {
  const nomi = ids.map((id) => nomeDi(stato, id));
  if (nomi.length <= 1) return nomi.join('');
  return `${nomi.slice(0, -1).join(', ')} e ${nomi[nomi.length - 1]}`;
}

/** Chi deve ancora lanciare in questo giro, nell'ordine in cui tocca. */
function daLanciare(stato) {
  const o = stato.ordine;
  if (!o) return [];
  return o.gruppi.filter((gr) => gr.length > 1).flat().filter((id) => !o.lanci[id]);
}

/** Prepara la fase 'ordine' su uno stato appena creato: lanciano tutti, nell'ordine della sala d'attesa. */
function avvia(stato) {
  const ids = stato.giocatori.filter((g) => !g.fallito).map((g) => g.id);
  stato.fase = 'ordine';
  stato.ordine = { giro: 1, gruppi: [ids], lanci: {}, storico: [] };
  stato.turno = { giocatoreId: ids[0], numero: 0, doppiConsecutivi: 0, soste: [] };
}

/** Il giocatore di turno lancia i due dadi (anche d'ufficio, con `automatico`). */
function lancia(stato, g, ctx, automatico = null) {
  const o = stato.ordine;
  const d1 = N.tiraDado(ctx);
  const d2 = N.tiraDado(ctx);
  o.lanci[g.id] = [d1, d2];
  stato.dadi = [d1, d2];
  const spareggio = o.giro > 1;
  const prima = automatico === 'disconnesso' ? `${g.nome} è disconnesso: il gioco lancia al posto suo. `
    : automatico === 'inattivo' ? `${g.nome} non lancia in tempo: il gioco lancia al posto suo. ` : '';
  emetti(ctx, 'lancioOrdine', g.id,
    `${prima}${g.nome} lancia ${d1} e ${d2}: ${d1 + d2}${spareggio ? ' (spareggio)' : ''}`,
    { dadi: [d1, d2], totale: d1 + d2, giro: o.giro, spareggio, automatico: automatico || null });
  prosegui(stato, ctx);
}

/** Toglie dall'ordine chi esce durante il lancio iniziale (abbandono o allontanamento). */
function rimuovi(stato, giocatoreId, ctx) {
  const o = stato.ordine;
  if (!o) return;
  o.gruppi = o.gruppi.map((gr) => gr.filter((id) => id !== giocatoreId)).filter((gr) => gr.length > 0);
  delete o.lanci[giocatoreId];
  prosegui(stato, ctx);
}

/** Passa al prossimo che deve lanciare; se il giro è finito lo chiude. */
function prosegui(stato, ctx) {
  const prossimi = daLanciare(stato);
  if (prossimi.length > 0) {
    stato.turno = { ...stato.turno, giocatoreId: prossimi[0] };
    return;
  }
  chiudiGiro(stato, ctx);
}

/** Tutti hanno lanciato: ordina ogni gruppo per punteggio e apre gli spareggi. */
function chiudiGiro(stato, ctx) {
  const o = stato.ordine;
  const totale = (id) => {
    const d = o.lanci[id];
    return d ? d[0] + d[1] : 0;
  };
  const nuovi = [];
  const spareggi = [];
  for (const gr of o.gruppi) {
    if (gr.length === 1) {
      nuovi.push(gr);
      continue;
    }
    const ordinati = gr.slice().sort((a, b) => totale(b) - totale(a));
    let corrente = [];
    for (const id of ordinati) {
      if (corrente.length && totale(corrente[0]) !== totale(id)) {
        nuovi.push(corrente);
        corrente = [];
      }
      corrente.push(id);
    }
    nuovi.push(corrente);
  }
  // Posizione (1 = primo) di ogni gruppo ancora in pareggio, per il messaggio.
  let posizione = 1;
  for (const gr of nuovi) {
    if (gr.length > 1) spareggi.push({ giocatori: gr, totale: totale(gr[0]), da: posizione, a: posizione + gr.length - 1 });
    posizione += gr.length;
  }
  o.storico.push({ giro: o.giro, lanci: o.lanci });
  o.gruppi = nuovi;
  o.lanci = {};

  if (spareggi.length === 0) {
    concludi(stato, ctx);
    return;
  }
  o.giro += 1;
  for (const s of spareggi) {
    const posti = s.da === 1 ? 'chi comincia' : `il ${s.da}° posto`;
    emetti(ctx, 'spareggio', null,
      `${elencoNomi(stato, s.giocatori)} fanno tutti ${s.totale}: rilanciano per decidere ${posti}`,
      { giocatori: s.giocatori, totale: s.totale, da: s.da, a: s.a, giro: o.giro });
  }
  stato.turno = { ...stato.turno, giocatoreId: daLanciare(stato)[0] };
}

/** Ordine deciso: i giocatori si mettono in fila e comincia il turno 1. */
function concludi(stato, ctx) {
  const ordine = stato.ordine.gruppi.flat();
  const fuori = stato.giocatori.filter((g) => !ordine.includes(g.id));
  stato.giocatori = [...ordine.map((id) => trova(stato, id)), ...fuori];
  stato.ordine = null;
  stato.fase = 'daLanciare';
  stato.dadi = null;
  const primo = ordine[0];
  stato.turno = { giocatoreId: primo, numero: 1, doppiConsecutivi: 0, soste: [] };
  const fila = ordine.map((id, i) => `${i + 1}. ${nomeDi(stato, id)}`).join(', ');
  emetti(ctx, 'ordineDeciso', primo, `Comincia ${nomeDi(stato, primo)}. Si gioca in quest'ordine: ${fila}`, { ordine });
  emetti(ctx, 'turno', primo, `Turno 1: tocca ${N.aChi(nomeDi(stato, primo))}`, { giocatoreId: primo, numero: 1 });
}

module.exports = { avvia, lancia, rimuovi, daLanciare };
