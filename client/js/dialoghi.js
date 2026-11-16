/**
 * client/js/dialoghi.js
 *
 * Finestre di dialogo modali montate in #dialoghi e notifiche brevi in #toast.
 *
 *   apri(tipo, dati, dispatch) → { chiudi, aggiorna }
 *   chiudiTutti()
 *   aggiorna(statoClient)      chiamata da pannelli.render a ogni nuovo stato:
 *                              i dialoghi aperti si ridisegnano dal vivo e si
 *                              chiudono da soli quando non hanno più senso
 *                              (asta finita, debito saldato, scambio risolto).
 *   toast(testo, { livello, durata })
 *
 * Tipi (INTERFACCE.md §4.6): dettaglioCasella, acquisto, asta, scambio,
 * costruzioni, ipoteca, gestione, prigione, debito, bancarotta, carta,
 * finePartita, conferma.
 *
 * Ogni dialogo è un <dialog> nativo aperto con showModal(): il resto della
 * pagina diventa inerte, Esc chiude, il focus resta intrappolato (con un
 * ulteriore giro Tab/Maiusc+Tab gestito qui) e torna all'elemento che aveva il
 * focus all'apertura. Le interazioni chiamano `dispatch` con le azioni di
 * gioco del §2.4: il server resta l'unica autorità, le verifiche lato client
 * servono solo a spiegare in anticipo perché un'azione non è possibile.
 *
 * Il modulo esporta anche le utilità condivise con pannelli.js (formattazione
 * del denaro, costruzione del DOM, regole di gioco lato client).
 */

import { CASELLE, GRUPPI } from '/dati/tabellone.js';
import { REGOLE, PREDEFINITE } from '/dati/regole.js';

const CAUZIONE = 50;

// ===========================================================================
// Utilità generiche
// ===========================================================================

