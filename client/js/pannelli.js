/**
 * client/js/pannelli.js
 *
 * Pannelli di gioco montati in #pannelli:
 *   - il turno: chi gioca, cosa deve fare, ultimo lancio, il mio denaro,
 *     avvisi (scambio in attesa, asta, debito) e la barra delle azioni;
 *   - i giocatori: colore, nome, denaro, posizione, stato (prigione,
 *     disconnesso, bancarotta) e proprietà raggruppate per colore;
 *   - la cronaca degli eventi (role=log, aria-live=polite).
 *
 * render(radice, statoClient, dispatch) è idempotente: costruisce il DOM una
 * volta e poi aggiorna solo ciò che cambia, conservando il focus.
 *
 * Su schermi stretti giocatori e cronaca diventano schede, mentre il turno con
 * le azioni diventa un cassetto fisso in basso (chiuso mostra solo l'azione
 * principale, aperto tutte).
 *
 * Il modulo apre anche i dialoghi automatici (acquisto, asta, debito, scambio
 * ricevuto, prigione, fine partita) e il dettaglio casella all'evento
 * 'casella-selezionata' del tabellone.
 */

import { CASELLE, GRUPPI } from '/dati/tabellone.js';
import * as dialoghi from '/js/dialoghi.js';

const {
  el, euro, pulsante, aggiornaPulsante, pallino, segniCase, partitaDi, mioIdDi, giocatoreDa, nomeDi,
  statoProp, proprietaDi, possiedeGruppo, indiciGruppo, nomeGruppo, descriviCostruzioni,
  motivoAzione, motivoCostruisci, motivoVendi, motivoIpoteca, motivoDisipoteca, nuovoId,
} = dialoghi;

const CAUZIONE = 50;
const MAX_VOCI_CRONACA = 200;
const QUERY_STRETTO = '(max-width: 63.99rem)';

// ---------------------------------------------------------------------------
// Stato del modulo (solo interfaccia, mai di gioco)
// ---------------------------------------------------------------------------

let ui = null;
let dispatchCorrente = () => {};
let codicePartita = null;
let ultimaChiaveLog = null;
const dialoghiMostrati = new Set();
let ascoltoCaselle = false;

function invia(azione) {
  dispatchCorrente(azione);
}

/** Per quanto si ignora un secondo clic sulla stessa azione in attesa del nuovo stato. */
const ATTESA_INVIO_MS = 800;
let versioneCorrente = null;
let invioInAttesa = null; // { tipo, versione, scade }

/**
 * Il lancio dai dadi del tabellone: vale come il pulsante "Lancia i dadi".
 * `puoLanciare` dice se adesso tocca a me lanciare, `lancia` invia il lancio.
 */
export function puoLanciare(stato) {
  const p = partitaDi(stato);
  const mio = mioIdDi(stato);
  if (!p || !mio || !Array.isArray(p.giocatori) || p.fase === 'lobby') return false;
  return !motivoAzione(p, mio, 'lanciaDadi');
}

export function lancia() {
  if (ui && ui.radice.classList.contains('pn-attesa')) return;
  inviaUnaVolta({ tipo: 'lanciaDadi' });
}

// --- Contratti nuovi nella scheda del giocatore --------------------------------

const proprietaViste = new Map(); // id giocatore -> Set degli indici già mostrati
let chiaveAvvio = null;           // codice + istante d'inizio: una partita, una consegna
let consegnaIniziale = false;     // partita appena avviata con le proprietà iniziali

/** Nessuno ha ancora lanciato: le proprietà che si vedono sono quelle date all'inizio. */
function appenaIniziata(p) {
  const log = Array.isArray(p.log) ? p.log : [];
  return log.some((e) => e && e.tipo === 'proprietaIniziali')
    && !log.some((e) => e && (e.tipo === 'dadi' || e.tipo === 'lancioOrdine'));
}

/**
 * I contratti che un giocatore non aveva entrano con un piccolo volo: alla
 * consegna iniziale uno dopo l'altro, a tempo con quelli sul tabellone; per
 * un acquisto, quando il contratto del tabellone si è posato.
 */
function segnaContrattiNuovi(li, p, g) {
  const bottoni = [...li.querySelectorAll('.pn-prop')];
  const indici = bottoni.map((b) => Number(String(b.dataset.chiave).slice(5)));
  const viste = proprietaViste.get(g.id);
  proprietaViste.set(g.id, new Set(indici));
  if (movimentoRidotto() || document.visibilityState !== 'visible') return;
  const quanti = p.giocatori.filter((x) => !x.fallito).length || 1;
  const posto = Math.max(0, p.giocatori.findIndex((x) => x.id === g.id));
  let k = 0;
  bottoni.forEach((b, j) => {
    if (viste ? viste.has(indici[j]) : !consegnaIniziale) return;
    const ritardo = viste ? 700 + k * 120 : 1500 + (k * quanti + posto) * 160;
    b.classList.add('pn-prop--nuova');
    b.style.setProperty('--ritardo', `${ritardo}ms`);
    k += 1;
  });
}

// --- Denaro che scorre -------------------------------------------------------

const DURATA_CONTEGGIO = 650;
const denaroVisto = new Map(); // 'io' o id del giocatore -> ultimo importo mostrato

function movimentoRidotto() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * L'importo non scatta: scorre dal valore di prima a quello nuovo, verde se
 * sale e rosso se scende. Senza animazioni (o a scheda nascosta) resta fermo
 * sul valore nuovo, già scritto da chi ha costruito il nodo.
 */
function scorriImporto(nodo, chiave, valore) {
  const prima = denaroVisto.get(chiave);
  denaroVisto.set(chiave, valore);
  if (!nodo || prima === undefined || prima === valore || movimentoRidotto()
    || typeof requestAnimationFrame !== 'function' || document.visibilityState !== 'visible') return;
  const inizio = performance.now();
  nodo.classList.add(valore > prima ? 'importo--sale' : 'importo--scende');
  nodo.textContent = euro(prima);
  const passo = (ora) => {
    if (!nodo.isConnected) return;
    const t = Math.min(1, Math.max(0, (ora - inizio) / DURATA_CONTEGGIO));
    const k = 1 - (1 - t) ** 3;
    nodo.textContent = euro(Math.round(prima + (valore - prima) * k));
    if (t < 1) requestAnimationFrame(passo);
    else setTimeout(() => nodo.classList.remove('importo--sale', 'importo--scende'), 600);
  };
  requestAnimationFrame(passo);
}

/**
 * Invia un'azione del turno ignorando il doppio clic: finché il server non
 * risponde con un nuovo stato (o per ATTESA_INVIO_MS) la stessa azione non
 * viene rimandata, altrimenti il secondo invio tornerebbe indietro come errore.
 */
function inviaUnaVolta(azione) {
  const adesso = Date.now();
  if (invioInAttesa && invioInAttesa.tipo === azione.tipo && invioInAttesa.versione === versioneCorrente
    && adesso < invioInAttesa.scade) {
    return;
  }
  invioInAttesa = { tipo: azione.tipo, versione: versioneCorrente, scade: adesso + ATTESA_INVIO_MS };
  invia(azione);
}

// ---------------------------------------------------------------------------
// Definizione dei pulsanti della barra azioni
// ---------------------------------------------------------------------------

