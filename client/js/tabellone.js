/**
 * client/js/tabellone.js
 *
 * Disegno del tabellone in #tabellone (INTERFACCE.md §4.4).
 *
 *   render(radice, stato, opzioni)  costruisce il DOM una volta sola
 *   aggiorna(stato)                 applica le differenze senza ricostruire
 *
 * Il tabellone è una griglia CSS 11x11: le 40 caselle stanno sul bordo (gli
 * angoli sono più grandi, rapporto RAPPORTO_ANGOLO), al centro ci sono il
 * turno, i dadi e i mazzi Probabilità/Imprevisti. Le pedine vivono in uno
 * strato sovrapposto e si muovono casella per casella.
 *
 * Il tabellone è un oggetto 3D fatto con le trasformazioni CSS: il piano di
 * gioco è inclinato (`--tilt`) e ruotato (`--giro`) dentro una scena con
 * prospettiva; pedine, case e alberghi sono sagome che stanno in piedi sul
 * piano e guardano sempre verso chi gioca; i dadi sono cubi veri. La "camera"
 * (vedi sezione Camera) segue la pedina di turno, si può ruotare di lato in
 * lato, avvicinare e mettere a perpendicolo (vista dall'alto).
 *
 * Ogni casella è un <button class="casella" data-indice="N"> con aria-label
 * completo (nome, proprietario, costruzioni, ipoteca, affitto, pedine).
 * Al click / Enter / Space emette sulla radice l'evento DOM
 * `casella-selezionata` con detail { indice, casella }. Le frecce spostano il
 * focus fra le caselle (roving tabindex), Home/End vanno al Via e all'ultima.
 *
 * `stato` può essere lo StatoPartita (§1) oppure lo StatoClient (§4.2): in
 * quel caso si usano `stato.partita` e `stato.selezione`.
 */

import { suoni, attivi as suoniAttivi, imposta as impostaSuoni } from '/js/suoni.js';

/** "a" davanti a un nome: "ad Anna", "alla banca", "a Bruno". */
function aChi(nome) {
  const n = String(nome ?? '');
  if (n === 'la banca') return 'alla banca';
  return /^[aAàÀ]/.test(n) ? `ad ${n}` : `a ${n}`;
}


/** Preferenza "Animazioni veloci" (solo in questo browser). */
function veloci() {
  try { return localStorage.getItem(CHIAVE_VELOCE) === '1'; } catch { return false; }
}
function impostaVeloci(si) {
  try { localStorage.setItem(CHIAVE_VELOCE, si ? '1' : '0'); } catch { /* resta per questa pagina */ }
}

const RAPPORTO_ANGOLO = 1.6;            // lato dell'angolo / lato corto di una casella
const UNITA_TOTALI = 2 * RAPPORTO_ANGOLO + 9;
const NUMERO_CASELLE = 40;
const DURATA_DADI = 720;                // ms dell'animazione di lancio
const DURATA_CARTA_VISIBILE = 8000;     // ms prima che la carta pescata torni via da sola
const CHIAVE_VELOCE = 'monopoly.animazioni-veloci';
const FATTORE_VELOCE = 0.4;             // pedine più rapide con "Animazioni veloci"
const PASSO_MAX = 230;                  // ms per casella
const PASSO_MIN = 70;
const DURATA_MAX_PERCORSO = 2600;       // un giro lungo (carta "vai a") resta sotto i 2,6 s

const NOMI_MAZZO = { probabilita: 'Probabilità', imprevisti: 'Imprevisti' };
const PREFISSI_NOME = /^(vicolo|viale|via|corso|piazza|largo|bastioni|parco della|parco|stazione|società)\s+/i;

// Icone statiche (nessun dato utente: sicuro usarle con innerHTML).
const SVG = (corpo, extra = '') =>
  `<svg class="icona" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${extra}>${corpo}</svg>`;
const ICONE = {
  treno: SVG('<rect x="5" y="2.5" width="14" height="14.5" rx="3.2"/><path d="M5 9.5h14M9.5 2.5v7M14.5 2.5v7"/><circle cx="8.8" cy="13.2" r="1.1" class="pieno"/><circle cx="15.2" cy="13.2" r="1.1" class="pieno"/><path d="M8.5 21.5 10 17M15.5 21.5 14 17M7.5 20h9"/>'),
  lampadina: SVG('<path d="M9.2 17.5h5.6M10 20.8h4"/><path d="M12 2.8a6.2 6.2 0 0 0-3.7 11.2c.7.5 1 1.2 1 2v.6h5.4V16c0-.8.3-1.5 1-2A6.2 6.2 0 0 0 12 2.8z"/><path d="M12 7v4l-1.6 1.5"/>'),
  goccia: SVG('<path d="M12 2.8s-6.3 6.8-6.3 11.6a6.3 6.3 0 0 0 12.6 0C18.3 9.6 12 2.8 12 2.8z"/><path d="M9 14.6a3 3 0 0 0 3 3"/>'),
  moneta: SVG('<circle cx="12" cy="12" r="8.6"/><path d="M15.4 8.6a4.2 4.2 0 1 0 0 6.8M7.4 10.9h6.4M7.4 13.3h6.4"/>'),
  diamante: SVG('<path d="M6.5 4h11l3.8 5.2L12 20.5 2.7 9.2z"/><path d="M2.7 9.2h18.6M9.3 4 12 20.5 14.7 4M7.2 9.2 9.3 4M16.8 9.2 14.7 4"/>'),
  auto: SVG('<path d="M5.2 11 7 6.3c.2-.5.7-.8 1.2-.8h7.6c.5 0 1 .3 1.2.8l1.8 4.7"/><rect x="2.8" y="11" width="18.4" height="6" rx="1.8"/><circle cx="7.3" cy="17.6" r="1.9" class="pieno"/><circle cx="16.7" cy="17.6" r="1.9" class="pieno"/><path d="M6 14h1.6M16.4 14H18"/>'),
  manette: SVG('<circle cx="7" cy="15.5" r="4"/><circle cx="17" cy="15.5" r="4"/><path d="M7 11.5V8.2M17 11.5V8.2M5.2 8.2h3.6M15.2 8.2h3.6M8.8 6.5c1-2 5.4-2 6.4 0"/>'),
  freccia: SVG('<path d="M21 12H4.5M11 5.5 4.5 12l6.5 6.5"/>'),
};
// Sagome in piedi sul tabellone: due facce (fronte e fianco) per dare volume.
const SVG_CASA = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="e-fianco" d="M15.5 10.5 22 7.2v11L15.5 22z"/><path class="e-fronte" d="M3 10.5h12.5V22H3z"/><path class="e-tetto-fianco" d="M9.2 3 15.6.6 23 7.2l-6.4 3.6z"/><path class="e-tetto" d="M1.6 10.9 9.2 3l7.6 7.9z"/><path class="e-porta" d="M7.4 22v-5.6h3.6V22z"/></svg>';
const SVG_ALBERGO = '<svg viewBox="0 0 36 28" aria-hidden="true" focusable="false"><path class="e-fianco" d="M26 11.5 34 8v14.5L26 27z"/><path class="e-fronte" d="M3 11.5h23V27H3z"/><path class="e-tetto-fianco" d="M9.5 3 18 .6 35 8l-8.5 3.8z"/><path class="e-tetto" d="M1.4 12 9.5 3h9.8l7.9 9z"/><path class="e-porta" d="M12.4 27v-6.4h4.4V27zM6 15.5h3.4v3.2H6zm13.8 0h3.4v3.2h-3.4z"/></svg>';
/**
 * La pedina: un birillo tornito e laccato (base a disco, corpo a campana,
 * collare, testa a sfera). Il colore del giocatore è `currentColor`; luci e
 * ombre sono sfumature bianche e nere sovrapposte, uguali per tutti i colori.
 * Gli id delle sfumature sono diversi per ogni pedina.
 */
let contaPedine = 0;
function svgPedina() {
  contaPedine += 1;
  const k = contaPedine;
  const base = 'M4 49.5v4c0 3.3 7.2 6 16 6s16-2.7 16-6v-4z';
  const corpo = 'M14.6 29.5c-.2 9.5-3.4 14.5-8 19.2 0 2.4 6 4.3 13.4 4.3s13.4-1.9 13.4-4.3c-4.6-4.7-7.8-9.7-8-19.2z';
  const collare = 'x="10.8" y="26" width="18.4" height="5.4" rx="2.7"';
  const testa = 'cx="20" cy="15.5" r="11.5"';
  return `<svg viewBox="0 0 40 60" aria-hidden="true" focusable="false"><defs>`
    + `<linearGradient id="p-lato-${k}" x1="0" x2="1" y1="0" y2="0">`
    + '<stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset=".17" stop-color="#fff" stop-opacity=".45"/>'
    + '<stop offset=".36" stop-color="#fff" stop-opacity=".05"/><stop offset=".62" stop-color="#000" stop-opacity=".14"/>'
    + '<stop offset=".88" stop-color="#000" stop-opacity=".5"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>'
    + `<radialGradient id="p-sfera-${k}" cx=".36" cy=".3" r=".82">`
    + '<stop offset="0" stop-color="#fff" stop-opacity=".72"/><stop offset=".26" stop-color="#fff" stop-opacity=".14"/>'
    + '<stop offset=".58" stop-color="#000" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity=".58"/></radialGradient>'
    + `<linearGradient id="p-sotto-${k}" x1="0" x2="0" y1="0" y2="1">`
    + '<stop offset="0" stop-color="#000" stop-opacity=".42"/><stop offset=".3" stop-color="#000" stop-opacity="0"/>'
    + '<stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient>'
    + '</defs>'
    + `<path class="p-col" d="${base}"/><path fill="url(#p-lato-${k})" d="${base}"/>`
    + '<ellipse class="p-col" cx="20" cy="49.5" rx="16" ry="5.2"/><ellipse class="p-piano" cx="20" cy="49.5" rx="16" ry="5.2"/>'
    + '<ellipse class="p-contatto" cx="20" cy="49.2" rx="13.6" ry="4.2"/>'
    + `<path class="p-col" d="${corpo}"/><path fill="url(#p-lato-${k})" d="${corpo}"/><path fill="url(#p-sotto-${k})" d="${corpo}"/>`
    + `<circle class="p-col" ${testa}/><circle fill="url(#p-sfera-${k})" ${testa}/>`
    + `<rect class="p-col" ${collare}/><rect fill="url(#p-lato-${k})" ${collare}/><rect class="p-piano" x="12.5" y="26.5" width="15" height="1.3" rx=".65"/>`
    + '<ellipse class="p-luce" cx="13.6" cy="8.2" rx="2.3" ry="1.2" transform="rotate(-38 13.6 8.2)"/>'
    + '</svg>';
}

