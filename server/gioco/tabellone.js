'use strict';

/**
 * server/gioco/tabellone.js
 *
 * Dati statici del tabellone: le 40 caselle dell'edizione italiana del
 * Monopoly con i valori ufficiali in euro. Il modulo è puro (nessuno stato,
 * nessuna dipendenza) ed è pensato per essere usato sia dal motore di gioco
 * lato server sia, serializzato, dal client per disegnare il tabellone.
 *
 * Ogni casella ha:
 *   indice        posizione 0-39 partendo dal Via, in senso orario
 *   tipo          'via' | 'proprieta' | 'stazione' | 'societa' | 'tassa' |
 *                 'probabilita' | 'imprevisti' | 'prigione' | 'parcheggio' |
 *                 'vaiInPrigione'
 *   nome          nome ufficiale italiano
 *   gruppo        chiave del gruppo colore (vedi GRUPPI) oppure null
 *   prezzo        prezzo d'acquisto dalla banca (null se non acquistabile)
 *   affitti       per 'proprieta': [0 case, 1, 2, 3, 4 case, albergo]
 *                 per 'stazione':  [1, 2, 3, 4 stazioni possedute]
 *                 per 'societa':   [1, 2 società possedute] = moltiplicatore
 *                                  del tiro di dadi (4x, 10x)
 *                 altrimenti null
 *   costoCasa     costo di una casa (e di un albergo, che costa quanto una
 *                 casa in più delle 4 già presenti); null se non edificabile
 *   importoTassa  solo per 'tassa': cifra da pagare alla banca
 *   ipoteca       valore d'ipoteca (metà del prezzo); null se non ipotecabile
 */

/** Gruppi colore con nome leggibile, colore per il client e numero di caselle. */
const GRUPPI = Object.freeze({
  marrone:   { nome: 'Marrone',   colore: '#8B4513', caselle: 2 },
  celeste:   { nome: 'Celeste',   colore: '#87CEEB', caselle: 3 },
  rosa:      { nome: 'Rosa',      colore: '#D9388C', caselle: 3 },
  arancione: { nome: 'Arancione', colore: '#F28C28', caselle: 3 },
  rosso:     { nome: 'Rosso',     colore: '#D62828', caselle: 3 },
  giallo:    { nome: 'Giallo',    colore: '#F2D33C', caselle: 3 },
  verde:     { nome: 'Verde',     colore: '#1E8E3E', caselle: 3 },
  blu:       { nome: 'Blu',       colore: '#1D4ED8', caselle: 2 },
  stazione:  { nome: 'Stazioni',  colore: '#2B2B2B', caselle: 4 },
  societa:   { nome: 'Società',   colore: '#6B7280', caselle: 2 },
});

/** Costanti di regolamento legate al tabellone. */
const STIPENDIO_VIA = 200;
const INDICE_VIA = 0;
const INDICE_PRIGIONE = 10;
const INDICE_VAI_IN_PRIGIONE = 30;
const CAUZIONE_PRIGIONE = 50;
const AFFITTI_STAZIONE = [25, 50, 100, 200];
const MOLTIPLICATORI_SOCIETA = [4, 10];

// ---------------------------------------------------------------------------
// Costruttori di casella: tengono l'array finale leggibile e senza ripetizioni.
// ---------------------------------------------------------------------------

function proprieta(indice, nome, gruppo, prezzo, affitti, costoCasa) {
  return {
    indice, tipo: 'proprieta', nome, gruppo, prezzo,
    affitti: Object.freeze(affitti.slice()), costoCasa, importoTassa: null, ipoteca: prezzo / 2,
  };
}

function stazione(indice, nome) {
  return {
    indice, tipo: 'stazione', nome, gruppo: 'stazione', prezzo: 200,
    affitti: Object.freeze(AFFITTI_STAZIONE.slice()), costoCasa: null, importoTassa: null, ipoteca: 100,
  };
}

function societa(indice, nome) {
  return {
    indice, tipo: 'societa', nome, gruppo: 'societa', prezzo: 150,
    affitti: Object.freeze(MOLTIPLICATORI_SOCIETA.slice()), costoCasa: null, importoTassa: null, ipoteca: 75,
  };
}

function tassa(indice, nome, importoTassa) {
  return {
    indice, tipo: 'tassa', nome, gruppo: null, prezzo: null,
    affitti: null, costoCasa: null, importoTassa, ipoteca: null,
  };
}

function speciale(indice, tipo, nome) {
  return {
    indice, tipo, nome, gruppo: null, prezzo: null,
    affitti: null, costoCasa: null, importoTassa: null, ipoteca: null,
  };
}

// ---------------------------------------------------------------------------
// Le 40 caselle, in ordine di percorso partendo dal Via.
// ---------------------------------------------------------------------------