const GRUPPI_AZIONI = [
  {
    etichetta: 'Turno',
    pulsanti: [
      { id: 'lancia', testo: 'Lancia i dadi', tipo: 'lanciaDadi' },
      { id: 'compra', testo: 'Compra', tipo: 'compra' },
      { id: 'asta', testo: 'Metti all’asta', tipo: 'rifiutaAcquisto' },
      { id: 'finisci', testo: 'Finisci il turno', tipo: 'finisciTurno' },
    ],
  },
  {
    etichetta: 'Proprietà',
    pulsanti: [
      { id: 'costruisci', testo: 'Costruisci', tipo: 'costruisci', gestione: 'costruisci' },
      { id: 'vendi', testo: 'Vendi case', tipo: 'vendiCasa', gestione: 'vendi' },
      { id: 'ipoteca', testo: 'Ipoteca', tipo: 'ipoteca', gestione: 'ipoteca' },
      { id: 'disipoteca', testo: 'Riscatta ipoteca', tipo: 'disipoteca', gestione: 'disipoteca' },
      { id: 'scambio', testo: 'Proponi scambio', tipo: 'proponiScambio' },
    ],
  },
  {
    etichetta: 'Prigione, debiti e uscita',
    pulsanti: [
      { id: 'cauzione', testo: 'Paga la cauzione', tipo: 'pagaCauzione' },
      { id: 'carta', testo: 'Usa la carta prigione', tipo: 'usaCartaPrigione' },
      { id: 'bancarotta', testo: 'Dichiara bancarotta', tipo: 'dichiaraBancarotta', pericolo: true },
      { id: 'abbandona', testo: 'Abbandona la partita', tipo: 'abbandona', pericolo: true },
    ],
  },
];

/** Prima proprietà idonea per una modalità di gestione, o il motivo per cui non ce n'è. */
function idoneitaGestione(p, mio, modalita) {
  const mie = proprietaDi(p, mio);
  let candidate;
  let controllo;
  let vuoto;
  if (modalita === 'costruisci') {
    candidate = mie.filter((c) => c.tipo === 'proprieta' && possiedeGruppo(p, c.gruppo, mio));
    controllo = motivoCostruisci;
    vuoto = 'Ti serve un gruppo colore completo';
  } else if (modalita === 'vendi') {
    candidate = mie.filter((c) => c.tipo === 'proprieta' && statoProp(p, c.indice).caseCostruite > 0);
    controllo = motivoVendi;
    vuoto = 'Non hai case né alberghi da vendere';
  } else if (modalita === 'ipoteca') {
    candidate = mie.filter((c) => !statoProp(p, c.indice).ipotecata);
    controllo = motivoIpoteca;
    vuoto = mie.length ? 'Le tue proprietà sono già tutte ipotecate' : 'Non hai proprietà da ipotecare';
  } else {
    candidate = mie.filter((c) => statoProp(p, c.indice).ipotecata);
    controllo = motivoDisipoteca;
    vuoto = 'Nessuna delle tue proprietà è ipotecata';
  }
  if (!candidate.length) return vuoto;
  let primoMotivo = null;
  for (const c of candidate) {
    const m = controllo(p, mio, c.indice);
    if (!m) return null;
    if (!primoMotivo) primoMotivo = m;
  }
  return primoMotivo;
}

function casellaCorrente(p, mio) {
  const io = giocatoreDa(p, mio);
  return io ? CASELLE[io.posizione] : null;
}

/** Stato di ciascun pulsante: { motivo, dettaglio, onclick }. */
function statoPulsante(def, p, mio) {
  const io = giocatoreDa(p, mio);
  const base = motivoAzione(p, mio, def.tipo);
  switch (def.id) {
    case 'lancia':
      return {
        motivo: base,
        dettaglio: !base && p.fase === 'ordine' ? 'chi fa di più comincia'
          : !base && io.inPrigione ? 'tenta il doppio' : (!base && p.turno.doppiConsecutivi > 0 ? 'hai fatto un doppio' : null),
        onclick: () => inviaUnaVolta({ tipo: 'lanciaDadi' }),
      };
    case 'compra': {
      const c = casellaCorrente(p, mio);
      const prezzo = c && c.prezzo;
      const motivo = base || (prezzo && io.denaro < prezzo ? `Ti mancano ${euro(prezzo - io.denaro)}: ipoteca o vendi, oppure mettila all’asta` : null);
      return { motivo, dettaglio: !base && prezzo ? euro(prezzo) : null, onclick: () => inviaUnaVolta({ tipo: 'compra' }) };
    }
    case 'asta':
      return { motivo: base, onclick: () => inviaUnaVolta({ tipo: 'rifiutaAcquisto' }) };
    case 'finisci':
      return { motivo: base, onclick: () => inviaUnaVolta({ tipo: 'finisciTurno' }) };
    case 'costruisci':
    case 'vendi':
    case 'ipoteca':
    case 'disipoteca':
      return {
        motivo: base || idoneitaGestione(p, mio, def.gestione),
        onclick: () => dialoghi.apri('gestione', { modalita: def.gestione }, dispatchCorrente),
      };
    case 'scambio': {
      const altri = p.giocatori.filter((g) => g.id !== mio && !g.fallito);
      return {
        motivo: base || (altri.length ? null : 'Non c’è nessuno con cui scambiare'),
        onclick: () => dialoghi.apri('scambio', { nuovo: true }, dispatchCorrente),
      };
    }
    case 'cauzione':
      return {
        motivo: base || (io.denaro < CAUZIONE ? `Ti servono ${euro(CAUZIONE)}` : null),
        dettaglio: euro(CAUZIONE),
        onclick: () => inviaUnaVolta({ tipo: 'pagaCauzione' }),
      };
    case 'carta':
      return {
        motivo: base,
        dettaglio: io.cartePrigione ? `ne hai ${io.cartePrigione}` : null,
        onclick: () => inviaUnaVolta({ tipo: 'usaCartaPrigione' }),
      };
    case 'bancarotta':
      return { motivo: base, onclick: () => dialoghi.apri('bancarotta', {}, dispatchCorrente) };
    case 'abbandona': {
      const conDebito = p.fase === 'debito' && p.debito && p.debito.giocatoreId === mio && p.debito.creditoreId;
      return {
        motivo: base,
        onclick: () => dialoghi.apri('conferma', {
          titolo: 'Abbandonare la partita?',
          testo: conDebito
            ? `Uscirai dalla partita e non potrai rientrare. Denaro e proprietà passano ${dialoghi.aChi(nomeDi(p, p.debito.creditoreId))}, a cui devi dei soldi. Gli altri continuano a giocare.`
            : 'Uscirai dalla partita e non potrai rientrare. Le tue proprietà tornano alla banca, che le mette all’asta tra gli altri giocatori. Gli altri continuano a giocare.',
          conferma: 'Abbandono la partita',
          annulla: 'Resto in gioco',
          pericolo: true,
          azione: { tipo: 'abbandona' },
        }, dispatchCorrente),
      };
    }
    default:
      return { motivo: base, onclick: () => {} };
  }
}

