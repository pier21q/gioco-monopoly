'use strict';

/**
 * server/gioco/regole.js
 *
 * Le regole che chi guida la stanza (host o admin) sceglie prima di avviare
 * la partita, nella finestra "Regole della partita". Oltre alla regola di
 * costruzione ci sono il denaro iniziale, le proprietà distribuite all'inizio
 * (per partite più veloci) e le varianti di casa più diffuse.
 *
 * REGOLE e PREDEFINITE sono dati puri: il server li espone anche al browser
 * come /dati/regole.js (le funzioni non vengono esportate lì).
 */

const REGOLE = Object.freeze([
  {
    chiave: 'denaroIniziale',
    titolo: 'Denaro iniziale',
    descrizione: 'Quanto riceve ogni giocatore all\'inizio.',
    predefinito: 1500,
    valori: [
      { valore: 1000, etichetta: '1.000 €', descrizione: 'Partita più tesa: si resta presto senza soldi.' },
      { valore: 1500, etichetta: '1.500 €', descrizione: 'Regola classica.' },
      { valore: 2000, etichetta: '2.000 €', descrizione: 'Più margine per comprare e costruire.' },
      { valore: 2500, etichetta: '2.500 €', descrizione: 'Partita più lunga e generosa.' },
    ],
  },
  {
    chiave: 'proprietaIniziali',
    titolo: 'Proprietà all\'inizio',
    descrizione: 'Per velocizzare l\'inizio, ognuno parte con alcune proprietà estratte a caso (gratis, mai un colore completo).',
    predefinito: 0,
    valori: [
      { valore: 0, etichetta: 'Nessuna', descrizione: 'Regola classica: si compra tutto giocando.' },
      { valore: 1, etichetta: '1 a testa', descrizione: 'Una proprietà a caso per ciascuno.' },
      { valore: 2, etichetta: '2 a testa', descrizione: 'Due proprietà a caso per ciascuno.' },
      { valore: 3, etichetta: '3 a testa', descrizione: 'Tre proprietà a caso: si arriva prima agli scambi.' },
    ],
  },
  {
    chiave: 'costruzione',
    titolo: 'Come si costruisce',
    descrizione: 'Case e alberghi si costruiscono solo sui colori posseduti per intero.',
    predefinito: 'libera',
    valori: [
      { valore: 'libera', etichetta: 'Quando vuoi', descrizione: 'Regola classica: nel tuo turno, su qualsiasi colore completo.' },
      { valore: 'sosta', etichetta: 'Solo dove ti fermi', descrizione: 'Solo nel turno in cui la pedina si ferma su una casella di quel colore.' },
    ],
  },
  {
    chiave: 'limiteCostruzioni',
    titolo: 'Case per turno',
    descrizione: 'Quante case (o alberghi) si possono costruire in un solo turno su ogni terreno, sempre in modo uniforme sul colore. Dopo un doppio il conto riparte.',
    predefinito: 0,
    valori: [
      { valore: 0, etichetta: 'Senza limite', descrizione: 'Regola classica: quante ne vuoi, se hai i soldi.' },
      { valore: 1, etichetta: '1 per terreno', descrizione: 'Variante: una casa a turno su ogni terreno (2 o 3 per colore).' },
      { valore: 2, etichetta: '2 per terreno', descrizione: 'Variante: due case a turno su ogni terreno (4 o 6 per colore).' },
      { valore: 3, etichetta: '3 per terreno', descrizione: 'Variante: tre case a turno su ogni terreno (6 o 9 per colore).' },
    ],
  },
  {
    chiave: 'scorteIllimitate',
    titolo: 'Case e alberghi in banca',
    descrizione: 'Quante case e quanti alberghi ha la banca in tutto.',
    predefinito: false,
    valori: [
      { valore: false, etichetta: '32 case e 12 alberghi', descrizione: 'Regola classica: quando finiscono non si costruisce più finché qualcuno non ne vende.' },
      { valore: true, etichetta: 'Senza tetto', descrizione: 'Variante: la banca non finisce mai né le case né gli alberghi.' },
    ],
  },
  {
    chiave: 'aste',
    titolo: 'Proprietà non comprate',
    descrizione: 'Cosa succede quando chi ci arriva sopra non la compra.',
    predefinito: true,
    valori: [
      { valore: true, etichetta: 'Vanno all\'asta', descrizione: 'Regola classica: tutti possono fare un\'offerta.' },
      { valore: false, etichetta: 'Restano alla banca', descrizione: 'Variante: nessuna asta, si potrà comprarla al prossimo passaggio.' },
    ],
  },
  {
    chiave: 'parcheggio',
    titolo: 'Parcheggio gratuito',
    descrizione: 'La variante più famosa: tasse, multe e cauzioni finiscono in un piatto al centro.',
    predefinito: false,
    valori: [
      { valore: false, etichetta: 'Non succede niente', descrizione: 'Regola classica: è solo una casella di sosta.' },
      { valore: true, etichetta: 'Si vince il piatto', descrizione: 'Chi si ferma sul Parcheggio gratuito incassa tutto il piatto.' },
    ],
  },
  {
    chiave: 'viaDoppio',
    titolo: 'Fermarsi sul Via',
    descrizione: 'Quanto si incassa quando la pedina si ferma proprio sulla casella Via.',
    predefinito: false,
    valori: [
      { valore: false, etichetta: '200 €', descrizione: 'Regola classica: come passarci sopra.' },
      { valore: true, etichetta: '400 €', descrizione: 'Variante: fermarsi esattamente sul Via raddoppia lo stipendio.' },
    ],
  },
  {
    chiave: 'affittoInPrigione',
    titolo: 'Affitti dalla prigione',
    descrizione: 'Se chi è in prigione riscuote gli affitti delle sue proprietà.',
    predefinito: true,
    valori: [
      { valore: true, etichetta: 'Si riscuotono', descrizione: 'Regola classica: la prigione non ferma gli affitti.' },
      { valore: false, etichetta: 'Niente affitti', descrizione: 'Variante: finché sei dentro, chi passa dalle tue proprietà non paga.' },
    ],
  },
]);

