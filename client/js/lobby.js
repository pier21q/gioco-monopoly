/**
 * client/js/lobby.js
 *
 * Schermata iniziale montata in #lobby (INTERFACCE.md §4.7). Tre viste:
 *
 *   - "ripresa"  : è in corso la riconnessione con il token salvato;
 *   - "ingresso" : nessuna stanza → scelta di nome e colore, poi "Crea una
 *                  stanza" oppure "Entra con codice" (codice precompilato dal
 *                  parametro ?stanza= dell'URL);
 *   - "sala"     : stanza in fase `lobby` → codice grande, link da copiare o
 *                  condividere, elenco dei giocatori, "Avvia partita" (solo
 *                  host, con almeno 2 giocatori connessi) ed "Esci".
 *
 * Il modulo non tiene stato di gioco: riceve lo StatoClient dallo store e
 * comunica le intenzioni dell'utente con `dispatch`. `render` è idempotente:
 * la struttura di una vista viene costruita una sola volta e poi solo
 * aggiornata, così i campi non perdono testo, focus o selezione.
 *
 * Campi dello StatoClient usati (oltre a §4.2):
 *   stato.lobby = { codiceUrl, inAttesa, ripresa, link }
 *   stato.preferenze = { nome, colore }
 *   stato.errore = { codice, messaggio, campo? }
 *
 * Azioni emesse:
 *   { tipo: 'creaStanza', nome, colore }   (app.js crea e poi entra)
 *   { tipo: 'entraStanza', codice, nome, colore }
 *   { tipo: 'avviaPartita' } · { tipo: 'esciStanza' }
 *   { tipo: 'ui:abbandonaSessione' } · { tipo: 'ui:toast', testo, livello }
 *   { tipo: 'ui:errore', errore } · { tipo: 'ui:pulisciErrore' }
 */

/** Palette dei giocatori, uguale a COLORI_GIOCATORE di server/protocollo.js. */
export const COLORI = Object.freeze([
  { valore: '#d62828', nome: 'Rosso' },
  { valore: '#1d4ed8', nome: 'Blu' },
  { valore: '#1e8e3e', nome: 'Verde' },
  { valore: '#f28c28', nome: 'Arancione' },
  { valore: '#7c3aed', nome: 'Viola' },
  { valore: '#0891b2', nome: 'Azzurro' },
  { valore: '#db2777', nome: 'Rosa' },
  { valore: '#a16207', nome: 'Ocra' },
]);

const MAX_GIOCATORI = 6;
const MIN_GIOCATORI = 2;
const NOME_MAX = 16;
const REGEX_CODICE = /^[A-Z0-9]{6}$/;

/** Quale campo evidenziare per ciascun codice di errore del server. */
const CAMPO_PER_ERRORE = {
  STANZA_INESISTENTE: 'codice',
  STANZA_PIENA: 'codice',
  PARTITA_INIZIATA: 'codice',
  NOME_NON_VALIDO: 'nome',
  NOME_OCCUPATO: 'nome',
  COLORE_NON_VALIDO: 'colore',
  COLORE_OCCUPATO: 'colore',
};

/** Messaggi più chiari (con suggerimento) per gli errori più comuni. */
const MESSAGGI_CHIARI = {
  STANZA_PIENA: 'La stanza è piena: ci sono già 6 giocatori. Chiedi a chi ti ha invitato di crearne un\'altra.',
  NOME_OCCUPATO: 'Questo nome è già usato da un altro giocatore nella stanza: scegline uno diverso.',
  COLORE_OCCUPATO: 'Questo colore è già stato scelto da un altro giocatore: prova con un altro.',
  STANZA_INESISTENTE: 'Non esiste una stanza con questo codice. Controlla di averlo scritto bene (6 caratteri).',
  PARTITA_INIZIATA: 'In questa stanza la partita è già cominciata: non si possono più aggiungere giocatori.',
};

/** Normalizza un codice stanza come fa il server ('k7pq2m ' → 'K7PQ2M'). */
export function normalizzaCodice(valore) {
  const codice = String(valore ?? '').trim().toUpperCase();
  return REGEX_CODICE.test(codice) ? codice : null;
}