const ICONE_CAMERA = {
  sinistra: SVG('<path d="M4 4v6h6"/><path d="M4.6 10A8 8 0 1 1 6 17.5"/>'),
  destra: SVG('<path d="M20 4v6h-6"/><path d="M19.4 10A8 8 0 1 0 18 17.5"/>'),
  alto: SVG('<rect x="4" y="4" width="16" height="16" rx="1.5"/><rect x="8.5" y="8.5" width="7" height="7"/>'),
  zoom: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.8v5.4M7.8 10.5h5.4"/>'),
  veloce: SVG('<path d="M4 6.5v11l7-5.5zM12 6.5v11l7-5.5z" class="pieno"/>'),
  suono: SVG('<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" class="pieno"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  segui: SVG('<circle cx="12" cy="12" r="3.2" class="pieno"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="7.2"/>'),
};
const CHIAVE_CAMERA = 'monopoly.camera';
const TILT_3D = 54;                     // gradi di inclinazione del piano
const ZOOM_VICINO = 1.75;               // il pulsante "Avvicina"
const ZOOM_MIN = 1;                     // con due dita si va da qui…
const ZOOM_MAX = 3.2;                   // …a qui
const BORDO_DAVANTI = 0.3886;           // bordo vicino sotto il centro (più un margine), in lati, a zoom 1
const PASSO_CONSEGNA = 160;              // ms fra un contratto e il successivo, alla consegna iniziale
const VOLO_CONSEGNA = 560;               // ms di volo di un contratto dato all'inizio
const VOLO_ACQUISTO = 820;               // ms di volo del contratto di un acquisto
const CHIAVE_CONSEGNA = 'monopoly.consegna';
const SCATTO_GIRO = 14;                 // gradi: lasciando vicino a un lato, il tabellone si raddrizza

/** Istanza corrente (il client ha un solo tabellone). */
let corrente = null;
/** Render in attesa dei dati caselle (import dinamico): conserva l'ultimo stato. */
let inAttesa = null;

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------

/**
 * Costruisce il tabellone nel contenitore dato. Richiamarlo ricostruisce tutto.
 *
 * @param {HTMLElement} radice  Contenitore #tabellone.
 * @param {object} stato        StatoPartita (o StatoClient con `partita`).
 * @param {{
 *   caselle?: object[], gruppi?: object, mioId?: string|null,
 *   animazioni?: boolean,
 *   onCasellaSelezionata?: (indice: number, casella: object) => void,
 * }} [opzioni]
 * @returns {{ aggiorna: (stato: object) => void, seleziona: (indice: number|null) => void, distruggi: () => void }}
 */
export function render(radice, stato, opzioni = {}) {
  if (!radice) throw new TypeError('tabellone.render: radice mancante');
  if (corrente) distruggi();
  inAttesa = null;

  const { partita, selezione } = normalizza(stato);
  const caselle = opzioni.caselle || (partita && partita.caselle) || null;

  if (!caselle) {
    // Dati non passati: li carichiamo dal modulo generato dal server e ridisegniamo.
    const richiesta = {};
    inAttesa = { richiesta, stato };
    radice.replaceChildren(testoCaricamento());
    import('/dati/tabellone.js')
      .then((dati) => {
        if (!inAttesa || inAttesa.richiesta !== richiesta) return; // superata da un altro render
        const ultimo = inAttesa.stato;
        inAttesa = null;
        render(radice, ultimo, { ...opzioni, caselle: dati.CASELLE, gruppi: opzioni.gruppi || dati.GRUPPI });
      })
      .catch(() => {
        radice.replaceChildren(testoCaricamento('Impossibile caricare il tabellone. Ricarica la pagina.'));
      });
    return { aggiorna, seleziona, distruggi };
  }

  const gruppi = opzioni.gruppi || (partita && partita.gruppi) || {};
  const ist = {
    radice,
    opzioni,
    caselle,
    gruppi,
    mioId: opzioni.mioId ?? null,
    el: {},
    pulsanti: [],
    pedine: new Map(),            // giocatoreId -> elemento
    prec: null,                   // ultimo StatoPartita applicato
    chiaveDadi: null,
    chiaveCarta: null,
    timerDadi: null,
    animazioni: new Map(),        // giocatoreId -> token di annullamento
    selezione: null,
    focoIndice: 0,
    ascoltatori: [],
    camera: leggiCamera(),
    fineAnimazione: 0,            // istante (performance.now) in cui dadi e pedine si fermano
    festa: false,
    inConsegna: new Set(),     // caselle il cui contratto iniziale è ancora in volo
    lato: 0,                      // lato del tabellone in px
    osservatore: null,
  };
  corrente = ist;

  costruisci(ist);
  if (selezione !== undefined) ist.selezione = selezione;
  applica(ist, partita, { iniziale: true });
  return { aggiorna, seleziona, distruggi };
}

/**
 * Aggiorna il tabellone già disegnato con il nuovo stato: pedine (animate),
 * proprietari, case/alberghi, ipoteche, dadi, carta pescata, turno.
 *
 * @param {object} stato  StatoPartita (o StatoClient con `partita`).
 */
export function aggiorna(stato) {
  if (inAttesa) inAttesa.stato = stato;
  const ist = corrente;
  if (!ist || !ist.el.griglia) return;
  const { partita, selezione } = normalizza(stato);
  if (selezione !== undefined && selezione !== ist.selezione) {
    ist.selezione = selezione;
    disegnaSelezione(ist);
  }
  if (!partita) return;
  if (ist.prec && typeof partita.versione === 'number' && typeof ist.prec.versione === 'number'
      && partita.versione < ist.prec.versione) return; // stato vecchio: ignorato (§1.1)
  applica(ist, partita, { iniziale: false });
}

/**
 * Millisecondi che mancano alla fine delle animazioni in corso (lancio dei
 * dadi e cammino delle pedine). Chi mostra le conseguenze di una mossa
 * (finestra d'acquisto, messaggi, denaro) aspetta questo tempo, così non
 * arrivano prima della pedina.
 */
export function attesa() {
  const ist = corrente;
  if (!ist) return 0;
  return Math.max(0, Math.round(ist.fineAnimazione - performance.now()));
}

function prolungaAttesa(ist, ms) {
  ist.fineAnimazione = Math.max(ist.fineAnimazione, performance.now() + ms);
}

/** Evidenzia una casella (o nessuna con null) senza emettere eventi. */
export function seleziona(indice) {
  const ist = corrente;
  if (!ist) return;
  ist.selezione = Number.isInteger(indice) ? indice : null;
  disegnaSelezione(ist);
}

/**
 * Mette in luce le caselle e la pedina di un giocatore (null: nessuno): le
 * altre caselle si abbassano. Lo chiama app.js quando nel pannello si passa
 * su un giocatore.
 */
export function evidenzia(giocatoreId) {
  const ist = corrente;
  if (!ist || !ist.el.tab) return;
  ist.inLuce = giocatoreId || null;
  disegnaLuce(ist);
}

function disegnaLuce(ist) {
  const id = ist.inLuce || null;
  let quante = 0;
  ist.pulsanti.forEach((b) => {
    const sua = id !== null && b.dataset.proprietario === id;
    if (sua) quante += 1;
    b.classList.toggle('in-luce', sua);
  });
  ist.el.tab.classList.toggle('tab--luce', quante > 0);
  ist.pedine.forEach((pedina, gid) => pedina.classList.toggle('pedina--in-luce', gid === id));
}

/** Smonta il tabellone: ferma animazioni e rimuove gli ascoltatori. */
export function distruggi() {
  const ist = corrente;
  if (!ist) return;
  ist.animazioni.forEach((token) => { token.annullato = true; });
  clearTimeout(ist.timerDadi);
  clearTimeout(ist.timerCarta);
  clearTimeout(ist.timerRiponiCarta);
  clearTimeout(ist.timerCamera);
  clearTimeout(ist.timerCentro);
  ist.ascoltatori.forEach(([el, tipo, fn]) => el.removeEventListener(tipo, fn));
  if (ist.osservatore) ist.osservatore.disconnect();
  if (ist.el.tab && ist.el.tab.parentNode === ist.radice) ist.radice.removeChild(ist.el.tab);
  corrente = null;
}

// ---------------------------------------------------------------------------
// Normalizzazione dell'input
// ---------------------------------------------------------------------------

function normalizza(stato) {
  if (!stato || typeof stato !== 'object') return { partita: null, selezione: undefined };
  if ('partita' in stato && !('giocatori' in stato)) {
    return { partita: stato.partita || null, selezione: stato.selezione ?? null };
  }
  return { partita: stato, selezione: undefined };
}

function testoCaricamento(testo = 'Caricamento del tabellone…') {
  const p = document.createElement('p');
  p.className = 'tab-caricamento';
  p.textContent = testo;
  return p;
}

// ---------------------------------------------------------------------------
// Geometria: indice -> riga/colonna della griglia 11x11 e lato
// ---------------------------------------------------------------------------

/** Riga e colonna (0-10) della casella e lato del tabellone su cui sta. */
export function coordinate(indice) {
  const i = ((indice % NUMERO_CASELLE) + NUMERO_CASELLE) % NUMERO_CASELLE;
  if (i === 0) return { riga: 10, colonna: 10, lato: 'angolo' };
  if (i < 10) return { riga: 10, colonna: 10 - i, lato: 'sud' };
  if (i === 10) return { riga: 10, colonna: 0, lato: 'angolo' };
  if (i < 20) return { riga: 20 - i, colonna: 0, lato: 'ovest' };
  if (i === 20) return { riga: 0, colonna: 0, lato: 'angolo' };
  if (i < 30) return { riga: 0, colonna: i - 20, lato: 'nord' };
  if (i === 30) return { riga: 0, colonna: 10, lato: 'angolo' };
  return { riga: i - 30, colonna: 10, lato: 'est' };
}

/** Inizio e ampiezza (in unità) della traccia n-esima della griglia. */
function traccia(n) {
  if (n === 0) return { inizio: 0, ampiezza: RAPPORTO_ANGOLO };
  if (n === 10) return { inizio: RAPPORTO_ANGOLO + 9, ampiezza: RAPPORTO_ANGOLO };
  return { inizio: RAPPORTO_ANGOLO + n - 1, ampiezza: 1 };
}

/** Centro della casella in unità di griglia. */
function centroCasella(indice) {
  const { riga, colonna } = coordinate(indice);
  const c = traccia(colonna);
  const r = traccia(riga);
  return { x: c.inizio + c.ampiezza / 2, y: r.inizio + r.ampiezza / 2 };
}

const INDICE_DA_CELLA = new Map();
for (let i = 0; i < NUMERO_CASELLE; i += 1) {
  const { riga, colonna } = coordinate(i);
  INDICE_DA_CELLA.set(`${riga},${colonna}`, i);
}

// ---------------------------------------------------------------------------
// Costruzione del DOM
// ---------------------------------------------------------------------------

function el(tag, classe, testo) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (testo != null) e.textContent = testo;
  return e;
}

