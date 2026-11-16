'use strict';

/**
 * tests/browser.test.js
 *
 * La grafica provata in un browser vero. Avvia il server su una porta libera,
 * apre Chrome senza finestra (headless) con due giocatori in due profili
 * separati, uno a 1280×800 e uno a 375×812 (telefono), e gioca una partita:
 * ingresso, sala d'attesa, regole, lancio iniziale, turni con acquisti e aste,
 * un ricaricamento a metà. Alla fine non ci devono essere errori JavaScript,
 * le due pagine devono essere allo stesso punto e il tabellone al suo posto.
 *
 * Non usa librerie: parla con Chrome via DevTools Protocol sul WebSocket di
 * `ws`, che è già l'unica dipendenza del progetto. I clic sono veri clic del
 * mouse nel punto in cui sta il pulsante: se qualcosa lo copre, il test fallisce.
 *
 * Viene saltato se Chrome (o Chromium, Edge, Brave) non è installato, oppure
 * con SENZA_BROWSER=1. Per indicare un altro browser: CHROME=/percorso/di/chrome.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const stanze = require('../server/stanze');
const indice = require('../server/index');

let WS = null;
try { ({ WebSocket: WS } = require('ws')); } catch { WS = null; }

/** Il primo browser della famiglia Chrome che si trova su questo computer. */
function trovaChrome() {
  const candidati = [
    process.env.CHROME,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ].filter(Boolean);
  for (const c of candidati) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* non c'è */ }
  }
  if (process.platform === 'win32') return null;
  for (const nome of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const r = spawnSync('which', [nome], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const CHROME = process.env.SENZA_BROWSER === '1' ? null : trovaChrome();
let SALTA = false;
if (!WS) SALTA = 'dipendenza "ws" non installata (esegui npm install)';
else if (process.env.SENZA_BROWSER === '1') SALTA = 'SENZA_BROWSER=1';
else if (!CHROME) SALTA = 'Chrome non trovato (imposta CHROME=/percorso/di/chrome)';

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Avvia Chrome headless e risolve con { processo, indirizzo, cartella }. */
function avviaChrome() {
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-chrome-'));
  const argomenti = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${cartella}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-gpu', '--hide-scrollbars',
  ];
  // Nei contenitori della CI (e da root) il sandbox di Chrome non parte.
  if (process.env.CI || (process.getuid && process.getuid() === 0)) argomenti.push('--no-sandbox');
  argomenti.push('about:blank');
  const processo = spawn(CHROME, argomenti, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((risolvi, rifiuta) => {
    let uscita = '';
    const scaduto = setTimeout(() => rifiuta(new Error(`Chrome non si è avviato in 20 secondi: ${uscita.slice(-400)}`)), 20000);
    processo.stderr.on('data', (d) => {
      uscita += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(uscita);
      if (m) {
        clearTimeout(scaduto);
        risolvi({ processo, indirizzo: m[1], cartella });
      }
    });
    processo.once('error', (e) => { clearTimeout(scaduto); rifiuta(e); });
    processo.once('exit', (codice) => { clearTimeout(scaduto); rifiuta(new Error(`Chrome si è chiuso subito (codice ${codice}): ${uscita.slice(-400)}`)); });
  });
}

/** Connessione al DevTools Protocol: comandi con risposta ed eventi. */
function collegaCdp(indirizzo) {
  return new Promise((risolvi, rifiuta) => {
    const ws = new WS(indirizzo, { perMessageDeflate: false });
    let prossimo = 0;
    const attese = new Map();
    const ascolti = [];
    ws.on('message', (dati) => {
      const m = JSON.parse(dati.toString());
      if (m.id && attese.has(m.id)) {
        const { ok, ko, metodo } = attese.get(m.id);
        attese.delete(m.id);
        if (m.error) ko(new Error(`${metodo}: ${m.error.message}`));
        else ok(m.result);
      } else if (m.method) {
        for (const f of ascolti) f(m);
      }
    });
    ws.once('error', rifiuta);
    ws.once('open', () => risolvi({
      ascolti,
      invia(metodo, parametri = {}, sessionId = undefined) {
        prossimo += 1;
        const id = prossimo;
        return new Promise((ok, ko) => {
          attese.set(id, { ok, ko, metodo });
          ws.send(JSON.stringify({ id, method: metodo, params: parametri, sessionId }));
        });
      },
      chiudi: () => ws.close(),
    }));
  });
}

/** Apre una scheda in un profilo tutto suo (sessione e preferenze separate). */
async function apriScheda(cdp, { larghezza, altezza, telefono = false }) {
  const { browserContextId } = await cdp.invia('Target.createBrowserContext');
  const { targetId } = await cdp.invia('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.invia('Target.attachToTarget', { targetId, flatten: true });
  const errori = [];
  cdp.ascolti.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errori.push(`eccezione: ${(d.exception && d.exception.description) || d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errori.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errori.push(`pagina: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
  });
  const invia = (metodo, parametri) => cdp.invia(metodo, parametri, sessionId);
  await invia('Runtime.enable');
  await invia('Log.enable');
  await invia('Page.enable');
  await invia('Emulation.setDeviceMetricsOverride', {
    width: larghezza, height: altezza, deviceScaleFactor: 1, mobile: telefono,
  });
  // Pedine e dadi più rapidi: il test dura meno, la grafica è la stessa.
  await invia('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('monopoly.animazioni-veloci', '1'); } catch (e) {}",
  });

  const scheda = {
    errori,
    larghezza,
    async valuta(espressione) {
      const r = await invia('Runtime.evaluate', { expression: espressione, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`valuta: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
      return r.result.value;
    },
    async vai(url) {
      await invia('Page.navigate', { url });
    },
    async ricarica() {
      await invia('Page.reload');
    },
    /** Aspetta che `espressione` sia vera nella pagina (o fallisce dicendo cosa aspettava). */
    async aspetta(espressione, cosa, millisecondi = 15000) {
      const fine = Date.now() + millisecondi;
      let ultimo;
      while (Date.now() < fine) {
        try { ultimo = await scheda.valuta(espressione); } catch (e) { ultimo = `errore: ${e.message}`; }
        if (ultimo && !String(ultimo).startsWith('errore:')) return ultimo;
        await pausa(100);
      }
      throw new Error(`${cosa}: non è successo in ${millisecondi} ms a ${larghezza}px (ultimo valore: ${JSON.stringify(ultimo)}; errori: ${errori.join(' | ') || 'nessuno'}; pagina: ${await scheda.diagnosi()})`);
    },
    /**
     * Clic vero del mouse al centro dell'elemento, che deve essere visibile e
     * non coperto. Una finestra che sta ancora entrando (240 ms) si aspetta.
     */
    async clicca(selettore) {
      let p = null;
      for (let tentativo = 0; tentativo < 15; tentativo += 1) {
        p = await scheda.valuta(`(() => {
          const e = document.querySelector(${JSON.stringify(selettore)});
          if (!e) return null;
          e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r = e.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const sopra = document.elementFromPoint(x, y);
          return { x, y, visibile: r.width > 0 && r.height > 0, libero: Boolean(sopra) && (sopra === e || e.contains(sopra)),
            sopra: sopra ? (String(sopra.className) || sopra.tagName) : 'niente: il punto ' + Math.round(x) + ',' + Math.round(y) + ' è fuori dalla finestra ' + innerWidth + 'x' + innerHeight };
        })()`);
        if (p && p.visibile && p.libero) break;
        await pausa(100);
      }
      assert.ok(p, `a ${larghezza}px non trovo ${selettore}`);
      assert.ok(p.visibile, `a ${larghezza}px ${selettore} non è visibile`);
      assert.ok(p.libero, `a ${larghezza}px ${selettore} è coperto da "${p.sopra}"`);
      await invia('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await invia('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await invia('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    },
    /** Scrive in un campo e controlla che il testo ci sia davvero (riprova se il clic è andato a vuoto). */
    async scrivi(selettore, testo) {
      let valore = null;
      for (let tentativo = 0; tentativo < 4; tentativo += 1) {
        await scheda.clicca(selettore);
        await invia('Input.insertText', { text: testo });
        valore = await scheda.valuta(`document.querySelector(${JSON.stringify(selettore)}).value`);
        if (valore === testo) return;
        await scheda.valuta(`document.querySelector(${JSON.stringify(selettore)}).value = ''`);
        await pausa(200);
      }
      assert.equal(valore, testo, `a ${larghezza}px non riesco a scrivere in ${selettore}`);
    },
    /** Com'è messa la pagina adesso: va in coda ai messaggi d'errore, per capire cosa è andato storto. */
    async diagnosi() {
      try {
        return JSON.stringify(await scheda.valuta(`(() => ({
          vista: document.querySelector('#app').dataset.vista + '/' + (document.querySelector('#lobby').dataset.vista || ''),
          connessione: document.querySelector('#connessione').dataset.stato,
          erroreLobby: (document.querySelector('#lobby-errore') || {}).textContent || '',
          nome: (document.querySelector('#lobby-nome') || {}).value,
          toast: [...document.querySelectorAll('#toast .toast__testo')].map((n) => n.textContent),
          finestra: (document.querySelector('dialog[open] .dlg__titolo') || {}).textContent || null,
        }))()`));
      } catch (e) {
        return `diagnosi non riuscita: ${e.message}`;
      }
    },
  };
  return scheda;
}

/**
 * Il prossimo pulsante da premere per un giocatore che gioca "normale": lancia,
 * compra se può (altrimenti manda all'asta), passa alle aste, finisce il
 * turno. Ritorna un selettore, oppure null se non tocca a lui o c'è un'animazione.
 */
const PROSSIMA_MOSSA = `(() => {
  const pronto = (sel) => {
    const e = document.querySelector(sel);
    return e && e.getAttribute('aria-disabled') !== 'true' && !e.disabled && e.getClientRects().length ? sel : null;
  };
  if (document.querySelector('#pannelli').classList.contains('pn-attesa')) return null;
  const d = document.querySelector('dialog[open]');
  const tipo = d ? d.className : '';
  if (/dlg--finePartita/.test(tipo)) return null;
  if (/dlg--ordine/.test(tipo)) return pronto('dialog[open] [data-chiave="ord-lancia"]') || pronto('dialog[open] .dlg__chiudi');
  if (/dlg--acquisto/.test(tipo)) return pronto('dialog[open] [data-chiave="acq-compra"]') || pronto('dialog[open] [data-chiave="acq-asta"]');
  if (/dlg--asta/.test(tipo)) return pronto('dialog[open] [data-chiave="asta-passa"]') || pronto('dialog[open] .dlg__chiudi');
  if (/dlg--prigione/.test(tipo)) return pronto('dialog[open] [data-chiave="pr-lancia"]');
  if (/dlg--debito/.test(tipo)) return pronto('dialog[open] .piano .btn') || pronto('dialog[open] [data-chiave="deb-bancarotta"]');
  if (/dlg--bancarotta/.test(tipo)) return pronto('dialog[open] .dlg__piede .btn--pericolo');
  if (d) return pronto('dialog[open] .dlg__chiudi');
  return pronto('[data-chiave="pn-lancia"]') || pronto('[data-chiave="pn-finisci"]');
})()`;

const STATO = `(() => {
  const s = globalThis.monopoly && monopoly.store.getState();
  const p = s && s.partita;
  if (!p) return null;
  return { fase: p.fase, turno: p.turno ? p.turno.numero : 0, versione: p.versione,
    eventi: (p.log || []).length, tipi: [...new Set((p.log || []).map((e) => e.tipo))] };
})()`;

/** Misure della pagina: niente scorrimento di lato, tabellone e pannelli al loro posto. */
const MISURE = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  return {
    finestra: innerWidth, larga: document.documentElement.scrollWidth,
    caselle: document.querySelectorAll('#tabellone .casella').length,
    pedine: document.querySelectorAll('#tabellone .pedina').length,
    tabellone: r('#tabellone .tab'), turno: r('.pn-turno'),
    cronaca: document.querySelectorAll('.pn-cronaca .pn-evento').length,
    giocatori: document.querySelectorAll('.pn-giocatore').length,
    erroreCaricamento: document.querySelector('#tabellone').dataset.errore || null,
    stretto: Boolean(document.querySelector('.pn--stretto')),
  };
})()`;

test('browser: una partita a due schede, a 1280 e a 375 pixel, senza errori JavaScript', { skip: SALTA, timeout: 180000 }, async () => {
  stanze.azzera();
  const { server, porta } = await indice.avvia({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${porta}`;
  let chrome = null;
  let cdp = null;
  try {
    chrome = await avviaChrome();
    cdp = await collegaCdp(chrome.indirizzo);
    const anna = await apriScheda(cdp, { larghezza: 1280, altezza: 800 });
    const bruno = await apriScheda(cdp, { larghezza: 375, altezza: 812, telefono: true });

    // Anna crea la stanza.
    // Quando la connessione passa a "Connesso" la barra in alto può cambiare
    // altezza (su un telefono l'indicatore si accorcia) e la pagina si sposta:
    // si comincia a cliccare solo dopo.
    const PRONTA = 'Boolean(document.querySelector("#lobby-nome")) && document.querySelector("#connessione").dataset.stato === "connesso"';
    await anna.vai(base);
    await anna.aspetta(PRONTA, 'modulo d\'ingresso di Anna');
    assert.equal(await anna.valuta('document.activeElement === document.body'), true,
      'al primo caricamento il focus resta sulla pagina: il primo Tab porta a "Salta al contenuto"');
    await anna.scrivi('#lobby-nome', 'Anna');
    await anna.clicca('button[data-azione="crea"]');
    const codice = await anna.aspetta('(document.querySelector("#sala-codice") || {}).textContent', 'codice della stanza');
    assert.match(codice, /^[A-Z0-9]{6}$/);

    // Bruno entra dal link, sul "telefono".
    await bruno.vai(`${base}/?stanza=${codice}`);
    await bruno.aspetta(PRONTA, 'modulo d\'ingresso di Bruno');
    assert.equal(await bruno.valuta('document.querySelector("#lobby-codice").value'), codice, 'il codice arriva dal link');
    await bruno.scrivi('#lobby-nome', 'Bruno');
    await bruno.clicca('button[data-azione="entra"]');
    await bruno.aspetta('document.querySelector("#lobby").dataset.vista === "sala"', 'Bruno nella sala d\'attesa');
    await anna.aspetta('document.querySelectorAll("#sala-giocatori .sala__giocatore").length === 2', 'Bruno nella sala d\'attesa di Anna');
    const salaStretta = await bruno.valuta(MISURE);
    assert.ok(salaStretta.larga <= salaStretta.finestra + 1, `sala d'attesa a 375px: niente scorrimento di lato (${salaStretta.larga}px)`);

    // Anna sceglie le regole classiche e avvia.
    await anna.clicca('#sala-avvia');
    await anna.aspetta('Boolean(document.querySelector("dialog[open].dlg--regole"))', 'finestra delle regole');
    await anna.clicca('dialog[open] [data-chiave="reg-avvia"]');
    for (const s of [anna, bruno]) {
      await s.aspetta('document.querySelector("#app").dataset.vista === "partita" && document.querySelectorAll("#tabellone .casella").length === 40',
        'tabellone della partita');
    }

    // Si gioca: lancio iniziale, poi una decina di turni.
    const TURNI = 10;
    const fine = Date.now() + 100000;
    let stato = null;
    let reloadFatto = false;
    while (Date.now() < fine) {
      for (const s of [anna, bruno]) {
        const mossa = await s.valuta(PROSSIMA_MOSSA);
        if (mossa) await s.clicca(mossa);
      }
      stato = await anna.valuta(STATO);
      if (stato && stato.fase === 'finePartita') break;
      if (stato && stato.turno >= TURNI && stato.fase !== 'ordine') break;
      // A metà partita Bruno ricarica la pagina: deve ritrovare il suo posto.
      if (!reloadFatto && stato && stato.turno >= 5) {
        reloadFatto = true;
        await bruno.ricarica();
        await bruno.aspetta('Boolean(globalThis.monopoly && monopoly.store.getState().partita && document.querySelectorAll("#tabellone .casella").length === 40)',
          'Bruno di nuovo in partita dopo il ricaricamento');
      }
      await pausa(120);
    }
    assert.ok(stato, 'la partita è cominciata');
    assert.ok(stato.fase === 'finePartita' || stato.turno >= TURNI,
      `la partita doveva arrivare al turno ${TURNI}, è ferma al ${stato.turno} (fase ${stato.fase}). Errori: ${[...anna.errori, ...bruno.errori].join(' | ') || 'nessuno'}`);
    assert.ok(reloadFatto || stato.fase === 'finePartita', 'il ricaricamento a metà partita è stato provato');
    for (const tipo of ['lancioOrdine', 'ordineDeciso', 'dadi', 'movimento', 'turno']) {
      assert.ok(stato.tipi.includes(tipo), `nella cronaca c'è almeno un evento "${tipo}"`);
    }

    // Le due pagine sono allo stesso punto.
    const versione = stato.versione;
    await bruno.aspetta(`(${STATO} || {}).versione >= ${versione}`, 'Bruno allo stesso punto di Anna');

    // Il tabellone e i pannelli sono al loro posto, a tutte e due le larghezze.
    const larga = await anna.valuta(MISURE);
    const stretta = await bruno.valuta(MISURE);
    for (const [nome, m] of [['1280px', larga], ['375px', stretta]]) {
      assert.equal(m.erroreCaricamento, null, `${nome}: tabellone caricato`);
      assert.equal(m.caselle, 40, `${nome}: 40 caselle`);
      assert.equal(m.pedine, 2, `${nome}: due pedine`);
      assert.equal(m.giocatori, 2, `${nome}: due schede giocatore`);
      assert.ok(m.cronaca > 5, `${nome}: la cronaca si riempie`);
      assert.ok(m.larga <= m.finestra + 1, `${nome}: niente scorrimento di lato (pagina larga ${m.larga}px su ${m.finestra}px)`);
      assert.ok(m.tabellone && m.tabellone.w >= 250 && m.tabellone.x >= -1 && m.tabellone.x + m.tabellone.w <= m.finestra + 1,
        `${nome}: il tabellone sta dentro la pagina (${JSON.stringify(m.tabellone)})`);
      assert.ok(m.turno && m.turno.h > 40, `${nome}: il riquadro del turno si vede`);
    }
    assert.equal(larga.stretto, false, 'a 1280px tabellone e pannelli sono affiancati');
    assert.equal(stretta.stretto, true, 'a 375px le azioni stanno nel cassetto in basso');
    assert.ok(larga.turno.x > larga.tabellone.x + larga.tabellone.w - 2, 'a 1280px i pannelli stanno a destra del tabellone');

    assert.deepEqual(anna.errori, [], 'nessun errore JavaScript a 1280px');
    assert.deepEqual(bruno.errori, [], 'nessun errore JavaScript a 375px');
  } finally {
    if (cdp) cdp.chiudi();
    if (chrome) {
      chrome.processo.kill('SIGKILL');
      await new Promise((r) => { chrome.processo.once('exit', r); setTimeout(r, 3000); });
      for (let i = 0; i < 5; i += 1) {
        try { fs.rmSync(chrome.cartella, { recursive: true, force: true }); break; } catch { await pausa(200); }
      }
    }
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    stanze.azzera();
  }
});