/** Normalizza un nome come fa il server (spazi compressi, 1–16 caratteri). */
export function normalizzaNome(valore) {
  // eslint-disable-next-line no-control-regex
  const nome = String(valore ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return nome.length >= 1 && nome.length <= NOME_MAX ? nome : null;
}

/** Testo d'errore da mostrare: prima quello chiaro locale, poi quello del server. */
export function testoErrore(errore) {
  if (!errore) return '';
  return MESSAGGI_CHIARI[errore.codice] || errore.messaggio || 'Si è verificato un errore.';
}

// ---------------------------------------------------------------------------
// Piccoli aiuti per costruire il DOM senza innerHTML con dati utente
// ---------------------------------------------------------------------------

/**
 * Crea un elemento. `attributi` accetta anche `testo`, `classe`, `dataset`
 * e gestori `on<evento>`.
 */
function el(tag, attributi = {}, ...figli) {
  const nodo = document.createElement(tag);
  for (const [chiave, valore] of Object.entries(attributi)) {
    if (valore === undefined || valore === null || valore === false) continue;
    if (chiave === 'testo') nodo.textContent = valore;
    else if (chiave === 'classe') nodo.className = valore;
    else if (chiave === 'dataset') Object.assign(nodo.dataset, valore);
    else if (chiave === 'stile') nodo.setAttribute('style', valore);
    else if (chiave.startsWith('on') && typeof valore === 'function') {
      nodo.addEventListener(chiave.slice(2), valore);
    } else if (valore === true) nodo.setAttribute(chiave, '');
    else nodo.setAttribute(chiave, String(valore));
  }
  for (const figlio of figli.flat()) {
    if (figlio === null || figlio === undefined || figlio === false) continue;
    nodo.append(figlio instanceof Node ? figlio : document.createTextNode(String(figlio)));
  }
  return nodo;
}

/** Sposta il focus sul titolo della vista solo se l'utente non sta scrivendo altrove. */
function focusSeLibero(radice, bersaglio) {
  const attivo = document.activeElement;
  const libero = !attivo || attivo === document.body || radice.contains(attivo)
    || !document.contains(attivo);
  if (libero && bersaglio) bersaglio.focus({ preventScroll: false });
}

// ---------------------------------------------------------------------------
// Render principale
// ---------------------------------------------------------------------------

/**
 * Disegna (o aggiorna) la lobby.
 *
 * @param {HTMLElement} radice  Contenitore #lobby.
 * @param {object} stato        StatoClient (§4.2 + campi lobby/preferenze).
 * @param {(azione: object) => void} dispatch
 */
export function render(radice, stato, dispatch) {
  if (!radice) return;
  const partita = stato.partita;
  let vista;
  if (partita && partita.fase === 'lobby') vista = 'sala';
  else if (stato.lobby && stato.lobby.ripresa) vista = 'ripresa';
  else vista = 'ingresso';

  if (radice.dataset.vista !== vista) {
    radice.dataset.vista = vista;
    radice.replaceChildren();
    if (vista === 'ripresa') costruisciRipresa(radice, dispatch);
    else if (vista === 'ingresso') costruisciIngresso(radice, stato, dispatch);
    else costruisciSala(radice, dispatch);
    focusSeLibero(radice, radice.querySelector('[data-titolo-vista]'));
  }

  if (vista === 'ingresso') aggiornaIngresso(radice, stato);
  else if (vista === 'sala') aggiornaSala(radice, stato);
}

// ---------------------------------------------------------------------------
// Vista "ripresa"
// ---------------------------------------------------------------------------

function costruisciRipresa(radice, dispatch) {
  radice.append(
    el('div', { classe: 'lobby__intestazione' },
      el('h1', { id: 'lobby-titolo', classe: 'lobby__titolo', tabindex: '-1', 'data-titolo-vista': true },
        'Bentornato!'),
      el('p', { classe: 'lobby__sottotitolo', role: 'status' },
        'Sto riprendendo la tua partita…'),
    ),
    el('p', { classe: 'lobby__caricamento' },
      el('button', {
        type: 'button',
        classe: 'pulsante pulsante--secondario',
        onclick: () => dispatch({ tipo: 'ui:abbandonaSessione' }),
      }, 'Annulla e torna all\'inizio'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Vista "ingresso": nome, colore, crea / entra
// ---------------------------------------------------------------------------

function costruisciIngresso(radice, stato, dispatch) {
  const pref = stato.preferenze || {};
  const codiceUrl = (stato.lobby && stato.lobby.codiceUrl) || '';
  const coloreIniziale = COLORI.some((c) => c.valore === pref.colore) ? pref.colore : COLORI[0].valore;

  const campoNome = el('input', {
    id: 'lobby-nome',
    name: 'nome',
    classe: 'campo__input',
    type: 'text',
    autocomplete: 'nickname',
    maxlength: String(NOME_MAX),
    required: true,
    spellcheck: 'false',
    'aria-describedby': 'lobby-nome-aiuto',
    value: pref.nome || '',
  });

  const opzioniColore = COLORI.map((c) =>
    el('label', { classe: 'scelta-colore__opzione', stile: `--colore: ${c.valore}`, title: c.nome },
      el('input', {
        type: 'radio',
        name: 'colore',
        value: c.valore,
        checked: c.valore === coloreIniziale,
        'aria-label': c.nome,
      }),
    ));

  const campoCodice = el('input', {
    id: 'lobby-codice',
    name: 'codice',
    classe: 'campo__input campo__input--codice',
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: '6',
    pattern: '[A-Za-z0-9]{6}',
    placeholder: 'K7PQ2M',
    'aria-describedby': 'lobby-codice-aiuto',
    value: codiceUrl,
  });

  const zonaErrore = el('div', {
    id: 'lobby-errore',
    classe: 'messaggio messaggio--errore lobby__errore',
    role: 'alert',
  });

  const pulsanteCrea = el('button', {
    type: 'submit',
    classe: `pulsante pulsante--grande ${codiceUrl ? 'pulsante--secondario' : 'pulsante--primario'}`,
    'data-azione': 'crea',
  }, 'Crea una stanza');

  const pulsanteEntra = el('button', {
    type: 'submit',
    classe: `pulsante pulsante--grande ${codiceUrl ? 'pulsante--primario' : 'pulsante--secondario'}`,
    'data-azione': 'entra',
  }, 'Entra nella stanza');

  const riquadroCrea = el('section', { classe: 'scheda lobby__riquadro', 'aria-labelledby': 'lobby-crea-titolo' },
    el('h2', { id: 'lobby-crea-titolo' }, 'Nuova partita'),
    el('p', {}, 'Crea una stanza e invita fino a 5 amici con un link.'),
    pulsanteCrea,
  );

  const riquadroEntra = el('section', { classe: 'scheda lobby__riquadro', 'aria-labelledby': 'lobby-entra-titolo' },
    el('h2', { id: 'lobby-entra-titolo' }, 'Hai un codice?'),
    el('div', { classe: 'campo' },
      el('label', { classe: 'campo__etichetta', for: 'lobby-codice' }, 'Codice della stanza'),
      campoCodice,
      el('p', { id: 'lobby-codice-aiuto', classe: 'campo__aiuto' },
        '6 caratteri, li trovi nel link che ti hanno mandato.'),
    ),
    pulsanteEntra,
  );

  const form = el('form', {
    classe: 'lobby__form',
    novalidate: true,
    'aria-describedby': 'lobby-errore',
  },
    el('section', { classe: 'scheda lobby__riquadro', 'aria-labelledby': 'lobby-tu-titolo' },
      el('h2', { id: 'lobby-tu-titolo' }, 'Chi sei?'),
      el('div', { classe: 'campo' },
        el('label', { classe: 'campo__etichetta', for: 'lobby-nome' }, 'Il tuo nome'),
        campoNome,
        el('p', { id: 'lobby-nome-aiuto', classe: 'campo__aiuto' },
          `Da 1 a ${NOME_MAX} caratteri, diverso da quello degli altri giocatori.`),
      ),
      el('fieldset', { classe: 'scelta-colore', id: 'lobby-colore' },
        el('legend', {}, 'Colore della pedina'),
        el('div', { classe: 'scelta-colore__opzioni' }, opzioniColore),
      ),
    ),
    zonaErrore,
    // Con un link d'invito l'ingresso viene prima della creazione.
    el('div', { classe: 'lobby__colonne' },
      codiceUrl ? [riquadroEntra, riquadroCrea] : [riquadroCrea, riquadroEntra]),
  );

  // Invio del form: il pulsante premuto decide; con Invio dentro il codice si
  // entra, altrimenti vale l'azione principale (entra se c'è un invito).
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let azione = e.submitter && e.submitter.dataset.azione;
    if (!azione) {
      const dalCodice = document.activeElement === campoCodice;
      azione = dalCodice || campoCodice.value.trim() ? 'entra' : 'crea';
    }
    invia(azione);
  });

  // Gli errori di validazione locale passano dallo store come quelli del
  // server, così un render successivo non li cancella.
  function segnaErrore(campo, messaggio) {
    dispatch({ tipo: 'ui:errore', errore: { codice: 'VALIDAZIONE', messaggio, campo } });
  }

  function invia(azione) {
    const nome = normalizzaNome(campoNome.value);
    const coloreScelto = form.querySelector('input[name="colore"]:checked');
    const colore = coloreScelto ? coloreScelto.value : null;
    if (!nome) {
      segnaErrore('nome', `Scrivi un nome da 1 a ${NOME_MAX} caratteri.`);
      return;
    }
    if (azione === 'entra') {
      const codice = normalizzaCodice(campoCodice.value);
      if (!codice) {
        segnaErrore('codice', 'Il codice della stanza è fatto di 6 lettere o cifre, per esempio K7PQ2M.');
        return;
      }
      dispatch({ tipo: 'entraStanza', codice, nome, colore });
    } else {
      dispatch({ tipo: 'creaStanza', nome, colore });
    }
  }

  // Correggendo un campo l'errore che lo riguarda sparisce.
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t === campoCodice) {
      const pulito = campoCodice.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (pulito !== campoCodice.value) campoCodice.value = pulito;
    }
    if (t.getAttribute('aria-invalid') === 'true' || t.name === 'colore') {
      dispatch({ tipo: 'ui:pulisciErrore' });
      pulisciErrore(radice);
    }
  });

  radice.append(
    el('div', { classe: 'lobby__intestazione' },
      el('h1', { id: 'lobby-titolo', classe: 'lobby__titolo', tabindex: '-1', 'data-titolo-vista': true },
        'Monopoly online'),
      el('p', { classe: 'lobby__sottotitolo' },
        codiceUrl
          ? `Sei stato invitato nella stanza ${codiceUrl}: scegli nome e colore ed entra.`
          : 'Compra, scambia e costruisci con i tuoi amici, fino a 6 giocatori, direttamente dal browser.'),
    ),
    form,
  );
}

