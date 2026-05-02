#!/bin/bash
# BookOS AI venv setup. Idempotent: safe to re-run.
# Run as root (called by postinst / pacman .INSTALL).

set -e

VENV=/opt/bookos-ai/venv
DATA=/var/lib/bookos-ai
LOG=/var/log/bookos-ai-setup.log

mkdir -p "$DATA"
chown root:root "$DATA"
chmod 755 "$DATA"

if [[ ! -d "$VENV" ]]; then
    python3 -m venv "$VENV"
fi

# Install ML deps inside venv. xgboost ~150MB, scikit-learn ~30MB.
"$VENV/bin/pip" install --quiet --upgrade pip wheel >> "$LOG" 2>&1 || true
"$VENV/bin/pip" install --quiet xgboost scikit-learn joblib pandas numpy >> "$LOG" 2>&1

echo "ok: bookos-ai venv ready at $VENV"