/** L'azione principale suggerita adesso (id di pulsante) o null. */
function azionePrincipale(p, mio) {
  if (!p.turno || p.turno.giocatoreId !== mio) return null;
  const io = giocatoreDa(p, mio);
  if (!io || io.fallito) return null;
  if (p.fase === 'daLanciare' || p.fase === 'ordine') return 'lancia';
  if (p.fase === 'mossa') return 'finisci';
  if (p.fase === 'daDecidereAcquisto') {
    const c = CASELLE[io.posizione];
    return c && c.prezzo && io.denaro >= c.prezzo ? 'compra' : 'asta';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Montaggio
// ---------------------------------------------------------------------------

function monta(radice) {
  const idTitoloTurno = nuovoId('pn-titolo');
  const idAzioni = nuovoId('pn-azioni');
  const idSezG = nuovoId('pn-sez');
  const idSezC = nuovoId('pn-sez');

  const titolo = el('h2', { class: 'pn-turno__titolo', id: idTitoloTurno });
  const guida = el('p', { class: 'pn-turno__guida' });
  const dadi = el('div', { class: 'pn-dadi', role: 'img' });
  const mioDenaro = el('p', { class: 'pn-turno__denaro' });
  const avvisi = el('div', { class: 'pn-avvisi' });

  const pulsanti = new Map();
  const azioni = el('div', { class: 'pn-azioni', id: idAzioni },
    GRUPPI_AZIONI.map((g) => el('div', { class: 'pn-azioni__gruppo', role: 'group', 'aria-label': g.etichetta },
      g.pulsanti.map((def) => {
        const b = pulsante({ testo: def.testo, chiave: `pn-${def.id}`, pericolo: !!def.pericolo });
        b.classList.add(`azione--${def.id}`);
        pulsanti.set(def.id, { def, nodo: b });
        return b;
      }))));

  const maniglia = el('button', {
    type: 'button', class: 'pn-cassetto__maniglia', 'aria-expanded': 'false', 'aria-controls': idAzioni,
  }, el('span', { class: 'pn-cassetto__tacca', 'aria-hidden': 'true' }), el('span', { class: 'pn-cassetto__testo', text: 'Tutte le azioni' }));

  const turno = el('section', { class: 'pn-turno', 'aria-labelledby': idTitoloTurno },
    el('div', { class: 'pn-turno__testa' },
      el('div', { class: 'pn-turno__intestazione' }, titolo, guida),
      dadi),
    mioDenaro,
    avvisi,
    maniglia,
    azioni);

  const tabG = el('button', { type: 'button', class: 'pn-scheda', id: nuovoId('pn-tab'), dataset: { sezione: 'giocatori' }, 'aria-controls': idSezG, text: 'Giocatori' });
  const tabC = el('button', { type: 'button', class: 'pn-scheda', id: nuovoId('pn-tab'), dataset: { sezione: 'cronaca' }, 'aria-controls': idSezC },
    'Cronaca', el('span', { class: 'pn-scheda__nuovi', hidden: true }));
  const schede = el('div', { class: 'pn-schede', 'aria-label': 'Sezioni del pannello' }, tabG, tabC);

  const elencoGiocatori = el('ul', { class: 'pn-giocatori', 'aria-label': 'Giocatori in ordine di turno' });
  const sezGiocatori = el('section', { class: 'pn-sezione pn-sezione--giocatori', id: idSezG, dataset: { sezione: 'giocatori' } },
    el('h2', { class: 'pn-sezione__titolo', text: 'Giocatori' }), elencoGiocatori);

  const cronaca = el('ol', {
    class: 'pn-cronaca', role: 'log', 'aria-live': 'off', 'aria-relevant': 'additions', tabindex: '0',
    'aria-label': 'Cronaca della partita',
  });
  const sezCronaca = el('section', { class: 'pn-sezione pn-sezione--cronaca', id: idSezC, dataset: { sezione: 'cronaca' } },
    el('h2', { class: 'pn-sezione__titolo', text: 'Cronaca' }), cronaca);

  const nodo = el('div', { class: 'pn' }, turno, schede, sezGiocatori, sezCronaca);
  radice.replaceChildren(nodo);
  radice.classList.add('pannelli-pronti');

  ui = {
    radice, nodo, turno, titolo, guida, dadi, mioDenaro, avvisi, azioni, maniglia, pulsanti,
    schede, tab: { giocatori: tabG, cronaca: tabC }, sezioni: { giocatori: sezGiocatori, cronaca: sezCronaca },
    elencoGiocatori, cronaca, schedaAttiva: 'giocatori', firmaAvvisi: '', firmeGiocatori: new Map(),
    // La cronaca segue la partita finché l'utente non la scorre all'indietro.
    cronacaSegue: true,
    stretto: window.matchMedia ? window.matchMedia(QUERY_STRETTO) : { matches: false, addEventListener() {} },
  };

  // Passando su un giocatore (o entrando con Tab fra le sue proprietà) il
  // tabellone mette in luce le sue caselle e la sua pedina.
  let inLuce = null;
  const mettiInLuce = (id) => {
    if (id === inLuce) return;
    inLuce = id;
    radice.dispatchEvent(new CustomEvent('giocatore-in-luce', { bubbles: true, detail: { id } }));
  };
  const giocatoreDi = (e) => {
    const li = e.target && e.target.closest ? e.target.closest('.pn-giocatore') : null;
    return li ? li.dataset.id : null;
  };
  elencoGiocatori.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') mettiInLuce(giocatoreDi(e)); });
  elencoGiocatori.addEventListener('pointerleave', () => mettiInLuce(null));
  elencoGiocatori.addEventListener('focusin', (e) => mettiInLuce(giocatoreDi(e)));
  elencoGiocatori.addEventListener('focusout', () => mettiInLuce(null));

  // Cassetto delle azioni (schermi stretti).
  maniglia.addEventListener('click', () => impostaCassetto(maniglia.getAttribute('aria-expanded') !== 'true'));
  turno.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.stretto.matches && maniglia.getAttribute('aria-expanded') === 'true') {
      impostaCassetto(false);
      maniglia.focus();
    }
  });
  // Dopo un'azione sul cassetto aperto lo richiudiamo, così il tabellone torna visibile.
  azioni.addEventListener('click', (e) => {
    const b = e.target.closest('.btn');
    if (b && !b.hasAttribute('aria-disabled') && ui.stretto.matches) setTimeout(() => impostaCassetto(false), 0);
  });

  // Schede (schermi stretti): frecce, Home, Fine.
  for (const t of [tabG, tabC]) {
    t.addEventListener('click', () => attivaScheda(t.dataset.sezione));
    t.addEventListener('keydown', (e) => {
      const ordine = ['giocatori', 'cronaca'];
      let k = ordine.indexOf(t.dataset.sezione);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') k = (k + 1) % ordine.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') k = (k - 1 + ordine.length) % ordine.length;
      else if (e.key === 'Home') k = 0;
      else if (e.key === 'End') k = ordine.length - 1;
      else return;
      e.preventDefault();
      attivaScheda(ordine[k]);
      ui.tab[ordine[k]].focus();
    });
  }
  const cambio = () => applicaLayout();
  if (ui.stretto.addEventListener) ui.stretto.addEventListener('change', cambio);
  else if (ui.stretto.addListener) ui.stretto.addListener(cambio);
  applicaLayout();

  // Altezza del cassetto → variabile CSS (spazio in fondo e posizione dei toast).
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const h = ui.stretto.matches ? Math.ceil(turno.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--pn-cassetto', `${h}px`);
    }).observe(turno);
  }

  cronaca.addEventListener('scroll', () => {
    // Nascosta (scheda non attiva) non ha altezza: lì la posizione non dice niente.
    if (cronaca.clientHeight > 0) ui.cronacaSegue = vicinoAlFondo(cronaca);
    if (vicinoAlFondo(cronaca)) segnaCronacaLetta();
  });
}

/**
 * Porta la cronaca all'ultimo evento, subito: con lo scorrimento morbido del
 * CSS un secondo evento arrivato durante l'animazione la trovava "non in
 * fondo" e la cronaca smetteva di seguire la partita.
 */
function cronacaInFondo() {
  const lista = ui.cronaca;
  if (typeof lista.scrollTo === 'function') lista.scrollTo({ top: lista.scrollHeight, behavior: 'instant' });
  else lista.scrollTop = lista.scrollHeight;
}

function impostaCassetto(aperto) {
  if (!ui) return;
  ui.maniglia.setAttribute('aria-expanded', aperto ? 'true' : 'false');
  ui.turno.classList.toggle('pn-turno--aperto', aperto);
  ui.maniglia.querySelector('.pn-cassetto__testo').textContent = aperto ? 'Nascondi le azioni' : 'Tutte le azioni';
}