const CASELLE = [
  speciale(0, 'via', 'Via!'),
  proprieta(1, 'Vicolo Corto', 'marrone', 60, [2, 10, 30, 90, 160, 250], 50),
  speciale(2, 'probabilita', 'Probabilità'),
  proprieta(3, 'Vicolo Stretto', 'marrone', 60, [4, 20, 60, 180, 320, 450], 50),
  tassa(4, 'Tassa patrimoniale', 200),
  stazione(5, 'Stazione Sud'),
  proprieta(6, 'Bastioni Gran Sasso', 'celeste', 100, [6, 30, 90, 270, 400, 550], 50),
  speciale(7, 'imprevisti', 'Imprevisti'),
  proprieta(8, 'Viale Monterosa', 'celeste', 100, [6, 30, 90, 270, 400, 550], 50),
  proprieta(9, 'Viale Vesuvio', 'celeste', 120, [8, 40, 100, 300, 450, 600], 50),
  speciale(10, 'prigione', 'Prigione / Transito'),
  proprieta(11, 'Via Accademia', 'rosa', 140, [10, 50, 150, 450, 625, 750], 100),
  societa(12, 'Società Elettrica'),
  proprieta(13, 'Corso Ateneo', 'rosa', 140, [10, 50, 150, 450, 625, 750], 100),
  proprieta(14, 'Piazza Università', 'rosa', 160, [12, 60, 180, 500, 700, 900], 100),
  stazione(15, 'Stazione Ovest'),
  proprieta(16, 'Via Verdi', 'arancione', 180, [14, 70, 200, 550, 750, 950], 100),
  speciale(17, 'probabilita', 'Probabilità'),
  proprieta(18, 'Corso Raffaello', 'arancione', 180, [14, 70, 200, 550, 750, 950], 100),
  proprieta(19, 'Piazza Dante', 'arancione', 200, [16, 80, 220, 600, 800, 1000], 100),
  speciale(20, 'parcheggio', 'Parcheggio gratuito'),
  proprieta(21, 'Via Marco Polo', 'rosso', 220, [18, 90, 250, 700, 875, 1050], 150),
  speciale(22, 'imprevisti', 'Imprevisti'),
  proprieta(23, 'Corso Magellano', 'rosso', 220, [18, 90, 250, 700, 875, 1050], 150),
  proprieta(24, 'Largo Colombo', 'rosso', 240, [20, 100, 300, 750, 925, 1100], 150),
  stazione(25, 'Stazione Nord'),
  proprieta(26, 'Viale Costantino', 'giallo', 260, [22, 110, 330, 800, 975, 1150], 150),
  proprieta(27, 'Viale Traiano', 'giallo', 260, [22, 110, 330, 800, 975, 1150], 150),
  societa(28, 'Società Acqua Potabile'),
  proprieta(29, 'Piazza Giulio Cesare', 'giallo', 280, [24, 120, 360, 850, 1025, 1200], 150),
  speciale(30, 'vaiInPrigione', 'In prigione!'),
  proprieta(31, 'Via Roma', 'verde', 300, [26, 130, 390, 900, 1100, 1275], 200),
  proprieta(32, 'Corso Impero', 'verde', 300, [26, 130, 390, 900, 1100, 1275], 200),
  speciale(33, 'probabilita', 'Probabilità'),
  proprieta(34, 'Largo Augusto', 'verde', 320, [28, 150, 450, 1000, 1200, 1400], 200),
  stazione(35, 'Stazione Est'),
  speciale(36, 'imprevisti', 'Imprevisti'),
  proprieta(37, 'Viale dei Giardini', 'blu', 350, [35, 175, 500, 1100, 1300, 1500], 200),
  tassa(38, 'Tassa di lusso', 100),
  proprieta(39, 'Parco della Vittoria', 'blu', 400, [50, 200, 600, 1400, 1700, 2000], 200),
];

// Congelamento profondo: nessun consumatore può alterare per errore i dati
// condivisi fra tutte le stanze (gli array `affitti` sono già congelati).
CASELLE.forEach(Object.freeze);
Object.freeze(CASELLE);
Object.values(GRUPPI).forEach(Object.freeze);
Object.freeze(AFFITTI_STAZIONE);
Object.freeze(MOLTIPLICATORI_SOCIETA);

// ---------------------------------------------------------------------------
// Piccole utilità di sola lettura sul tabellone.
// ---------------------------------------------------------------------------

/** Restituisce la casella all'indice dato (gestisce il giro completo). */
function casella(indice) {
  return CASELLE[((indice % CASELLE.length) + CASELLE.length) % CASELLE.length];
}

/** Indici di tutte le caselle di un gruppo colore (o 'stazione' / 'societa'). */
function indiciGruppo(gruppo) {
  return CASELLE.filter((c) => c.gruppo === gruppo).map((c) => c.indice);
}

/** Vero se la casella può essere comprata da un giocatore. */
function acquistabile(indice) {
  const c = casella(indice);
  return c.tipo === 'proprieta' || c.tipo === 'stazione' || c.tipo === 'societa';
}

/**
 * Indice della prossima casella del tipo dato partendo da `daIndice`
 * (escluso) e procedendo in avanti. Serve per le carte "stazione più vicina"
 * e "società più vicina".
 */
function prossimaCasellaDiTipo(daIndice, tipo) {
  for (let passo = 1; passo <= CASELLE.length; passo += 1) {
    const c = casella(daIndice + passo);
    if (c.tipo === tipo) return c.indice;
  }
  return null;
}

module.exports = {
  CASELLE,
  GRUPPI,
  STIPENDIO_VIA,
  INDICE_VIA,
  INDICE_PRIGIONE,
  INDICE_VAI_IN_PRIGIONE,
  CAUZIONE_PRIGIONE,
  AFFITTI_STAZIONE,
  MOLTIPLICATORI_SOCIETA,
  casella,
  indiciGruppo,
  acquistabile,
  prossimaCasellaDiTipo,
};
