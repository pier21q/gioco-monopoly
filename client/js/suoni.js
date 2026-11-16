/**
 * client/js/suoni.js
 *
 * Piccoli suoni del gioco, sintetizzati con la Web Audio API: nessun file da
 * scaricare. Ogni funzione è sicura da chiamare sempre: se l'audio è spento,
 * non disponibile o non ancora sbloccato da un gesto dell'utente, non fa nulla.
 *
 *   suoni.dadi() · passo() · atterra() · moneta() · paga() · carta()
 *   suoni.costruisci() · prigione() · turno() · vittoria()
 *   attivi() / imposta(true|false)   preferenza salvata nel browser
 */

const CHIAVE = 'monopoly.suoni';
let ctx = null;
let acceso = leggi();

function leggi() {
  try {
    return localStorage.getItem(CHIAVE) !== '0';
  } catch {
    return true;
  }
}

export function attivi() {
  return acceso;
}

export function imposta(valore) {
  acceso = Boolean(valore);
  try {
    localStorage.setItem(CHIAVE, acceso ? '1' : '0');
  } catch { /* la scelta vale solo per questa pagina */ }
  if (acceso) contesto();
}

function contesto() {
  if (!acceso || typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running' ? ctx : null;
}

// I browser fanno partire l'audio solo dopo un gesto: lo sblocchiamo al primo tocco.
if (typeof window !== 'undefined') {
  const sblocca = () => { contesto(); };
  window.addEventListener('pointerdown', sblocca, { passive: true });
  window.addEventListener('keydown', sblocca, { passive: true });
}

/** Una nota breve con attacco e rilascio morbidi. */
function nota(freq, durata, { tipo = 'sine', volume = 0.07, ritardo = 0, fino = null } = {}) {
  const c = contesto();
  if (!c) return;
  const t = c.currentTime + ritardo;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = tipo;
  osc.frequency.setValueAtTime(freq, t);
  if (fino) osc.frequency.exponentialRampToValueAtTime(fino, t + durata);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(volume, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durata);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + durata + 0.02);
}

let tamponeRumore = null;

/** Uno scoppio di rumore filtrato: colpi di dado, fruscio di carta. */
function rumore(durata, { volume = 0.08, ritardo = 0, frequenza = 1800, q = 1.2, tipo = 'bandpass' } = {}) {
  const c = contesto();
  if (!c) return;
  if (!tamponeRumore) {
    tamponeRumore = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
    const dati = tamponeRumore.getChannelData(0);
    for (let i = 0; i < dati.length; i += 1) dati[i] = Math.random() * 2 - 1;
  }
  const t = c.currentTime + ritardo;
  const sorgente = c.createBufferSource();
  sorgente.buffer = tamponeRumore;
  const filtro = c.createBiquadFilter();
  filtro.type = tipo;
  filtro.frequency.value = frequenza;
  filtro.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durata);
  sorgente.connect(filtro).connect(g).connect(c.destination);
  sorgente.start(t, Math.random() * 0.3, durata + 0.02);
}

/** Sul telefono, con i suoni accesi, un colpetto di vibrazione (dove esiste). */
function vibra(ms) {
  if (!acceso || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  // Prima di un tocco il browser la blocca (e lo scrive in console): si aspetta.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(ms); } catch { /* non concessa: niente */ }
}

export const suoni = {
  /** Dadi che rotolano: una manciata di colpetti sempre più radi. */
  dadi() {
    const colpi = [0, 0.07, 0.13, 0.21, 0.3, 0.41, 0.53, 0.62];
    colpi.forEach((t, k) => rumore(0.05, { ritardo: t, volume: 0.11 - k * 0.008, frequenza: 2200 + Math.random() * 1400, q: 3 }));
  },
  passo() {
    nota(520, 0.05, { tipo: 'triangle', volume: 0.035 });
  },
  atterra() {
    nota(170, 0.12, { volume: 0.09, fino: 90 });
    rumore(0.06, { volume: 0.04, frequenza: 500, q: 0.8 });
  },
  moneta() {
    nota(1318, 0.09, { tipo: 'triangle', volume: 0.06 });
    nota(1760, 0.22, { tipo: 'triangle', volume: 0.06, ritardo: 0.08 });
  },
  paga() {
    nota(392, 0.14, { tipo: 'triangle', volume: 0.055, fino: 294 });
    nota(262, 0.2, { tipo: 'triangle', volume: 0.05, ritardo: 0.12, fino: 196 });
  },
  carta() {
    rumore(0.16, { volume: 0.07, frequenza: 3200, q: 0.7, tipo: 'highpass' });
  },
  costruisci() {
    nota(240, 0.06, { tipo: 'square', volume: 0.04 });
    nota(300, 0.08, { tipo: 'square', volume: 0.04, ritardo: 0.11 });
  },
  prigione() {
    [0, 0.14, 0.28].forEach((t) => {
      nota(150, 0.12, { tipo: 'square', volume: 0.05, ritardo: t });
      rumore(0.05, { volume: 0.06, ritardo: t, frequenza: 4200, q: 6 });
    });
  },
  turno() {
    vibra(35);
    nota(659, 0.12, { volume: 0.05 });
    nota(988, 0.25, { volume: 0.05, ritardo: 0.11 });
  },
  vittoria() {
    [523, 659, 784, 1047, 1319].forEach((f, k) => nota(f, 0.3, { tipo: 'triangle', volume: 0.07, ritardo: k * 0.11 }));
  },
};