function aggiornaIngresso(radice, stato) {
  // Pulsanti bloccati mentre si attende la risposta del server.
  const occupato = Boolean(stato.lobby && stato.lobby.inAttesa);
  for (const b of radice.querySelectorAll('button[type="submit"]')) {
    b.disabled = occupato;
    b.setAttribute('aria-busy', String(occupato));
  }
  if (stato.errore) mostraErrore(radice, stato.errore);
  else pulisciErrore(radice);
}

/** Mostra un errore nella zona `role="alert"` e marca il campo interessato. */
function mostraErrore(radice, errore) {
  const zona = radice.querySelector('#lobby-errore');
  if (!zona) return;
  const testo = testoErrore(errore);
  const campo = errore.campo || (errore.dettagli && errore.dettagli.campo) || CAMPO_PER_ERRORE[errore.codice];
  const firma = `${errore.codice}|${testo}|${campo}`;
  if (zona.dataset.firma === firma) return; // già mostrato: niente annunci doppi
  zona.dataset.firma = firma;
  zona.textContent = testo;

  for (const n of radice.querySelectorAll('[aria-invalid]')) n.removeAttribute('aria-invalid');
  const bersaglio = campo === 'nome' ? radice.querySelector('#lobby-nome')
    : campo === 'codice' ? radice.querySelector('#lobby-codice')
      : campo === 'colore' ? radice.querySelector('input[name="colore"]:checked')
        : null;
  if (bersaglio) {
    if (campo !== 'colore') bersaglio.setAttribute('aria-invalid', 'true');
    else radice.querySelector('#lobby-colore')?.setAttribute('aria-invalid', 'true');
    bersaglio.focus();
    if (typeof bersaglio.select === 'function') bersaglio.select();
  }
}

