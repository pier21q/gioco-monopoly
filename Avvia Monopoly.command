#!/bin/bash
# Doppio clic su questo file per avviare Monopoly online su questo computer.
# Si apre una finestra del Terminale: finché resta aperta il gioco è acceso;
# per spegnerlo chiudi la finestra (o premi Ctrl+C).

cd "$(dirname "$0")" || exit 1
PORTA="${PORT:-3000}"
INDIRIZZO="http://localhost:$PORTA"

# Node: quello del sistema oppure quello installato in ~/.local/node.
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$HOME/.local/node/current/bin/node" ]; then
    export PATH="$HOME/.local/node/current/bin:$PATH"
  else
    echo "Non trovo Node.js. Scaricalo da https://nodejs.org (versione 20 o successiva) e riprova."
    read -r -p "Premi Invio per chiudere."
    exit 1
  fi
fi

# Quello che risponde su /salute, o niente se sulla porta non c'è nessuno.
salute() {
  curl -s --max-time 2 "$INDIRIZZO/salute"
}

# È questo gioco? Lo dice il campo "gioco" di /salute (le versioni vecchie e
# gli altri programmi non ce l'hanno).
e_monopoly() {
  printf '%s' "$1" | grep -q '"gioco":"monopoly"'
}

# Ora dell'ultima modifica ai file del gioco, in secondi (vuoto se non si riesce).
ultima_modifica() {
  if [ "$(uname)" = "Darwin" ]; then
    find server client package.json -type f ! -name '.*' -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1
  else
    find server client package.json -type f ! -name '.*' -exec stat -c %Y {} + 2>/dev/null | sort -n | tail -1
  fi
}

# Già acceso? Allora basta aprire il browser, ma solo se è davvero questo gioco.
if RISPOSTA="$(salute)"; then
  if ! e_monopoly "$RISPOSTA"; then
    echo "Sulla porta $PORTA risponde già qualcosa che non è questo Monopoly:"
    echo "una versione vecchia rimasta accesa, oppure un altro programma."
    echo "Chiudi la finestra del Terminale in cui è acceso e riprova, oppure"
    echo "avvia il gioco su un'altra porta: PORT=3001 \"$0\""
    read -r -p "Premi Invio per chiudere."
    exit 1
  fi
  AVVIATO_MS="$(printf '%s' "$RISPOSTA" | sed -n 's/.*"avviatoIl":\([0-9][0-9]*\).*/\1/p')"
  MODIFICATO="$(ultima_modifica)"
  if [ -n "$AVVIATO_MS" ] && [ -n "$MODIFICATO" ] && [ "$MODIFICATO" -gt $((AVVIATO_MS / 1000)) ]; then
    echo "ATTENZIONE: Monopoly è acceso da prima dell'ultima modifica ai file del gioco,"
    echo "quindi gira ancora la versione vecchia del server. Per aggiornarlo chiudi la"
    echo "finestra del Terminale in cui è acceso e fai di nuovo doppio clic su questo file."
  fi
  echo "Monopoly è già acceso: apro il browser."
  open "$INDIRIZZO"
  exit 0
fi

if [ ! -d node_modules/ws ]; then
  echo "Prima volta: installo quello che serve (pochi secondi)…"
  npm install || { read -r -p "Installazione non riuscita. Premi Invio per chiudere."; exit 1; }
fi

# Apre il browser appena il server (questo, non un altro) risponde.
(
  for _ in $(seq 1 40); do
    if e_monopoly "$(salute)"; then
      open "$INDIRIZZO"
      break
    fi
    sleep 0.25
  done
) &

echo "Avvio Monopoly online… (chiudi questa finestra per spegnerlo)"
PORT="$PORTA" node server/index.js
