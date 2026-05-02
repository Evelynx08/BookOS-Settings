#!/bin/bash
# BookOS search — reacciona a cambios en filesystem e indexa incremental.
# Lanzado por bookos-search-watcher.service (user unit).

set -u
VENV=/opt/bookos-search/venv
INDEXADOR=/opt/bookos-search/indexador.py
CFG="$HOME/.config/bookos-search/config.json"

if [ ! -x "$VENV/bin/python" ]; then
    echo "venv no existe en $VENV — ejecuta setup.sh" >&2
    exit 1
fi

# Extraer dirs del config (fallback si no existe)
if [ -f "$CFG" ]; then
    DIRS=$("$VENV/bin/python" -c "import json,sys; c=json.load(open('$CFG')); print('\n'.join(c.get('directorios',[])))")
else
    DIRS="$HOME/Documentos
$HOME/Escritorio"
fi

# Crear dirs si no existen para que inotifywait no falle
while read -r d; do [ -n "$d" ] && mkdir -p "$d"; done <<<"$DIRS"

# shellcheck disable=SC2086
echo "$DIRS" | xargs -d '\n' inotifywait -q -m -r \
    -e close_write -e create -e delete -e moved_to -e moved_from \
    --format '%e|%w%f' |
while IFS='|' read -r EVT PATH_; do
    case "$EVT" in
        *DELETE*|*MOVED_FROM*)
            "$VENV/bin/python" "$INDEXADOR" --borrar "$PATH_" 2>/dev/null ;;
        *)
            [ -f "$PATH_" ] && "$VENV/bin/python" "$INDEXADOR" --archivo "$PATH_" 2>/dev/null ;;
    esac
done
