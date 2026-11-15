'use strict';

/**
 * server/protocollo.js
 *
 * Costanti, tipi di messaggio, codici di errore e validazione dei messaggi
 * WebSocket. Nessuna logica di gioco: il contratto completo è in
 * INTERFACCE.md §0, §3 e §7. Modulo puro, senza dipendenze.
 */

// ---------------------------------------------------------------------------
// Limiti e costanti
// ---------------------------------------------------------------------------

const LIMITI = Object.freeze({
  MAX_GIOCATORI: 6,
  MIN_GIOCATORI: 2,
  NOME_MIN: 1,
  NOME_MAX: 16,
  MESSAGGIO_MAX_BYTE: 16 * 1024,
  RIF_MAX: 32,
  LOG_MAX: 200,
  ERRORI_CONSECUTIVI_MAX: 3,
  CODICE_LUNGHEZZA: 6,
  // Oltre MESSAGGIO_MAX_BYTE il server risponde con un errore; oltre
  // FRAME_MAX_BYTE la libreria ws chiude la connessione (codice 1009).
  FRAME_MAX_BYTE: 64 * 1024,
  // Ping a livello WebSocket: chi non risponde entro un intervallo è disconnesso.
  HEARTBEAT_MS: 30 * 1000,
  // Anti-flood: messaggi al secondo per socket prima di scartarli.
  MESSAGGI_AL_SECONDO_MAX: 30,
});

/** Alfabeto dei codici stanza: niente I, O, 0, 1 per evitare ambiguità a voce. */
const ALFABETO_CODICE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const REGEX_CODICE = /^[A-Z0-9]{6}$/;
const REGEX_COLORE = /^#[0-9a-f]{6}$/;
const REGEX_TOKEN = /^[0-9a-f]{32}$/;
const REGEX_ID = /^[a-z0-9]{8}$/;

/** Palette consigliata per i giocatori (INTERFACCE.md §0.5). */
const COLORI_GIOCATORE = Object.freeze([
  '#d62828', // rosso
  '#1d4ed8', // blu
  '#1e8e3e', // verde
  '#f28c28', // arancione
  '#7c3aed', // viola
  '#0891b2', // azzurro
  '#db2777', // rosa
  '#a16207', // ocra
]);

// ---------------------------------------------------------------------------
// Tipi di messaggio
// ---------------------------------------------------------------------------

const MESSAGGI_CLIENT = Object.freeze([
  'creaStanza',
  'entraStanza',
  'avviaPartita',
  'azione',
  'riconnetti',
  'esciStanza',
  'ping',
]);

const MESSAGGI_SERVER = Object.freeze([
  'stanzaCreata',
  'entrato',
  'stato',
  'evento',
  'errore',
  'pong',
]);

// ---------------------------------------------------------------------------
// Codici di errore → messaggio italiano predefinito
// ---------------------------------------------------------------------------

