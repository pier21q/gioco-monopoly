'use strict';

/**
 * server/salvataggio.js
 *
 * Salvataggio delle partite su file, così un riavvio del server (Ctrl+C,
 * finestra chiusa, crash) non le cancella. Ogni pochi secondi, se qualcosa è
 * cambiato, le stanze aperte (stanze.esporta) vengono scritte in JSON con una
 * scrittura atomica (file temporaneo + rinomina); all'avvio vengono ricaricate
 * (stanze.importa) e i giocatori rientrano con il token del proprio browser.
 * Un file che non si riesce a leggere non viene mai sovrascritto: resta accanto
 * all'originale come `partite.json.illeggibile-<data>` (caricaSenzaPerdere).
 *
 * Il file contiene i token di sessione: viene creato con permessi 600 in una
 * cartella 700 ed è escluso da git (.gitignore). Su Render gratuito il disco si
 * azzera a ogni riavvio o ripubblicazione: lì il salvataggio non aiuta.
 *
 * Variabile SALVATAGGIO: percorso del file; `0` (o `no`) lo disattiva; se manca
 * si usa `.partite/partite.json` nella cartella del progetto.
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSIONE_FORMATO = 1;
const INTERVALLO_MS = 5000;

/** Percorso del file a partire dalla variabile SALVATAGGIO, o null se disattivato. */
function percorsoDaAmbiente(valore, radiceProgetto) {
  if (valore === undefined || valore === null || valore === '') {
    return path.join(radiceProgetto, '.partite', 'partite.json');
  }
  if (['0', 'no', 'false', 'off'].includes(String(valore).trim().toLowerCase())) return null;
  return path.resolve(String(valore));
}

/** Testo JSON del salvataggio per le stanze attuali. */
function serializza(stanze) {
  return JSON.stringify({ formato: VERSIONE_FORMATO, salvatoIl: Date.now(), stanze: stanze.esporta() });
}

/** Scrive `testo` in `percorso` in modo atomico, con permessi 600. */
function scriviAtomico(percorso, testo) {
  fs.mkdirSync(path.dirname(percorso), { recursive: true, mode: 0o700 });
  const temporaneo = `${percorso}.${process.pid}.tmp`;
  fs.writeFileSync(temporaneo, testo, { mode: 0o600 });
  fs.renameSync(temporaneo, percorso);
}

/**
 * Carica il salvataggio (se esiste) nel registro delle stanze.
 * @returns {number} stanze ripristinate
 * @throws se il file esiste ma non è un salvataggio valido
 */
function carica(percorso, stanze, { ora = Date.now } = {}) {
  let testo;
  try {
    testo = fs.readFileSync(percorso, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  const dati = JSON.parse(testo);
  if (!dati || dati.formato !== VERSIONE_FORMATO || !Array.isArray(dati.stanze)) {
    throw new Error('formato del salvataggio non riconosciuto');
  }
  return stanze.importa(dati.stanze, { ora });
}

/** `20261116-193005`: data e ora locali per il nome del file messo da parte. */
function timbro(data) {
  const due = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}${due(data.getMonth() + 1)}${due(data.getDate())}`
    + `-${due(data.getHours())}${due(data.getMinutes())}${due(data.getSeconds())}`;
}

/**
 * Carica il salvataggio senza mai perderlo: se il file c'è ma non si riesce a
 * leggerlo (JSON rovinato, formato di un'altra versione) viene rinominato in
 * `<file>.illeggibile-<data>` prima che il salvataggio periodico lo riscriva.
 *
 * @returns {{ripristinate: number, errore: Error|null, messoDaParte: string|null, sicuro: boolean}}
 *   `sicuro` dice se si può avviare il salvataggio periodico su `percorso`: è
 *   false solo se il file è illeggibile e non si è riusciti a spostarlo.
 */
function caricaSenzaPerdere(percorso, stanze, { ora = Date.now } = {}) {
  try {
    return { ripristinate: carica(percorso, stanze, { ora }), errore: null, messoDaParte: null, sicuro: true };
  } catch (errore) {
    const base = `${percorso}.illeggibile-${timbro(new Date(ora()))}`;
    for (let i = 0; i < 100; i += 1) {
      const destinazione = i === 0 ? base : `${base}-${i}`;
      if (fs.existsSync(destinazione)) continue;
      try {
        fs.renameSync(percorso, destinazione);
        return { ripristinate: 0, errore, messoDaParte: destinazione, sicuro: true };
      } catch (e) {
        // Il file è sparito nel frattempo: non c'è più niente da proteggere.
        if (e.code === 'ENOENT') return { ripristinate: 0, errore, messoDaParte: null, sicuro: true };
        break;
      }
    }
    return { ripristinate: 0, errore, messoDaParte: null, sicuro: false };
  }
}

/**
 * Avvia il salvataggio periodico. Ritorna { salvaOra, ferma }: `salvaOra` è
 * sincrona, da chiamare anche alla chiusura del server.
 */
function avvia(percorso, stanze, { intervallo = INTERVALLO_MS } = {}) {
  let ultimo = null;
  const salvaOra = () => {
    let testo;
    try {
      testo = serializza(stanze);
      // salvatoIl cambia sempre: si confronta solo il contenuto delle stanze.
      const contenuto = testo.slice(testo.indexOf('"stanze"'));
      if (contenuto === ultimo) return false;
      scriviAtomico(percorso, testo);
      ultimo = contenuto;
      return true;
    } catch (e) {
      console.error('[salvataggio] scrittura non riuscita', percorso, e.message);
      return false;
    }
  };
  const timer = setInterval(salvaOra, intervallo);
  timer.unref();
  return { salvaOra, ferma: () => clearInterval(timer) };
}

module.exports = { percorsoDaAmbiente, serializza, scriviAtomico, carica, caricaSenzaPerdere, avvia, VERSIONE_FORMATO };