const PREDEFINITE = Object.freeze(Object.fromEntries(REGOLE.map((r) => [r.chiave, r.predefinito])));

/**
 * Valida regole arrivate da fuori (anche parziali): le chiavi mancanti
 * prendono il valore predefinito, quelle sconosciute sono un errore.
 * @returns {{ regole: object } | { errore: { campo: string, messaggio: string } }}
 */
function normalizza(grezze) {
  if (grezze == null) return { regole: { ...PREDEFINITE } };
  if (typeof grezze !== 'object' || Array.isArray(grezze)) {
    return { errore: { campo: 'regole', messaggio: 'Le regole devono essere un oggetto' } };
  }
  const regole = { ...PREDEFINITE };
  for (const [chiave, valore] of Object.entries(grezze)) {
    const r = REGOLE.find((x) => x.chiave === chiave);
    if (!r) return { errore: { campo: `regole.${chiave}`, messaggio: `Regola sconosciuta: ${chiave}` } };
    if (valore === undefined || valore === null) continue;
    if (!r.valori.some((v) => v.valore === valore)) {
      return { errore: { campo: `regole.${chiave}`, messaggio: `Valore non ammesso per «${r.titolo}»` } };
    }
    regole[chiave] = valore;
  }
  return { regole };
}

/** Valore di una regola nello stato, con il predefinito per le partite salvate prima che esistesse. */
function valore(stato, chiave) {
  const r = stato && stato.regole;
  return r && Object.hasOwn(r, chiave) ? r[chiave] : PREDEFINITE[chiave];
}

module.exports = { REGOLE, PREDEFINITE, normalizza, valore };