/** 1500 → "1.500 €": stessa regola di dialoghi.js, app.js e del server. */
function euro(n) {
  const v = Math.round(Number(n) || 0);
  const cifre = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0 ? '−' : ''}${cifre} €`;
}

function nomeBreve(nome) {
  const breve = nome.replace(PREFISSI_NOME, '').replace(/^dei\s+/i, '');
  return breve || nome;
}

function costruisci(ist) {
  const { radice } = ist;
  const tab = el('div', 'tab');
  tab.style.setProperty('--tab-angolo', String(RAPPORTO_ANGOLO));

  const griglia = el('div', 'tab__griglia');
  griglia.setAttribute('role', 'group');
  griglia.setAttribute('aria-label', 'Caselle del tabellone. Usa le frecce per spostarti, Invio per i dettagli.');

  ist.caselle.forEach((c, i) => {
    const b = creaCasella(ist, c, i);
    ist.pulsanti[i] = b;
    griglia.appendChild(b);
  });

  const centro = creaCentro(ist);
  griglia.appendChild(centro);

  const edifici = el('div', 'tab__edifici');
  edifici.setAttribute('aria-hidden', 'true');
  griglia.appendChild(edifici);

  const strato = el('div', 'tab__pedine');
  strato.setAttribute('aria-hidden', 'true');
  griglia.appendChild(strato);

  // Scena 3D: prospettiva → camera (inclinazione e giro) → piano di gioco con il suo spessore.
  const scena = el('div', 'tab__scena');
  const camera = el('div', 'tab__camera');
  camera.appendChild(griglia);
  ['sud', 'ovest', 'nord', 'est'].forEach((lato) => {
    const fianco = el('span', `tab__fianco tab__fianco--${lato}`);
    fianco.setAttribute('aria-hidden', 'true');
    camera.appendChild(fianco);
  });
  const ombra = el('span', 'tab__ombra');
  ombra.setAttribute('aria-hidden', 'true');
  camera.appendChild(ombra);
  scena.appendChild(camera);
  tab.appendChild(scena);
  tab.appendChild(creaComandiCamera(ist));
  radice.replaceChildren(tab);

  ist.el.tab = tab;
  ist.el.scena = scena;
  ist.el.griglia = griglia;
  ist.el.strato = strato;
  ist.el.edifici = edifici;

  applicaCamera(ist);
  misura(ist);
  if (animazioniAttive(ist) && document.visibilityState === 'visible') {
    // Ingresso: il tabellone arriva sul tavolo ruotando, poi compaiono pedine e case.
    // (Con un timer e non con requestAnimationFrame, che in una scheda in secondo
    // piano non scatta e lascerebbe il tabellone invisibile.)
    tab.classList.add('tab--intro');
    void tab.offsetWidth;
    setTimeout(() => {
      tab.classList.add('tab--intro-via');
      tab.classList.remove('tab--intro');
      setTimeout(() => tab.classList.remove('tab--intro-via'), 1900);
    }, 40);
  }
  if (typeof ResizeObserver === 'function') {
    ist.osservatore = new ResizeObserver(() => misura(ist));
    ist.osservatore.observe(radice);
  }
  ascolta(ist, window, 'resize', () => misura(ist));
  trascinamento(ist, scena);

  ascolta(ist, griglia, 'click', (e) => {
    if (ist.trascinato) return; // era uno spostamento della vista, non un tocco
    const b = e.target.closest('.casella');
    if (b && griglia.contains(b)) scegli(ist, Number(b.dataset.indice));
  });
  // I dadi si toccano: quando tocca a te lanciare valgono come il pulsante
  // "Lancia i dadi" (decide app.js, che sa se il lancio è possibile).
  ascolta(ist, ist.el.zonaDadi, 'click', () => {
    if (ist.trascinato) return;
    radice.dispatchEvent(new CustomEvent('dadi-toccati', { bubbles: true }));
  });
  ascolta(ist, griglia, 'keydown', (e) => tastiera(ist, e));
  ascolta(ist, griglia, 'focusin', (e) => {
    const b = e.target.closest('.casella');
    if (b) impostaFoco(ist, Number(b.dataset.indice), false);
  });

  impostaFoco(ist, 0, false);
}

function ascolta(ist, bersaglio, tipo, fn) {
  bersaglio.addEventListener(tipo, fn);
  ist.ascoltatori.push([bersaglio, tipo, fn]);
}

function creaCasella(ist, c, i) {
  const { riga, colonna, lato } = coordinate(i);
  const b = el('button', `casella casella--${c.tipo} lato-${lato}`);
  b.type = 'button';
  b.dataset.indice = String(i);
  b.tabIndex = -1;
  b.style.gridRow = String(riga + 1);
  b.style.gridColumn = String(colonna + 1);

  // La "faccia" è il cartoncino della casella, girato come sul tabellone vero:
  // la fascia colore verso il centro, il testo leggibile da fuori.
  const faccia = el('span', 'casella__faccia');
  const gruppo = c.gruppo && ist.gruppi[c.gruppo];
  if (c.tipo === 'proprieta') {
    b.style.setProperty('--gruppo', (gruppo && gruppo.colore) || '#888888');
    const banda = el('span', 'casella__banda');
    banda.appendChild(el('span', 'casella__edifici'));
    faccia.appendChild(banda);
  }

  const testo = el('span', 'casella__testo');

  if (lato === 'angolo') {
    b.classList.add('angolo', `angolo--${c.tipo}`);
    riempiAngolo(testo, c);
  } else {
    const icona = iconaPer(c);
    if (icona) {
      const ic = el('span', 'casella__icona');
      ic.innerHTML = icona;
      testo.appendChild(ic);
      testo.classList.add('con-icona');
    }
    const nome = el('span', 'casella__nome');
    nome.appendChild(el('span', 'nome-lungo', c.nome));
    nome.appendChild(el('span', 'nome-breve', nomeBreve(c.nome)));
    testo.appendChild(nome);

    if (c.prezzo != null) testo.appendChild(el('span', 'casella__prezzo', euro(c.prezzo)));
    else if (c.importoTassa != null) testo.appendChild(el('span', 'casella__prezzo', `Paga ${euro(c.importoTassa)}`));
  }
  faccia.appendChild(testo);

  if (c.prezzo != null) {
    const prop = el('span', 'casella__proprietario');
    prop.hidden = true;
    prop.setAttribute('aria-hidden', 'true');
    faccia.appendChild(prop);
    const timbro = el('span', 'casella__timbro', 'Ipotecata');
    timbro.hidden = true;
    timbro.setAttribute('aria-hidden', 'true');
    faccia.appendChild(timbro);
  }
  b.appendChild(faccia);

  b.setAttribute('aria-label', c.nome);
  return b;
}

function iconaPer(c) {
  switch (c.tipo) {
    case 'stazione': return ICONE.treno;
    case 'societa': return /acqu/i.test(c.nome) ? ICONE.goccia : ICONE.lampadina;
    case 'tassa': return c.importoTassa != null && c.importoTassa < 200 ? ICONE.diamante : ICONE.moneta;
    case 'probabilita': return '<span class="glifo glifo--probabilita" aria-hidden="true">?</span>';
    case 'imprevisti': return '<span class="glifo glifo--imprevisti" aria-hidden="true">!</span>';
    default: return '';
  }
}

function riempiAngolo(testo, c) {
  const ic = el('span', 'casella__icona');
  switch (c.tipo) {
    case 'via': {
      testo.appendChild(el('span', 'angolo__piccolo', 'Ritirate 200 € passando dal'));
      testo.appendChild(el('span', 'angolo__titolo', 'Via!'));
      ic.innerHTML = ICONE.freccia;
      ic.classList.add('freccia-via');
      testo.appendChild(ic);
      break;
    }
    case 'prigione': {
      const cella = el('span', 'prigione__cella');
      cella.appendChild(el('span', 'prigione__sbarre'));
      cella.appendChild(el('span', 'prigione__scritta', 'Prigione'));
      testo.appendChild(cella);
      testo.appendChild(el('span', 'prigione__transito', 'Transito'));
      break;
    }
    case 'parcheggio': {
      ic.innerHTML = ICONE.auto;
      testo.appendChild(el('span', 'angolo__piccolo', 'Parcheggio'));
      testo.appendChild(ic);
      testo.appendChild(el('span', 'angolo__titolo', 'gratuito'));
      break;
    }
    case 'vaiInPrigione': {
      ic.innerHTML = ICONE.manette;
      testo.appendChild(el('span', 'angolo__piccolo', 'Andate'));
      testo.appendChild(ic);
      testo.appendChild(el('span', 'angolo__titolo', c.nome));
      break;
    }
    default:
      testo.appendChild(el('span', 'angolo__titolo', c.nome));
  }
}

function creaCentro(ist) {
  const centro = el('div', 'tab__centro');

  const turno = el('div', 'tab-turno');
  const riga = el('p', 'tab-turno__chi');
  const segno = el('span', 'tab-turno__segno');
  segno.setAttribute('aria-hidden', 'true');
  const nome = el('span', 'tab-turno__nome');
  riga.append(segno, nome);
  const fase = el('p', 'tab-turno__fase');
  const numero = el('p', 'tab-turno__numero');
  turno.append(riga, fase, numero);
  turno.setAttribute('aria-live', 'off');

  const zonaDadi = el('div', 'tab-dadi');
  zonaDadi.setAttribute('role', 'img');
  const dadi = [creaDado(), creaDado()];
  const totale = el('span', 'tab-dadi__totale');
  totale.setAttribute('aria-hidden', 'true');
  zonaDadi.append(dadi[0], dadi[1], totale);

  const mazzi = el('div', 'tab-mazzi');
  const mazzoP = creaMazzo('probabilita');
  const mazzoI = creaMazzo('imprevisti');
  mazzi.append(mazzoP, mazzoI);

  const carta = el('article', 'tab-carta');
  carta.hidden = true;
  carta.setAttribute('aria-label', 'Carta pescata');
  const cartaTesta = el('p', 'tab-carta__mazzo');
  const cartaGlifo = el('span', 'glifo');
  cartaGlifo.setAttribute('aria-hidden', 'true');
  const cartaMazzo = el('span', 'tab-carta__nome-mazzo');
  cartaTesta.append(cartaGlifo, cartaMazzo);
  const cartaTesto = el('p', 'tab-carta__testo');
  const cartaChi = el('p', 'tab-carta__chi');
  carta.append(cartaTesta, cartaTesto, cartaChi);
  mazzi.appendChild(carta);

  const codice = el('p', 'tab-centro__codice');

  const dritto = el('div', 'tab__centro-dritto');
  dritto.append(turno, zonaDadi, mazzi, codice);
  centro.appendChild(dritto);
  Object.assign(ist.el, {
    centro, turnoSegno: segno, turnoNome: nome, turnoFase: fase, turnoNumero: numero,
    zonaDadi, dadi, totale, mazzoP, mazzoI, carta, cartaGlifo, cartaMazzo, cartaTesto, cartaChi, codice,
  });
  return centro;
}

/** Un dado è un cubo: 6 facce con i puntini, girato per mostrare in alto il valore. */
function creaDado() {
  const d = el('span', 'dado');
  d.dataset.valore = '0';
  const cubo = el('span', 'dado__cubo');
  for (let n = 1; n <= 6; n += 1) {
    const f = el('span', `dado__faccia dado__faccia--${n}`);
    for (let k = 0; k < n; k += 1) f.appendChild(el('i'));
    cubo.appendChild(f);
  }
  d.appendChild(cubo);
  return d;
}

// Rotazione del cubo che porta in alto la faccia n (vedi le facce in tabellone.css).
const GIRO_DADO = {
  0: [0, 0], 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [180, 0],
};

function mostraDado(d, valore, giriExtra = 0) {
  d.dataset.valore = String(valore);
  const [x, y] = GIRO_DADO[valore] || GIRO_DADO[0];
  const cubo = d.firstElementChild;
  d.dataset.giri = String((Number(d.dataset.giri) || 0) + giriExtra);
  const giri = Number(d.dataset.giri) * 360;
  cubo.style.transform = `rotateX(${x + giri}deg) rotateY(${y + giri}deg)`;
}

function creaMazzo(mazzo) {
  const m = el('div', `tab-mazzo tab-mazzo--${mazzo}`);
  m.setAttribute('aria-hidden', 'true');
  const g = el('span', 'glifo', mazzo === 'probabilita' ? '?' : '!');
  m.append(g, el('span', 'tab-mazzo__nome', NOMI_MAZZO[mazzo]));
  return m;
}

// ---------------------------------------------------------------------------
// Applicazione dello stato
// ---------------------------------------------------------------------------

function applica(ist, partita, { iniziale }) {
  if (!partita) {
    ist.prec = null;
    disegnaSelezione(ist);
    return;
  }
  const giocatori = Array.isArray(partita.giocatori) ? partita.giocatori : [];
  const perId = new Map(giocatori.map((g) => [g.id, g]));
  const ctx = { partita, giocatori, perId };

  const lanciati = aggiornaDadi(ist, ctx, iniziale);
  if (lanciati) prolungaAttesa(ist, DURATA_DADI);
  aggiornaPedine(ist, ctx, iniziale, lanciati ? DURATA_DADI : 0);
  if (!iniziale) mostraMovimentiDenaro(ist, ctx);
  if (partita.fase === 'finePartita' && !ist.festa) {
    ist.festa = true;
    if (!iniziale) festeggia(ist);
  }
  // Proprietà iniziali: i contratti partono dal centro, uno per volta.
  const consegna = consegnaDaMostrare(ist, ctx);
  ist.inConsegna = new Set((consegna || []).map((v) => v.indice));
  aggiornaCaselle(ist, ctx);
  if (consegna) mostraConsegna(ist, consegna, iniziale ? 1500 : 250);
  // Il testo al centro ("Decide se comprare…") non anticipa dove arriverà la pedina.
  const daAspettare = iniziale ? 0 : attesa();
  clearTimeout(ist.timerCentro);
  if (daAspettare > 40) {
    ist.timerCentro = setTimeout(() => {
      if (corrente === ist && ist.prec === partita) aggiornaCentro(ist, ctx);
    }, daAspettare);
  } else {
    aggiornaCentro(ist, ctx);
  }
  aggiornaCarta(ist, ctx, iniziale);
  disegnaSelezione(ist);
  ist.prec = partita;
  seguiTurno(ist, ctx, lanciati ? DURATA_DADI : 0);
  if (iniziale) setTimeout(() => misura(ist), 0); // i pannelli arrivano dopo il tabellone
}

function animazioniAttive(ist) {
  if (ist.opzioni.animazioni === false) return false;
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

// --- caselle -----------------------------------------------------------------

function aggiornaCaselle(ist, { partita, perId, giocatori }) {
  const proprieta = partita.proprieta || {};
  const presenti = new Map();
  for (const g of giocatori) {
    if (g.fallito) continue;
    const pos = Number(g.posizione) || 0;
    if (!presenti.has(pos)) presenti.set(pos, []);
    presenti.get(pos).push(g);
  }

  ist.caselle.forEach((c, i) => {
    const b = ist.pulsanti[i];
    const p = proprieta[String(i)] || null;
    const prop = p && p.proprietario ? perId.get(p.proprietario) : null;
    const case_ = p ? Number(p.caseCostruite) || 0 : 0;
    const ipotecata = Boolean(p && p.ipotecata);

    // Proprietario: bordo colore + gettone con l'iniziale (non solo colore).
    const badge = b.querySelector('.casella__proprietario');
    if (badge) {
      const chiave = prop ? `${prop.id}|${prop.colore}|${prop.nome}` : '';
      if (badge.dataset.chiave !== chiave) {
        const eraDi = badge.dataset.chiave || '';
        badge.dataset.chiave = chiave;
        badge.hidden = !prop;
        if (prop) {
          badge.textContent = iniziale(prop.nome);
          badge.style.setProperty('--colore-giocatore', prop.colore);
          badge.style.color = testoSu(prop.colore);
          b.style.setProperty('--proprietario', prop.colore);
          b.dataset.proprietario = prop.id;
        } else {
          b.style.removeProperty('--proprietario');
          delete b.dataset.proprietario;
        }
        if (prop && ist.prec && animazioniAttive(ist) && !ist.inConsegna.has(i)) {
          if (!eraDi && document.visibilityState === 'visible') {
            // Comprata dalla banca: il contratto vola dal centro alla casella.
            volaAtto(ist, i, prop, { acquisto: true, mia: prop.id === ist.mioId });
          } else {
            b.classList.remove('appena-comprata');
            void b.offsetWidth; // riavvia l'animazione
            b.classList.add('appena-comprata');
            setTimeout(() => b.classList.remove('appena-comprata'), 1400);
          }
        }
        b.classList.toggle('posseduta', Boolean(prop));
        b.classList.toggle('mia', Boolean(prop && prop.id === ist.mioId));
      }
    }

    // Ipoteca: tratteggio + timbro "Ipotecata".
    const timbro = b.querySelector('.casella__timbro');
    if (timbro) {
      timbro.hidden = !ipotecata;
      b.classList.toggle('ipotecata', ipotecata);
    }

    // Case e albergo sulla banda.
    const edifici = b.querySelector('.casella__edifici');
    if (edifici && edifici.dataset.n !== String(case_)) {
      edifici.dataset.n = String(case_);
      b.classList.toggle('con-albergo', case_ >= 5);
      b.classList.toggle('con-case', case_ > 0 && case_ < 5);
      const cresciuto = b.dataset.caseVisti !== undefined && Number(b.dataset.caseVisti) < case_;
      if (cresciuto && ist.prec) suoni.costruisci();
      disegnaEdifici(ist, i, case_, cresciuto);
      b.dataset.caseVisti = String(case_);
    }

    const qui = presenti.get(i) || [];
    const etichetta = etichettaCasella(ist, c, i, { p, prop, case_, ipotecata, qui, partita });
    if (b.getAttribute('aria-label') !== etichetta) b.setAttribute('aria-label', etichetta);
    b.classList.toggle('turno-qui', qui.some((g) => partita.turno && g.id === partita.turno.giocatoreId));
  });
  if (ist.inLuce) disegnaLuce(ist);
}

// --- contratti che volano ----------------------------------------------------

/**
 * Le proprietà iniziali (regola "proprietà iniziali") da consegnare con
 * l'animazione: [{ g, indice }] a giro, una per giocatore, oppure null. Vale
 * una volta per partita e solo se nessuno ha ancora lanciato i dadi.
 */
function consegnaDaMostrare(ist, { partita, perId }) {
  const log = Array.isArray(partita.log) ? partita.log : [];
  let avvio = null;
  for (const e of log) if (e && e.tipo === 'partitaIniziata') avvio = e;
  if (!avvio) return null;
  const chiave = `${partita.codice || ''}|${avvio.t}`;
  if (ist.chiaveConsegna === chiave) return null;
  ist.chiaveConsegna = chiave;
  if (!animazioniAttive(ist) || document.visibilityState !== 'visible') return null;
  if (log.some((e) => e && (e.tipo === 'dadi' || e.tipo === 'lancioOrdine'))) return null;
  try {
    if (sessionStorage.getItem(CHIAVE_CONSEGNA) === chiave) return null; // già vista: pagina ricaricata
    sessionStorage.setItem(CHIAVE_CONSEGNA, chiave);
  } catch { /* senza archivio si rivede a ogni ricarica: pazienza */ }
  const mani = [];
  for (const e of log) {
    const g = e && e.tipo === 'proprietaIniziali' ? perId.get(e.giocatoreId) : null;
    if (g && e.dati && Array.isArray(e.dati.caselle)) mani.push(e.dati.caselle.map((indice) => ({ g, indice })));
  }
  const voci = [];
  for (let giro = 0; mani.some((m) => m.length > giro); giro += 1) {
    for (const m of mani) if (m[giro]) voci.push(m[giro]);
  }
  return voci.length ? voci : null;
}

function mostraConsegna(ist, voci, ritardo) {
  const passo = PASSO_CONSEGNA * (veloci() ? 0.6 : 1);
  voci.forEach(({ g, indice }, k) => {
    volaAtto(ist, indice, g, { ritardo: ritardo + k * passo, mia: g.id === ist.mioId });
  });
  prolungaAttesa(ist, ritardo + (voci.length - 1) * passo + VOLO_CONSEGNA + 250);
}

/**
 * Un contratto vola dal centro del tabellone (la banca) fino alla casella:
 * finché è in volo la casella non mostra il proprietario, poi lampeggia e la
 * linguetta sale. Per gli acquisti il volo è più alto e chiude con un'onda.
 */
function volaAtto(ist, indice, g, { ritardo = 0, mia = false, acquisto = false } = {}) {
  const b = ist.pulsanti[indice];
  if (!b) return;
  b.classList.add('in-consegna');
  const durata = (acquisto ? VOLO_ACQUISTO : VOLO_CONSEGNA) * (veloci() ? 0.7 : 1);
  const posa = () => {
    b.classList.remove('in-consegna', 'appena-comprata');
    void b.offsetWidth; // riavvia l'animazione
    b.classList.add('appena-comprata');
    setTimeout(() => b.classList.remove('appena-comprata'), 1400);
  };
  const parti = () => {
    if (corrente !== ist || b.dataset.proprietario !== g.id) {
      b.classList.remove('in-consegna'); // tabellone smontato o proprietà già passata di mano
      return;
    }
    const c = ist.caselle[indice];
    const gruppo = c && c.gruppo && ist.gruppi[c.gruppo];
    const atto = el('span', `tab-atto${mia ? ' tab-atto--mia' : ''}${acquisto ? ' tab-atto--acquisto' : ''}`);
    atto.style.setProperty('--gruppo', (gruppo && gruppo.colore) || '#4a6168');
    atto.style.setProperty('--colore-giocatore', g.colore);
    atto.style.setProperty('--volo', `${Math.round(durata)}ms`);
    atto.appendChild(el('span', 'tab-atto__carta'));
    atto.style.left = '50%';
    atto.style.top = '50%';
    ist.el.strato.appendChild(atto);
    void atto.offsetWidth;
    const meta = centroCasella(indice);
    atto.style.left = `${(meta.x / UNITA_TOTALI) * 100}%`;
    atto.style.top = `${(meta.y / UNITA_TOTALI) * 100}%`;
    atto.classList.add('in-volo');
    suoni.carta();
    setTimeout(() => {
      if (corrente !== ist) {
        atto.remove();
        return;
      }
      posa();
      if (acquisto || mia) {
        const onda = el('span', 'tab-onda');
        onda.style.left = atto.style.left;
        onda.style.top = atto.style.top;
        onda.style.setProperty('--colore', g.colore);
        ist.el.strato.appendChild(onda);
        setTimeout(() => onda.remove(), 1100);
      }
      if (acquisto) suoni.moneta();
      atto.classList.add('posato');
      setTimeout(() => atto.remove(), 320);
    }, durata);
  };
  if (ritardo > 0) setTimeout(parti, ritardo);
  else parti();
}

/** Punto (in unità) lungo la fascia colore della casella: k-esimo edificio di n. */
function puntoEdificio(indice, k, n) {
  const { lato } = coordinate(indice);
  const base = centroCasella(indice);
  const R = RAPPORTO_ANGOLO;
  const scarto = (k - (n - 1) / 2) * 0.22;
  const dentro = 0.22; // distanza dal bordo interno della casella
  if (lato === 'sud') return { x: base.x + scarto, y: R + 9 + dentro };
  if (lato === 'nord') return { x: base.x - scarto, y: R - dentro };
  if (lato === 'ovest') return { x: R - dentro, y: base.y + scarto };
  return { x: R + 9 + dentro, y: base.y - scarto };
}

/** Case (1-4) o albergo (5) in piedi sulla fascia colore della casella. */
function disegnaEdifici(ist, indice, quanti, cresciuto) {
  const strato = ist.el.edifici;
  strato.querySelectorAll(`[data-casella="${indice}"]`).forEach((e) => e.remove());
  const albergo = quanti >= 5;
  const n = albergo ? 1 : Math.max(0, quanti);
  for (let k = 0; k < n; k += 1) {
    const e = el('span', `edificio ${albergo ? 'albergo' : 'casa'}`);
    e.dataset.casella = String(indice);
    const sagoma = el('span', 'edificio__sagoma');
    sagoma.innerHTML = albergo ? SVG_ALBERGO : SVG_CASA;
    e.appendChild(sagoma);
    const punto = puntoEdificio(indice, k, n);
    e.style.left = `${(punto.x / UNITA_TOTALI) * 100}%`;
    e.style.top = `${(punto.y / UNITA_TOTALI) * 100}%`;
    if (cresciuto && (albergo || k === n - 1) && animazioniAttive(ist)) e.classList.add('nuovo');
    strato.appendChild(e);
  }
}

function etichettaCasella(ist, c, i, { p, prop, case_, ipotecata, qui, partita }) {
  const parti = [c.nome];
  const gruppo = c.gruppo && ist.gruppi[c.gruppo];
  if (c.tipo === 'proprieta' && gruppo) parti.push(`gruppo ${gruppo.nome}`);
  if (c.tipo === 'stazione') parti.push('stazione');
  if (c.tipo === 'societa') parti.push('società');

  if (c.prezzo != null) {
    if (!p || !p.proprietario) {
      parti.push(`in vendita a ${euro(c.prezzo)}`);
    } else {
      const chi = prop ? (prop.id === ist.mioId ? `${prop.nome} (tu)` : prop.nome) : 'sconosciuto';
      parti.push(`proprietario ${chi}`);
      if (case_ >= 5) parti.push('albergo');
      else if (case_ === 1) parti.push('1 casa');
      else if (case_ > 1) parti.push(`${case_} case`);
      if (ipotecata) parti.push('ipotecata, nessun affitto');
      else parti.push(descriviAffitto(ist, c, i, p, partita));
    }
  } else if (c.tipo === 'tassa' && c.importoTassa != null) {
    parti.push(`paga ${euro(c.importoTassa)}`);
  } else if (c.tipo === 'via') {
    parti.push('ritira 200 € passando');
  } else if (c.tipo === 'probabilita' || c.tipo === 'imprevisti') {
    parti.push('pesca una carta');
  } else if (c.tipo === 'vaiInPrigione') {
    parti.push('vai direttamente in prigione');
  }

  if (qui.length) {
    if (c.tipo === 'prigione') {
      const dentro = qui.filter((g) => g.inPrigione).map(nomePedina(ist));
      const fuori = qui.filter((g) => !g.inPrigione).map(nomePedina(ist));
      if (dentro.length) parti.push(`in prigione: ${elenco(dentro)}`);
      if (fuori.length) parti.push(`in transito: ${elenco(fuori)}`);
    } else {
      parti.push(`qui: ${elenco(qui.map(nomePedina(ist)))}`);
    }
  }
  return `${parti.join(', ')}.`;
}

function nomePedina(ist) {
  return (g) => (g.id === ist.mioId ? `${g.nome} (tu)` : g.nome);
}

function elenco(nomi) {
  if (nomi.length <= 1) return nomi.join('');
  return `${nomi.slice(0, -1).join(', ')} e ${nomi[nomi.length - 1]}`;
}

function descriviAffitto(ist, c, i, p, partita) {
  const proprieta = partita.proprieta || {};
  const stessoGruppo = ist.caselle.filter((x) => x.gruppo === c.gruppo);
  const possedute = stessoGruppo.filter((x) => {
    const q = proprieta[String(x.indice)];
    return q && q.proprietario === p.proprietario;
  });
  if (!Array.isArray(c.affitti)) return '';
  if (c.tipo === 'proprieta') {
    const case_ = Number(p.caseCostruite) || 0;
    let affitto = c.affitti[Math.min(case_, c.affitti.length - 1)];
    if (case_ === 0 && possedute.length === stessoGruppo.length) affitto *= 2;
    return `affitto ${euro(affitto)}`;
  }
  if (c.tipo === 'stazione') {
    const n = Math.max(1, possedute.length);
    return `affitto ${euro(c.affitti[Math.min(n, c.affitti.length) - 1])}`;
  }
  if (c.tipo === 'societa') {
    const n = Math.max(1, possedute.length);
    return `affitto ${c.affitti[Math.min(n, c.affitti.length) - 1]} volte i dadi`;
  }
  return '';
}

function iniziale(nome) {
  const s = String(nome || '?').trim();
  return (Array.from(s)[0] || '?').toLocaleUpperCase('it-IT');
}

/** Nero o bianco, quello con contrasto migliore sul colore dato. */
function testoSu(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const contrBianco = 1.05 / (L + 0.05);
  const contrNero = (L + 0.05) / 0.05;
  return contrNero >= contrBianco ? '#14231e' : '#ffffff';
}

// --- pedine -----------------------------------------------------------------

/** Posizioni a riposo (in unità) di tutte le pedine, raggruppate per casella. */
function posizioniARiposo(giocatori) {
  const gruppi = new Map();
  for (const g of giocatori) {
    if (g.fallito) continue;
    const pos = Number(g.posizione) || 0;
    const chiave = pos === 10 ? (g.inPrigione ? 'cella' : 'transito') : String(pos);
    if (!gruppi.has(chiave)) gruppi.set(chiave, []);
    gruppi.get(chiave).push(g);
  }
  const ris = new Map();
  for (const [chiave, lista] of gruppi) {
    lista.forEach((g, k) => ris.set(g.id, puntoNelGruppo(chiave, k, lista.length)));
  }
  return ris;
}

const DISPOSIZIONI = {
  1: [[0, 0]],
  2: [[0, -0.24], [0, 0.24]],
  3: [[-0.2, -0.36], [0.2, 0], [-0.2, 0.36]],
  4: [[-0.21, -0.22], [0.21, -0.22], [-0.21, 0.22], [0.21, 0.22]],
  5: [[-0.21, -0.42], [0.21, -0.42], [0, 0], [-0.21, 0.42], [0.21, 0.42]],
  6: [[-0.21, -0.42], [0.21, -0.42], [-0.21, 0], [0.21, 0], [-0.21, 0.42], [0.21, 0.42]],
};

function puntoNelGruppo(chiave, k, n) {
  const R = RAPPORTO_ANGOLO;
  if (chiave === 'cella') {
    // Cella della prigione: quadrato interno verso il centro del tabellone.
    const cx = 0.62 * R;
    const cy = R + 9 + 0.38 * R;
    const d = DISPOSIZIONI[Math.min(n, 6)][k % 6] || [0, 0];
    return { x: cx + d[1] * 0.85, y: cy + d[0] * 0.85 };
  }
  if (chiave === 'transito') {
    // Fascia esterna a L: prima in basso, poi sul lato sinistro.
    const passi = [[0.4, 0.88], [0.64, 0.88], [0.88, 0.88], [0.12, 0.88], [0.12, 0.62], [0.12, 0.36]];
    const [px, py] = passi[k % passi.length];
    return { x: px * R, y: R + 9 + py * R };
  }
  const indice = Number(chiave);
  const { lato } = coordinate(indice);
  const base = centroCasella(indice);
  const d = DISPOSIZIONI[Math.min(n, 6)][k % 6] || [0, 0];
  if (lato === 'angolo') return { x: base.x + d[1] * 0.9, y: base.y + d[0] * 0.9 };
  // Spostate leggermente verso il bordo esterno, lontano dalla banda colore.
  const spinta = 0.12;
  if (lato === 'sud') return { x: base.x + d[0], y: base.y + d[1] + spinta };
  if (lato === 'nord') return { x: base.x + d[0], y: base.y + d[1] - spinta };
  if (lato === 'ovest') return { x: base.x + d[1] - spinta, y: base.y + d[0] };
  return { x: base.x + d[1] + spinta, y: base.y + d[0] };
}

function aggiornaPedine(ist, { partita, giocatori, perId }, iniziale_, ritardo) {
  const strato = ist.el.strato;
  const riposo = posizioniARiposo(giocatori);
  const precPerId = new Map(((ist.prec && ist.prec.giocatori) || []).map((g) => [g.id, g]));
  const anima = !iniziale_ && animazioniAttive(ist);
  const diTurno = partita.turno ? partita.turno.giocatoreId : null;

  // Rimuove pedine di giocatori usciti o falliti.
  for (const [id, pedina] of ist.pedine) {
    const g = perId.get(id);
    if (!g || g.fallito) {
      const token = ist.animazioni.get(id);
      if (token) token.annullato = true;
      pedina.remove();
      ist.pedine.delete(id);
    }
  }

  giocatori.forEach((g, ordine) => {
    if (g.fallito) return;
    let pedina = ist.pedine.get(g.id);
    const nuova = !pedina;
    if (nuova) {
      pedina = el('span', 'pedina');
      const corpo = el('span', 'pedina__corpo');
      const figura = el('span', 'pedina__figura');
      figura.innerHTML = svgPedina();
      figura.appendChild(el('span', 'pedina__lettera'));
      corpo.appendChild(figura);
      pedina.appendChild(corpo);
      pedina.appendChild(el('span', 'pedina__ombra'));
      strato.appendChild(pedina);
      ist.pedine.set(g.id, pedina);
    }
    const lettera = pedina.querySelector('.pedina__lettera');
    lettera.textContent = iniziale(g.nome);
    pedina.style.setProperty('--colore-giocatore', g.colore);
    pedina.style.setProperty('--testo-giocatore', testoSu(g.colore));
    pedina.style.zIndex = String(10 + ordine);
    pedina.classList.toggle('di-turno', g.id === diTurno);
    pedina.classList.toggle('mia', g.id === ist.mioId);
    pedina.classList.toggle('disconnessa', g.connesso === false);
    pedina.classList.toggle('in-prigione', Boolean(g.inPrigione));
    pedina.title = g.nome;

    const finale = riposo.get(g.id);
    const gPrec = precPerId.get(g.id);
    const da = gPrec ? Number(gPrec.posizione) || 0 : null;
    const a = Number(g.posizione) || 0;

    if (nuova || !anima || da === null || da === a) {
      const inCorso = ist.animazioni.get(g.id);
      if (nuova || da !== a) {
        // Posizione cambiata senza animazione: salto diretto.
        if (inCorso) inCorso.annullato = true;
        posiziona(pedina, finale, nuova ? 0 : 180);
      } else if (inCorso) {
        // Sta ancora camminando: aggiorniamo solo la tappa finale (riassetto del gruppo).
        inCorso.finale = finale;
      } else {
        posiziona(pedina, finale, 180); // riassetto se altre pedine sono arrivate/partite
      }
      return;
    }
    const percorso = calcolaPercorso(da, a, gPrec, g, partita.log);
    if (g.inPrigione && !gPrec.inPrigione) arresta(ist, pedina, ritardo);
    avviaPercorso(ist, g.id, pedina, percorso, finale, ritardo);
  });
}

/**
 * Gli ultimi movimenti di `id` scritti nella cronaca che, messi in fila,
 * portano da `da` ad `a` (per esempio il lancio e poi la carta "Andate fino al
 * Via"): [{ da, a, passi }], oppure null se la cronaca non li racconta.
 */
function movimentiDalLog(log, id, da, a) {
  if (!Array.isArray(log)) return null;
  const mosse = [];
  let atteso = a;
  for (let k = log.length - 1; k >= 0 && mosse.length < 6; k -= 1) {
    const e = log[k];
    if (!e || e.tipo !== 'movimento' || e.giocatoreId !== id) continue;
    const d = e.dati || {};
    if (d.a !== atteso || !Number.isInteger(d.da) || !Number.isInteger(d.passi) || d.passi === 0) return null;
    mosse.unshift(d);
    if (d.da === da) return mosse;
    atteso = d.da;
  }
  return null;
}

/**
 * Le caselle su cui la pedina passa per andare da `da` ad `a` (l'ultima tappa,
 * la posizione a riposo, la aggiunge chi chiama). La strada è quella vera,
 * presa dai movimenti della cronaca: prima il lancio e poi l'eventuale carta,
 * in avanti anche per un giro quasi completo ("Andate fino al Via") e
 * all'indietro solo per "tre passi indietro". Senza cronaca si va per la via
 * più corta in avanti, o indietro se la casella è appena alle spalle.
 */
export function calcolaPercorso(da, a, gPrec, g, log) {
  if (g.inPrigione && !gPrec.inPrigione) return []; // "In prigione!": salto diretto
  const passi = [];
  const mosse = movimentiDalLog(log, g.id, da, a);
  if (mosse) {
    mosse.forEach((m, k) => {
      const verso = m.passi > 0 ? 1 : -1;
      const quanti = Math.min(NUMERO_CASELLE, Math.abs(m.passi));
      for (let n = 1; n <= quanti; n += 1) {
        passi.push((((m.da + verso * n) % NUMERO_CASELLE) + NUMERO_CASELLE) % NUMERO_CASELLE);
      }
      // L'arrivo dell'ultimo movimento è la posizione a riposo: non è una tappa intermedia.
      if (k === mosse.length - 1) passi.pop();
    });
    return passi;
  }
  const avanti = (a - da + NUMERO_CASELLE) % NUMERO_CASELLE;
  if (avanti > 28) {
    const indietro = NUMERO_CASELLE - avanti;
    for (let k = 1; k < indietro; k += 1) passi.push((da - k + NUMERO_CASELLE) % NUMERO_CASELLE);
  } else {
    for (let k = 1; k < avanti; k += 1) passi.push((da + k) % NUMERO_CASELLE);
  }
  return passi;
}

function attendi(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

async function avviaPercorso(ist, id, pedina, intermedie, finale, ritardo) {
  const vecchio = ist.animazioni.get(id);
  if (vecchio) vecchio.annullato = true;
  const token = { annullato: false, finale };
  ist.animazioni.set(id, token);

  const tappe = intermedie.length + 1;
  const fattore = veloci() ? FATTORE_VELOCE : 1;
  const passo = Math.max(PASSO_MIN * fattore, Math.min(PASSO_MAX * fattore, (DURATA_MAX_PERCORSO * fattore) / tappe));
  // Chi aspetta la fine del movimento (finestre, messaggi) conta anche l'atterraggio.
  prolungaAttesa(ist, (ritardo || 0) + tappe * passo + 220);
  pedina.classList.add('in-cammino');
  try {
    if (ritardo) await attendi(ritardo);
    for (const indice of intermedie) {
      if (token.annullato || corrente !== ist) return;
      posiziona(pedina, centroCasella(indice), passo * 0.9);
      saltella(pedina, passo);
      suoni.passo();
      await attendi(passo);
    }
    if (token.annullato || corrente !== ist) return;
    posiziona(pedina, token.finale, passo * 0.9);
    saltella(pedina, passo);
    await attendi(passo);
    if (token.annullato || corrente !== ist) return;
    atterra(pedina);
  } finally {
    if (ist.animazioni.get(id) === token) {
      ist.animazioni.delete(id);
      pedina.classList.remove('in-cammino');
    }
  }
}

/** Arrivo sulla casella: la pedina si schiaccia un attimo e parte un'onda sul piano. */
function atterra(pedina) {
  pedina.classList.remove('atterra');
  void pedina.offsetWidth;
  pedina.classList.add('atterra');
  suoni.atterra();
  setTimeout(() => pedina.classList.remove('atterra'), 700);
}

/** "In prigione!": la pedina cade nella cella e le sbarre tremano. */
function arresta(ist, pedina, ritardo) {
  prolungaAttesa(ist, (ritardo || 0) + 700);
  setTimeout(() => {
    if (corrente !== ist) return;
    const cella = ist.pulsanti[10];
    pedina.classList.remove('arrestata');
    cella.classList.remove('sbattuta');
    void pedina.offsetWidth;
    pedina.classList.add('arrestata');
    cella.classList.add('sbattuta');
    suoni.prigione();
    setTimeout(() => {
      pedina.classList.remove('arrestata');
      cella.classList.remove('sbattuta');
    }, 900);
  }, (ritardo || 0) + 120);
}

/** Per ogni giocatore il cui denaro è cambiato, un importo che sale sopra la pedina. */
function mostraMovimentiDenaro(ist, { giocatori }) {
  if (!ist.prec || !animazioniAttive(ist)) return;
  const prima = new Map((ist.prec.giocatori || []).map((g) => [g.id, g]));
  const cambi = [];
  for (const g of giocatori) {
    const p = prima.get(g.id);
    if (!p || g.fallito) continue;
    const delta = (Number(g.denaro) || 0) - (Number(p.denaro) || 0);
    if (delta !== 0) cambi.push({ g, delta });
  }
  if (!cambi.length) return;
  const ritardo = attesa();
  setTimeout(() => {
    if (corrente !== ist) return;
    let suonato = false;
    cambi.forEach(({ g, delta }, k) => {
      const pedina = ist.pedine.get(g.id);
      if (!pedina) return;
      const volo = el('span', `volo ${delta > 0 ? 'volo--entra' : 'volo--esce'}`);
      volo.style.setProperty('--colore', g.colore || '#888');
      volo.style.left = pedina.style.left;
      volo.style.top = pedina.style.top;
      const testo = el('span', 'volo__testo', `${delta > 0 ? '+' : '−'}${euro(Math.abs(delta))}`);
      testo.style.animationDelay = `${k * 120}ms`;
      volo.appendChild(testo);
      ist.el.strato.appendChild(volo);
      setTimeout(() => volo.remove(), 1900 + k * 120);
      // Un solo suono per aggiornamento: quello che riguarda me, altrimenti il primo.
      if (!suonato && (g.id === ist.mioId || cambi.every((c) => c.g.id !== ist.mioId))) {
        suonato = true;
        if (delta > 0) suoni.moneta(); else suoni.paga();
      }
    });
  }, ritardo);
}

/** Fine partita: coriandoli sopra il tabellone. */
function festeggia(ist) {
  const festa = el('div', 'tab__festa');
  festa.setAttribute('aria-hidden', 'true');
  const colori = ['#e03a30', '#f7d84a', '#2fa84f', '#1b56c4', '#f29a2e', '#d84a9c', '#9bd4f0', '#f7f0dc'];
  for (let k = 0; k < 90; k += 1) {
    const c = el('i');
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colori[k % colori.length];
    c.style.animationDelay = `${Math.random() * 1.8}s`;
    c.style.animationDuration = `${2.6 + Math.random() * 2.2}s`;
    c.style.setProperty('--deriva', `${Math.round(Math.random() * 160 - 80)}px`);
    c.style.setProperty('--giri', `${Math.round(360 + Math.random() * 720)}deg`);
    festa.appendChild(c);
  }
  ist.el.tab.appendChild(festa);
  suoni.vittoria();
  setTimeout(() => festa.remove(), 7000);
}

function posiziona(pedina, punto, durata) {
  if (!punto) return;
  pedina.style.setProperty('--durata', `${Math.round(durata)}ms`);
  pedina.style.left = `${(punto.x / UNITA_TOTALI) * 100}%`;
  pedina.style.top = `${(punto.y / UNITA_TOTALI) * 100}%`;
}

function saltella(pedina, durata) {
  const corpo = pedina.firstElementChild;
  corpo.classList.remove('salto');
  void corpo.offsetWidth;
  corpo.style.setProperty('--durata-salto', `${Math.round(durata)}ms`);
  corpo.classList.add('salto');
}

// --- dadi -------------------------------------------------------------------

function ultimoEvento(partita, tipi, dopoIndice = -1) {
  const log = Array.isArray(partita.log) ? partita.log : [];
  for (let k = log.length - 1; k > dopoIndice; k -= 1) {
    if (log[k] && tipi.includes(log[k].tipo)) return { evento: log[k], indice: k };
  }
  return null;
}

/** Aggiorna i dadi; ritorna true se è appena avvenuto un nuovo lancio animato. */
function aggiornaDadi(ist, { partita, perId }, iniziale_) {
  const dadi = Array.isArray(partita.dadi) && partita.dadi.length === 2 ? partita.dadi : null;
  const ev = ultimoEvento(partita, ['dadi', 'lancioOrdine']);
  const chiave = ev
    ? `${ev.evento.t}|${ev.evento.giocatoreId}|${dadi ? dadi.join('-') : ''}`
    : `v|${dadi ? dadi.join('-') : ''}|${partita.versione}`;
  const nuovo = chiave !== ist.chiaveDadi;
  const cambiatiValori = !ist.prec || String(ist.prec.dadi) !== String(partita.dadi);
  ist.chiaveDadi = chiave;

  const zona = ist.el.zonaDadi;
  if (!dadi) {
    ist.el.dadi.forEach((d) => mostraDado(d, 0));
    ist.el.totale.textContent = '';
    zona.setAttribute('aria-label', 'Dadi: nessun lancio ancora');
    zona.classList.remove('doppio');
    return false;
  }
  const doppio = dadi[0] === dadi[1];
  const chi = ev && perId.get(ev.evento.giocatoreId);
  const etichetta = `Ultimo lancio${chi ? ` di ${chi.nome}` : ''}: ${dadi[0]} e ${dadi[1]}, totale ${dadi[0] + dadi[1]}${doppio ? ', doppio' : ''}`;
  zona.setAttribute('aria-label', etichetta);

  const finisci = (giri = 0) => {
    mostraDado(ist.el.dadi[0], dadi[0], giri);
    mostraDado(ist.el.dadi[1], dadi[1], giri);
    ist.el.totale.textContent = doppio ? `${dadi[0] + dadi[1]} · doppio` : String(dadi[0] + dadi[1]);
    zona.classList.toggle('doppio', doppio);
    zona.classList.remove('in-lancio');
  };

  const daAnimare = !iniziale_ && (ev ? nuovo : (nuovo && cambiatiValori)) && animazioniAttive(ist);
  clearTimeout(ist.timerDadi);
  if (!daAnimare) {
    finisci();
    return false;
  }
  zona.classList.remove('in-lancio', 'doppio');
  void zona.offsetWidth;
  zona.classList.add('in-lancio');
  suoni.dadi();
  ist.el.totale.textContent = '';
  // I cubi rotolano (due giri completi) fino a mostrare il valore; il totale arriva a fine lancio.
  mostraDado(ist.el.dadi[0], dadi[0], 2);
  mostraDado(ist.el.dadi[1], dadi[1], 2);
  ist.timerDadi = setTimeout(() => finisci(0), DURATA_DADI - 40);
  return true;
}

// --- carta pescata ----------------------------------------------------------

function aggiornaCarta(ist, { partita, perId }, iniziale_) {
  const { carta } = ist.el;
  const ev = ultimoEvento(partita, ['carta']);
  let mostra = null;
  if (ev && ev.evento.dati && ev.evento.dati.carta) {
    // Resta visibile finché non arriva un nuovo lancio o un nuovo turno.
    const dopo = ultimoEvento(partita, ['dadi', 'turno'], ev.indice);
    if (!dopo) mostra = ev.evento;
  }
  if (!mostra) {
    carta.hidden = true;
    clearTimeout(ist.timerCarta);
    ist.cartaInArrivo = false;
    ist.el.mazzoP.classList.remove('svuotato');
    ist.el.mazzoI.classList.remove('svuotato');
    ist.chiaveCarta = null;
    return;
  }
  const dati = mostra.dati;
  const mazzo = dati.mazzo === 'imprevisti' ? 'imprevisti' : 'probabilita';
  const chiave = `${mostra.t}|${dati.carta.id || ''}|${mostra.giocatoreId}`;
  if (chiave === ist.chiaveCarta && (!carta.hidden || ist.cartaInArrivo || ist.cartaRiposta === chiave)) return;
  ist.chiaveCarta = chiave;
  // La carta si gira quando la pedina è arrivata sulla casella, non prima.
  const ritardo = iniziale_ ? 0 : attesa();
  clearTimeout(ist.timerCarta);
  if (ritardo > 0) {
    ist.cartaInArrivo = true;
    carta.hidden = true;
    ist.timerCarta = setTimeout(() => {
      ist.cartaInArrivo = false;
      if (corrente === ist && ist.chiaveCarta === chiave) rivela();
    }, ritardo);
    return;
  }
  rivela();

  function rivela() {

  carta.dataset.mazzo = mazzo;
  ist.el.cartaGlifo.textContent = mazzo === 'probabilita' ? '?' : '!';
  ist.el.cartaMazzo.textContent = NOMI_MAZZO[mazzo];
  ist.el.cartaTesto.textContent = dati.carta.testo || '';
  const chi = perId.get(mostra.giocatoreId);
  ist.el.cartaChi.textContent = chi ? (chi.id === ist.mioId ? 'L\'hai pescata tu' : `Pescata da ${chi.nome}`) : '';
  carta.setAttribute('aria-label', `Carta ${NOMI_MAZZO[mazzo]} pescata`);
  ist.el.mazzoP.classList.toggle('svuotato', mazzo === 'probabilita');
  ist.el.mazzoI.classList.toggle('svuotato', mazzo === 'imprevisti');
  carta.hidden = false;
  carta.classList.remove('pescata');
  if (!iniziale_ && animazioniAttive(ist)) {
    void carta.offsetWidth;
    carta.classList.add('pescata');
    suoni.carta();
  }
  // Letta la carta, torna via: restava al centro del tabellone per tutto il
  // turno, sopra dadi e caselle. Un clic la mette via subito.
  clearTimeout(ist.timerRiponiCarta);
  ist.timerRiponiCarta = setTimeout(riponi, DURATA_CARTA_VISIBILE);
  carta.onclick = riponi;
  }

  function riponi() {
    clearTimeout(ist.timerRiponiCarta);
    if (corrente !== ist || ist.chiaveCarta !== chiave) return;
    ist.cartaRiposta = chiave;
    carta.hidden = true;
    ist.el.mazzoP.classList.remove('svuotato');
    ist.el.mazzoI.classList.remove('svuotato');
  }
}

// --- centro: turno e fase ---------------------------------------------------

function aggiornaCentro(ist, { partita, perId }) {
  const e = ist.el;
  const turnoId = partita.turno ? partita.turno.giocatoreId : null;
  const g = turnoId ? perId.get(turnoId) : null;
  const mio = g && g.id === ist.mioId;

  if (partita.fase === 'finePartita') {
    const v = perId.get(partita.vincitoreId);
    e.turnoNome.textContent = v ? (v.id === ist.mioId ? 'Hai vinto!' : `Vince ${v.nome}`) : 'Partita finita';
    impostaSegno(e.turnoSegno, v);
    e.turnoFase.textContent = 'Partita finita';
  } else if (g) {
    e.turnoNome.textContent = mio ? 'Tocca a te' : `Tocca ${aChi(g.nome)}`;
    impostaSegno(e.turnoSegno, g);
    e.turnoFase.textContent = descriviFase(ist, partita, g, perId);
  } else {
    e.turnoNome.textContent = 'In attesa di iniziare';
    impostaSegno(e.turnoSegno, null);
    e.turnoFase.textContent = '';
  }
  // Cambio di turno: il nome al centro fa un piccolo ingresso, e a chi tocca arriva un suono.
  const chiaveTurno = `${turnoId}|${partita.turno ? partita.turno.numero : ''}`;
  if (ist.turnoMostrato !== undefined && ist.turnoMostrato !== chiaveTurno && animazioniAttive(ist)) {
    const blocco = e.turnoNome.closest('.tab-turno');
    blocco.classList.remove('cambio');
    void blocco.offsetWidth;
    blocco.classList.add('cambio');
    if (mio) suoni.turno();
  }
  ist.turnoMostrato = chiaveTurno;
  const n = partita.turno && partita.turno.numero;
  e.turnoNumero.textContent = n ? `Turno ${n}` : '';
  e.codice.textContent = partita.codice ? `Stanza ${partita.codice}` : '';
  e.centro.dataset.fase = partita.fase || '';
}

function impostaSegno(segno, g) {
  segno.hidden = !g;
  if (!g) return;
  segno.textContent = iniziale(g.nome);
  segno.style.setProperty('--colore-giocatore', g.colore);
  segno.style.color = testoSu(g.colore);
}

function descriviFase(ist, partita, g, perId) {
  const nomeCasella = (i) => (ist.caselle[i] ? ist.caselle[i].nome : `casella ${i}`);
  switch (partita.fase) {
    case 'ordine':
      return partita.ordine && partita.ordine.giro > 1 ? 'Spareggio: rilancia i dadi' : 'Lancia i dadi: chi fa di più comincia';
    case 'daLanciare':
      if (g.inPrigione) return 'È in prigione: tira per un doppio, paga 50 € o usa la carta';
      return partita.turno && partita.turno.doppiConsecutivi > 0 ? 'Doppio! Lancia di nuovo' : 'Deve lanciare i dadi';
    case 'daDecidereAcquisto':
      return `Decide se comprare ${nomeCasella(g.posizione)}`;
    case 'mossa':
      return 'Può costruire, scambiare o finire il turno';
    case 'asta': {
      const a = partita.asta;
      if (!a) return 'Asta in corso';
      const top = a.migliorOfferenteId && perId.get(a.migliorOfferenteId);
      return `Asta per ${nomeCasella(a.casella)}${top ? `: ${euro(a.offertaMassima)} di ${top.nome}` : ': nessuna offerta'}`;
    }
    case 'debito': {
      const d = partita.debito;
      const deb = d && perId.get(d.giocatoreId);
      return d ? `${deb ? deb.nome : 'Un giocatore'} deve pagare ${euro(d.importo)}` : 'Debito da saldare';
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Selezione, focus e tastiera
// ---------------------------------------------------------------------------

function scegli(ist, indice) {
  if (!Number.isInteger(indice) || indice < 0 || indice >= NUMERO_CASELLE) return;
  ist.selezione = indice;
  disegnaSelezione(ist);
  impostaFoco(ist, indice, false);
  const casella = ist.caselle[indice];
  ist.radice.dispatchEvent(new CustomEvent('casella-selezionata', {
    bubbles: true,
    detail: { indice, casella },
  }));
  if (typeof ist.opzioni.onCasellaSelezionata === 'function') {
    ist.opzioni.onCasellaSelezionata(indice, casella);
  }
}

function disegnaSelezione(ist) {
  ist.pulsanti.forEach((b, i) => {
    const sel = i === ist.selezione;
    b.classList.toggle('selezionata', sel);
    if (sel) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  if (Number.isInteger(ist.selezione) && document.activeElement && !ist.el.griglia.contains(document.activeElement)) {
    impostaFoco(ist, ist.selezione, false);
  }
}

function impostaFoco(ist, indice, sposta) {
  const prima = ist.pulsanti[ist.focoIndice];
  if (prima) prima.tabIndex = -1;
  ist.focoIndice = indice;
  const b = ist.pulsanti[indice];
  if (!b) return;
  b.tabIndex = 0;
  if (sposta) b.focus();
}

const DIREZIONI = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
};

function tastiera(ist, e) {
  const b = e.target.closest('.casella');
  if (!b) return;
  const i = Number(b.dataset.indice);
  let dest = null;
  if (DIREZIONI[e.key]) {
    const { riga, colonna } = coordinate(i);
    // Le frecce seguono quello che si vede: con il tabellone girato cambiano direzione.
    let [dr, dc] = DIREZIONI[e.key];
    const quarti = ((Math.round(ist.camera.giro / 90) % 4) + 4) % 4;
    for (let q = 0; q < quarti; q += 1) [dr, dc] = [-dc, dr];
    const vicina = INDICE_DA_CELLA.get(`${riga + dr},${colonna + dc}`);
    if (vicina !== undefined) dest = vicina;
  } else if (e.key === 'Home') {
    dest = 0;
  } else if (e.key === 'End') {
    dest = NUMERO_CASELLE - 1;
  } else if (e.key === 'PageDown' || e.key === ']') {
    dest = (i + 1) % NUMERO_CASELLE;
  } else if (e.key === 'PageUp' || e.key === '[') {
    dest = (i - 1 + NUMERO_CASELLE) % NUMERO_CASELLE;
  } else {
    return; // Enter e Space generano già il click del <button>
  }
  e.preventDefault();
  if (dest !== null) impostaFoco(ist, dest, true);
}

// ---------------------------------------------------------------------------
// Camera: inclinazione, giro, zoom, inseguimento della pedina di turno
// ---------------------------------------------------------------------------

function leggiCamera() {
  const base = { giro: 0, vista: '3d', zoom: null, segui: true, pan: 0, panY: 0, pizzico: 1 };
  try {
    const salvata = JSON.parse(localStorage.getItem(CHIAVE_CAMERA) || 'null');
    if (salvata && typeof salvata === 'object') {
      if (salvata.vista === 'alto') base.vista = 'alto';
      if (typeof salvata.zoom === 'boolean') base.zoom = salvata.zoom;
      if (typeof salvata.segui === 'boolean') base.segui = salvata.segui;
    }
  } catch { /* preferenze non disponibili: valori predefiniti */ }
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && base.segui) base.segui = false;
  } catch { /* nessun matchMedia */ }
  return base;
}

function salvaCamera(ist) {
  const { vista, zoom, segui } = ist.camera;
  try {
    localStorage.setItem(CHIAVE_CAMERA, JSON.stringify({ vista, zoom, segui }));
  } catch { /* la scelta vale solo per questa pagina */ }
}

function creaComandiCamera(ist) {
  const barra = el('div', 'tab__comandi');
  barra.setAttribute('role', 'group');
  barra.setAttribute('aria-label', 'Vista del tabellone');
  const pulsante = (chiave, icona, etichetta, azione, premibile) => {
    const b = el('button', 'tab__comando');
    b.type = 'button';
    b.innerHTML = icona;
    b.setAttribute('aria-label', etichetta);
    b.title = etichetta;
    if (premibile) b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', azione);
    ist.el[`comando_${chiave}`] = b;
    barra.appendChild(b);
    return b;
  };
  pulsante('sinistra', ICONE_CAMERA.sinistra, 'Gira il tabellone a sinistra', () => gira(ist, 90));
  pulsante('destra', ICONE_CAMERA.destra, 'Gira il tabellone a destra', () => gira(ist, -90));
  pulsante('zoom', ICONE_CAMERA.zoom, 'Avvicina il lato davanti', () => {
    // Vale anche dopo uno zoom fatto con due dita: se si è vicini, si torna lontani.
    ist.camera.zoom = !(fattoreZoom(ist) > 1.05);
    ist.camera.pizzico = 1;
    ist.camera.pan = 0;
    ist.camera.panY = 0;
    salvaCamera(ist);
    misura(ist);
    centraSuTurno(ist);
  }, true);
  pulsante('alto', ICONE_CAMERA.alto, 'Vista dall\'alto', () => {
    ist.camera.vista = ist.camera.vista === 'alto' ? '3d' : 'alto';
    salvaCamera(ist);
    misura(ist);
  }, true);
  pulsante('segui', ICONE_CAMERA.segui, 'Segui la pedina di turno', () => {
    ist.camera.segui = !ist.camera.segui;
    salvaCamera(ist);
    applicaCamera(ist);
    ist.chiaveSegui = null;
    if (ist.camera.segui && ist.prec) seguiTurno(ist, contestoDi(ist.prec), 0);
  }, true);
  const rapido = pulsante('veloce', ICONE_CAMERA.veloce, 'Animazioni veloci', () => {
    impostaVeloci(!veloci());
    rapido.setAttribute('aria-pressed', String(veloci()));
    ist.radice.classList.toggle('tab--veloce', veloci());
  }, true);
  rapido.setAttribute('aria-pressed', String(veloci()));
  ist.radice.classList.toggle('tab--veloce', veloci());
  const audio = pulsante('suono', ICONE_CAMERA.suono, 'Suoni', () => {
    impostaSuoni(!suoniAttivi());
    audio.setAttribute('aria-pressed', String(suoniAttivi()));
    if (suoniAttivi()) suoni.moneta();
  }, true);
  audio.setAttribute('aria-pressed', String(suoniAttivi()));
  return barra;
}

function contestoDi(partita) {
  const giocatori = Array.isArray(partita.giocatori) ? partita.giocatori : [];
  return { partita, giocatori, perId: new Map(giocatori.map((g) => [g.id, g])) };
}

/** Lo zoom è acceso per scelta oppure, senza scelta, sugli schermi stretti. */
function zoomAttivo(ist) {
  if (ist.camera.vista === 'alto') return false;
  if (typeof ist.camera.zoom === 'boolean') return ist.camera.zoom;
  return ist.larghezza > 0 && ist.larghezza < 620;
}

/** Quanto è ingrandito il tabellone: il pulsante "Avvicina" per lo zoom fatto con due dita. */
function fattoreZoom(ist) {
  const base = zoomAttivo(ist) ? ZOOM_VICINO : 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, base * (ist.camera.pizzico || 1)));
}

/** Porta lo zoom complessivo al valore chiesto (entro i limiti). */
function impostaZoom(ist, totale) {
  const base = zoomAttivo(ist) ? ZOOM_VICINO : 1;
  ist.camera.pizzico = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, totale)) / base;
  if (fattoreZoom(ist) <= 1.02) {
    ist.camera.pan = 0;
    ist.camera.panY = 0;
  }
}

/**
 * Giro manuale di un quarto: l'inseguimento automatico si spegne. Da un angolo
 * libero (lasciato col dito) si va al lato successivo, non 90 gradi più in là.
 */
function gira(ist, gradi) {
  const quarti = ist.camera.giro / 90;
  ist.camera.giro = gradi > 0 ? (Math.floor(quarti + 1e-6) + 1) * 90 : (Math.ceil(quarti - 1e-6) - 1) * 90;
  ist.camera.pan = 0;
  ist.camera.panY = 0;
  if (ist.camera.segui) {
    ist.camera.segui = false;
    salvaCamera(ist);
  }
  applicaCamera(ist);
}

/** Misura lo spazio disponibile e sceglie il lato del tabellone e l'altezza della scena. */
function misura(ist) {
  if (corrente !== ist || !ist.el.tab) return;
  const larghezza = ist.radice.clientWidth || 320;
  const barra = document.querySelector('.barra');
  const altoFinestra = window.innerHeight || 800;
  const affiancato = window.matchMedia('(min-width: 64rem)').matches;
  // Su schermi stretti il cassetto del turno è fisso in basso: il tabellone deve starci sopra.
  const cassetto = affiancato ? null : document.querySelector('.pn--stretto .pn-turno');
  const sotto = cassetto ? Math.min(cassetto.offsetHeight, altoFinestra * 0.42) : (affiancato ? 0 : altoFinestra * 0.3);
  const altezzaUtile = Math.max(260, altoFinestra - (barra ? barra.offsetHeight : 56) - sotto - 40);
  const alto = ist.camera.vista === 'alto';
  ist.larghezza = larghezza;
  let lato;
  let altezzaScena;
  if (alto) {
    lato = Math.min(larghezza, altezzaUtile);
    altezzaScena = lato;
  } else {
    // In prospettiva il lato vicino appare più largo (~1,2 volte) e il piano più basso (~0,7).
    lato = Math.min(larghezza / 1.2, altezzaUtile / 0.74);
    altezzaScena = lato * 0.76;
    if (zoomAttivo(ist)) {
      // Da vicino si guarda il lato davanti: tabellone largo quanto lo schermo, scena più alta.
      lato = Math.max(lato, Math.min(larghezza, altezzaUtile / 0.74));
      altezzaScena = Math.min(altezzaUtile, lato * 1.05);
    }
  }
  lato = Math.max(260, Math.floor(lato));
  ist.lato = lato;
  const tab = ist.el.tab;
  tab.style.setProperty('--lato', `${lato}px`);
  tab.style.setProperty('--u', `${(lato / UNITA_TOTALI).toFixed(3)}px`);
  tab.style.setProperty('--scena-alta', `${Math.round(altezzaScena)}px`);
  ist.scenaAlta = altezzaScena;
  // Spostamento verticale della camera: da vicino il bordo davanti resta in fondo alla scena.
  if (alto) ist.su = 0;
  else if (zoomAttivo(ist)) ist.su = Math.round(altezzaScena / 2 - lato * BORDO_DAVANTI * ZOOM_VICINO);
  else ist.su = Math.round(lato * -0.035);
  tab.style.setProperty('--su', `${ist.su}px`);
  tab.classList.toggle('tab--piccolo', lato / UNITA_TOTALI < 34 && !zoomAttivo(ist));
  applicaCamera(ist);
  // Da vicino, dopo un cambio di misura, si torna sulla pedina di turno.
  if (zoomAttivo(ist) && !ist.trascinato) centraSuTurno(ist);
}

function applicaCamera(ist) {
  const tab = ist.el.tab;
  if (!tab) return;
  const c = ist.camera;
  const alto = c.vista === 'alto';
  const zoom = fattoreZoom(ist);
  const lato = ist.lato || 0;
  // Di quanto si può scorrere quando il tabellone avvicinato esce dalla scena.
  const fuori = Math.max(0, (lato * zoom * 1.2 - (ist.larghezza || lato)) / 2);
  const fuoriY = zoom > 1.02 ? Math.max(0, (lato * zoom * (alto ? 1 : 0.86) - (ist.scenaAlta || lato)) / 2) : 0;
  c.pan = Math.max(-fuori, Math.min(fuori, c.pan));
  c.panY = Math.max(-fuoriY, Math.min(fuoriY, c.panY || 0));
  tab.style.setProperty('--tilt', `${alto ? 0 : TILT_3D}deg`);
  tab.style.setProperty('--giro', `${alto ? 0 : c.giro}deg`);
  tab.style.setProperty('--zoom', zoom.toFixed(3));
  tab.style.setProperty('--pan', `${Math.round(c.pan)}px`);
  tab.style.setProperty('--pan-y', `${Math.round(c.panY)}px`);
  tab.dataset.vista = alto ? 'alto' : '3d';
  tab.classList.toggle('tab--zoom', zoom > 1.05);
  const premi = (chiave, valore) => {
    const b = ist.el[`comando_${chiave}`];
    if (b) b.setAttribute('aria-pressed', String(valore));
  };
  premi('alto', alto);
  premi('zoom', zoom > 1.05);
  premi('segui', c.segui);
  ['sinistra', 'destra', 'segui'].forEach((chiave) => {
    const b = ist.el[`comando_${chiave}`];
    if (b) b.disabled = alto;
  });
}

/** Lato (0 sud, 1 ovest, 2 nord, 3 est) da cui si vede meglio la casella. */
function latoDi(posizione) {
  const p = ((posizione % NUMERO_CASELLE) + NUMERO_CASELLE) % NUMERO_CASELLE;
  if (p === 0) return 0;
  return Math.floor((p - 1) / 10);
}

const GIRO_PER_LATO = [0, -90, 180, 90];

/** Porta davanti il lato su cui si trova la pedina di turno, lungo la via più breve. */
function seguiTurno(ist, { partita, perId }, ritardo) {
  const g = partita.turno ? perId.get(partita.turno.giocatoreId) : null;
  if (!g || g.fallito) return;
  const posizione = Number(g.posizione) || 0;
  // Si torna sulla pedina solo quando cambia chi gioca o dove sta: gli altri
  // aggiornamenti non spostano una vista scelta con le dita.
  const chiave = `${g.id}|${posizione}`;
  if (chiave === ist.chiaveSegui) return;
  ist.chiaveSegui = chiave;
  clearTimeout(ist.timerCamera);
  ist.timerCamera = setTimeout(() => {
    if (corrente !== ist) return;
    if (ist.camera.segui && ist.camera.vista !== 'alto') {
      const meta = GIRO_PER_LATO[latoDi(posizione)];
      const ora = ist.camera.giro;
      ist.camera.giro = ora + ((((meta - ora) % 360) + 540) % 360) - 180;
    }
    centraSuTurno(ist, posizione);
    applicaCamera(ist);
  }, ritardo);
}

/** Con lo zoom acceso scorre di lato fino ad avere la pedina di turno al centro. */
function centraSuTurno(ist, posizione) {
  const zoom = fattoreZoom(ist);
  if (zoom <= 1.05 || ist.camera.vista === 'alto') return;
  let pos = posizione;
  if (pos === undefined) {
    const p = ist.prec;
    const g = p && p.turno && (p.giocatori || []).find((x) => x.id === p.turno.giocatoreId);
    if (!g) return;
    pos = Number(g.posizione) || 0;
  }
  const centro = centroCasella(pos);
  const x = centro.x - UNITA_TOTALI / 2;
  const y = centro.y - UNITA_TOTALI / 2;
  const a = (ist.camera.giro * Math.PI) / 180;
  const ruotato = x * Math.cos(a) - y * Math.sin(a);
  ist.camera.pan = -(ruotato / UNITA_TOTALI) * ist.lato * zoom * 1.15;
  // Il bordo davanti (dove sta la pedina) resta dentro la scena a ogni zoom.
  ist.camera.panY = Math.min(0, (ist.scenaAlta || ist.lato) / 2 - (ist.su || 0) - ist.lato * BORDO_DAVANTI * zoom);
  applicaCamera(ist);
}

/**
 * Gesti sulla scena.
 *  - Un dito (o il mouse) trascinato di lato fa girare il tabellone: sotto il
 *    centro il bordo vicino segue il dito, sopra il centro lo segue quello
 *    lontano. Lasciando vicino a un lato, il tabellone si raddrizza. Con un
 *    dito in verticale la pagina scorre come sempre (touch-action: pan-y).
 *  - Due dita avvicinano, allontanano e spostano. Sul trackpad vale il
 *    pizzico (rotella con Ctrl); col mouse, Maiusc + trascina sposta.
 *  - Dall'alto il tabellone non gira: un dito lo sposta.
 */
function trascinamento(ist, scena) {
  const tab = ist.el.tab;
  const punti = new Map();   // pointerId -> { x, y }
  let giro = null;           // gesto a un dito
  let pizzico = null;        // gesto a due dita
  let timerRotella = null;

  const presa = (si) => {
    scena.classList.toggle('in-trascinamento', si);
    tab.classList.toggle('tab--in-presa', si);
  };
  const dueDita = () => {
    const [a, b] = [...punti.values()];
    return { distanza: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  ascolta(ist, scena, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (punti.size === 0) ist.trascinato = false;
    punti.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (punti.size === 2) {
      giro = null;
      pizzico = { ...dueDita(), zoom: fattoreZoom(ist), pan: ist.camera.pan, panY: ist.camera.panY };
      ist.trascinato = true;
      presa(true);
    } else if (punti.size === 1) {
      const r = scena.getBoundingClientRect();
      giro = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        giro: ist.camera.giro,
        verso: e.clientY < r.top + r.height * 0.42 ? 1 : -1,
        gradiPerPx: 180 / Math.max(280, r.width * 0.9),
        sposta: e.pointerType === 'mouse' && e.shiftKey,
        pan: ist.camera.pan,
        panY: ist.camera.panY,
      };
    }
  });

  ascolta(ist, scena, 'pointermove', (e) => {
    const p = punti.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pizzico && punti.size >= 2) {
      const ora = dueDita();
      impostaZoom(ist, pizzico.zoom * (ora.distanza / pizzico.distanza));
      ist.camera.pan = pizzico.pan + (ora.cx - pizzico.cx);
      ist.camera.panY = pizzico.panY + (ora.cy - pizzico.cy);
      applicaCamera(ist);
      return;
    }
    if (!giro || giro.id !== e.pointerId) return;
    const dx = e.clientX - giro.x;
    const dy = e.clientY - giro.y;
    if (!ist.trascinato) {
      if (Math.hypot(dx, dy) < 8) return;
      ist.trascinato = true;
      presa(true);
      try { scena.setPointerCapture(e.pointerId); } catch { /* puntatore già rilasciato */ }
    }
    if (giro.sposta || ist.camera.vista === 'alto') {
      ist.camera.pan = giro.pan + dx;
      ist.camera.panY = giro.panY + dy;
    } else {
      ist.camera.giro = giro.giro + giro.verso * dx * giro.gradiPerPx;
    }
    applicaCamera(ist);
  });

  const fine = (e) => {
    if (!punti.delete(e.pointerId)) return;
    if (punti.size < 2) pizzico = null;
    if (punti.size > 0) {
      giro = null; // il dito rimasto dopo un pizzico non fa girare
      return;
    }
    const girato = giro && ist.trascinato && !giro.sposta && ist.camera.vista !== 'alto';
    giro = null;
    presa(false);
    if (girato) {
      const lato = Math.round(ist.camera.giro / 90) * 90;
      if (Math.abs(ist.camera.giro - lato) < SCATTO_GIRO) {
        ist.camera.giro = lato;
        applicaCamera(ist);
      }
    }
    // Il click che segue un trascinamento va ignorato: si azzera al giro dopo.
    setTimeout(() => { ist.trascinato = false; }, 0);
  };
  ascolta(ist, scena, 'pointerup', fine);
  ascolta(ist, scena, 'pointercancel', fine);

  // Con due dita sulla scena la pagina non deve né scorrere né ingrandirsi.
  const attivo = (tipo, fn) => {
    scena.addEventListener(tipo, fn, { passive: false });
    ist.ascoltatori.push([scena, tipo, fn]);
  };
  const fermaDueDita = (e) => {
    if (e.touches && e.touches.length >= 2 && e.cancelable) e.preventDefault();
  };
  attivo('touchstart', fermaDueDita);
  attivo('touchmove', fermaDueDita);
  attivo('gesturestart', (e) => e.preventDefault()); // Safari

  // Trackpad: il pizzico arriva come rotella con Ctrl; lo scorrimento di lato sposta.
  attivo('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      impostaZoom(ist, fattoreZoom(ist) * Math.exp(-e.deltaY * 0.012));
    } else if (fattoreZoom(ist) > 1.05 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const prima = ist.camera.pan;
      ist.camera.pan -= e.deltaX;
      applicaCamera(ist);
      if (ist.camera.pan === prima) return; // già al bordo: la pagina scorre
      e.preventDefault();
    } else {
      return;
    }
    presa(true);
    applicaCamera(ist);
    clearTimeout(timerRotella);
    timerRotella = setTimeout(() => { if (punti.size === 0) presa(false); }, 160);
  });
}