/** Ruoli ARIA delle schede solo quando le schede sono davvero visibili. */
function applicaLayout() {
  if (!ui) return;
  const stretto = ui.stretto.matches;
  ui.nodo.classList.toggle('pn--stretto', stretto);
  if (stretto) {
    ui.schede.setAttribute('role', 'tablist');
    for (const [nome, t] of Object.entries(ui.tab)) {
      t.setAttribute('role', 'tab');
      ui.sezioni[nome].setAttribute('role', 'tabpanel');
      ui.sezioni[nome].setAttribute('aria-labelledby', t.id);
    }
    attivaScheda(ui.schedaAttiva);
  } else {
    ui.schede.removeAttribute('role');
    for (const [nome, t] of Object.entries(ui.tab)) {
      t.removeAttribute('role');
      t.removeAttribute('aria-selected');
      t.removeAttribute('tabindex');
      ui.sezioni[nome].removeAttribute('role');
      ui.sezioni[nome].removeAttribute('aria-labelledby');
      ui.sezioni[nome].hidden = false;
    }
    impostaCassetto(false);
    // Riempita mentre era nascosta in una scheda, la cronaca era rimasta in cima.
    if (ui.cronacaSegue) cronacaInFondo();
  }
}

function attivaScheda(nome) {
  if (!ui) return;
  ui.schedaAttiva = nome;
  if (!ui.stretto.matches) return;
  for (const [n, t] of Object.entries(ui.tab)) {
    const attiva = n === nome;
    t.setAttribute('aria-selected', attiva ? 'true' : 'false');
    t.setAttribute('tabindex', attiva ? '0' : '-1');
    ui.sezioni[n].hidden = !attiva;
  }
  if (nome === 'cronaca') {
    ui.cronacaSegue = true;
    cronacaInFondo();
    segnaCronacaLetta();
  }
}

// ---------------------------------------------------------------------------
// Sezione turno
// ---------------------------------------------------------------------------

const FACCE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function testoGuida(p, mio) {
  const diTurno = giocatoreDa(p, p.turno && p.turno.giocatoreId);
  const mioTurno = diTurno && diTurno.id === mio;
  const nome = diTurno ? diTurno.nome : '';
  const io = giocatoreDa(p, mio);
  const casella = diTurno ? CASELLE[diTurno.posizione] : null;
  switch (p.fase) {
    case 'ordine': {
      const spareggio = p.ordine && p.ordine.giro > 1;
      if (mioTurno) return spareggio ? 'Spareggio: lancia di nuovo i dadi.' : 'Lancia i dadi: chi fa di più comincia.';
      return spareggio ? `Spareggio: tocca ${dialoghi.aChi(nome)} rilanciare.` : `Si decide chi comincia: tocca ${dialoghi.aChi(nome)} lanciare.`;
    }
    case 'daLanciare':
      if (!mioTurno) return diTurno && diTurno.inPrigione ? `${nome} è in prigione e sceglie come uscire.` : `${nome} deve lanciare i dadi.`;
      if (io.inPrigione) return 'Sei in prigione: tenta il doppio, paga la cauzione o usa la carta.';
      return p.turno.doppiConsecutivi > 0 ? 'Hai fatto un doppio: lancia di nuovo.' : 'Lancia i dadi per muovere la tua pedina.';
    case 'mossa':
      return mioTurno ? 'Costruisci, scambia o ipoteca se vuoi, poi finisci il turno.' : `${nome} può ancora costruire o scambiare, poi finisce il turno.`;
    case 'daDecidereAcquisto':
      return mioTurno ? `Sei su ${casella ? casella.nome : 'una proprietà libera'}: comprala o mettila all’asta.` : `${nome} decide se comprare ${casella ? casella.nome : 'la proprietà'}.`;
    case 'asta': {
      const a = p.asta;
      if (!a) return 'Asta in corso.';
      const c = CASELLE[a.casella];
      return a.migliorOfferenteId
        ? `Asta per ${c.nome}: in testa ${a.migliorOfferenteId === mio ? 'tu' : nomeDi(p, a.migliorOfferenteId)} con ${euro(a.offertaMassima)}.`
        : `Asta per ${c.nome}: ancora nessuna offerta.`;
    }
    case 'debito': {
      const d = p.debito;
      if (!d) return 'Un giocatore deve saldare un debito.';
      if (d.giocatoreId === mio) return `Devi ${euro(d.importo)} ${dialoghi.aChi(nomeDi(p, d.creditoreId))}: vendi o ipoteca per pagare.`;
      return `${nomeDi(p, d.giocatoreId)} deve ${euro(d.importo)} ${dialoghi.aChi(d.creditoreId === mio ? 'te' : nomeDi(p, d.creditoreId))}.`;
    }
    case 'finePartita':
      return p.vincitoreId ? `Vince ${p.vincitoreId === mio ? 'tu' : nomeDi(p, p.vincitoreId)}.` : 'La partita è finita.';
    default:
      return '';
  }
}

