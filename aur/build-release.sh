#!/bin/bash
# Builds the precompiled binary tarball to upload as a GitHub Release asset.
#
# Output:
#   bookos-settings-<version>-x86_64.tar.gz
#
# This tarball contains ONLY the compiled binary. All other assets
# (icons, systemd units, .desktop, scripts) are pulled from the
# tagged source repo by the AUR PKGBUILD.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep -oP '"version"\s*:\s*"\K[^"]+' "$PROJECT_DIR/src-tauri/tauri.conf.json")"
ARCH="x86_64"
TARBALL="bookos-settings-${VERSION}-${ARCH}.tar.gz"
OUT_DIR="$PROJECT_DIR/aur/dist"

echo "==> Building bookos-settings $VERSION"
cd "$PROJECT_DIR"
cargo tauri build --no-bundle

BIN="$PROJECT_DIR/src-tauri/target/release/bookos-settings"
[[ -f "$BIN" ]] || { echo "ERROR: binary not found at $BIN"; exit 1; }

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
cp "$BIN" "$STAGE/bookos-settings"
chmod 755 "$STAGE/bookos-settings"

tar -czf "$OUT_DIR/$TARBALL" -C "$STAGE" bookos-settings
rm -rf "$STAGE"

echo
echo "==> Built: $OUT_DIR/$TARBALL"
echo "==> SHA256:"
sha256sum "$OUT_DIR/$TARBALL"
echo
echo "Next steps:"
echo "  1. Upload $TARBALL to: https://github.com/Evelynx08/BookOS-Settings/releases/tag/v$VERSION"
echo "  2. Copy the SHA256 above into PKGBUILD's sha256sums array"
echo "  3. Regenerate .SRCINFO:  cd aur && makepkg --printsrcinfo > .SRCINFO"