/** 1500 → "1.500 €" (punto delle migliaia anche sotto i 10.000). */
export function euro(n) {
  const v = Math.round(Number(n) || 0);
  const cifre = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0 ? '−' : ''}${cifre} €`;
}

/**
 * Piccolo costruttore di DOM. Niente innerHTML: nomi dei giocatori e testi
 * arrivano dalla rete e finiscono sempre in textContent.
 */
export function el(tag, attributi, ...figli) {
  const nodo = document.createElement(tag);
  for (const [chiave, valore] of Object.entries(attributi || {})) {
    if (valore == null || valore === false) continue;
    if (chiave === 'class') nodo.className = valore;
    else if (chiave === 'text') nodo.textContent = valore;
    else if (chiave === 'style' && typeof valore === 'object') {
      for (const [prop, v] of Object.entries(valore)) {
        if (v != null) nodo.style.setProperty(prop, String(v));
      }
    } else if (chiave === 'dataset') Object.assign(nodo.dataset, valore);
    else if (chiave.startsWith('on') && typeof valore === 'function') {
      nodo.addEventListener(chiave.slice(2), valore);
    } else if (valore === true) nodo.setAttribute(chiave, '');
    else nodo.setAttribute(chiave, String(valore));
  }
  aggiungiFigli(nodo, figli);
  return nodo;
}

function aggiungiFigli(nodo, figli) {
  for (const f of figli.flat(Infinity)) {
    if (f == null || f === false) continue;
    nodo.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
}

function comeArray(x) {
  if (x == null) return [];
  return (Array.isArray(x) ? x : [x]).flat(Infinity).filter((n) => n != null && n !== false);
}

let contatoreId = 0;
export function nuovoId(prefisso = 'pn') {
  contatoreId += 1;
  return `${prefisso}-${contatoreId}`;
}

/** Colore del testo (inchiostro o bianco) con il contrasto migliore su `hex`. */
export function testoSu(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const canali = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * canali[0] + 0.7152 * canali[1] + 0.0722 * canali[2];
  const suBianco = 1.05 / (lum + 0.05);
  const suInchiostro = (lum + 0.05) / (0.028 + 0.05);
  return suInchiostro >= suBianco ? '#14323a' : '#ffffff';
}

const COLORI_TIPO = {
  via: '#c8952c',
  prigione: '#4a6168',
  parcheggio: '#4a6168',
  vaiInPrigione: '#a4262c',
  probabilita: '#2a6f97',
  imprevisti: '#b45309',
  tassa: '#4a6168',
};

export function coloreCasella(c) {
  if (!c) return '#4a6168';
  if (c.gruppo && GRUPPI[c.gruppo]) return GRUPPI[c.gruppo].colore;
  return COLORI_TIPO[c.tipo] || '#4a6168';
}

// ===========================================================================
// Lettura dello stato
// ===========================================================================

/** Accetta sia lo StatoClient dello store sia direttamente uno StatoPartita. */
export function partitaDi(sc) {
  if (!sc) return null;
  if ('partita' in sc) return sc.partita || null;
  return Array.isArray(sc.giocatori) ? sc : null;
}

export function mioIdDi(sc) {
  return (sc && sc.io && sc.io.giocatoreId) || null;
}

export function giocatoreDa(p, id) {
  return (p && Array.isArray(p.giocatori) && p.giocatori.find((g) => g.id === id)) || null;
}

/** "a" davanti a un nome: "ad Anna", "alla banca", "a Bruno". */
export function aChi(nome) {
  const n = String(nome ?? '');
  if (n === 'la banca') return 'alla banca';
  return /^[aAàÀ]/.test(n) ? `ad ${n}` : `a ${n}`;
}

export function nomeDi(p, id, { banca = 'la banca' } = {}) {
  if (id == null) return banca;
  const g = giocatoreDa(p, id);
  return g ? g.nome : 'un giocatore';
}

const PROP_VUOTA = Object.freeze({ proprietario: null, caseCostruite: 0, ipotecata: false });

export function statoProp(p, indice) {
  return (p && p.proprieta && p.proprieta[String(indice)]) || PROP_VUOTA;
}

export function acquistabile(c) {
  return !!c && (c.tipo === 'proprieta' || c.tipo === 'stazione' || c.tipo === 'societa');
}

export function indiciGruppo(gruppo) {
  return CASELLE.filter((c) => c.gruppo === gruppo).map((c) => c.indice);
}

export function proprietaDi(p, id) {
  if (!id) return [];
  return CASELLE.filter((c) => acquistabile(c) && statoProp(p, c.indice).proprietario === id);
}

export function possiedeGruppo(p, gruppo, id) {
  const indici = indiciGruppo(gruppo);
  return indici.length > 0 && indici.every((i) => statoProp(p, i).proprietario === id);
}

export function nomeGruppo(gruppo) {
  return (GRUPPI[gruppo] && GRUPPI[gruppo].nome) || '';
}

export function interesseIpoteca(c) {
  return Math.ceil((c.ipoteca || 0) * 0.1);
}

export function costoRiscatto(c) {
  return (c.ipoteca || 0) + interesseIpoteca(c);
}

export function descriviCostruzioni(n) {
  if (n >= 5) return 'albergo';
  if (n === 1) return '1 casa';
  if (n > 1) return `${n} case`;
  return 'nessuna casa';
}

/** Affitto attualmente dovuto su una casella: { importo, testo }. */
export function affittoAttuale(p, indice) {
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  if (!acquistabile(c) || !s.proprietario) return { importo: null, testo: '' };
  if (s.ipotecata) return { importo: 0, testo: 'nessun affitto (ipotecata)' };
  if (c.tipo === 'proprieta') {
    let importo = c.affitti[s.caseCostruite] || 0;
    if (s.caseCostruite === 0 && possiedeGruppo(p, c.gruppo, s.proprietario)) importo *= 2;
    return { importo, testo: euro(importo) };
  }
  const n = indiciGruppo(c.gruppo).filter((i) => statoProp(p, i).proprietario === s.proprietario).length;
  if (c.tipo === 'stazione') {
    const importo = c.affitti[Math.max(0, n - 1)] || 0;
    return { importo, testo: euro(importo) };
  }
  const molt = c.affitti[Math.max(0, n - 1)] || 0;
  return { importo: null, testo: `${molt} volte i dadi` };
}

/** Valore complessivo dei beni (per la classifica finale). */
export function patrimonio(p, id) {
  const g = giocatoreDa(p, id);
  if (!g) return 0;
  let tot = g.denaro || 0;
  for (const c of proprietaDi(p, id)) {
    const s = statoProp(p, c.indice);
    tot += s.ipotecata ? c.prezzo - c.ipoteca : c.prezzo;
    if (c.costoCasa) tot += s.caseCostruite * c.costoCasa;
  }
  return tot;
}

/** Denaro + metà delle costruzioni + ipoteche ancora ottenibili. */
export function liquidabile(p, id) {
  const g = giocatoreDa(p, id);
  if (!g) return 0;
  let tot = g.denaro || 0;
  for (const c of proprietaDi(p, id)) {
    const s = statoProp(p, c.indice);
    if (c.costoCasa) tot += s.caseCostruite * (c.costoCasa / 2);
    if (!s.ipotecata) tot += c.ipoteca || 0;
  }
  return tot;
}

// ===========================================================================
// Azioni ammesse: le calcola il server (motore.azioniDisponibili) e le manda
// nello stato pubblico in `azioni`, così le regole non sono ricopiate qui.
// ===========================================================================

/** I tipi di azione che `id` può eseguire adesso, secondo il server. */
export function azioniAmmesse(p, id) {
  const g = giocatoreDa(p, id);
  if (!p || !g || g.fallito || !p.azioni || !Array.isArray(p.azioni[id])) return new Set();
  return new Set(p.azioni[id]);
}

/**
 * Perché `tipo` non è ammesso adesso (frase italiana) oppure null se la fase
 * lo consente. Non valuta i parametri: per quelli ci sono motivoCostruisci &c.
 */
export function motivoAzione(p, id, tipo) {
  if (!p || p.fase === 'lobby') return 'La partita non è ancora iniziata';
  if (p.fase === 'finePartita') return 'La partita è finita';
  const io = giocatoreDa(p, id);
  if (!io) return 'Non partecipi a questa partita';
  if (io.fallito) return 'Sei fuori dalla partita';
  if (azioniAmmesse(p, id).has(tipo)) return null;

  const f = p.fase;
  const mio = p.turno && p.turno.giocatoreId === id;
  const altro = `È il turno di ${nomeDi(p, p.turno && p.turno.giocatoreId)}`;

  if (f === 'ordine' && tipo !== 'lanciaDadi' && tipo !== 'abbandona') {
    return 'Prima si lanciano i dadi per decidere chi comincia';
  }
  if (f === 'asta' && !['offertaAsta', 'passaAsta', 'vendiCasa', 'ipoteca'].includes(tipo)) {
    return 'Aspetta la fine dell’asta in corso';
  }
  if (f === 'debito' && ['lanciaDadi', 'finisciTurno', 'compra', 'rifiutaAcquisto', 'costruisci', 'disipoteca', 'pagaCauzione', 'usaCartaPrigione'].includes(tipo)) {
    return p.debito && p.debito.giocatoreId === id
      ? 'Prima salda il debito'
      : `${nomeDi(p, p.debito && p.debito.giocatoreId)} deve prima saldare un debito`;
  }

  switch (tipo) {
    case 'lanciaDadi':
      if (!mio) return altro;
      if (f === 'mossa') return 'Hai già lanciato: ora puoi finire il turno';
      if (f === 'daDecidereAcquisto') return 'Prima decidi se comprare o mettere all’asta';
      break;
    case 'compra':
    case 'rifiutaAcquisto':
      if (!mio) return altro;
      if (f === 'daLanciare') return 'Prima lancia i dadi';
      return 'Non sei fermo su una proprietà in vendita';
    case 'finisciTurno':
      if (!mio) return altro;
      if (f === 'daLanciare') {
        if (io.inPrigione) return 'Scegli prima come tentare di uscire di prigione';
        return p.turno.doppiConsecutivi > 0 ? 'Hai fatto un doppio: lancia di nuovo' : 'Prima lancia i dadi';
      }
      if (f === 'daDecidereAcquisto') return 'Prima decidi se comprare o mettere all’asta';
      break;
    case 'pagaCauzione':
    case 'usaCartaPrigione':
      if (!io.inPrigione) return 'Non sei in prigione';
      if (!mio) return altro;
      if (f !== 'daLanciare') return 'Si può fare solo prima di lanciare i dadi';
      if (tipo === 'usaCartaPrigione') return 'Non hai la carta «Uscite gratis di prigione»';
      break;
    case 'costruisci':
    case 'disipoteca':
      if (!mio) return 'Puoi farlo solo durante il tuo turno';
      break;
    case 'vendiCasa':
    case 'ipoteca':
      if (f === 'asta') return 'Durante l’asta può farlo solo chi partecipa';
      if (f === 'debito') return 'Durante un debito può farlo solo chi deve pagare';
      if (!mio) return 'Puoi farlo solo durante il tuo turno';
      break;
    case 'proponiScambio':
      if (p.scambio) return 'C’è già una proposta di scambio in attesa';
      break;
    case 'accettaScambio':
      return p.scambio ? 'Solo il destinatario può accettare' : 'Nessuno scambio in attesa';
    case 'rifiutaScambio':
      return p.scambio ? 'Lo scambio non ti riguarda' : 'Nessuno scambio in attesa';
    case 'offertaAsta':
    case 'passaAsta':
      if (f !== 'asta' || !p.asta) return 'Nessuna asta in corso';
      if ((p.asta.passati || []).includes(id)) return 'Hai già passato';
      if (tipo === 'passaAsta' && p.asta.migliorOfferenteId === id) return 'Hai l’offerta più alta: non puoi passare';
      return 'Non partecipi a questa asta';
    case 'dichiaraBancarotta':
      return 'Si può solo quando hai un debito che non riesci a pagare';
    default:
      break;
  }
  return 'Azione non disponibile in questo momento';
}

function denaroDi(p, id) {
  const g = giocatoreDa(p, id);
  return g ? g.denaro || 0 : 0;
}

export function motivoCostruisci(p, id, indice) {
  const fase = motivoAzione(p, id, 'costruisci');
  if (fase) return fase;
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  if (!c || c.tipo !== 'proprieta') return 'Su questa casella non si costruisce';
  if (s.proprietario !== id) return 'Non è tua';
  if (!possiedeGruppo(p, c.gruppo, id)) return `Ti serve tutto il gruppo ${nomeGruppo(c.gruppo).toLowerCase()}`;
  if (p.regole && p.regole.costruzione === 'sosta') {
    // Regola scelta dall'host: si costruisce solo sul colore su cui ci si è fermati in questo turno.
    // Stessa regola di fermoSulGruppo in server/gioco/motore.js.
    const io = giocatoreDa(p, id);
    const qui = io ? CASELLE[io.posizione] : null;
    const sosteDelTurno = (p.turno && Array.isArray(p.turno.soste)) ? p.turno.soste : [];
    const fermo = sosteDelTurno.includes(c.gruppo) || (Boolean(qui) && qui.tipo === 'proprieta' && qui.gruppo === c.gruppo
      && (p.fase !== 'daLanciare' || (p.turno && p.turno.doppiConsecutivi > 0)));
    if (!fermo) return `Costruisci qui solo nel turno in cui ti fermi sul gruppo ${nomeGruppo(c.gruppo).toLowerCase()}`;
  }
  const gruppo = indiciGruppo(c.gruppo).map((i) => statoProp(p, i));
  if (gruppo.some((x) => x.ipotecata)) return 'Nel gruppo c’è una proprietà ipotecata';
  if (s.caseCostruite >= 5) return 'C’è già un albergo';
  const minimo = Math.min(...gruppo.map((x) => x.caseCostruite));
  if (s.caseCostruite > minimo) return 'Costruisci prima sulle altre proprietà del gruppo';
  if (s.caseCostruite === 4) {
    if ((p.alberghiDisponibili ?? 12) <= 0) return 'La banca ha finito gli alberghi';
  } else if ((p.caseDisponibili ?? 32) <= 0) return 'La banca ha finito le case';
  if (denaroDi(p, id) < c.costoCasa) return `Ti servono ${euro(c.costoCasa)}`;
  return null;
}

export function motivoVendi(p, id, indice) {
  const fase = motivoAzione(p, id, 'vendiCasa');
  if (fase) return fase;
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  if (!c || c.tipo !== 'proprieta') return 'Qui non ci sono costruzioni';
  if (s.proprietario !== id) return 'Non è tua';
  if (s.caseCostruite <= 0) return 'Non ci sono case da vendere';
  const massimo = Math.max(...indiciGruppo(c.gruppo).map((i) => statoProp(p, i).caseCostruite));
  if (s.caseCostruite < massimo) return 'Vendi prima dalle proprietà del gruppo con più case';
  // Albergo senza 4 case in banca: il server lo vende per intero (ammesso).
  return null;
}

export function motivoIpoteca(p, id, indice) {
  const fase = motivoAzione(p, id, 'ipoteca');
  if (fase) return fase;
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  if (!acquistabile(c)) return 'Questa casella non si ipoteca';
  if (s.proprietario !== id) return 'Non è tua';
  if (s.ipotecata) return 'È già ipotecata';
  if (c.tipo === 'proprieta' && indiciGruppo(c.gruppo).some((i) => statoProp(p, i).caseCostruite > 0)) {
    return 'Vendi prima tutte le case del gruppo';
  }
  return null;
}

export function motivoDisipoteca(p, id, indice) {
  const fase = motivoAzione(p, id, 'disipoteca');
  if (fase) return fase;
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  if (!acquistabile(c)) return 'Questa casella non si ipoteca';
  if (s.proprietario !== id) return 'Non è tua';
  if (!s.ipotecata) return 'Non è ipotecata';
  if (denaroDi(p, id) < costoRiscatto(c)) return `Ti servono ${euro(costoRiscatto(c))}`;
  return null;
}

/**
 * Piano suggerito per coprire `mancante`: prima le ipoteche (costano solo il
 * 10% al riscatto), partendo dalle proprietà che non completano un gruppo,
 * poi la vendita delle case (si recupera solo metà del costo). Simula lo
 * stato passo per passo così l'uniformità delle vendite è rispettata.
 */
export function pianoLiquidazione(p, id, mancante) {
  const sim = {};
  for (const c of proprietaDi(p, id)) sim[c.indice] = { ...statoProp(p, c.indice) };
  const passi = [];
  let raccolto = 0;
  for (let giro = 0; giro < 200 && raccolto < mancante; giro += 1) {
    const ipotecabili = Object.keys(sim).map(Number).filter((i) => {
      const c = CASELLE[i];
      if (sim[i].ipotecata) return false;
      if (c.tipo !== 'proprieta') return true;
      return indiciGruppo(c.gruppo).every((j) => !sim[j] || sim[j].caseCostruite === 0);
    });
    if (ipotecabili.length) {
      const completa = (i) => (CASELLE[i].tipo === 'proprieta' && possiedeGruppo(p, CASELLE[i].gruppo, id) ? 1 : 0);
      const resto = mancante - raccolto;
      ipotecabili.sort((a, b) => completa(a) - completa(b)
        // a parità, la più piccola che basta; se nessuna basta, la più grande
        || ((CASELLE[a].ipoteca >= resto ? 0 : 1) - (CASELLE[b].ipoteca >= resto ? 0 : 1))
        || (CASELLE[a].ipoteca >= resto ? CASELLE[a].ipoteca - CASELLE[b].ipoteca : CASELLE[b].ipoteca - CASELLE[a].ipoteca));
      const i = ipotecabili[0];
      sim[i].ipotecata = true;
      raccolto += CASELLE[i].ipoteca;
      passi.push({ tipo: 'ipoteca', casella: i, ricavo: CASELLE[i].ipoteca });
      continue;
    }
    const vendibili = Object.keys(sim).map(Number).filter((i) => {
      const c = CASELLE[i];
      if (c.tipo !== 'proprieta' || sim[i].caseCostruite <= 0) return false;
      const massimo = Math.max(...indiciGruppo(c.gruppo).map((j) => (sim[j] ? sim[j].caseCostruite : 0)));
      return sim[i].caseCostruite === massimo;
    });
    if (!vendibili.length) break;
    vendibili.sort((a, b) => CASELLE[b].costoCasa - CASELLE[a].costoCasa);
    const i = vendibili[0];
    sim[i].caseCostruite -= 1;
    raccolto += CASELLE[i].costoCasa / 2;
    passi.push({ tipo: 'vendiCasa', casella: i, ricavo: CASELLE[i].costoCasa / 2 });
  }
  return { passi, raccolto, copre: raccolto >= mancante };
}

/** Classifica finale: chi è ancora in gioco per patrimonio, poi i falliti dall'ultimo al primo. */
export function classifica(p) {
  if (!p) return [];
  const ordineFallimenti = [];
  for (const ev of p.log || []) {
    if (ev.tipo === 'bancarotta' && ev.giocatoreId && !ordineFallimenti.includes(ev.giocatoreId)) {
      ordineFallimenti.push(ev.giocatoreId);
    }
  }
  const vivi = p.giocatori.filter((g) => !g.fallito)
    .sort((a, b) => (b.id === p.vincitoreId) - (a.id === p.vincitoreId) || patrimonio(p, b.id) - patrimonio(p, a.id));
  const falliti = p.giocatori.filter((g) => g.fallito)
    .sort((a, b) => ordineFallimenti.indexOf(b.id) - ordineFallimenti.indexOf(a.id));
  return [...vivi, ...falliti];
}

// ===========================================================================
// Pulsanti con motivo (aria-disabled + suggerimento visibile)
// ===========================================================================

/**
 * Pulsante che resta focalizzabile anche quando l'azione non è permessa:
 * aria-disabled, motivo collegato con aria-describedby e mostrato come
 * suggerimento al passaggio del mouse o al focus; il click mostra il motivo.
 * Ritorna il contenitore (span.azione) con il pulsante dentro.
 */
export function pulsante({ testo, dettaglio, motivo, onclick, classe = '', chiave, tipo = 'button', primario = false, pericolo = false, autofocus = false }) {
  const idSug = nuovoId('sug');
  const btn = el('button', {
    type: tipo,
    class: ['btn', primario && 'btn--primario', pericolo && 'btn--pericolo', classe].filter(Boolean).join(' '),
    dataset: chiave ? { chiave } : undefined,
    autofocus,
  });
  const sug = el('span', { class: 'suggerimento', role: 'tooltip', id: idSug });
  const avvolto = el('span', { class: 'azione' }, btn, sug);
  btn.addEventListener('click', (e) => {
    // Mentre dadi e pedina si muovono il pannello mostra ancora la mossa di
    // prima: il CSS blocca il mouse, qui si bloccano anche Invio e Spazio.
    if (btn.closest('.pn-attesa')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (btn.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      e.stopPropagation();
      if (sug.textContent) toast(sug.textContent, { livello: 'avviso', durata: 3500 });
      return;
    }
    if (typeof avvolto._onclick === 'function') avvolto._onclick(e);
  });
  avvolto._btn = btn;
  avvolto._sug = sug;
  aggiornaPulsante(avvolto, { testo, dettaglio, motivo, onclick });
  return avvolto;
}

export function aggiornaPulsante(avvolto, { testo, dettaglio, motivo, onclick, primario }) {
  const btn = avvolto._btn;
  const sug = avvolto._sug;
  if (testo !== undefined) {
    const contenuto = [el('span', { class: 'btn__testo', text: testo })];
    if (dettaglio) contenuto.push(el('span', { class: 'btn__dettaglio', text: dettaglio }));
    const firma = `${testo}|${dettaglio || ''}`;
    if (btn.dataset.firma !== firma) {
      btn.replaceChildren(...contenuto);
      btn.dataset.firma = firma;
    }
  }
  if (onclick !== undefined) avvolto._onclick = onclick;
  if (primario !== undefined) btn.classList.toggle('btn--primario', !!primario);
  if (motivo !== undefined) {
    if (motivo) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-describedby', sug.id);
      if (sug.textContent !== motivo) sug.textContent = motivo;
      avvolto.classList.add('azione--bloccata');
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-describedby');
      sug.textContent = '';
      avvolto.classList.remove('azione--bloccata');
    }
  }
  return avvolto;
}

// ===========================================================================
// Pezzi grafici riusati
// ===========================================================================

export function pallino(colore, etichetta) {
  return el('span', {
    class: 'pallino',
    style: { '--colore': colore },
    'aria-hidden': etichetta ? null : 'true',
    role: etichetta ? 'img' : null,
    'aria-label': etichetta || null,
  });
}

function nomeGiocatoreEl(p, id) {
  const g = giocatoreDa(p, id);
  if (!g) return el('span', { class: 'nome-giocatore', text: id == null ? 'la banca' : 'un giocatore' });
  return el('span', { class: 'nome-giocatore' }, pallino(g.colore), el('span', { text: g.nome }));
}

/** Etichetta di una casella con fascetta di colore, per elenchi e riepiloghi. */
function etichettaCasella(indice, p, { mostraStato = true } = {}) {
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  const note = [];
  if (mostraStato && s.caseCostruite) note.push(descriviCostruzioni(s.caseCostruite));
  if (mostraStato && s.ipotecata) note.push('ipotecata');
  return el('span', { class: `etichetta-casella${s.ipotecata ? ' etichetta-casella--ipotecata' : ''}` },
    el('span', { class: 'fascetta', style: { '--colore': coloreCasella(c) }, 'aria-hidden': 'true' }),
    el('span', { class: 'etichetta-casella__nome', text: c ? c.nome : `Casella ${indice}` }),
    note.length ? el('span', { class: 'etichetta-casella__nota', text: note.join(', ') }) : null);
}

const DESCRIZIONI = {
  via: () => 'Ogni volta che passi o ti fermi qui ritiri 200 € dalla banca.',
  tassa: (c) => `Chi si ferma qui paga ${euro(c.importoTassa)} alla banca.`,
  probabilita: () => 'Pesca una carta Probabilità e segui le istruzioni.',
  imprevisti: () => 'Pesca una carta Imprevisti e segui le istruzioni.',
  prigione: () => 'Se sei di passaggio non succede nulla. Chi è in prigione esce con un doppio, pagando 50 € di cauzione o usando la carta «Uscite gratis di prigione». Al terzo tentativo fallito paga 50 € ed esce.',
  parcheggio: () => 'Sosta libera: qui non succede nulla.',
  vaiInPrigione: () => 'Vai dritto in prigione, senza passare dal Via e senza ritirare 200 €.',
};

/** Il "contratto": la carta della proprietà con fascia colorata e tabella affitti. */
function contratto(p, indice, { compatto = false } = {}) {
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  const colore = coloreCasella(c);
  const sotto = c.gruppo === 'stazione' ? 'Stazione' : c.gruppo === 'societa' ? 'Società' : (nomeGruppo(c.gruppo) || '');
  const carta = el('div', {
    class: `contratto contratto--${c.tipo}${s.ipotecata ? ' contratto--ipotecato' : ''}${compatto ? ' contratto--compatto' : ''}`,
    style: { '--fascia': colore, '--fascia-testo': testoSu(colore) },
  },
  el('div', { class: 'contratto__fascia', 'aria-hidden': 'true' },
    sotto ? el('span', { class: 'contratto__gruppo', text: c.tipo === 'proprieta' ? `Gruppo ${sotto.toLowerCase()}` : sotto }) : null,
    el('span', { class: 'contratto__nome', text: c.nome })));

  if (!acquistabile(c)) {
    const d = DESCRIZIONI[c.tipo];
    carta.append(el('p', { class: 'contratto__descrizione', text: d ? d(c) : '' }));
    return carta;
  }
  if (compatto) {
    carta.append(el('p', { class: 'contratto__prezzo' }, 'Prezzo di listino ', el('strong', { text: euro(c.prezzo) })));
    return carta;
  }

  const righe = [];
  const attuale = s.proprietario && !s.ipotecata;
  if (c.tipo === 'proprieta') {
    const completo = s.proprietario && possiedeGruppo(p, c.gruppo, s.proprietario);
    righe.push(['Rendita del terreno', euro(c.affitti[0]), attuale && s.caseCostruite === 0 && !completo]);
    righe.push(['Con il gruppo completo', euro(c.affitti[0] * 2), attuale && s.caseCostruite === 0 && completo]);
    for (let n = 1; n <= 4; n += 1) righe.push([`Con ${descriviCostruzioni(n)}`, euro(c.affitti[n]), attuale && s.caseCostruite === n]);
    righe.push(['Con albergo', euro(c.affitti[5]), attuale && s.caseCostruite === 5]);
  } else if (c.tipo === 'stazione') {
    const n = s.proprietario ? indiciGruppo('stazione').filter((i) => statoProp(p, i).proprietario === s.proprietario).length : 0;
    c.affitti.forEach((v, k) => righe.push([k === 0 ? 'Con 1 stazione' : `Con ${k + 1} stazioni`, euro(v), attuale && n === k + 1]));
  } else {
    const n = s.proprietario ? indiciGruppo('societa').filter((i) => statoProp(p, i).proprietario === s.proprietario).length : 0;
    c.affitti.forEach((v, k) => righe.push([k === 0 ? 'Con 1 società' : 'Con 2 società', `${v} volte i dadi`, attuale && n === k + 1]));
  }

  const tabella = el('table', { class: 'contratto__affitti' },
    el('caption', { class: 'visivamente-nascosto', text: `Affitti di ${c.nome}` }),
    el('tbody', null, righe.map(([etichetta, valore, corrente]) => el('tr', { class: corrente ? 'corrente' : null, 'aria-current': corrente ? 'true' : null },
      el('th', { scope: 'row' }, etichetta, corrente ? el('span', { class: 'visivamente-nascosto', text: ' (affitto attuale)' }) : null),
      el('td', { text: valore })))));
  carta.append(tabella);

  const costi = [['Prezzo di listino', euro(c.prezzo)]];
  if (c.costoCasa) {
    costi.push(['Ogni casa costa', euro(c.costoCasa)]);
    costi.push(['L’albergo costa', `4 case + ${euro(c.costoCasa)}`]);
  }
  costi.push(['Valore d’ipoteca', euro(c.ipoteca)]);
  costi.push(['Per riscattarla', euro(costoRiscatto(c))]);
  carta.append(el('dl', { class: 'contratto__costi' },
    costi.map(([k, v]) => el('div', null, el('dt', { text: k }), el('dd', { text: v })))));
  if (c.tipo === 'proprieta') {
    carta.append(el('p', { class: 'contratto__nota', text: 'Con tutto il gruppo e nessuna casa l’affitto del terreno raddoppia.' }));
  }
  return carta;
}

/** Riga di stato sotto il contratto: proprietario, costruzioni, ipoteca, pedine presenti. */
function statoCasella(p, indice) {
  const c = CASELLE[indice];
  const s = statoProp(p, indice);
  const voci = [];
  if (acquistabile(c)) {
    if (s.proprietario) {
      voci.push(el('div', null, el('dt', { text: 'Proprietario' }), el('dd', null, nomeGiocatoreEl(p, s.proprietario))));
      if (c.tipo === 'proprieta') voci.push(el('div', null, el('dt', { text: 'Costruzioni' }), el('dd', { text: descriviCostruzioni(s.caseCostruite) })));
      voci.push(el('div', null, el('dt', { text: 'Affitto adesso' }), el('dd', { text: affittoAttuale(p, indice).testo })));
    } else {
      voci.push(el('div', null, el('dt', { text: 'Proprietario' }), el('dd', { text: `nessuno, in vendita a ${euro(c.prezzo)}` })));
    }
  }
  const presenti = p ? p.giocatori.filter((g) => !g.fallito && g.posizione === indice) : [];
  if (presenti.length) {
    voci.push(el('div', null, el('dt', { text: 'Qui adesso' }),
      el('dd', { class: 'elenco-in-linea' }, presenti.map((g) => nomeGiocatoreEl(p, g.id)))));
  }
  return voci.length ? el('dl', { class: 'scheda-stato' }, voci) : null;
}

// ===========================================================================
// Infrastruttura dei dialoghi
// ===========================================================================

let ultimoStato = null;
let ultimoDispatch = () => {};
let corrente = null;

const SELETTORE_FOCUS = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focalizzabili(radice) {
  return [...radice.querySelectorAll(SELETTORE_FOCUS)].filter((n) => !n.closest('[hidden]') && n.getClientRects().length > 0);
}

/** Tipo del dialogo aperto, o null. */
export function aperto() {
  // Un dialogo appena chiuso resta `corrente` fino all'evento 'close', che il
  // browser manda dopo: per chi chiede è già chiuso (es. asta finita e subito
  // un'altra in coda, che altrimenti non si aprirebbe).
  return corrente && !corrente.chiuso ? corrente.tipo : null;
}

/** Riceve l'ultimo StatoClient: aggiorna o chiude il dialogo aperto. */
export function aggiorna(statoClient, dispatch) {
  ultimoStato = statoClient;
  if (typeof dispatch === 'function') ultimoDispatch = dispatch;
  if (!corrente) return;
  const ctx = corrente;
  const p = partitaDi(statoClient);
  if (ctx.def.valido && !ctx.def.valido(ctx)) {
    const dopo = ctx.def.quandoNonValido;
    ctx.chiudi();
    if (dopo) dopo(ctx);
    return;
  }
  const versione = p ? p.versione : null;
  if (versione === ctx.versione) return;
  ctx.versione = versione;
  if (ctx.def.aggiorna) ctx.def.aggiorna(ctx);
  else if (ctx.def.vivo) ridisegna(ctx);
}

export function chiudiTutti() {
  if (corrente) corrente.chiudi();
  const box = document.getElementById('dialoghi');
  if (box) box.querySelectorAll('dialog[open]').forEach((d) => d.close());
}

/**
 * Apre un dialogo del tipo indicato chiudendo quello eventualmente aperto.
 *
 * @param {string} tipo
 * @param {object} dati
 * @param {(azione: object) => void} dispatch
 * @returns {{ chiudi: () => void, aggiorna: () => void }}
 */
export function apri(tipo, dati = {}, dispatch) {
  const def = TIPI[tipo];
  if (!def) {
    console.warn(`[dialoghi] tipo sconosciuto: ${tipo}`);
    return { chiudi() {}, aggiorna() {} };
  }
  if (typeof dispatch === 'function') ultimoDispatch = dispatch;
  const daRipristinare = corrente ? corrente.focusPrecedente : document.activeElement;
  if (corrente) corrente.chiudi({ silenzioso: true });

  const idTitolo = nuovoId('dlg-titolo');
  const dialog = el('dialog', { class: `dlg dlg--${tipo}${def.classe ? ` ${def.classe}` : ''}`, 'aria-labelledby': idTitolo });
  const titoloEl = el('h2', { class: 'dlg__titolo', id: idTitolo });
  const chiudiBtn = el('button', { type: 'button', class: 'dlg__chiudi', 'aria-label': 'Chiudi la finestra' },
    el('span', { 'aria-hidden': 'true', text: '×' }));
  const annuncioEl = el('div', { class: 'visivamente-nascosto', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const corpoEl = el('div', { class: 'dlg__corpo' });
  const piedeEl = el('div', { class: 'dlg__piede' });
  dialog.append(el('div', { class: 'dlg__quadro' },
    el('header', { class: 'dlg__testa' }, titoloEl, def.senzaChiudi ? null : chiudiBtn),
    annuncioEl, corpoEl, piedeEl));

  const ctx = {
    tipo,
    def,
    dati: dati || {},
    dialog,
    titoloEl,
    corpoEl,
    piedeEl,
    annuncioEl,
    focusPrecedente: daRipristinare,
    chiuso: false,
    get stato() { return ultimoStato || (dati && dati.stato) || null; },
    get p() { return partitaDi(this.stato); },
    get mio() { return mioIdDi(this.stato) || (dati && dati.mioId) || null; },
    get io() { return giocatoreDa(this.p, this.mio); },
    invia(azione, { chiudi = false } = {}) {
      (dispatch || ultimoDispatch)(azione);
      if (chiudi) ctx.chiudi();
    },
    annuncia(testo) {
      annuncioEl.textContent = '';
      requestAnimationFrame(() => { annuncioEl.textContent = testo; });
    },
    ridisegna() { ridisegna(ctx); },
    chiudi({ silenzioso = false } = {}) {
      if (ctx.chiuso) return;
      ctx.chiuso = true;
      ctx.silenzioso = silenzioso;
      if (dialog.open) dialog.close();
      else dialog.dispatchEvent(new Event('close'));
    },
  };
  ctx.versione = ctx.p ? ctx.p.versione : null;
  if (def.prepara) def.prepara(ctx);
  if (def.valido && !def.valido(ctx)) {
    // Il dialogo non ha senso nello stato attuale (es. asta già chiusa).
    return { chiudi() {}, aggiorna() {} };
  }

  chiudiBtn.addEventListener('click', () => ctx.chiudi());
  dialog.addEventListener('cancel', (e) => {
    if (def.nonAnnullabile) e.preventDefault();
  });
  // Click sullo sfondo (fuori dal quadro) = chiudi.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog && !def.nonAnnullabile) ctx.chiudi();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const nodi = focalizzabili(dialog);
    if (!nodi.length) return;
    const primo = nodi[0];
    const ultimo = nodi[nodi.length - 1];
    if (e.shiftKey && document.activeElement === primo) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primo.focus();
    }
  });
  dialog.addEventListener('close', () => {
    ctx.chiuso = true;
    dialog.remove();
    if (corrente === ctx) corrente = null;
    if (!ctx.silenzioso) {
      if (def.dopoChiusura) def.dopoChiusura(ctx);
      let torna = ctx.focusPrecedente;
      // Se il pulsante da cui si era partiti ora è bloccato, meglio il pulsante principale del turno.
      if (torna && torna.getAttribute && torna.getAttribute('aria-disabled') === 'true') {
        torna = document.querySelector('.pn-turno .btn--primario:not([aria-disabled="true"])') || torna;
      }
      if (!corrente && torna && torna.isConnected && typeof torna.focus === 'function') torna.focus({ preventScroll: true });
    }
  }, { once: true });

  disegna(ctx);
  const contenitore = document.getElementById('dialoghi') || document.body;
  contenitore.append(dialog);
  corrente = ctx;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');

  const iniziale = dialog.querySelector('[autofocus]')
    || (def.focusIniziale && def.focusIniziale(ctx))
    || focalizzabili(corpoEl)[0]
    || focalizzabili(piedeEl)[0]
    || chiudiBtn;
  if (iniziale && typeof iniziale.focus === 'function') iniziale.focus();

  return { chiudi: () => ctx.chiudi(), aggiorna: () => ridisegna(ctx) };
}

function disegna(ctx) {
  ctx.titoloEl.textContent = ctx.def.titolo(ctx);
  ctx.corpoEl.replaceChildren(...comeArray(ctx.def.corpo(ctx)));
  const piede = comeArray(ctx.def.piede ? ctx.def.piede(ctx) : null);
  ctx.piedeEl.replaceChildren(...piede);
  ctx.piedeEl.hidden = piede.length === 0;
}

/** Ridisegna corpo e piede conservando valori dei campi e focus (via data-chiave). */
function ridisegna(ctx) {
  const attivo = document.activeElement;
  const dentro = attivo && ctx.dialog.contains(attivo);
  let chiave = null;
  if (dentro) {
    if (attivo.dataset && attivo.dataset.chiave) chiave = attivo.dataset.chiave;
    else if (attivo.name && (attivo.type === 'radio' || attivo.type === 'checkbox')) chiave = `scelta:${attivo.name}=${attivo.value}`;
    else if (attivo.name) chiave = `campo:${attivo.name}`;
  }
  const valori = new Map();
  ctx.dialog.querySelectorAll('input[name], select[name], textarea[name]').forEach((n) => {
    if (n.type === 'checkbox' || n.type === 'radio') valori.set(`${n.name}=${n.value}`, n.checked);
    else valori.set(n.name, n.value);
  });
  const selezione = dentro && attivo.tagName === 'INPUT' && attivo.type !== 'number' ? [attivo.selectionStart, attivo.selectionEnd] : null;

  disegna(ctx);

  ctx.dialog.querySelectorAll('input[name], select[name], textarea[name]').forEach((n) => {
    if (n.dataset.nonConservare !== undefined) return;
    const k = n.type === 'checkbox' || n.type === 'radio' ? `${n.name}=${n.value}` : n.name;
    if (!valori.has(k)) return;
    if (n.type === 'checkbox' || n.type === 'radio') n.checked = valori.get(k);
    else n.value = valori.get(k);
  });
  if (ctx.def.dopoRidisegno) ctx.def.dopoRidisegno(ctx);

  if (dentro) {
    let dest = null;
    if (chiave && chiave.startsWith('campo:')) dest = ctx.dialog.querySelector(`[name="${CSS.escape(chiave.slice(6))}"]`);
    else if (chiave && chiave.startsWith('scelta:')) {
      const [nome, valore] = chiave.slice(7).split('=');
      dest = ctx.dialog.querySelector(`[name="${CSS.escape(nome)}"][value="${CSS.escape(valore)}"]`);
    }
    else if (chiave) dest = ctx.dialog.querySelector(`[data-chiave="${CSS.escape(chiave)}"]`);
    if (!dest && ctx.dialog.contains(attivo)) dest = attivo;
    if (!dest) dest = focalizzabili(ctx.corpoEl)[0] || focalizzabili(ctx.dialog)[0];
    if (dest && document.activeElement !== dest) dest.focus({ preventScroll: true });
    if (selezione && dest && dest.setSelectionRange) {
      try { dest.setSelectionRange(selezione[0], selezione[1]); } catch { /* tipi senza selezione */ }
    }
  }
}

function chiudiPulsante(ctx, testo = 'Chiudi', { primario = false } = {}) {
  return el('button', { type: 'button', class: `btn${primario ? ' btn--primario' : ' btn--quieto'}`, text: testo, onclick: () => ctx.chiudi() });
}

function indiceDaDati(dati) {
  if (Number.isInteger(dati.indice)) return dati.indice;
  if (Number.isInteger(dati.casella)) return dati.casella;
  if (dati.casella && Number.isInteger(dati.casella.indice)) return dati.casella.indice;
  return null;
}

function avviso(testo, livello = 'info') {
  return el('p', { class: `riquadro riquadro--${livello}`, text: testo });
}

// ===========================================================================
// Tipi di dialogo
// ===========================================================================

const TIPI = {};

// --- Dettaglio casella ----------------------------------------------------

TIPI.dettaglioCasella = {
  classe: 'dlg--stretto',
  vivo: true,
  prepara(ctx) { ctx.indice = indiceDaDati(ctx.dati) ?? 0; },
  titolo: (ctx) => (CASELLE[ctx.indice] ? CASELLE[ctx.indice].nome : 'Casella'),
  corpo(ctx) {
    return [contratto(ctx.p, ctx.indice), statoCasella(ctx.p, ctx.indice)];
  },
  piede(ctx) {
    const { p, mio, indice } = ctx;
    const c = CASELLE[indice];
    const s = statoProp(p, indice);
    const out = [];
    if (acquistabile(c) && mio && s.proprietario === mio) {
      if (c.tipo === 'proprieta') {
        out.push(pulsante({
          testo: s.caseCostruite === 4 ? 'Costruisci l’albergo' : 'Costruisci una casa',
          dettaglio: euro(c.costoCasa),
          chiave: 'dc-costruisci',
          motivo: motivoCostruisci(p, mio, indice),
          onclick: () => ctx.invia({ tipo: 'costruisci', casella: indice }),
        }));
        out.push(pulsante({
          testo: s.caseCostruite === 5 ? 'Vendi l’albergo' : 'Vendi una casa',
          dettaglio: `+${euro(c.costoCasa / 2)}`,
          chiave: 'dc-vendi',
          motivo: motivoVendi(p, mio, indice),
          onclick: () => ctx.invia({ tipo: 'vendiCasa', casella: indice }),
        }));
      }
      if (s.ipotecata) {
        out.push(pulsante({
          testo: 'Riscatta l’ipoteca',
          dettaglio: euro(costoRiscatto(c)),
          chiave: 'dc-disipoteca',
          motivo: motivoDisipoteca(p, mio, indice),
          onclick: () => ctx.invia({ tipo: 'disipoteca', casella: indice }),
        }));
      } else {
        out.push(pulsante({
          testo: 'Ipoteca',
          dettaglio: `+${euro(c.ipoteca)}`,
          chiave: 'dc-ipoteca',
          motivo: motivoIpoteca(p, mio, indice),
          onclick: () => ctx.invia({ tipo: 'ipoteca', casella: indice }),
        }));
      }
    }
    out.push(chiudiPulsante(ctx, 'Chiudi', { primario: out.length === 0 }));
    return out;
  },
  focusIniziale: (ctx) => ctx.piedeEl.querySelector('.btn'),
};

// --- Acquisto -------------------------------------------------------------

TIPI.acquisto = {
  classe: 'dlg--stretto',
  vivo: true,
  prepara(ctx) {
    ctx.indice = indiceDaDati(ctx.dati);
    if (ctx.indice == null && ctx.io) ctx.indice = ctx.io.posizione;
  },
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'daDecidereAcquisto' && ctx.p.turno.giocatoreId === ctx.mio,
  titolo: (ctx) => `Vuoi comprare ${CASELLE[ctx.indice] ? CASELLE[ctx.indice].nome : 'questa proprietà'}?`,
  corpo(ctx) {
    const c = CASELLE[ctx.indice];
    const denaro = ctx.io ? ctx.io.denaro : (ctx.dati.denaro || 0);
    const resta = denaro - c.prezzo;
    return [
      contratto(ctx.p, ctx.indice),
      el('dl', { class: 'conto' },
        el('div', null, el('dt', { text: 'Hai' }), el('dd', { text: euro(denaro) })),
        el('div', null, el('dt', { text: 'Prezzo' }), el('dd', { text: `−${euro(c.prezzo)}` })),
        el('div', { class: 'conto__totale' }, el('dt', { text: 'Ti resterebbero' }), el('dd', { class: resta < 0 ? 'negativo' : null, text: euro(resta) }))),
      resta < 0
        ? avviso('Non hai abbastanza denaro. Puoi ipotecare o vendere case dal pannello e poi comprare, oppure metterla all’asta.', 'avviso')
        : el('p', { class: 'testo-secondario', text: ctx.p.regole && ctx.p.regole.aste === false
          ? 'Se rinunci, la proprietà resta alla banca: chi ci arriva dopo potrà comprarla.'
          : 'Se rinunci, la proprietà va all’asta tra tutti i giocatori, te compreso.' }),
    ];
  },
  piede(ctx) {
    const c = CASELLE[ctx.indice];
    const denaro = ctx.io ? ctx.io.denaro : 0;
    return [
      pulsante({
        testo: ctx.p.regole && ctx.p.regole.aste === false ? 'Non comprare' : 'Metti all’asta',
        chiave: 'acq-asta',
        motivo: motivoAzione(ctx.p, ctx.mio, 'rifiutaAcquisto'),
        onclick: () => ctx.invia({ tipo: 'rifiutaAcquisto' }, { chiudi: true }),
      }),
      pulsante({
        testo: `Compra per ${euro(c.prezzo)}`,
        chiave: 'acq-compra',
        primario: true,
        motivo: motivoAzione(ctx.p, ctx.mio, 'compra') || (denaro < c.prezzo ? `Ti mancano ${euro(c.prezzo - denaro)}` : null),
        onclick: () => ctx.invia({ tipo: 'compra' }, { chiudi: true }),
      }),
    ];
  },
  focusIniziale: (ctx) => ctx.piedeEl.querySelector('[data-chiave="acq-compra"]:not([aria-disabled])') || ctx.piedeEl.querySelector('.btn'),
};

// --- Asta -----------------------------------------------------------------

function minimoAsta(asta) {
  return (asta.offertaMassima || 0) + (asta.incrementoMinimo || 1);
}

TIPI.asta = {
  vivo: true,
  prepara(ctx) {
    const asta = (ctx.p && ctx.p.asta) || ctx.dati.asta;
    ctx.rif = asta ? asta.iniziataIl : null;
    ctx.ultimaOfferta = asta ? `${asta.offertaMassima}|${asta.migliorOfferenteId}` : '';
    ctx.indice = asta ? asta.casella : indiceDaDati(ctx.dati);
  },
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'asta' && !!ctx.p.asta && (ctx.rif == null || ctx.p.asta.iniziataIl === ctx.rif),
  titolo: (ctx) => `Asta per ${CASELLE[ctx.indice].nome}`,
  aggiorna(ctx) {
    const asta = ctx.p.asta;
    const firma = `${asta.offertaMassima}|${asta.migliorOfferenteId}`;
    if (firma !== ctx.ultimaOfferta) {
      ctx.ultimaOfferta = firma;
      if (asta.migliorOfferenteId) {
        ctx.annuncia(`${asta.migliorOfferenteId === ctx.mio ? 'Tu' : nomeDi(ctx.p, asta.migliorOfferenteId)}: ${euro(asta.offertaMassima)}`);
      }
      ctx.dialog.classList.remove('dlg--rilancio');
      void ctx.dialog.offsetWidth;
      ctx.dialog.classList.add('dlg--rilancio');
    }
    ridisegna(ctx);
  },
  corpo(ctx) {
    const { p, mio } = ctx;
    const asta = p.asta;
    const io = ctx.io;
    const inTesta = asta.migliorOfferenteId;
    const partecipa = asta.partecipanti.includes(mio);
    const passato = asta.passati.includes(mio);
    const minimo = minimoAsta(asta);

    const offerta = el('div', { class: `asta-offerta${inTesta === mio ? ' asta-offerta--mia' : ''}` },
      el('span', { class: 'asta-offerta__etichetta', text: inTesta ? 'Offerta più alta' : 'Nessuna offerta' }),
      el('span', { class: 'asta-offerta__importo', text: inTesta ? euro(asta.offertaMassima) : '—' }),
      el('span', { class: 'asta-offerta__chi' }, inTesta
        ? (inTesta === mio ? 'È la tua' : nomeGiocatoreEl(p, inTesta))
        : `Si parte da ${euro(minimo)}`));

    const partecipanti = el('ul', { class: 'asta-partecipanti', 'aria-label': 'Partecipanti' },
      asta.partecipanti.map((id) => {
        const g = giocatoreDa(p, id);
        const st = id === inTesta ? 'in testa' : asta.passati.includes(id) ? 'ha passato' : 'in gara';
        return el('li', { class: `asta-partecipante asta-partecipante--${st.replace(/\s/g, '-')}` },
          pallino(g ? g.colore : '#888'),
          el('span', { class: 'asta-partecipante__nome', text: id === mio ? `${g ? g.nome : ''} (tu)` : (g ? g.nome : '') }),
          el('span', { class: 'asta-partecipante__stato', text: st }));
      }));

    const parti = [
      el('div', { class: 'asta-griglia' }, contratto(p, ctx.indice, { compatto: true }), offerta),
      partecipanti,
    ];

    if (!partecipa) {
      parti.push(avviso('Non partecipi a questa asta: puoi seguirla da qui.'));
    } else if (passato) {
      parti.push(avviso('Hai passato: segui come va a finire.'));
    } else {
      const idErr = nuovoId('err');
      const idAiuto = nuovoId('aiuto');
      const campo = el('input', {
        type: 'number', name: 'importo', id: nuovoId('campo'), inputmode: 'numeric',
        min: minimo, max: io.denaro, step: 1, value: Math.min(minimo, io.denaro), required: true,
        'aria-describedby': `${idAiuto} ${idErr}`,
      });
      const errore = el('p', { class: 'errore-campo', id: idErr, 'aria-live': 'assertive' });
      const rapidi = [10, 50, 100].map((n) => el('button', {
        type: 'button', class: 'btn btn--piccolo', dataset: { chiave: `asta-piu-${n}` },
        'aria-label': `Offri ${n} euro più dell’offerta attuale`, text: `+${n}`,
        onclick: () => {
          campo.value = String(Math.min(io.denaro, (asta.offertaMassima || 0) + n));
          campo.focus();
        },
      }));
      const modulo = el('form', {
        class: 'asta-modulo', novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          const importo = Number(campo.value);
          const astaOra = ctx.p.asta;
          const min = minimoAsta(astaOra);
          let msg = '';
          if (!Number.isInteger(importo)) msg = 'Scrivi un importo intero in euro.';
          else if (importo < min) msg = `L’offerta minima è ${euro(min)}.`;
          else if (importo > ctx.io.denaro) msg = `Hai solo ${euro(ctx.io.denaro)}.`;
          errore.textContent = msg;
          campo.setAttribute('aria-invalid', msg ? 'true' : 'false');
          if (msg) { campo.focus(); return; }
          ctx.invia({ tipo: 'offertaAsta', importo });
        },
      },
      el('label', { for: campo.id, class: 'etichetta-campo', text: 'La tua offerta in euro' }),
      el('div', { class: 'asta-modulo__riga' }, campo, ...rapidi),
      el('p', { class: 'aiuto-campo', id: idAiuto, text: io.denaro < minimo ? `Ti servirebbero almeno ${euro(minimo)}: hai ${euro(io.denaro)}.` : `Minimo ${euro(minimo)}, massimo ${euro(io.denaro)} (il tuo denaro).` }),
      errore,
      el('button', {
        type: 'submit', class: 'btn btn--primario btn--largo', dataset: { chiave: 'asta-offri' },
        disabled: io.denaro < minimo, text: 'Fai l’offerta',
      }));
      parti.push(modulo);
    }
    return parti;
  },
  dopoRidisegno(ctx) {
    const campo = ctx.dialog.querySelector('input[name="importo"]');
    if (!campo || !ctx.p || !ctx.p.asta || !ctx.io) return;
    const min = minimoAsta(ctx.p.asta);
    if (!(Number(campo.value) >= min)) campo.value = String(Math.min(min, ctx.io.denaro));
  },
  piede(ctx) {
    const partecipa = ctx.p.asta.partecipanti.includes(ctx.mio);
    const passato = ctx.p.asta.passati.includes(ctx.mio);
    const out = [];
    if (partecipa && !passato) {
      out.push(pulsante({
        testo: 'Passa',
        chiave: 'asta-passa',
        motivo: motivoAzione(ctx.p, ctx.mio, 'passaAsta'),
        onclick: () => ctx.invia({ tipo: 'passaAsta' }),
      }));
    }
    out.push(chiudiPulsante(ctx, partecipa && !passato ? 'Nascondi' : 'Chiudi'));
    return out;
  },
  focusIniziale: (ctx) => ctx.dialog.querySelector('input[name="importo"]'),
};

// --- Scambio ---------------------------------------------------------------

function vuotoLato() {
  return { denaro: 0, proprieta: [], cartePrigione: 0 };
}

function scambiabili(p, id) {
  return proprietaDi(p, id).filter((c) => statoProp(p, c.indice).caseCostruite === 0);
}

function interessiRicevuti(p, indici) {
  return indici.reduce((tot, i) => tot + (statoProp(p, i).ipotecata ? interesseIpoteca(CASELLE[i]) : 0), 0);
}

function elencoLato(p, lato, vuoto) {
  const voci = [];
  if (lato.denaro > 0) voci.push(el('li', { class: 'voce-scambio voce-scambio--denaro', text: euro(lato.denaro) }));
  for (const i of lato.proprieta || []) voci.push(el('li', { class: 'voce-scambio' }, etichettaCasella(i, p)));
  if (lato.cartePrigione > 0) {
    voci.push(el('li', { class: 'voce-scambio', text: lato.cartePrigione === 1 ? '1 carta «Uscite gratis di prigione»' : `${lato.cartePrigione} carte «Uscite gratis di prigione»` }));
  }
  if (!voci.length) voci.push(el('li', { class: 'voce-scambio voce-scambio--vuota', text: vuoto }));
  return el('ul', { class: 'lato-scambio__voci' }, voci);
}

/** Colonna di composizione: denaro, proprietà scambiabili, carte prigione. */
function colonnaComposizione(ctx, ruolo) {
  const { p } = ctx;
  const id = ruolo === 'offre' ? ctx.mio : ctx.bozza.aId;
  const g = giocatoreDa(p, id);
  const bozza = ctx.bozza[ruolo];
  const titolo = ruolo === 'offre' ? 'Tu offri' : `Chiedi ${aChi(g ? g.nome : '…')}`;
  const campoDenaro = el('input', {
    type: 'number', name: `${ruolo}-denaro`, id: nuovoId('campo'), min: 0, max: g ? g.denaro : 0, step: 1,
    inputmode: 'numeric', value: bozza.denaro,
    oninput: (e) => { bozza.denaro = Math.max(0, Math.floor(Number(e.target.value) || 0)); aggiornaRiepilogoScambio(ctx); },
  });
  const props = g ? scambiabili(p, id) : [];
  const costruite = g ? proprietaDi(p, id).filter((c) => statoProp(p, c.indice).caseCostruite > 0) : [];
  const elenco = props.length
    ? el('ul', { class: 'scelta-proprieta' }, props.map((c) => {
      const idCampo = nuovoId('prop');
      return el('li', null,
        el('input', {
          type: 'checkbox', id: idCampo, name: `${ruolo}-proprieta`, value: c.indice,
          checked: bozza.proprieta.includes(c.indice),
          onchange: (e) => {
            const i = Number(e.target.value);
            bozza.proprieta = e.target.checked ? [...new Set([...bozza.proprieta, i])] : bozza.proprieta.filter((x) => x !== i);
            aggiornaRiepilogoScambio(ctx);
          },
        }),
        el('label', { for: idCampo }, etichettaCasella(c.indice, p)));
    }))
    : el('p', { class: 'testo-secondario', text: 'Nessuna proprietà scambiabile.' });
  const parti = [
    el('legend', { text: titolo }),
    el('div', { class: 'campo' },
      el('label', { for: campoDenaro.id, class: 'etichetta-campo', text: 'Denaro' }),
      campoDenaro,
      el('span', { class: 'aiuto-campo', text: `Disponibili ${euro(g ? g.denaro : 0)}` })),
    el('div', { class: 'campo' }, el('span', { class: 'etichetta-campo', text: 'Proprietà' }), elenco),
  ];
  if (costruite.length) {
    parti.push(el('p', { class: 'aiuto-campo', text: `Non scambiabili finché hanno case: ${costruite.map((c) => c.nome).join(', ')}.` }));
  }
  if (g && g.cartePrigione > 0) {
    const campoCarte = el('input', {
      type: 'number', name: `${ruolo}-carte`, id: nuovoId('campo'), min: 0, max: g.cartePrigione, step: 1, value: bozza.cartePrigione,
      oninput: (e) => { bozza.cartePrigione = Math.max(0, Math.min(g.cartePrigione, Math.floor(Number(e.target.value) || 0))); aggiornaRiepilogoScambio(ctx); },
    });
    parti.push(el('div', { class: 'campo' },
      el('label', { for: campoCarte.id, class: 'etichetta-campo', text: 'Carte «Uscite gratis di prigione»' }),
      campoCarte,
      el('span', { class: 'aiuto-campo', text: `Ne ha ${g.cartePrigione}` })));
  }
  return el('fieldset', { class: `lato-scambio lato-scambio--${ruolo}`, dataset: { ruolo } }, parti);
}

function erroreBozza(ctx) {
  const { p, bozza } = ctx;
  const io = ctx.io;
  const altro = giocatoreDa(p, bozza.aId);
  if (!altro) return 'Scegli con chi scambiare';
  const vuoto = (l) => !l.denaro && !l.proprieta.length && !l.cartePrigione;
  if (vuoto(bozza.offre) && vuoto(bozza.chiede)) return 'Aggiungi almeno qualcosa da offrire o da chiedere';
  if (bozza.offre.denaro > io.denaro) return `Puoi offrire al massimo ${euro(io.denaro)}`;
  if (bozza.chiede.denaro > altro.denaro) return `${altro.nome} ha solo ${euro(altro.denaro)}`;
  return null;
}

function aggiornaRiepilogoScambio(ctx) {
  const box = ctx.dialog.querySelector('.riepilogo-scambio');
  const invio = ctx.invioScambio;
  if (!box || !invio) return;
  const { p, bozza } = ctx;
  const mieInteressi = interessiRicevuti(p, bozza.chiede.proprieta);
  const loroInteressi = interessiRicevuti(p, bozza.offre.proprieta);
  const righe = [];
  if (mieInteressi) righe.push(`Se accetta, pagherai ${euro(mieInteressi)} di interessi alla banca per le proprietà ipotecate che ricevi.`);
  if (loroInteressi) righe.push(`${nomeDi(p, bozza.aId)} pagherà ${euro(loroInteressi)} di interessi per le ipotecate che riceve.`);
  box.replaceChildren(...righe.map((t) => el('p', { text: t })));
  box.hidden = righe.length === 0;
  aggiornaPulsante(invio, { motivo: motivoAzione(p, ctx.mio, 'proponiScambio') || erroreBozza(ctx) });
}

TIPI.scambio = {
  classe: 'dlg--largo',
  prepara(ctx) {
    const p = ctx.p;
    const pendente = (p && p.scambio) || ctx.dati.scambio || null;
    ctx.modo = pendente && !ctx.dati.nuovo ? 'vista' : 'nuovo';
    if (ctx.modo === 'vista') {
      ctx.rif = pendente.id;
    } else {
      const altri = p ? p.giocatori.filter((g) => g.id !== ctx.mio && !g.fallito) : [];
      const scelto = ctx.dati.aId && altri.some((g) => g.id === ctx.dati.aId) ? ctx.dati.aId : (altri[0] && altri[0].id);
      ctx.bozza = { aId: scelto || null, offre: vuotoLato(), chiede: vuotoLato() };
      if (Number.isInteger(ctx.dati.chiediCasella)) ctx.bozza.chiede.proprieta.push(ctx.dati.chiediCasella);
    }
  },
  valido(ctx) {
    if (!ctx.p || ctx.p.fase === 'finePartita') return false;
    if (ctx.modo === 'vista') return !!ctx.p.scambio && ctx.p.scambio.id === ctx.rif;
    return true;
  },
  aggiorna(ctx) {
    if (ctx.modo === 'vista') ridisegna(ctx);
    else aggiornaRiepilogoScambio(ctx);
  },
  titolo(ctx) {
    if (ctx.modo === 'nuovo') return 'Proponi uno scambio';
    const s = ctx.p.scambio;
    if (s.aId === ctx.mio) return `${nomeDi(ctx.p, s.daId)} ti propone uno scambio`;
    if (s.daId === ctx.mio) return `La tua proposta ${aChi(nomeDi(ctx.p, s.aId))}`;
    return `Scambio tra ${nomeDi(ctx.p, s.daId)} e ${nomeDi(ctx.p, s.aId)}`;
  },
  corpo(ctx) {
    const { p } = ctx;
    if (ctx.modo === 'nuovo') {
      const altri = p.giocatori.filter((g) => g.id !== ctx.mio && !g.fallito);
      if (!altri.length) return avviso('Non c’è nessun altro giocatore con cui scambiare.');
      const idSel = nuovoId('campo');
      const sel = el('select', {
        id: idSel, name: 'controparte',
        onchange: (e) => {
          ctx.bozza.aId = e.target.value;
          ctx.bozza.chiede = vuotoLato();
          const vecchia = ctx.dialog.querySelector('.lato-scambio--chiede');
          if (vecchia) vecchia.replaceWith(colonnaComposizione(ctx, 'chiede'));
          aggiornaRiepilogoScambio(ctx);
        },
      }, altri.map((g) => el('option', { value: g.id, selected: g.id === ctx.bozza.aId, text: `${g.nome} (${euro(g.denaro)})` })));
      return [
        el('div', { class: 'campo campo--in-linea' }, el('label', { for: idSel, class: 'etichetta-campo', text: 'Scambia con' }), sel),
        el('div', { class: 'scambio-colonne' }, colonnaComposizione(ctx, 'offre'), colonnaComposizione(ctx, 'chiede')),
        el('div', { class: 'riepilogo-scambio riquadro riquadro--info', hidden: true }),
        el('p', { class: 'testo-secondario', text: 'Si possono scambiare solo proprietà senza case. Chi riceve una proprietà ipotecata paga subito il 10% di interessi.' }),
      ];
    }
    const s = p.scambio;
    const daNome = s.daId === ctx.mio ? 'Tu offri' : `${nomeDi(p, s.daId)} offre`;
    const chiedeNome = s.daId === ctx.mio ? `Chiedi ${aChi(nomeDi(p, s.aId))}` : (s.aId === ctx.mio ? 'In cambio ti chiede' : `Chiede ${aChi(nomeDi(p, s.aId))}`);
    const parti = [el('div', { class: 'scambio-colonne' },
      el('section', { class: 'lato-scambio lato-scambio--offre', 'aria-label': daNome }, el('h3', { text: daNome }), elencoLato(p, s.offre, 'Niente')),
      el('section', { class: 'lato-scambio lato-scambio--chiede', 'aria-label': chiedeNome }, el('h3', { text: chiedeNome }), elencoLato(p, s.chiede, 'Niente')))];
    if (s.aId === ctx.mio) {
      const interessi = interessiRicevuti(p, s.offre.proprieta);
      if (interessi) parti.push(avviso(`Accettando paghi subito ${euro(interessi)} di interessi alla banca per le proprietà ipotecate.`, 'avviso'));
    }
    if (s.daId === ctx.mio) parti.push(el('p', { class: 'testo-secondario', text: `In attesa della risposta di ${nomeDi(p, s.aId)}. Puoi ritirare la proposta finché non risponde.` }));
    return parti;
  },
  piede(ctx) {
    const { p, mio } = ctx;
    if (ctx.modo === 'nuovo') {
      ctx.invioScambio = pulsante({
        testo: 'Invia la proposta',
        chiave: 'sc-invia',
        primario: true,
        motivo: motivoAzione(p, mio, 'proponiScambio') || erroreBozza(ctx),
        onclick: () => {
          const b = ctx.bozza;
          ctx.invia({
            tipo: 'proponiScambio',
            aId: b.aId,
            offre: { denaro: b.offre.denaro, proprieta: [...b.offre.proprieta], cartePrigione: b.offre.cartePrigione },
            chiede: { denaro: b.chiede.denaro, proprieta: [...b.chiede.proprieta], cartePrigione: b.chiede.cartePrigione },
          }, { chiudi: true });
          toast(`Proposta inviata ${aChi(nomeDi(p, b.aId))}`, { livello: 'info' });
        },
      });
      queueMicrotask(() => aggiornaRiepilogoScambio(ctx));
      return [chiudiPulsante(ctx, 'Annulla'), ctx.invioScambio];
    }
    const s = p.scambio;
    if (s.aId === mio) {
      const io = ctx.io;
      return [
        pulsante({ testo: 'Rifiuta', chiave: 'sc-rifiuta', onclick: () => ctx.invia({ tipo: 'rifiutaScambio', scambioId: s.id }, { chiudi: true }) }),
        pulsante({
          testo: 'Accetta lo scambio', chiave: 'sc-accetta', primario: true,
          motivo: motivoAzione(p, mio, 'accettaScambio') || (s.chiede.denaro > io.denaro ? `Ti chiede ${euro(s.chiede.denaro)} ma hai ${euro(io.denaro)}` : null),
          onclick: () => ctx.invia({ tipo: 'accettaScambio', scambioId: s.id }, { chiudi: true }),
        }),
      ];
    }
    if (s.daId === mio) {
      return [
        pulsante({ testo: 'Ritira la proposta', chiave: 'sc-ritira', pericolo: true, onclick: () => ctx.invia({ tipo: 'rifiutaScambio', scambioId: s.id }, { chiudi: true }) }),
        chiudiPulsante(ctx, 'Chiudi', { primario: true }),
      ];
    }
    return [chiudiPulsante(ctx, 'Chiudi', { primario: true })];
  },
  focusIniziale: (ctx) => ctx.dialog.querySelector('select[name="controparte"]') || ctx.piedeEl.querySelector('[data-chiave="sc-accetta"]'),
};

// --- Gestione del patrimonio (costruzioni, vendite, ipoteche) -------------

const MODALITA = [
  { id: 'costruisci', etichetta: 'Costruisci', azione: 'costruisci' },
  { id: 'vendi', etichetta: 'Vendi case', azione: 'vendiCasa' },
  { id: 'ipoteca', etichetta: 'Ipoteca', azione: 'ipoteca' },
  { id: 'disipoteca', etichetta: 'Riscatta', azione: 'disipoteca' },
];

function voceGestione(ctx, c, modalita) {
  const { p, mio } = ctx;
  const s = statoProp(p, c.indice);
  let testo;
  let dettaglio;
  let motivo;
  let azione;
  if (modalita === 'costruisci') {
    testo = s.caseCostruite === 4 ? 'Albergo' : 'Casa';
    dettaglio = euro(c.costoCasa);
    motivo = motivoCostruisci(p, mio, c.indice);
    azione = 'costruisci';
  } else if (modalita === 'vendi') {
    testo = s.caseCostruite === 5 ? 'Vendi albergo' : 'Vendi casa';
    dettaglio = `+${euro(c.costoCasa / 2)}`;
    motivo = motivoVendi(p, mio, c.indice);
    azione = 'vendiCasa';
  } else if (modalita === 'ipoteca') {
    testo = 'Ipoteca';
    dettaglio = `+${euro(c.ipoteca)}`;
    motivo = motivoIpoteca(p, mio, c.indice);
    azione = 'ipoteca';
  } else {
    testo = 'Riscatta';
    dettaglio = euro(costoRiscatto(c));
    motivo = motivoDisipoteca(p, mio, c.indice);
    azione = 'disipoteca';
  }
  const btn = pulsante({
    testo, dettaglio, motivo, chiave: `gest-${modalita}-${c.indice}`, classe: 'btn--piccolo',
    onclick: () => ctx.invia({ tipo: azione, casella: c.indice }),
  });
  btn._btn.setAttribute('aria-label', `${testo} ${c.nome}, ${dettaglio}`);
  return el('li', { class: `voce-gestione${ctx.evidenzia === c.indice ? ' voce-gestione--evidenziata' : ''}` },
    el('button', {
      type: 'button', class: 'voce-gestione__nome', dataset: { chiave: `gest-info-${c.indice}` },
      'aria-label': `Dettagli di ${c.nome}`,
      onclick: () => apri('dettaglioCasella', { indice: c.indice }),
    }, etichettaCasella(c.indice, p)),
    c.tipo === 'proprieta' ? segniCase(s.caseCostruite) : el('span'),
    btn);
}

export function segniCase(n) {
  const box = el('span', { class: 'segni-case', 'aria-hidden': 'true' });
  if (n >= 5) box.append(el('span', { class: 'segno segno--albergo' }));
  else for (let k = 0; k < n; k += 1) box.append(el('span', { class: 'segno segno--casa' }));
  return box;
}

TIPI.gestione = {
  classe: 'dlg--medio',
  vivo: true,
  prepara(ctx) {
    ctx.modalita = MODALITA.some((m) => m.id === ctx.dati.modalita) ? ctx.dati.modalita : 'costruisci';
    ctx.evidenzia = indiceDaDati(ctx.dati);
  },
  valido: (ctx) => !!ctx.p && ctx.p.fase !== 'finePartita' && !!ctx.io && !ctx.io.fallito,
  titolo: () => 'Gestisci le tue proprietà',
  corpo(ctx) {
    const { p, mio } = ctx;
    const io = ctx.io;
    const nomeGruppoRadio = 'modalita';
    const scelta = el('div', { class: 'segmentato', role: 'radiogroup', 'aria-label': 'Cosa vuoi fare' },
      MODALITA.map((m) => {
        const idR = nuovoId('mod');
        return el('span', { class: 'segmentato__voce' },
          el('input', {
            type: 'radio', name: nomeGruppoRadio, id: idR, value: m.id, checked: ctx.modalita === m.id,
            'data-non-conservare': true,
            onchange: () => { ctx.modalita = m.id; ridisegna(ctx); },
          }),
          el('label', { for: idR, text: m.etichetta }));
      }));
    const info = el('dl', { class: 'conto conto--in-linea' },
      el('div', null, el('dt', { text: 'Il tuo denaro' }), el('dd', { text: euro(io.denaro) })),
      el('div', null, el('dt', { text: 'Case in banca' }), el('dd', { text: String(p.caseDisponibili ?? 32) })),
      el('div', null, el('dt', { text: 'Alberghi in banca' }), el('dd', { text: String(p.alberghiDisponibili ?? 12) })));

    const modo = MODALITA.find((m) => m.id === ctx.modalita);
    const generale = motivoAzione(p, mio, modo.azione);
    let mie = proprietaDi(p, mio);
    if (ctx.modalita === 'costruisci' || ctx.modalita === 'vendi') mie = mie.filter((c) => c.tipo === 'proprieta');
    if (ctx.modalita === 'vendi') mie = mie.filter((c) => statoProp(p, c.indice).caseCostruite > 0);
    if (ctx.modalita === 'disipoteca') mie = mie.filter((c) => statoProp(p, c.indice).ipotecata);
    if (ctx.modalita === 'ipoteca') mie = mie.filter((c) => !statoProp(p, c.indice).ipotecata);

    const vuoti = {
      costruisci: 'Non hai ancora proprietà su cui costruire: serve un gruppo colore completo.',
      vendi: 'Non hai case né alberghi da vendere.',
      ipoteca: 'Non hai proprietà da ipotecare.',
      disipoteca: 'Nessuna delle tue proprietà è ipotecata.',
    };

    const gruppi = new Map();
    for (const c of mie) {
      if (!gruppi.has(c.gruppo)) gruppi.set(c.gruppo, []);
      gruppi.get(c.gruppo).push(c);
    }
    const elenco = mie.length
      ? el('div', { class: 'elenco-gestione' }, [...gruppi.entries()].map(([g, caselle]) => el('section', {
        class: 'gruppo-gestione', style: { '--colore': (GRUPPI[g] && GRUPPI[g].colore) || '#4a6168' },
        'aria-label': nomeGruppo(g),
      },
      el('h3', { class: 'gruppo-gestione__titolo' }, nomeGruppo(g),
        possiedeGruppo(p, g, mio) ? el('span', { class: 'distintivo distintivo--ok', text: 'completo' }) : null),
      el('ul', null, caselle.map((c) => voceGestione(ctx, c, ctx.modalita))))))
      : el('p', { class: 'vuoto', text: vuoti[ctx.modalita] });

    return [scelta, info, generale ? avviso(generale, 'avviso') : null, elenco];
  },
  piede: (ctx) => [chiudiPulsante(ctx, 'Fatto', { primario: true })],
  focusIniziale: (ctx) => ctx.dialog.querySelector('input[name="modalita"]:checked'),
};

TIPI.costruzioni = {
  ...TIPI.gestione,
  prepara(ctx) {
    ctx.modalita = ctx.dati.modalita === 'vendi' ? 'vendi' : 'costruisci';
    ctx.evidenzia = indiceDaDati(ctx.dati);
  },
};

TIPI.ipoteca = {
  ...TIPI.gestione,
  prepara(ctx) {
    const i = indiceDaDati(ctx.dati);
    ctx.evidenzia = i;
    ctx.modalita = ctx.dati.modalita === 'disipoteca' || (i != null && statoProp(ctx.p, i).ipotecata) ? 'disipoteca' : 'ipoteca';
  },
};

// --- Prigione ---------------------------------------------------------------

TIPI.prigione = {
  classe: 'dlg--stretto',
  vivo: true,
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'daLanciare' && ctx.p.turno.giocatoreId === ctx.mio && !!ctx.io && ctx.io.inPrigione,
  titolo: () => 'Sei in prigione',
  corpo(ctx) {
    const io = ctx.io;
    const tentativo = (io.turniInPrigione || 0) + 1;
    return [
      el('p', { class: 'testo-guida', text: tentativo >= 3
        ? 'È il tuo terzo tentativo: se non fai un doppio paghi 50 € ed esci comunque.'
        : `Tentativo ${tentativo} di 3. Con un doppio esci e avanzi; altrimenti resti dentro.` }),
      el('dl', { class: 'conto conto--in-linea' },
        el('div', null, el('dt', { text: 'Il tuo denaro' }), el('dd', { text: euro(io.denaro) })),
        el('div', null, el('dt', { text: 'Carte per uscire' }), el('dd', { text: String(io.cartePrigione || 0) }))),
      el('div', { class: 'scelte' },
        pulsante({
          testo: 'Tenta il doppio', dettaglio: 'lancia i dadi', chiave: 'pr-lancia', primario: true,
          motivo: motivoAzione(ctx.p, ctx.mio, 'lanciaDadi'),
          onclick: () => ctx.invia({ tipo: 'lanciaDadi' }, { chiudi: true }),
        }),
        pulsante({
          testo: 'Paga la cauzione', dettaglio: euro(CAUZIONE), chiave: 'pr-cauzione',
          motivo: motivoAzione(ctx.p, ctx.mio, 'pagaCauzione') || (io.denaro < CAUZIONE ? `Ti servono ${euro(CAUZIONE)}` : null),
          onclick: () => ctx.invia({ tipo: 'pagaCauzione' }, { chiudi: true }),
        }),
        pulsante({
          testo: 'Usa la carta', dettaglio: 'Uscite gratis di prigione', chiave: 'pr-carta',
          motivo: motivoAzione(ctx.p, ctx.mio, 'usaCartaPrigione'),
          onclick: () => ctx.invia({ tipo: 'usaCartaPrigione' }, { chiudi: true }),
        })),
      el('p', { class: 'testo-secondario', text: 'Pagando o usando la carta esci subito e poi lanci normalmente.' }),
    ];
  },
  piede: (ctx) => [chiudiPulsante(ctx, 'Decido dopo')],
};

// --- Lancio iniziale: chi comincia -------------------------------------------

/** Righe della classifica provvisoria del lancio iniziale, dalla prima posizione. */
export function righeOrdine(p) {
  const o = p && p.ordine;
  if (!o || !Array.isArray(o.gruppi)) return [];
  const storico = Array.isArray(o.storico) ? o.storico : [];
  const righe = [];
  let posizione = 1;
  for (const gr of o.gruppi) {
    // Finché tutti sono nello stesso gruppo nessuno ha ancora un posto.
    const tutti = gr.length > 1 && gr.length === o.gruppi.reduce((n, x) => n + x.length, 0);
    const posto = gr.length === 1 ? `${posizione}°` : tutti ? '' : `${posizione}–${posizione + gr.length - 1}°`;
    for (const id of gr) {
      const lanci = storico.filter((giro) => giro.lanci && giro.lanci[id]).map((giro) => giro.lanci[id]);
      if (o.lanci && o.lanci[id]) lanci.push(o.lanci[id]);
      const stato = p.turno && p.turno.giocatoreId === id ? 'tocca'
        : gr.length === 1 ? 'deciso'
          : o.lanci && o.lanci[id] ? 'lanciato' : 'attesa';
      righe.push({ id, posto, pari: gr.length > 1, lanci: lanci.map((d) => d[0] + d[1]), stato });
    }
    posizione += gr.length;
  }
  return righe;
}

const STATI_ORDINE = { tocca: 'lancia ora', deciso: 'posto deciso', lanciato: 'ha lanciato', attesa: 'deve lanciare' };

TIPI.ordine = {
  classe: 'dlg--stretto',
  vivo: true,
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'ordine' && !!ctx.p.ordine,
  titolo: () => 'Chi comincia?',
  corpo(ctx) {
    const { p, mio } = ctx;
    const o = p.ordine;
    const diTurno = giocatoreDa(p, p.turno && p.turno.giocatoreId);
    return [
      el('p', { class: 'testo-guida', text: o.giro > 1
        ? `Spareggio: rilancia solo chi ha fatto lo stesso punteggio, e solo per i posti in palio (giro ${o.giro}).`
        : 'Ognuno lancia i due dadi: chi fa di più comincia, poi gli altri in ordine di punteggio. Chi pareggia rilancia contro chi ha fatto lo stesso numero.' }),
      el('ol', { class: 'classifica classifica--ordine' }, righeOrdine(p).map((r) => {
        const g = giocatoreDa(p, r.id);
        return el('li', { class: `classifica__voce${r.id === mio ? ' classifica__voce--mia' : ''}${r.stato === 'tocca' ? ' classifica__voce--tocca' : ''}` },
          el('span', { class: 'classifica__posto', text: r.posto }),
          pallino(g ? g.colore : '#888'),
          el('span', { class: 'classifica__nome', text: `${g ? g.nome : 'Giocatore'}${r.id === mio ? ' (tu)' : ''}` }),
          el('span', { class: 'classifica__valore', text: r.lanci.length ? r.lanci.join(' → ') : '–' }),
          el('span', { class: `distintivo${r.stato === 'tocca' ? ' distintivo--avviso' : ''}`, text: r.pari && r.stato === 'deciso' ? 'pari' : STATI_ORDINE[r.stato] }));
      })),
      diTurno && diTurno.id === mio
        ? el('div', { class: 'scelte' }, pulsante({
          testo: 'Lancia i dadi', dettaglio: o.giro > 1 ? 'spareggio' : 'chi fa di più comincia', chiave: 'ord-lancia', primario: true,
          motivo: motivoAzione(p, mio, 'lanciaDadi'),
          onclick: () => ctx.invia({ tipo: 'lanciaDadi' }),
        }))
        : el('p', { class: 'testo-secondario', text: diTurno ? `Tocca ${aChi(diTurno.nome)} lanciare.` : '' }),
    ];
  },
  piede: (ctx) => [chiudiPulsante(ctx, 'Guarda il tabellone')],
  focusIniziale: (ctx) => ctx.corpoEl?.querySelector('[data-chiave="ord-lancia"]:not([aria-disabled])') || ctx.piedeEl.querySelector('.btn'),
};

// --- Debito -----------------------------------------------------------------

const MOTIVI_DEBITO = {
  affitto: 'affitto',
  tassa: 'tassa',
  carta: 'carta pescata',
  cauzione: 'cauzione',
  pagaATutti: 'pagamento a tutti i giocatori',
  interesseScambio: 'interessi sulle ipotecate ricevute',
  interesseBancarotta: 'interessi sulle ipotecate ricevute da una bancarotta',
};

function descriviPasso(passo) {
  const c = CASELLE[passo.casella];
  return passo.tipo === 'ipoteca' ? `Ipoteca ${c.nome}` : `Vendi una casa su ${c.nome}`;
}

TIPI.debito = {
  classe: 'dlg--medio',
  vivo: true,
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'debito' && !!ctx.p.debito && ctx.p.debito.giocatoreId === ctx.mio,
  quandoNonValido(ctx) {
    if (ctx.io && !ctx.io.fallito) toast('Debito saldato', { livello: 'successo' });
  },
  titolo: () => 'Devi saldare un debito',
  corpo(ctx) {
    const { p, mio } = ctx;
    const d = p.debito;
    const io = ctx.io;
    const mancante = Math.max(0, d.importo - io.denaro);
    const massimo = liquidabile(p, mio);
    const piano = pianoLiquidazione(p, mio, mancante);
    const parti = [
      el('p', { class: 'testo-guida' },
        'Devi ', el('strong', { text: euro(d.importo) }),
        // "ad Anna", "alla banca": la preposizione segue il nome.
        d.creditoreId ? [` ${aChi(nomeDi(p, d.creditoreId)).split(' ')[0]}\u00a0`, nomeGiocatoreEl(p, d.creditoreId)] : ' alla banca',
        ` per ${MOTIVI_DEBITO[d.motivo] || d.motivo}.`),
      el('dl', { class: 'conto' },
        el('div', null, el('dt', { text: 'Hai' }), el('dd', { text: euro(io.denaro) })),
        el('div', { class: 'conto__totale' }, el('dt', { text: 'Ti mancano' }), el('dd', { class: 'negativo', text: euro(mancante) })),
        el('div', null, el('dt', { text: 'Ricavabile vendendo e ipotecando tutto' }), el('dd', { text: euro(massimo) }))),
    ];
    if (massimo < d.importo) {
      parti.push(avviso(`Anche liquidando tutto arrivi a ${euro(massimo)}: senza uno scambio vantaggioso dovrai dichiarare bancarotta.`, 'pericolo'));
    }
    if (piano.passi.length) {
      parti.push(el('h3', { class: 'sottotitolo', text: piano.copre ? 'Piano suggerito' : 'Il massimo che puoi ricavare' }));
      parti.push(el('p', { class: 'testo-secondario', text: 'Prima le ipoteche, che si riscattano pagando solo il 10% in più; le case si rivendono a metà prezzo.' }));
      parti.push(el('ol', { class: 'piano' }, piano.passi.map((passo, k) => {
        const motivo = passo.tipo === 'ipoteca' ? motivoIpoteca(p, mio, passo.casella) : motivoVendi(p, mio, passo.casella);
        const azione = pulsante({
          testo: `+${euro(passo.ricavo)}`, chiave: `deb-passo-${k}-${passo.tipo}-${passo.casella}`, classe: 'btn--piccolo',
          // Il primo passo è la mossa consigliata: deve spiccare più della bancarotta.
          primario: k === 0 && !motivo,
          motivo: motivo ? 'Fai prima i passi precedenti' : null,
          onclick: () => ctx.invia({ tipo: passo.tipo, casella: passo.casella }),
        });
        azione._btn.setAttribute('aria-label', `${descriviPasso(passo)}, ricavi ${euro(passo.ricavo)}`);
        return el('li', { class: 'piano__passo' },
          etichettaCasella(passo.casella, p),
          el('span', { class: 'piano__descrizione', text: passo.tipo === 'ipoteca' ? 'ipoteca' : 'vendi una casa' }),
          azione);
      })));
    } else {
      parti.push(el('p', { class: 'vuoto', text: 'Non hai più nulla da vendere o ipotecare.' }));
    }
    parti.push(el('p', { class: 'testo-secondario' }, 'Per scegliere tu cosa vendere apri ',
      el('button', { type: 'button', class: 'collegamento', dataset: { chiave: 'deb-gestione' }, text: 'la gestione delle proprietà', onclick: () => apri('gestione', { modalita: 'ipoteca' }) }),
      '. Il debito si salda da solo appena hai abbastanza denaro.'));
    return parti;
  },
  piede(ctx) {
    const { p, mio, io } = ctx;
    // Rossa e in evidenza solo quando non resta altro: se il debito si può
    // saldare è un pulsante sobrio (e chiede comunque conferma).
    const senzaScampo = !io || liquidabile(p, mio) < p.debito.importo;
    return [
      pulsante({
        testo: 'Proponi uno scambio', chiave: 'deb-scambio',
        motivo: motivoAzione(p, mio, 'proponiScambio'),
        onclick: () => apri('scambio', { nuovo: true, aId: p.debito.creditoreId || undefined }),
      }),
      pulsante({
        testo: 'Dichiara bancarotta', chiave: 'deb-bancarotta', pericolo: senzaScampo,
        classe: senzaScampo ? '' : 'btn--quieto',
        motivo: motivoAzione(p, mio, 'dichiaraBancarotta'),
        onclick: () => apri('bancarotta', {}),
      }),
    ];
  },
  focusIniziale: (ctx) => ctx.corpoEl.querySelector('.piano .btn:not([aria-disabled])'),
};

// --- Bancarotta e conferme ---------------------------------------------------

TIPI.bancarotta = {
  classe: 'dlg--stretto dlg--pericolo',
  valido: (ctx) => !!ctx.p && ctx.p.fase === 'debito' && !!ctx.p.debito && ctx.p.debito.giocatoreId === ctx.mio,
  titolo: () => 'Dichiarare bancarotta?',
  corpo(ctx) {
    const d = ctx.p.debito;
    const aChi = d.creditoreId
      ? `Il tuo denaro, le tue proprietà (anche quelle ipotecate) e le carte prigione passano ${aChi(nomeDi(ctx.p, d.creditoreId))}. Le case vengono vendute alla banca a metà prezzo e il ricavato va ${aChi(nomeDi(ctx.p, d.creditoreId))}.`
      : 'Le tue proprietà tornano alla banca libere da ipoteche e le case vengono vendute.';
    return [
      el('p', { class: 'testo-guida', text: aChi }),
      avviso('Uscirai dalla partita e non potrai rientrare. L’operazione non si può annullare.', 'pericolo'),
    ];
  },
  piede: (ctx) => [
    el('button', { type: 'button', class: 'btn btn--quieto', autofocus: true, text: 'Torna indietro', onclick: () => { ctx.chiudi({ silenzioso: true }); apri('debito', {}); } }),
    el('button', { type: 'button', class: 'btn btn--pericolo', text: 'Dichiaro bancarotta', onclick: () => ctx.invia({ tipo: 'dichiaraBancarotta' }, { chiudi: true }) }),
  ],
};

TIPI.conferma = {
  classe: 'dlg--stretto',
  titolo: (ctx) => ctx.dati.titolo || 'Confermi?',
  corpo: (ctx) => (ctx.dati.testo ? el('p', { class: 'testo-guida', text: ctx.dati.testo }) : null),
  piede: (ctx) => [
    el('button', { type: 'button', class: 'btn btn--quieto', autofocus: true, text: ctx.dati.annulla || 'Annulla', onclick: () => ctx.chiudi() }),
    el('button', {
      type: 'button', class: `btn ${ctx.dati.pericolo ? 'btn--pericolo' : 'btn--primario'}`, text: ctx.dati.conferma || 'Conferma',
      onclick: () => {
        ctx.chiudi();
        if (typeof ctx.dati.onConferma === 'function') ctx.dati.onConferma();
        else if (ctx.dati.azione) ctx.invia(ctx.dati.azione);
      },
    }),
  ],
};

// --- Admin: togliere giocatori e chiudere la stanza ------------------------

TIPI.admin = {
  classe: 'dlg--stretto',
  vivo: true,
  valido: (ctx) => !!ctx.p && !!ctx.mio && (ctx.p.adminId === ctx.mio || ctx.p.hostId === ctx.mio),
  titolo: (ctx) => (ctx.p && ctx.p.adminId === ctx.mio ? 'Admin della stanza' : 'Gestisci la stanza'),
  corpo(ctx) {
    const { p, mio } = ctx;
    const inPartita = p.fase !== 'lobby';
    // L'admin non si può togliere.
    const altri = (p.giocatori || []).filter((g) => g.id !== mio && !g.fallito && g.id !== p.adminId);
    const togli = (g) => apri('conferma', {
      titolo: `Togliere ${g.nome} dalla stanza?`,
      testo: inPartita
        ? `${g.nome} esce dalla partita come se avesse abbandonato: le sue proprietà tornano alla banca e vanno all’asta. Non potrà rientrare.`
        : `${g.nome} esce dalla sala d’attesa. Con il link d’invito potrebbe rientrare: avvia la partita quando ci sono tutti.`,
      conferma: 'Togli dalla stanza',
      pericolo: true,
      azione: { tipo: 'cacciaGiocatore', giocatoreId: g.id },
    }, ctx.invia);
    // Solo l'admin cede il ruolo: chi lo riceve diventa admin e host.
    const sonoAdmin = p.adminId === mio;
    const cedi = (g) => apri('conferma', {
      titolo: `Cedere l’admin ${aChi(g.nome)}?`,
      testo: `${g.nome} diventa admin e host della stanza: potrà ${inPartita ? '' : 'avviare la partita, '}togliere giocatori e chiudere la stanza. Tu perdi questi comandi e non li riprendi con il link da admin finché ${g.nome} resta nella stanza.`,
      conferma: 'Cedi admin',
      azione: { tipo: 'cediAdmin', giocatoreId: g.id },
    }, ctx.invia);
    return [
      el('p', { class: 'testo-guida', text: p.adminId === mio
        ? 'Questi comandi li vedi solo tu.'
        : 'Questi comandi li ha solo chi guida la stanza (l’host).' }),
      altri.length
        ? el('ul', { class: 'elenco-admin' }, altri.map((g) => el('li', { class: 'elenco-admin__voce' },
          nomeGiocatoreEl(p, g.id),
          g.connesso === false ? el('span', { class: 'distintivo', text: 'disconnesso' }) : null,
          el('span', { class: 'elenco-admin__comandi' },
            sonoAdmin ? el('button', {
              type: 'button', class: 'btn btn--piccolo', 'data-chiave': `admin-cedi-${g.id}`,
              text: 'Cedi admin', onclick: () => cedi(g),
            }) : null,
            el('button', {
              type: 'button', class: 'btn btn--pericolo btn--piccolo', 'data-chiave': `admin-togli-${g.id}`,
              text: 'Togli dalla stanza', onclick: () => togli(g),
            })))))
        : el('p', { class: 'vuoto', text: 'Non c’è nessun altro giocatore.' }),
    ];
  },
  // "Chiudi" accanto a "Chiudi la stanza" si confondeva: il pulsante sicuro si
  // chiama "Fatto", sta a destra e prende il focus; quello pericoloso a sinistra.
  piede: (ctx) => [
    el('button', {
      type: 'button', class: 'btn btn--pericolo admin__chiudi-stanza', text: 'Chiudi la stanza…',
      onclick: () => apri('conferma', {
        titolo: 'Chiudere la stanza?',
        testo: 'Tutti i giocatori escono e la partita finisce subito, senza vincitore. Non si può annullare.',
        conferma: 'Chiudi la stanza',
        pericolo: true,
        azione: { tipo: 'chiudiStanza' },
      }, ctx.invia),
    }),
    chiudiPulsante(ctx, 'Fatto', { primario: true }),
  ],
  focusIniziale: (ctx) => ctx.piedeEl.querySelector('.btn--primario'),
};

// --- Regole della partita ---------------------------------------------------

/** Dove il browser ricorda le ultime regole scelte, per proporle alla prossima stanza. */
const CHIAVE_REGOLE = 'monopoly.regole';
/** Chiave delle versioni precedenti, che ricordavano solo la regola di costruzione. */
const CHIAVE_REGOLA_VECCHIA = 'monopoly.regola-costruzione';

/** Tiene solo chiavi e valori del catalogo; il resto prende il predefinito. */
export function regoleValide(grezze) {
  const out = { ...PREDEFINITE };
  if (!grezze || typeof grezze !== 'object') return out;
  for (const r of REGOLE) {
    if (Object.hasOwn(grezze, r.chiave) && r.valori.some((v) => v.valore === grezze[r.chiave])) out[r.chiave] = grezze[r.chiave];
  }
  return out;
}

function regoleSalvate() {
  try {
    const testo = localStorage.getItem(CHIAVE_REGOLA_VECCHIA);
    const grezze = JSON.parse(localStorage.getItem(CHIAVE_REGOLE) || 'null') || {};
    if (testo === 'sosta' && !grezze.costruzione) grezze.costruzione = 'sosta'; // scelta salvata dalle versioni precedenti
    return regoleValide(grezze);
  } catch {
    return { ...PREDEFINITE };
  }
}

function salvaRegole(regole) {
  try {
    localStorage.setItem(CHIAVE_REGOLE, JSON.stringify(regole));
  } catch { /* archivio non disponibile: la scelta vale solo per questa stanza */ }
}

/** Le regole della stanza: quelle scelte, oppure (non ancora scelte) le ultime usate da questo browser. */
export function regoleDiPartenza(p) {
  if (p && p.regoleImpostate && p.regole) return regoleValide(p.regole);
  return regoleSalvate();
}

/** Righe di riepilogo: { chiave, titolo, etichetta, variante } (variante = diversa dalla regola classica). */
export function riepilogoRegole(regole) {
  const r = regoleValide(regole);
  return REGOLE.map((def) => {
    const v = def.valori.find((x) => x.valore === r[def.chiave]) || def.valori[0];
    return { chiave: def.chiave, titolo: def.titolo, etichetta: v.etichetta, variante: r[def.chiave] !== def.predefinito };
  });
}

/** Host o admin, in sala d'attesa: chi può scegliere le regole. */
function guidaLaStanza(p, mio) {
  return !!p && !!mio && (p.hostId === mio || p.adminId === mio);
}

TIPI.regole = {
  classe: 'dlg--medio',
  prepara(ctx) {
    ctx.modifica = !!ctx.p && ctx.p.fase === 'lobby' && guidaLaStanza(ctx.p, ctx.mio);
    ctx.scelte = regoleDiPartenza(ctx.p);
  },
  // Chi sta scegliendo perde la finestra se la partita parte o se non guida più la stanza.
  valido: (ctx) => !!ctx.p && (!ctx.modifica || (ctx.p.fase === 'lobby' && guidaLaStanza(ctx.p, ctx.mio))),
  titolo: (ctx) => (ctx.modifica ? 'Regole della partita' : 'Le regole di questa partita'),
  corpo(ctx) {
    if (!ctx.modifica) {
      const p = ctx.p;
      const impostate = p.fase !== 'lobby' || p.regoleImpostate;
      return [
        el('p', { class: 'testo-guida', text: impostate
          ? 'Le ha scelte chi guida la stanza prima di cominciare. Quelle evidenziate sono varianti rispetto alla regola classica.'
          : 'Chi guida la stanza non le ha ancora scelte: queste sono le regole classiche.' }),
        el('dl', { class: 'riepilogo-regole' }, riepilogoRegole(p.regole).map((r) => el('div', { class: r.variante ? 'riepilogo-regole__voce riepilogo-regole__voce--variante' : 'riepilogo-regole__voce' },
          el('dt', { text: r.titolo }), el('dd', { text: r.etichetta })))),
      ];
    }
    return [
      el('p', { class: 'testo-guida', text: 'Scegli le regole prima di avviare: gli altri giocatori le vedono nella sala d’attesa. Se non tocchi niente si gioca con le regole classiche.' }),
      ...REGOLE.map((def) => {
        const nome = `regola-${def.chiave}`;
        return el('fieldset', { class: 'scelta-regola' },
          el('legend', { class: 'scelta-regola__titolo', text: def.titolo }),
          el('p', { class: 'scelta-regola__descrizione', text: def.descrizione }),
          el('div', { class: 'scelta-regola__valori' }, def.valori.map((v, i) => el('label', { class: 'scelta-regola__valore' },
            el('input', {
              type: 'radio', name: nome, value: String(i), checked: ctx.scelte[def.chiave] === v.valore,
              onchange: () => { ctx.scelte[def.chiave] = v.valore; },
            }),
            el('span', { class: 'scelta-regola__testo' },
              el('span', { class: 'scelta-regola__etichetta', text: v.etichetta }),
              el('span', { class: 'scelta-regola__spiega', text: v.descrizione }))))));
      }),
    ];
  },
  piede(ctx) {
    if (!ctx.modifica) return [chiudiPulsante(ctx, 'Chiudi', { primario: true })];
    const connessi = (ctx.p.giocatori || []).filter((g) => g.connesso !== false).length;
    const conferma = (avvia) => () => {
      const regole = regoleValide(ctx.scelte);
      salvaRegole(regole);
      ctx.invia(avvia ? { tipo: 'avviaPartita', regole } : { tipo: 'impostaRegole', regole }, { chiudi: true });
    };
    return [
      el('button', {
        type: 'button', class: 'btn btn--quieto', text: 'Regole classiche',
        onclick: () => {
          ctx.scelte = { ...PREDEFINITE };
          for (const def of REGOLE) {
            const i = def.valori.findIndex((v) => v.valore === def.predefinito);
            const input = ctx.corpoEl.querySelector(`input[name="regola-${def.chiave}"][value="${i}"]`);
            if (input) input.checked = true;
          }
          ctx.annuncia('Rimesse le regole classiche');
        },
      }),
      el('button', { type: 'button', class: `btn${ctx.dati.avvia ? ' btn--quieto' : ' btn--primario'}`, 'data-chiave': 'reg-salva', text: 'Salva le regole', onclick: conferma(false) }),
      pulsante({
        testo: 'Salva e avvia la partita', chiave: 'reg-avvia', primario: Boolean(ctx.dati.avvia),
        motivo: connessi < 2 ? 'Servono almeno 2 giocatori connessi' : null,
        onclick: conferma(true),
      }),
    ];
  },
  focusIniziale: (ctx) => ctx.corpoEl.querySelector('input:checked') || ctx.piedeEl.querySelector('.btn'),
};

// --- Carta pescata ---------------------------------------------------------

TIPI.carta = {
  classe: 'dlg--stretto',
  titolo: (ctx) => (ctx.dati.mazzo === 'imprevisti' ? 'Imprevisti' : 'Probabilità'),
  corpo(ctx) {
    const carta = ctx.dati.carta || {};
    const mazzo = ctx.dati.mazzo || carta.mazzo || 'probabilita';
    return el('figure', { class: `carta-pescata carta-pescata--${mazzo}` },
      el('span', { class: 'carta-pescata__segno', 'aria-hidden': 'true', text: mazzo === 'imprevisti' ? '!' : '?' }),
      el('blockquote', { class: 'carta-pescata__testo', text: carta.testo || '' }),
      ctx.dati.chi ? el('figcaption', { class: 'testo-secondario', text: `Pescata da ${ctx.dati.chi}` }) : null);
  },
  piede: (ctx) => [chiudiPulsante(ctx, 'Ho capito', { primario: true })],
};

// --- Fine partita -----------------------------------------------------------

TIPI.finePartita = {
  classe: 'dlg--medio dlg--finale',
  titolo: () => 'Partita finita',
  corpo(ctx) {
    const p = ctx.p;
    if (!p) return null;
    const vincitore = giocatoreDa(p, p.vincitoreId || (ctx.dati.vincitore && ctx.dati.vincitore.id));
    const ordine = classifica(p);
    // Chi ha abbandonato (o è stato tolto) non ha fatto bancarotta.
    const ritirati = new Set((p.log || []).filter((e) => e.tipo === 'abbandono').map((e) => e.giocatoreId));
    return [
      vincitore ? el('div', { class: 'vincitore', style: { '--colore': vincitore.colore } },
        el('span', { class: 'vincitore__corona', 'aria-hidden': 'true' }),
        el('p', { class: 'vincitore__nome', text: vincitore.id === ctx.mio ? 'Hai vinto!' : `Vince ${vincitore.nome}` }),
        el('p', { class: 'vincitore__dettaglio', text: `con un patrimonio di ${euro(patrimonio(p, vincitore.id))}` })) : null,
      el('h3', { class: 'sottotitolo', text: 'Classifica' }),
      el('ol', { class: 'classifica' }, ordine.map((g) => el('li', { class: `classifica__voce${g.fallito ? ' classifica__voce--fallito' : ''}${g.id === ctx.mio ? ' classifica__voce--mia' : ''}` },
        pallino(g.colore),
        el('span', { class: 'classifica__nome', text: g.id === ctx.mio ? `${g.nome} (tu)` : g.nome }),
        el('span', { class: 'classifica__valore', text: g.fallito ? (ritirati.has(g.id) ? 'ha abbandonato' : 'bancarotta') : euro(patrimonio(p, g.id)) })))),
      el('p', { class: 'testo-secondario', text: 'Il patrimonio conta denaro, proprietà al prezzo di listino (metà se ipotecate) e case al costo di costruzione.' }),
    ];
  },
  piede: (ctx) => [chiudiPulsante(ctx, 'Chiudi', { primario: true })],
};

// ===========================================================================
// Notifiche brevi (#toast)
// ===========================================================================

const DURATA_TOAST = 4000;

/**
 * Mostra una notifica non modale nel contenitore #toast (role=status).
 * Con `silenzioso` la notifica è solo visiva (aria-hidden, senza pulsante di
 * chiusura): serve per gli eventi che gli screen reader sentono già dalla
 * cronaca, così non vengono letti due volte.
 * @param {string} testo
 * @param {{ livello?: 'info'|'successo'|'avviso'|'errore', durata?: number, silenzioso?: boolean }} opzioni
 */
export function toast(testo, { livello = 'info', durata = DURATA_TOAST, silenzioso = false } = {}) {
  const box = document.getElementById('toast');
  if (!box || !testo) return;
  // Lo stesso messaggio già a schermo non si ripete.
  if ([...box.querySelectorAll('.toast__testo')].some((n) => n.textContent === testo)) return;
  const voce = el('div', { class: `toast toast--${livello}`, 'aria-hidden': silenzioso ? 'true' : null },
    el('span', { class: 'toast__testo', text: testo }));
  const chiudi = () => {
    voce.classList.add('toast--uscita');
    setTimeout(() => voce.remove(), 220);
  };
  if (silenzioso) {
    // Niente elementi focalizzabili dentro un nodo aria-hidden: si chiude con un clic.
    voce.addEventListener('click', chiudi);
  } else {
    voce.append(el('button', { type: 'button', class: 'toast__chiudi', 'aria-label': 'Chiudi la notifica', onclick: chiudi },
      el('span', { 'aria-hidden': 'true', text: '×' })));
  }
  box.append(voce);
  // Al massimo tre insieme: di più coprivano un terzo del tabellone.
  while (box.children.length > 3) box.firstElementChild.remove();
  let timer = setTimeout(chiudi, durata);
  const pausa = () => clearTimeout(timer);
  const riprendi = () => { clearTimeout(timer); timer = setTimeout(chiudi, 1500); };
  voce.addEventListener('mouseenter', pausa);
  voce.addEventListener('mouseleave', riprendi);
  voce.addEventListener('focusin', pausa);
  voce.addEventListener('focusout', riprendi);
}
