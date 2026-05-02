#!/bin/bash
# BookOS — auto-sync rqs_lib from upstream rquickshare/core_lib
# Checks GitHub for newer commits, downloads if needed, applies patches.
# Usage: ./sync-rqs-upstream.sh [--force]

set -e

REPO="Martichou/rquickshare"
BRANCH="main"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RQS_LIB="$SCRIPT_DIR/rqs_lib"
PATCHES_DIR="$SCRIPT_DIR/rqs_patches"
SYNC_STAMP="$RQS_LIB/.upstream_sync"
FORCE="${1:-}"

# ── 1. Check latest commit on GitHub ─────────────────────────────────────────
echo "==> Comprobando versión upstream en GitHub..."
LATEST=$(curl -sf "https://api.github.com/repos/$REPO/commits/$BRANCH" \
    -H "Accept: application/vnd.github.v3+json" | \
    grep '"sha"' | head -1 | sed 's/.*"sha": *"\([^"]*\)".*/\1/')

if [ -z "$LATEST" ]; then
    echo "ERROR: No se pudo conectar con GitHub. ¿Hay internet?"
    exit 1
fi

SHORT="${LATEST:0:7}"
echo "==> Último commit upstream: $SHORT"

# ── 2. Compare with stored commit ────────────────────────────────────────────
CURRENT=""
[ -f "$SYNC_STAMP" ] && CURRENT=$(cut -d' ' -f1 "$SYNC_STAMP")

if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" != "--force" ]; then
    echo "==> Ya estás al día con upstream ($SHORT). Usa --force para forzar."
    exit 0
fi

[ -n "$CURRENT" ] && echo "==> Actualización disponible: ${CURRENT:0:7} → $SHORT"
[ -z "$CURRENT" ] && echo "==> Primera sincronización."

# ── 3. Download tarball ───────────────────────────────────────────────────────
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Descargando rquickshare@$SHORT..."
curl -sL "https://github.com/$REPO/archive/$LATEST.tar.gz" -o "$TMP/upstream.tar.gz"
tar -xzf "$TMP/upstream.tar.gz" -C "$TMP"
EXTRACTED=$(ls "$TMP" | grep -v upstream.tar.gz | head -1)
CORE_LIB="$TMP/$EXTRACTED/core_lib"

if [ ! -d "$CORE_LIB/src" ]; then
    echo "ERROR: No se encontró core_lib/src en el tarball."
    exit 1
fi

# ── 4. Sync src (preserve our Cargo.toml) ────────────────────────────────────
echo "==> Sincronizando src/..."
rsync -a --delete \
    --exclude='*.orig' \
    "$CORE_LIB/src/" "$RQS_LIB/src/"

# Save upstream Cargo.toml for manual dep comparison
cp "$CORE_LIB/Cargo.toml" "$RQS_LIB/Cargo.toml.upstream"

# Check if upstream added new dependencies we might be missing
NEW_DEPS=$(diff <(grep '^\s*[a-z]' "$RQS_LIB/Cargo.toml.upstream" 2>/dev/null) \
               <(grep '^\s*[a-z]' "$RQS_LIB/Cargo.toml" 2>/dev/null) 2>/dev/null | \
           grep '^<' | grep -v '^\-\-\-' || true)
if [ -n "$NEW_DEPS" ]; then
    echo ""
    echo "⚠ Dependencias nuevas en upstream Cargo.toml (revisa Cargo.toml.upstream):"
    echo "$NEW_DEPS" | sed 's/^< /  /'
    echo ""
fi

# ── 5. Apply patches ─────────────────────────────────────────────────────────
mkdir -p "$PATCHES_DIR"
PATCH_OK=0; PATCH_FAIL=0
for p in "$PATCHES_DIR"/*.patch; do
    [ -f "$p" ] || continue
    echo "==> Aplicando parche: $(basename "$p")..."
    if patch -p1 -d "$RQS_LIB" --dry-run -s < "$p" 2>/dev/null; then
        patch -p1 -d "$RQS_LIB" -s < "$p"
        PATCH_OK=$((PATCH_OK+1))
    else
        echo "WARN: El parche $(basename "$p") no se aplicó limpiamente — revisar manualmente"
        PATCH_FAIL=$((PATCH_FAIL+1))
    fi
done

# ── 6. Record sync ────────────────────────────────────────────────────────────
echo "$LATEST $(date '+%Y-%m-%d %H:%M')" > "$SYNC_STAMP"

echo ""
echo "✓ Sincronizado: rqs_lib ahora en upstream $SHORT"
[ "$PATCH_OK" -gt 0 ]   && echo "  Parches aplicados: $PATCH_OK"
[ "$PATCH_FAIL" -gt 0 ] && echo "  Parches fallidos:  $PATCH_FAIL (revisar manualmente)"
echo ""
echo "Siguiente paso: cargo tauri build"