function pulisciErrore(radice) {
  const zona = radice.querySelector('#lobby-errore');
  if (!zona || !zona.dataset.firma) return;
  zona.textContent = '';
  delete zona.dataset.firma;
  for (const n of radice.querySelectorAll('[aria-invalid]')) n.removeAttribute('aria-invalid');
}

// ---------------------------------------------------------------------------
// Vista "sala": stanza in attesa dell'avvio
// ---------------------------------------------------------------------------

function costruisciSala(radice, dispatch) {
  const campoLink = el('input', {
    id: 'sala-link',
    classe: 'campo__input',
    type: 'text',
    readonly: true,
    'aria-label': 'Link da condividere',
    onfocus: (e) => e.target.select(),
  });

  const pulsanteCopia = el('button', {
    type: 'button',
    classe: 'pulsante pulsante--primario',
    onclick: async () => {
      const ok = await copiaTesto(campoLink.value, campoLink);
      dispatch({
        tipo: 'ui:toast',
        testo: ok ? 'Link copiato: incollalo nella chat con i tuoi amici.' : 'Non riesco a copiare: seleziona il link e copialo a mano.',
        livello: ok ? 'successo' : 'avviso',
      });
      if (ok) {
        pulsanteCopia.textContent = 'Copiato ✓';
        setTimeout(() => { pulsanteCopia.textContent = 'Copia link'; }, 2500);
      }
    },
  }, 'Copia link');

  // Su telefono il pannello di condivisione nativo è più comodo.
  const pulsanteCondividi = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
    ? el('button', {
      type: 'button',
      classe: 'pulsante pulsante--secondario',
      onclick: () => {
        navigator.share({
          title: 'Monopoly online',
          text: 'Giochiamo a Monopoly! Entra nella mia stanza:',
          url: campoLink.value,
        }).catch(() => { /* condivisione annullata */ });
      },
    }, 'Condividi…')
    : null;

  const pulsanteAvvia = el('button', {
    type: 'button',
    id: 'sala-avvia',
    classe: 'pulsante pulsante--primario pulsante--grande',
    'aria-describedby': 'sala-suggerimento',
    onclick: () => dispatch({ tipo: 'avviaPartita' }),
  }, 'Avvia la partita');

  const pulsanteEsci = el('button', {
    type: 'button',
    classe: 'pulsante pulsante--pericolo',
    onclick: () => dispatch({ tipo: 'esciStanza' }),
  }, 'Esci dalla stanza');

  radice.append(
    el('div', { classe: 'lobby__intestazione' },
      el('h1', { id: 'lobby-titolo', classe: 'lobby__titolo', tabindex: '-1', 'data-titolo-vista': true },
        'Sala d\'attesa'),
      el('p', { classe: 'lobby__sottotitolo' },
        'Condividi il codice o il link: la partita parte quando l\'host la avvia.'),
    ),
    el('div', { classe: 'sala' },
      el('section', { classe: 'scheda sala__codice', 'aria-labelledby': 'sala-codice-titolo' },
        el('h2', { id: 'sala-codice-titolo', classe: 'campo__etichetta' }, 'Codice della stanza'),
        el('p', { id: 'sala-codice', classe: 'sala__codice-valore' }),
        el('div', { classe: 'sala__link' }, campoLink, pulsanteCopia, pulsanteCondividi),
      ),
      el('section', { classe: 'scheda lobby__riquadro', 'aria-labelledby': 'sala-giocatori-titolo' },
        el('h2', { id: 'sala-giocatori-titolo' }, 'Giocatori'),
        el('ul', {
          id: 'sala-giocatori',
          classe: 'sala__giocatori',
          role: 'list',
          'aria-live': 'polite',
          'aria-relevant': 'additions removals',
        }),
      ),
      el('div', { classe: 'sala__comandi' },
        el('div', { classe: 'lobby__riquadro' },
          pulsanteAvvia,
          el('p', { id: 'sala-suggerimento', classe: 'sala__suggerimento' }),
        ),
        pulsanteEsci,
      ),
    ),
  );
}