const ERRORI = Object.freeze({
  // Protocollo e stanze
  MESSAGGIO_NON_VALIDO: 'Messaggio non valido',
  TIPO_SCONOSCIUTO: 'Tipo di messaggio sconosciuto',
  STANZA_INESISTENTE: 'La stanza non esiste',
  STANZA_PIENA: 'La stanza è piena (massimo 6 giocatori)',
  PARTITA_INIZIATA: 'La partita è già iniziata',
  NOME_NON_VALIDO: 'Nome non valido (da 1 a 16 caratteri)',
  NOME_OCCUPATO: 'Questo nome è già usato nella stanza',
  COLORE_NON_VALIDO: 'Colore non valido (formato #rrggbb)',
  COLORE_OCCUPATO: 'Questo colore è già usato nella stanza',
  GIA_IN_STANZA: 'Sei già in una stanza',
  NON_IN_STANZA: 'Non sei in nessuna stanza',
  NON_HOST: 'Solo chi ha creato la stanza può farlo',
  POCHI_GIOCATORI: 'Servono almeno 2 giocatori',
  TOKEN_NON_VALIDO: 'Sessione non valida o scaduta',
  SOLO_IN_LOBBY: 'Operazione possibile solo prima dell\'inizio della partita',
  TROPPI_MESSAGGI: 'Stai inviando troppi messaggi: rallenta',
  ERRORE_INTERNO: 'Errore interno del server: riprova',

  // Motore
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

// ---------------------------------------------------------------------------
// Normalizzazione dei valori in ingresso
// ---------------------------------------------------------------------------

/** 'k7pq2m ' → 'K7PQ2M'; qualunque altra cosa → null. */
function normalizzaCodice(valore) {
  if (typeof valore !== 'string') return null;
  const codice = valore.trim().toUpperCase();
  return REGEX_CODICE.test(codice) ? codice : null;
}

/** Nome: trim, spazi interni compressi, 1–16 caratteri, niente controlli. */
function normalizzaNome(valore) {
  if (typeof valore !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const nome = valore.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (nome.length < LIMITI.NOME_MIN || nome.length > LIMITI.NOME_MAX) return null;
  return nome;
}

/** '#D62828' → '#d62828'; non valido → null. */
function normalizzaColore(valore) {
  if (typeof valore !== 'string') return null;
  const colore = valore.trim().toLowerCase();
  return REGEX_COLORE.test(colore) ? colore : null;
}

function normalizzaToken(valore) {
  if (typeof valore !== 'string') return null;
  const token = valore.trim().toLowerCase();
  return REGEX_TOKEN.test(token) ? token : null;
}

// ---------------------------------------------------------------------------
// Costruzione messaggi server → client
// ---------------------------------------------------------------------------

/**
 * Costruisce un messaggio di errore. `extra` può contenere `rif`, `dettagli`
 * o un `messaggio` personalizzato che sostituisce quello predefinito.
 */
function errore(codice, extra = {}) {
  const messaggio = extra.messaggio || ERRORI[codice] || 'Errore';
  const out = { tipo: 'errore', codice, messaggio };
  if (extra.rif !== undefined) out.rif = extra.rif;
  if (extra.dettagli !== undefined) out.dettagli = extra.dettagli;
  return out;
}

// ---------------------------------------------------------------------------
// Analisi e validazione dei messaggi client → server
// ---------------------------------------------------------------------------

function eOggetto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function manca(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Esito negativo con codice §7 e un messaggio italiano specifico. */
function rifiuta(errore, messaggio, dettagli) {
  const out = { ok: false, errore, messaggio };
  if (dettagli !== undefined) out.dettagli = dettagli;
  return out;
}

/** Validazione del campo `codice` comune a entraStanza e riconnetti. */
function validaCampoCodice(m) {
  if (manca(m.codice)) {
    return rifiuta('MESSAGGIO_NON_VALIDO', 'Manca il codice della stanza', { campo: 'codice' });
  }
  const codice = normalizzaCodice(m.codice);
  if (!codice) {
    return rifiuta('STANZA_INESISTENTE', 'Codice stanza non valido: servono 6 lettere o cifre (es. K7PQ2M)', { campo: 'codice' });
  }
  return { ok: true, codice };
}

/** Profondità massima di annidamento accettata nel payload di un'azione. */
const PROFONDITA_AZIONE_MAX = 4;

function profondita(v, livello = 0) {
  if (livello > PROFONDITA_AZIONE_MAX) return livello;
  if (v === null || typeof v !== 'object') return livello;
  let max = livello;
  for (const figlio of Object.values(v)) {
    max = Math.max(max, profondita(figlio, livello + 1));
    if (max > PROFONDITA_AZIONE_MAX) break;
  }
  return max;
}

/**
 * Validatori per tipo: ricevono il messaggio grezzo e ritornano
 * { ok: true, messaggio } con i campi normalizzati, oppure
 * { ok: false, errore, messaggio?, dettagli? }.
 */
const VALIDATORI = {
  creaStanza() {
    return { ok: true, messaggio: { tipo: 'creaStanza' } };
  },

  entraStanza(m) {
    const c = validaCampoCodice(m);
    if (!c.ok) return c;
    if (manca(m.nome)) return rifiuta('NOME_NON_VALIDO', 'Scegli un nome per entrare nella stanza', { campo: 'nome' });
    const nome = normalizzaNome(m.nome);
    if (!nome) {
      return rifiuta('NOME_NON_VALIDO', `Il nome deve avere da ${LIMITI.NOME_MIN} a ${LIMITI.NOME_MAX} caratteri`, { campo: 'nome' });
    }
    let colore = null;
    if (!manca(m.colore)) {
      colore = normalizzaColore(m.colore);
      if (!colore) return rifiuta('COLORE_NON_VALIDO', 'Colore non valido: usa il formato #rrggbb', { campo: 'colore' });
    }
    return { ok: true, messaggio: { tipo: 'entraStanza', codice: c.codice, nome, colore } };
  },

  avviaPartita() {
    return { ok: true, messaggio: { tipo: 'avviaPartita' } };
  },

  azione(m) {
    if (m.azione === undefined || m.azione === null) {
      return rifiuta('MESSAGGIO_NON_VALIDO', 'Manca il campo "azione"', { campo: 'azione' });
    }
    if (!eOggetto(m.azione) || typeof m.azione.tipo !== 'string' || m.azione.tipo === '') {
      return rifiuta('MESSAGGIO_NON_VALIDO', 'Il campo "azione" deve essere un oggetto con un "tipo"', { campo: 'azione' });
    }
    if (profondita(m.azione) > PROFONDITA_AZIONE_MAX) {
      return rifiuta('MESSAGGIO_NON_VALIDO', 'Azione troppo annidata', { campo: 'azione' });
    }
    // La validazione dei parametri è compito del motore (AZIONE_NON_VALIDA /
    // PARAMETRI_NON_VALIDI): qui garantiamo solo la forma.
    return { ok: true, messaggio: { tipo: 'azione', azione: m.azione } };
  },

  riconnetti(m) {
    if (manca(m.codice) || manca(m.token)) {
      return rifiuta('TOKEN_NON_VALIDO', 'Per riconnettersi servono codice della stanza e token di sessione', {
        campo: manca(m.codice) ? 'codice' : 'token',
      });
    }
    const codice = normalizzaCodice(m.codice);
    const token = normalizzaToken(m.token);
    if (!codice || !token) return rifiuta('TOKEN_NON_VALIDO', 'Sessione non valida: entra di nuovo nella stanza');
    return { ok: true, messaggio: { tipo: 'riconnetti', codice, token } };
  },

  esciStanza() {
    return { ok: true, messaggio: { tipo: 'esciStanza' } };
  },

  ping() {
    return { ok: true, messaggio: { tipo: 'ping' } };
  },
};

/**
 * Analizza un frame di testo ricevuto dal client.
 *
 * @param {string|Buffer} testo
 * @returns {{ok: true, messaggio: object}
 *   | {ok: false, errore: string, messaggio?: string, dettagli?: object, rif?: string}}
 */
function analizza(testo) {
  const stringa = typeof testo === 'string' ? testo : String(testo ?? '');
  if (Buffer.byteLength(stringa, 'utf8') > LIMITI.MESSAGGIO_MAX_BYTE) {
    return rifiuta('MESSAGGIO_NON_VALIDO', `Messaggio troppo grande (massimo ${LIMITI.MESSAGGIO_MAX_BYTE} byte)`);
  }

  let grezzo;
  try {
    grezzo = JSON.parse(stringa);
  } catch {
    return rifiuta('MESSAGGIO_NON_VALIDO', 'Messaggio non valido: non è JSON');
  }
  if (!eOggetto(grezzo)) {
    return rifiuta('MESSAGGIO_NON_VALIDO', 'Messaggio non valido: serve un oggetto JSON');
  }
  if (typeof grezzo.tipo !== 'string' || grezzo.tipo === '') {
    return rifiuta('MESSAGGIO_NON_VALIDO', 'Messaggio non valido: manca il campo "tipo"', { campo: 'tipo' });
  }

  const rif = typeof grezzo.rif === 'string' && grezzo.rif.length <= LIMITI.RIF_MAX
    ? grezzo.rif
    : undefined;

  // hasOwn evita che tipi come "toString" o "__proto__" peschino dal prototipo.
  const validatore = Object.hasOwn(VALIDATORI, grezzo.tipo) ? VALIDATORI[grezzo.tipo] : null;
  if (!validatore) {
    return {
      ...rifiuta('TIPO_SCONOSCIUTO', `Tipo di messaggio sconosciuto: "${grezzo.tipo.slice(0, 32)}"`),
      rif,
    };
  }

  const esito = validatore(grezzo);
  if (!esito.ok) return { ...esito, rif };
  if (rif !== undefined) esito.messaggio.rif = rif;
  return esito;
}

module.exports = {
  LIMITI,
  ALFABETO_CODICE,
  REGEX_CODICE,
  REGEX_COLORE,
  REGEX_TOKEN,
  REGEX_ID,
  COLORI_GIOCATORE,
  MESSAGGI_CLIENT,
  MESSAGGI_SERVER,
  ERRORI,
  normalizzaCodice,
  normalizzaNome,
  normalizzaColore,
  normalizzaToken,
  errore,
  analizza,
};
