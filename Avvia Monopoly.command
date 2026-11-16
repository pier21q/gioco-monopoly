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

# Già acceso? Allora basta aprire il browser.
if curl -s -o /dev/null --max-time 2 "$INDIRIZZO/salute"; then
  echo "Monopoly è già acceso: apro il browser."
  open "$INDIRIZZO"
  exit 0
fi

if [ ! -d node_modules/ws ]; then
  echo "Prima volta: installo quello che serve (pochi secondi)…"
  npm install || { read -r -p "Installazione non riuscita. Premi Invio per chiudere."; exit 1; }
fi

# Apre il browser appena il server risponde.
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 1 "$INDIRIZZO/salute"; then
      open "$INDIRIZZO"
      break
    fi
    sleep 0.25
  done
) &

echo "Avvio Monopoly online… (chiudi questa finestra per spegnerlo)"
PORT="$PORTA" node server/index.js