function aggiornaSala(radice, stato) {
  const partita = stato.partita;
  const mioId = stato.io && stato.io.giocatoreId;
  const giocatori = partita.giocatori || [];
  const host = giocatori.find((g) => g.id === partita.hostId);
  const sonoHost = Boolean(mioId) && partita.hostId === mioId;
  const connessi = giocatori.filter((g) => g.connesso).length;

  // Codice e link.
  const codice = partita.codice || (stato.io && stato.io.codice) || '';
  const nodoCodice = radice.querySelector('#sala-codice');
  if (nodoCodice.textContent !== codice) {
    nodoCodice.textContent = codice;
    nodoCodice.setAttribute('aria-label', `Codice ${codice.split('').join(' ')}`);
  }
  const link = (stato.lobby && stato.lobby.link) || linkStanza(codice);
  const campoLink = radice.querySelector('#sala-link');
  if (campoLink.value !== link) campoLink.value = link;

  // Elenco giocatori: ricostruito per intero (non contiene elementi focalizzabili).
  const lista = radice.querySelector('#sala-giocatori');
  const firma = JSON.stringify([giocatori.map((g) => [g.id, g.nome, g.colore, g.connesso]), partita.hostId, mioId]);
  if (lista.dataset.firma !== firma) {
    lista.dataset.firma = firma;
    const voci = giocatori.map((g) => {
      const etichette = [];
      if (g.id === partita.hostId) etichette.push(el('span', { classe: 'etichetta etichetta--host' }, 'host'));
      if (g.id === mioId) etichette.push(el('span', { classe: 'etichetta etichetta--io' }, 'tu'));
      if (!g.connesso) etichette.push(el('span', { classe: 'etichetta' }, 'disconnesso'));
      const colore = COLORI.find((c) => c.valore === g.colore);
      return el('li', {
        classe: `sala__giocatore${g.id === mioId ? ' sala__giocatore--io' : ''}${g.connesso ? '' : ' sala__giocatore--disconnesso'}`,
        stile: `--colore: ${g.colore}`,
      },
        el('span', { classe: 'pedina-colore', stile: `--colore: ${g.colore}`, 'aria-hidden': 'true' }),
        el('span', { classe: 'sala__nome' }, g.nome),
        el('span', { classe: 'visivamente-nascosto' }, colore ? `, pedina ${colore.nome.toLowerCase()}` : ''),
        el('span', { classe: 'sala__etichette' }, etichette),
      );
    });
    for (let i = giocatori.length; i < MAX_GIOCATORI; i += 1) {
      voci.push(el('li', { classe: 'sala__posto-libero', 'aria-hidden': 'true' }, 'Posto libero'));
    }
    lista.replaceChildren(...voci);
    const titolo = radice.querySelector('#sala-giocatori-titolo');
    titolo.textContent = `Giocatori (${giocatori.length} di ${MAX_GIOCATORI})`;
  }

  // Avvio: solo l'host, con almeno 2 giocatori connessi.
  const pulsanteAvvia = radice.querySelector('#sala-avvia');
  const suggerimento = radice.querySelector('#sala-suggerimento');
  const occupato = Boolean(stato.lobby && stato.lobby.inAttesa);
  pulsanteAvvia.hidden = !sonoHost;
  pulsanteAvvia.disabled = !sonoHost || connessi < MIN_GIOCATORI || occupato || stato.connessione !== 'connesso';
  let testo;
  if (sonoHost) {
    testo = connessi < MIN_GIOCATORI
      ? `Servono almeno ${MIN_GIOCATORI} giocatori connessi: manda il link a un amico.`
      : `Siete in ${connessi}: puoi avviare quando volete${giocatori.length < MAX_GIOCATORI ? ` (o aspettare altri giocatori, fino a ${MAX_GIOCATORI})` : ''}.`;
  } else {
    testo = host
      ? `In attesa che ${host.nome} avvii la partita…`
      : 'In attesa che l\'host avvii la partita…';
  }
  if (suggerimento.textContent !== testo) suggerimento.textContent = testo;
}

/** Link d'invito ricostruito dalla pagina corrente (se il server non l'ha dato). */
export function linkStanza(codice) {
  if (!codice) return '';
  const base = typeof location !== 'undefined' ? location.origin : '';
  return `${base}/?stanza=${encodeURIComponent(codice)}`;
}

/**
 * Copia un testo negli appunti. Usa l'API Clipboard e, se non disponibile
 * (es. pagina servita in http su un indirizzo di rete locale), ripiega sulla
 * selezione di un campo + execCommand.
 *
 * @returns {Promise<boolean>}
 */
export async function copiaTesto(testo, campo) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(testo);
      return true;
    }
  } catch {
    /* si prova il metodo alternativo */
  }
  try {
    if (campo) {
      campo.focus();
      campo.select();
      // eslint-disable-next-line deprecation/deprecation
      return document.execCommand('copy');
    }
  } catch {
    /* niente da fare */
  }
  return false;
}