function disegnaTurno(p, mio) {
  const diTurno = giocatoreDa(p, p.turno && p.turno.giocatoreId);
  const io = giocatoreDa(p, mio);
  const mioTurno = diTurno && diTurno.id === mio;

  // Titolo
  let firmaTitolo;
  let contenutoTitolo;
  if (p.fase === 'finePartita') {
    firmaTitolo = 'fine';
    contenutoTitolo = ['Partita finita'];
  } else if (p.fase === 'ordine') {
    firmaTitolo = `ordine|${mioTurno}|${diTurno ? diTurno.id : ''}|${p.ordine ? p.ordine.giro : ''}`;
    contenutoTitolo = [
      diTurno && !mioTurno ? pallino(diTurno.colore) : null,
      mioTurno ? 'Tocca a te' : `Tocca ${dialoghi.aChi(diTurno ? diTurno.nome : '…')}`,
      el('span', { class: 'pn-turno__numero', text: p.ordine && p.ordine.giro > 1 ? 'Spareggio' : 'Chi comincia' }),
    ];
  } else if (mioTurno) {
    firmaTitolo = `mio|${p.turno.numero}`;
    contenutoTitolo = ['Tocca a te', el('span', { class: 'pn-turno__numero', text: `Turno ${p.turno.numero}` })];
  } else {
    firmaTitolo = `altro|${diTurno ? diTurno.id : ''}|${diTurno && diTurno.connesso}|${p.turno && p.turno.numero}`;
    contenutoTitolo = [
      diTurno ? pallino(diTurno.colore) : null,
      `Tocca ${dialoghi.aChi(diTurno ? diTurno.nome : '…')}`,
      diTurno && !diTurno.connesso ? el('span', { class: 'distintivo distintivo--avviso', text: 'disconnesso' }) : null,
      el('span', { class: 'pn-turno__numero', text: `Turno ${p.turno ? p.turno.numero : ''}` }),
    ];
  }
  if (ui.titolo.dataset.firma !== firmaTitolo) {
    ui.titolo.replaceChildren(...contenutoTitolo.filter(Boolean).map((x) => (typeof x === 'string' ? document.createTextNode(x) : x)));
    ui.titolo.dataset.firma = firmaTitolo;
  }
  ui.turno.classList.toggle('pn-turno--mio', !!mioTurno && p.fase !== 'finePartita');
  ui.turno.style.setProperty('--colore-turno', diTurno ? diTurno.colore : 'transparent');

  const guida = testoGuida(p, mio);
  if (ui.guida.textContent !== guida) ui.guida.textContent = guida;

  // Dadi
  const d = Array.isArray(p.dadi) ? p.dadi : null;
  const firmaDadi = d ? `${d[0]}-${d[1]}-${p.versione}` : 'nessuno';
  if (ui.dadi.dataset.firma !== firmaDadi) {
    ui.dadi.dataset.firma = firmaDadi;
    if (d) {
      const doppio = d[0] === d[1];
      ui.dadi.setAttribute('aria-label', `Ultimo lancio: ${d[0]} e ${d[1]}${doppio ? ', doppio' : ''}`);
      const prima = ui.dadi.dataset.valori;
      ui.dadi.dataset.valori = `${d[0]}-${d[1]}`;
      ui.dadi.replaceChildren(
        el('span', { class: 'pn-dado', 'aria-hidden': 'true', text: FACCE[d[0]] || '' }),
        el('span', { class: 'pn-dado', 'aria-hidden': 'true', text: FACCE[d[1]] || '' }));
      ui.dadi.classList.toggle('pn-dadi--doppio', doppio);
      if (prima && prima !== ui.dadi.dataset.valori) {
        ui.dadi.classList.remove('pn-dadi--nuovo');
        void ui.dadi.offsetWidth;
        ui.dadi.classList.add('pn-dadi--nuovo');
      }
      ui.dadi.hidden = false;
    } else {
      ui.dadi.hidden = true;
      ui.dadi.replaceChildren();
    }
  }

  // Il mio denaro
  const testoDenaro = io ? (io.fallito ? 'Sei fuori dalla partita' : euro(io.denaro)) : '';
  if (ui.mioDenaro.dataset.firma !== testoDenaro) {
    ui.mioDenaro.dataset.firma = testoDenaro;
    ui.mioDenaro.replaceChildren(...(io && !io.fallito
      ? [el('span', { class: 'pn-turno__denaro-etichetta', text: 'Il tuo denaro' }), el('strong', { class: 'importo', text: testoDenaro })]
      : [testoDenaro]));
    ui.mioDenaro.hidden = !io;
    if (io && !io.fallito) scorriImporto(ui.mioDenaro.querySelector('.importo'), 'io', io.denaro);
  }

  disegnaAvvisi(p, mio);

  // Pulsanti
  const principale = azionePrincipale(p, mio);
  const fuori = !io || io.fallito || p.fase === 'finePartita';
  ui.azioni.hidden = fuori;
  ui.maniglia.hidden = fuori;
  for (const { def, nodo } of ui.pulsanti.values()) {
    const st = io ? statoPulsante(def, p, mio) : { motivo: 'Non partecipi a questa partita', onclick: () => {} };
    // Senza aste (variante) "Metti all'asta" diventa semplicemente "Non comprare".
    const testo = def.id === 'asta' && p.regole && p.regole.aste === false ? 'Non comprare' : def.testo;
    aggiornaPulsante(nodo, { testo, dettaglio: st.dettaglio || null, motivo: st.motivo, onclick: st.onclick, primario: def.id === principale });
    nodo.classList.toggle('azione--principale', def.id === principale);
  }
  ui.turno.classList.toggle('pn-turno--con-principale', !!principale);
}

