#!/bin/bash
# BookOS search — crea venv en /opt/bookos-search, instala deps,
# pre-descarga el modelo. Ejecutar una vez con sudo.
set -e

VENV=/opt/bookos-search/venv
LIBDIR=/opt/bookos-search

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecuta con sudo: sudo $0" >&2
    exit 1
fi

mkdir -p "$LIBDIR"

if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install --extra-index-url https://download.pytorch.org/whl/cpu \
    torch torchvision --index-url https://download.pytorch.org/whl/cpu
"$VENV/bin/pip" install sentence-transformers chromadb pypdf
# KRunner D-Bus plugin deps
"$VENV/bin/pip" install dbus-python || true   # fallback: use system dbus-python

# Pre-descarga modelo al caché compartido
export SENTENCE_TRANSFORMERS_HOME="$LIBDIR/models"
mkdir -p "$SENTENCE_TRANSFORMERS_HOME"
"$VENV/bin/python" -c "
from sentence_transformers import SentenceTransformer
SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
print('modelo descargado')
"

# Copiar script KRunner
cp "$LIBDIR/bookos-krunner.py" "$LIBDIR/bookos-krunner.py" 2>/dev/null || true
chmod -R a+rX "$LIBDIR"
echo "OK — venv en $VENV, modelo en $SENTENCE_TRANSFORMERS_HOME"