function disegnaAvvisi(p, mio) {
  const voci = [];
  const s = p.scambio;
  if (s && p.fase !== 'finePartita') {
    if (s.aId === mio) voci.push(['scambio', 'info', `${nomeDi(p, s.daId)} ti propone uno scambio`, 'Vedi la proposta', () => dialoghi.apri('scambio', {}, dispatchCorrente)]);
    else if (s.daId === mio) voci.push(['scambio', 'neutro', `Hai proposto uno scambio ${dialoghi.aChi(nomeDi(p, s.aId))}`, 'Vedi o ritira', () => dialoghi.apri('scambio', {}, dispatchCorrente)]);
    else voci.push(['scambio', 'neutro', `Scambio in attesa tra ${nomeDi(p, s.daId)} e ${nomeDi(p, s.aId)}`, 'Vedi', () => dialoghi.apri('scambio', {}, dispatchCorrente)]);
  }
  if (p.fase === 'asta' && p.asta) {
    const partecipo = p.asta.partecipanti.includes(mio) && !p.asta.passati.includes(mio);
    voci.push(['asta', partecipo ? 'info' : 'neutro', `Asta per ${CASELLE[p.asta.casella].nome}`, partecipo ? 'Fai un’offerta' : 'Segui l’asta', () => dialoghi.apri('asta', {}, dispatchCorrente)]);
  }
  if (p.fase === 'debito' && p.debito && p.debito.giocatoreId === mio) {
    voci.push(['debito', 'pericolo', `Devi pagare ${euro(p.debito.importo)}`, 'Gestisci il debito', () => dialoghi.apri('debito', {}, dispatchCorrente)]);
  }
  if (p.fase === 'finePartita') {
    voci.push(['fine', 'info', 'La partita è finita', 'Vedi la classifica', () => dialoghi.apri('finePartita', {}, dispatchCorrente)]);
  }
  // Variante del Parcheggio gratuito: il piatto sempre in vista.
  if (p.regole && p.regole.parcheggio === true && p.fase !== 'finePartita') {
    voci.push(['piatto', 'neutro', `Piatto del Parcheggio gratuito: ${euro(p.piatto || 0)}`, null, null]);
  }
  if (p.fase === 'ordine') {
    voci.push(['ordine', 'info', 'Si lanciano i dadi per decidere chi comincia', 'Vedi i lanci', () => dialoghi.apri('ordine', {}, dispatchCorrente)]);
  }
  // Chi ha perso la connessione: se è di turno il gioco va avanti per lui dopo
  // 45 secondi; in ogni caso dopo 5 minuti esce dalla partita
  // (TOLLERANZA_DISCONNESSIONE_MS e ABBANDONO_DISCONNESSO_MS sul server).
  const diTurno = giocatoreDa(p, p.turno && p.turno.giocatoreId);
  const turnoFermo = diTurno && !diTurno.connesso && !diTurno.fallito && p.fase !== 'finePartita' && diTurno.id !== mio;
  if (turnoFermo) {
    voci.push(['attesa', 'avviso', `${diTurno.nome} ha perso la connessione: se non torna entro un minuto circa ${p.fase === 'ordine'
      ? 'il gioco lancia i dadi al posto suo' : 'il turno passa al giocatore successivo'}, e se non rientra entro 5 minuti esce dalla partita.`, null, null]);
  }
  const assenti = p.fase === 'finePartita' ? []
    : p.giocatori.filter((g) => !g.connesso && !g.fallito && g.id !== mio && !(turnoFermo && g.id === diTurno.id));
  if (assenti.length) {
    const nomi = assenti.map((g) => g.nome).join(', ');
    voci.push(['assenti', 'neutro', assenti.length === 1
      ? `${nomi} ha perso la connessione: se non rientra entro 5 minuti esce dalla partita e i suoi beni tornano alla banca.`
      : `${nomi} hanno perso la connessione: chi non rientra entro 5 minuti esce dalla partita e i suoi beni tornano alla banca.`, null, null]);
  }
  const io = giocatoreDa(p, mio);
  if (io && io.fallito && p.fase !== 'finePartita') {
    voci.push(['fallito', 'neutro', 'Sei in bancarotta: puoi continuare a guardare la partita.', null, null]);
  }

  const firma = voci.map((v) => `${v[0]}|${v[2]}|${v[3]}`).join('§');
  if (firma === ui.firmaAvvisi) {
    // Aggiorniamo solo i gestori (le closure fanno riferimento allo stato corrente).
    return;
  }
  ui.firmaAvvisi = firma;
  const attivo = document.activeElement;
  const chiaveAttiva = ui.avvisi.contains(attivo) ? attivo.dataset.chiave : null;
  ui.avvisi.replaceChildren(...voci.map(([id, livello, testo, etichetta, azione]) => el('div', { class: `pn-avviso pn-avviso--${livello}` },
    el('p', { class: 'pn-avviso__testo', text: testo }),
    etichetta ? el('button', { type: 'button', class: 'btn btn--piccolo', dataset: { chiave: `avv-${id}` }, text: etichetta, onclick: azione }) : null)));
  ui.avvisi.hidden = voci.length === 0;
  if (chiaveAttiva) {
    const dest = ui.avvisi.querySelector(`[data-chiave="${chiaveAttiva}"]`);
    if (dest) dest.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------------------
// Sezione giocatori
// ---------------------------------------------------------------------------

function firmaGiocatore(p, g, mio) {
  const props = proprietaDi(p, g.id).map((c) => {
    const s = statoProp(p, c.indice);
    return `${c.indice}:${s.caseCostruite}:${s.ipotecata ? 1 : 0}`;
  }).join(',');
  const diTurno = p.turno && p.turno.giocatoreId === g.id && p.fase !== 'finePartita';
  return [g.nome, g.colore, g.denaro, g.posizione, g.inPrigione, g.turniInPrigione, g.cartePrigione,
    g.connesso, g.fallito, diTurno, g.id === mio, g.id === p.vincitoreId, p.hostId === g.id, props].join('|');
}

function voceGiocatore(p, g, mio) {
  const diTurno = p.turno && p.turno.giocatoreId === g.id && p.fase !== 'finePartita';
  const casella = CASELLE[g.posizione];
  const distintivi = [];
  if (g.id === p.vincitoreId) distintivi.push(['ok', 'vincitore']);
  if (diTurno) distintivi.push(['turno', 'di turno']);
  if (g.fallito) distintivi.push(['pericolo', dialoghi.haAbbandonato(p, g.id) ? 'ha abbandonato' : 'in bancarotta']);
  if (g.inPrigione && !g.fallito) distintivi.push(['avviso', `in prigione, tentativo ${Math.min(3, (g.turniInPrigione || 0) + 1)} di 3`]);
  if (!g.connesso && !g.fallito) distintivi.push(['neutro', 'disconnesso']);
  if (g.cartePrigione > 0) distintivi.push(['neutro', g.cartePrigione === 1 ? '1 carta esci gratis' : `${g.cartePrigione} carte esci gratis`]);

  const mie = proprietaDi(p, g.id);
  const perGruppo = new Map();
  for (const c of mie) {
    if (!perGruppo.has(c.gruppo)) perGruppo.set(c.gruppo, []);
    perGruppo.get(c.gruppo).push(c);
  }

  const proprieta = mie.length
    ? el('ul', { class: 'pn-gruppi', 'aria-label': `Proprietà di ${g.nome}` },
      [...perGruppo.entries()].map(([gruppo, caselle]) => {
        const totale = indiciGruppo(gruppo).length;
        const completo = caselle.length === totale && totale > 1;
        const colore = (GRUPPI[gruppo] && GRUPPI[gruppo].colore) || '#4a6168';
        return el('li', { class: `pn-gruppo${completo ? ' pn-gruppo--completo' : ''}`, style: { '--colore': colore } },
          el('span', { class: 'pn-gruppo__nome' },
            nomeGruppo(gruppo),
            el('span', { class: 'pn-gruppo__conteggio', text: completo ? 'gruppo completo' : `${caselle.length} di ${totale}` })),
          el('ul', { class: 'pn-gruppo__caselle' }, caselle.map((c) => {
            const s = statoProp(p, c.indice);
            const stato = [];
            if (c.tipo === 'proprieta' && s.caseCostruite) stato.push(descriviCostruzioni(s.caseCostruite));
            if (s.ipotecata) stato.push('ipotecata');
            return el('li', null, el('button', {
              type: 'button',
              class: `pn-prop${s.ipotecata ? ' pn-prop--ipotecata' : ''}`,
              dataset: { chiave: `prop-${c.indice}` },
              'aria-label': `${c.nome}${stato.length ? `, ${stato.join(', ')}` : ''}. Apri il contratto`,
              onclick: () => {
                invia({ tipo: 'ui:seleziona', indice: c.indice });
                dialoghi.apri('dettaglioCasella', { indice: c.indice }, dispatchCorrente);
              },
            },
            el('span', { class: 'pn-prop__nome', text: c.nome }),
            c.tipo === 'proprieta' && s.caseCostruite ? segniCase(s.caseCostruite) : null,
            s.ipotecata ? el('span', { class: 'pn-prop__ipoteca', 'aria-hidden': 'true', text: 'ipotecata' }) : null));
          })));
      }))
    : el('p', { class: 'pn-giocatore__vuoto', text: g.fallito ? 'Nessun bene' : 'Ancora nessuna proprietà' });

  const iniziale = (g.nome || '?').trim().charAt(0).toUpperCase();
  return el('li', {
    class: ['pn-giocatore', diTurno && 'pn-giocatore--turno', g.fallito && 'pn-giocatore--fallito', !g.connesso && 'pn-giocatore--disconnesso', g.id === mio && 'pn-giocatore--mio'].filter(Boolean).join(' '),
    style: { '--colore': g.colore, '--su-colore': dialoghi.testoSu(g.colore) },
    'aria-current': diTurno ? 'true' : null,
    dataset: { id: g.id },
  },
  el('div', { class: 'pn-giocatore__testa' },
    el('span', { class: 'pn-pedina', 'aria-hidden': 'true', text: iniziale }),
    el('div', { class: 'pn-giocatore__chi' },
      el('h3', { class: 'pn-giocatore__nome' }, g.nome, g.id === mio ? el('span', { class: 'pn-giocatore__tu', text: ' (tu)' }) : null),
      el('p', { class: 'pn-giocatore__dove', text: g.fallito ? 'fuori dalla partita' : (g.inPrigione ? 'in prigione' : `su ${casella ? casella.nome : '…'}`) })),
    el('p', { class: 'pn-giocatore__denaro' },
      el('span', { class: 'visivamente-nascosto', text: 'Denaro: ' }),
      el('span', { class: 'importo', text: euro(g.denaro) }))),
  distintivi.length ? el('ul', { class: 'pn-distintivi', 'aria-label': 'Stato' },
    distintivi.map(([liv, t]) => el('li', { class: `distintivo distintivo--${liv}`, text: t }))) : null,
  proprieta);
}

function disegnaGiocatori(p, mio) {
  const lista = ui.elencoGiocatori;
  const ids = p.giocatori.map((g) => g.id);
  // Rimuove chi non c'è più.
  for (const li of [...lista.children]) {
    if (!ids.includes(li.dataset.id)) {
      li.remove();
      ui.firmeGiocatori.delete(li.dataset.id);
    }
  }
  p.giocatori.forEach((g, k) => {
    const firma = firmaGiocatore(p, g, mio);
    let li = lista.querySelector(`:scope > [data-id="${CSS.escape(g.id)}"]`);
    if (!li || ui.firmeGiocatori.get(g.id) !== firma) {
      const nuovo = voceGiocatore(p, g, mio);
      const attivo = document.activeElement;
      const chiave = li && li.contains(attivo) ? attivo.dataset.chiave : null;
      if (li) li.replaceWith(nuovo);
      else lista.append(nuovo);
      li = nuovo;
      ui.firmeGiocatori.set(g.id, firma);
      if (!g.fallito) scorriImporto(li.querySelector('.pn-giocatore__denaro .importo'), g.id, g.denaro);
      segnaContrattiNuovi(li, p, g);
      if (chiave) {
        const dest = li.querySelector(`[data-chiave="${CSS.escape(chiave)}"]`);
        if (dest) dest.focus({ preventScroll: true });
      }
    }
    if (lista.children[k] !== li) lista.insertBefore(li, lista.children[k] || null);
  });
}

// ---------------------------------------------------------------------------
// Cronaca
// ---------------------------------------------------------------------------

function chiaveEvento(ev) {
  return `${ev.t}|${ev.tipo}|${ev.giocatoreId || ''}|${ev.testo || ''}`;
}

function nomeCasella(i) {
  return CASELLE[i] ? CASELLE[i].nome : `casella ${i}`;
}

/** Testo leggibile di un evento: quello del server se c'è, altrimenti composto qui. */
export function testoEvento(ev, p) {
  if (ev.testo) return ev.testo;
  const d = ev.dati || {};
  const chi = nomeDi(p, ev.giocatoreId, { banca: 'La banca' });
  switch (ev.tipo) {
    case 'giocatoreEntrato': return `${d.nome || chi} entra nella stanza`;
    case 'giocatoreUscito': return `${chi} esce dalla stanza`;
    case 'connessione': return d.connesso ? `${chi} si è riconnesso` : `${chi} si è disconnesso`;
    case 'partitaIniziata': return `La partita comincia: ${d.denaroIniziale ? `${euro(d.denaroIniziale)} a testa` : 'buon divertimento'}${d.costruzione === 'sosta' ? '. Si costruisce solo sul colore su cui ci si ferma' : ''}`;
    case 'turno': return `Turno ${d.numero}: tocca ${dialoghi.aChi(chi)}`;
    case 'dadi': return d.dadi ? `${chi} lancia ${d.dadi[0]} e ${d.dadi[1]}${d.doppio ? ' (doppio)' : ''}` : `${chi} lancia i dadi`;
    case 'lancioOrdine': return d.dadi ? `${chi} lancia ${d.dadi[0]} e ${d.dadi[1]}: ${d.totale}` : `${chi} lancia i dadi`;
    case 'spareggio': return `Spareggio tra ${(d.giocatori || []).map((id) => nomeDi(p, id)).join(', ')}`;
    case 'ordineDeciso': return `Comincia ${chi}`;
    case 'regoleImpostate': return `${chi} sceglie le regole della partita`;
    case 'proprietaIniziali': return `${chi} riceve ${(d.caselle || []).map(nomeCasella).join(', ')}`;
    case 'piatto': return `${chi} vince il piatto del Parcheggio gratuito: ${euro(d.importo)}`;
    case 'acquistoRifiutato': return `${chi} non compra ${nomeCasella(d.casella)}`;
    case 'movimento': return `${chi} va su ${nomeCasella(d.a)}`;
    case 'passaggioVia': return `${chi} passa dal Via e ritira ${euro(d.importo)}`;
    case 'acquisto': return `${chi} compra ${nomeCasella(d.casella)} per ${euro(d.prezzo)}${d.tramite === 'asta' ? ' all’asta' : ''}`;
    case 'affitto': return `${nomeDi(p, d.daId)} paga ${euro(d.importo)} di affitto ${dialoghi.aChi(nomeDi(p, d.aId))} per ${nomeCasella(d.casella)}`;
    case 'tassa': return `${chi} paga ${euro(d.importo)} di ${nomeCasella(d.casella).toLowerCase()}`;
    case 'carta': return `${chi} pesca ${d.mazzo === 'imprevisti' ? 'Imprevisti' : 'Probabilità'}: ${(d.carta && d.carta.testo) || ''}`;
    case 'pagamento': return `${nomeDi(p, d.daId)} paga ${euro(d.importo)} ${dialoghi.aChi(nomeDi(p, d.aId))}`;
    case 'prigione': return d.motivo === 'treDoppi' ? `${chi} fa tre doppi e finisce in prigione` : `${chi} va in prigione`;
    case 'uscitaPrigione': return `${chi} esce di prigione`;
    case 'astaInizio': return `Si apre l’asta per ${nomeCasella(d.casella)}`;
    case 'astaOfferta': return `${chi} offre ${euro(d.importo)} per ${nomeCasella(d.casella)}`;
    case 'astaPasso': return `${chi} passa`;
    case 'astaFine': return d.vincitoreId ? `${nomeDi(p, d.vincitoreId)} vince l’asta per ${nomeCasella(d.casella)} con ${euro(d.importo)}` : `Nessuna offerta: ${nomeCasella(d.casella)} resta alla banca`;
    case 'costruzione': return `${chi} costruisce su ${nomeCasella(d.casella)} (${descriviCostruzioni(d.caseCostruite)})`;
    case 'vendita': return `${chi} vende una costruzione su ${nomeCasella(d.casella)} e incassa ${euro(d.ricavo)}`;
    case 'ipoteca': return `${chi} ipoteca ${nomeCasella(d.casella)} e incassa ${euro(d.importo)}`;
    case 'disipoteca': return `${chi} riscatta ${nomeCasella(d.casella)} per ${euro(d.importo)}`;
    case 'scambioProposto': return `${chi} propone uno scambio ${dialoghi.aChi(nomeDi(p, d.scambio && d.scambio.aId))}`;
    case 'scambioAccettato': return `Scambio concluso tra ${nomeDi(p, d.scambio && d.scambio.daId)} e ${nomeDi(p, d.scambio && d.scambio.aId)}`;
    case 'scambioRifiutato': return d.motivo === 'scaduto' || !d.daId ? 'Proposta di scambio scaduta senza risposta' : `Scambio annullato da ${nomeDi(p, d.daId)}`;
    case 'abbandono':
      if (d.motivo === 'assente') return `${chi} non rientra da troppo tempo ed esce dalla partita`;
      return d.motivo === 'debito' ? `${chi} non ha saldato il debito in tempo ed esce dalla partita` : `${chi} abbandona la partita`;
    case 'host': return `${chi} è il nuovo host della stanza`;
    case 'admin': return d.giocatoreId ? `${chi} è l’admin della stanza` : 'La stanza non ha più un admin';
    case 'debito': return `${chi} deve ${euro(d.importo)} ${dialoghi.aChi(nomeDi(p, d.creditoreId))}`;
    case 'debitoSaldato': return `${chi} salda il debito di ${euro(d.importo)}`;
    case 'bancarotta': return `${chi} dichiara bancarotta`;
    case 'finePartita': return `Partita finita: vince ${nomeDi(p, d.vincitoreId)}`;
    default: return `${chi}: ${ev.tipo}`;
  }
}

const TIPI_RILIEVO = new Set(['ordineDeciso', 'spareggio', 'piatto', 'acquisto', 'astaFine', 'bancarotta', 'finePartita', 'scambioAccettato', 'prigione', 'debito']);

function voceCronaca(ev, p) {
  const g = giocatoreDa(p, ev.giocatoreId);
  const t = Number(ev.t);
  const data = new Date(Number.isFinite(t) && t > 0 ? t : Date.now());
  const ora = `${String(data.getHours()).padStart(2, '0')}:${String(data.getMinutes()).padStart(2, '0')}`;
  return el('li', { class: `pn-evento pn-evento--${ev.tipo}${TIPI_RILIEVO.has(ev.tipo) ? ' pn-evento--rilievo' : ''}`, style: { '--colore': g ? g.colore : 'var(--colore-bordo-forte, #8f8a74)' } },
    el('time', { class: 'pn-evento__ora', datetime: data.toISOString(), text: ora }),
    el('span', { class: 'pn-evento__testo', text: testoEvento(ev, p) }));
}

function vicinoAlFondo(n) {
  return n.scrollHeight - n.scrollTop - n.clientHeight < 48;
}

function segnaCronacaLetta() {
  const badge = ui && ui.tab.cronaca.querySelector('.pn-scheda__nuovi');
  if (badge) {
    badge.hidden = true;
    badge.textContent = '';
    ui.nonLetti = 0;
  }
}

function disegnaCronaca(p) {
  const lista = ui.cronaca;
  const log = Array.isArray(p.log) ? p.log : [];
  const chiavi = log.map(chiaveEvento);
  let da = 0;
  if (ultimaChiaveLog !== null) {
    const k = chiavi.lastIndexOf(ultimaChiaveLog);
    if (k === -1) lista.replaceChildren();
    else da = k + 1;
  }
  const nuovi = log.slice(da);
  if (!nuovi.length) return;
  const primoGiro = ultimaChiaveLog === null;
  if (primoGiro) ui.cronacaSegue = true;
  const inFondo = ui.cronacaSegue;
  const frammento = document.createDocumentFragment();
  for (const ev of nuovi) frammento.append(voceCronaca(ev, p));
  lista.append(frammento);
  while (lista.children.length > MAX_VOCI_CRONACA) lista.firstElementChild.remove();
  ultimaChiaveLog = chiavi[chiavi.length - 1];
  if (inFondo) cronacaInFondo();

  if (primoGiro) {
    // La cronaca iniziale (anche 200 eventi dopo una riconnessione) non va letta tutta:
    // la regione diventa "viva" solo dopo il primo riempimento.
    requestAnimationFrame(() => lista.setAttribute('aria-live', 'polite'));
  } else if (ui.stretto.matches && ui.schedaAttiva !== 'cronaca') {
    ui.nonLetti = (ui.nonLetti || 0) + nuovi.length;
    const badge = ui.tab.cronaca.querySelector('.pn-scheda__nuovi');
    badge.hidden = false;
    badge.textContent = String(Math.min(99, ui.nonLetti));
    badge.setAttribute('aria-label', `${ui.nonLetti} nuovi eventi`);
  }
}

// ---------------------------------------------------------------------------
// Dialoghi automatici
// ---------------------------------------------------------------------------

/** Il dialogo che lo stato richiede adesso, in ordine di priorità. */
function dialogoRichiesto(p, mio) {
  const io = giocatoreDa(p, mio);
  if (!io) return null;
  if (p.fase === 'finePartita') return { chiave: `fine|${p.codice}`, tipo: 'finePartita', forte: true };
  if (io.fallito) return null;
  if (p.fase === 'debito' && p.debito && p.debito.giocatoreId === mio) {
    return { chiave: `debito|${p.turno.numero}|${p.debito.importo}|${p.debito.motivo}|${p.debito.creditoreId}`, tipo: 'debito', forte: true };
  }
  if (p.fase === 'asta' && p.asta && p.asta.partecipanti.includes(mio) && !p.asta.passati.includes(mio)) {
    return { chiave: `asta|${p.asta.iniziataIl}|${p.asta.casella}`, tipo: 'asta', forte: true };
  }
  if (p.fase === 'daDecidereAcquisto' && p.turno.giocatoreId === mio) {
    return { chiave: `acquisto|${p.turno.numero}|${p.turno.doppiConsecutivi}|${io.posizione}`, tipo: 'acquisto', forte: true };
  }
  if (p.scambio && p.scambio.aId === mio) return { chiave: `scambio|${p.scambio.id}`, tipo: 'scambio', forte: false };
  // Lancio iniziale: la finestra si apre una volta a inizio partita e a ogni spareggio in cui tocca a me.
  if (p.fase === 'ordine' && p.ordine) {
    const mioSpareggio = p.ordine.giro > 1 && p.turno.giocatoreId === mio;
    return { chiave: `ordine|${p.codice}|${mioSpareggio ? p.ordine.giro : 1}`, tipo: 'ordine', forte: false };
  }
  if (p.fase === 'daLanciare' && p.turno.giocatoreId === mio && io.inPrigione) {
    return { chiave: `prigione|${p.turno.numero}|${io.turniInPrigione}`, tipo: 'prigione', forte: false };
  }
  return null;
}

function apriAutomatici(p, mio) {
  const richiesto = dialogoRichiesto(p, mio);
  if (!richiesto || dialoghiMostrati.has(richiesto.chiave)) return;
  const aperto = dialoghi.aperto();
  if (aperto === richiesto.tipo) {
    dialoghiMostrati.add(richiesto.chiave);
    return;
  }
  if (aperto && !richiesto.forte) return; // riproviamo quando l'utente chiude il dialogo attuale
  dialoghiMostrati.add(richiesto.chiave);
  dialoghi.apri(richiesto.tipo, {}, dispatchCorrente);
}

// ---------------------------------------------------------------------------
// Punto d'ingresso
// ---------------------------------------------------------------------------

/**
 * Disegna (o aggiorna) i pannelli.
 *
 * @param {HTMLElement} radice  Contenitore #pannelli.
 * @param {object} stato        StatoClient dello store (accetta anche uno StatoPartita).
 * @param {(azione: object) => void} dispatch
 */
export function render(radice, stato, dispatch, opzioni = {}) {
  if (!radice) return;
  if (typeof dispatch === 'function') dispatchCorrente = dispatch;
  dialoghi.aggiorna(stato, dispatchCorrente);

  if (!ascoltoCaselle) {
    ascoltoCaselle = true;
    document.addEventListener('casella-selezionata', (e) => {
      const i = e.detail && Number.isInteger(e.detail.indice) ? e.detail.indice : null;
      if (i !== null) dialoghi.apri('dettaglioCasella', { indice: i }, dispatchCorrente);
    });
  }

  const p = partitaDi(stato);
  if (!p || p.fase === 'lobby' || !Array.isArray(p.giocatori)) return;
  const mio = mioIdDi(stato);

  if (!ui || ui.radice !== radice || !radice.contains(ui.nodo)) {
    monta(radice);
    ultimaChiaveLog = null;
  }
  versioneCorrente = p.versione;
  if (p.codice !== codicePartita) {
    codicePartita = p.codice;
    dialoghiMostrati.clear();
    denaroVisto.clear();
    ultimaChiaveLog = null;
    ui.cronaca.replaceChildren();
    ui.cronaca.setAttribute('aria-live', 'off');
  }

  // Una partita nuova (anche nella stessa stanza): i contratti si rivedono arrivare.
  const avvio = (p.log || []).find((e) => e && e.tipo === 'partitaIniziata');
  const chiave = `${p.codice}|${avvio ? avvio.t : ''}`;
  if (chiave !== chiaveAvvio) {
    chiaveAvvio = chiave;
    proprietaViste.clear();
    consegnaIniziale = appenaIniziata(p);
  } else if (consegnaIniziale && !appenaIniziata(p)) {
    consegnaIniziale = false;
  }

  disegnaTurno(p, mio);
  spostaFocusDaBloccato(radice);
  disegnaGiocatori(p, mio);
  disegnaCronaca(p);
  // Mentre il tabellone consegna le proprietà iniziali le finestre aspettano.
  if (opzioni.finestre !== false) apriAutomatici(p, mio);
}

/**
 * Il pulsante col focus si è appena bloccato (es. "Lancia i dadi" dopo il
 * lancio): il focus passa al pulsante principale, così Invio fa la mossa
 * successiva invece di mostrare un divieto.
 */
function spostaFocusDaBloccato(radice) {
  const attivo = document.activeElement;
  if (!attivo || !radice.contains(attivo) || attivo.getAttribute('aria-disabled') !== 'true') return;
  if (dialoghi.aperto()) return;
  const principale = radice.querySelector('.pn-turno .btn--primario:not([aria-disabled="true"])');
  if (principale && principale !== attivo) principale.focus({ preventScroll: true });
}
