#!/bin/bash
# Publish a new bookos-settings .deb to the APT repo on the gh-pages branch.
#
# Usage:
#   ./scripts/publish-apt.sh <path-to-deb>
#
# Example:
#   ./scripts/publish-apt.sh "src-tauri/target/release/bundle/deb/Bookos Settings_0.5.0_amd64.deb"
#
# Requirements:
#   - dpkg-dev (provides dpkg-scanpackages)
#   - gpg with key for josrebe333@gmail.com loaded
#   - Local gh-pages worktree at /tmp/bookos-apt (auto-created if missing)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEB="${1:-}"
WORKTREE="/tmp/bookos-apt"
CODENAME="bookworm"
GPG_KEY="josrebe333@gmail.com"

[[ -z "$DEB" ]] && { echo "Usage: $0 <path-to-deb>"; exit 1; }
[[ -f "$DEB" ]] || { echo "ERROR: $DEB not found"; exit 1; }

# Create or reuse the gh-pages worktree
if [[ ! -d "$WORKTREE/.git" ]] && [[ ! -f "$WORKTREE/.git" ]]; then
    echo "==> Creating gh-pages worktree at $WORKTREE"
    cd "$REPO_DIR"
    git fetch origin gh-pages 2>/dev/null || true
    if git show-ref --verify --quiet refs/heads/gh-pages; then
        git worktree add "$WORKTREE" gh-pages
    else
        git worktree add --orphan -b gh-pages "$WORKTREE"
    fi
fi

cd "$WORKTREE"
echo "==> Updating repo at $WORKTREE"

# Extract version from deb
PKG_VER="$(dpkg-deb -f "$DEB" Version)"
PKG_NAME="$(dpkg-deb -f "$DEB" Package)"
echo "    Package: $PKG_NAME"
echo "    Version: $PKG_VER"

# Drop into pool with normalized name
mkdir -p "pool/main/b/$PKG_NAME"
TARGET="pool/main/b/$PKG_NAME/${PKG_NAME}_${PKG_VER}_amd64.deb"
cp "$DEB" "$TARGET"
echo "    -> $TARGET"

# Regenerate Packages index
mkdir -p "dists/$CODENAME/main/binary-amd64"
dpkg-scanpackages --arch amd64 pool/ > "dists/$CODENAME/main/binary-amd64/Packages"
gzip -k -f "dists/$CODENAME/main/binary-amd64/Packages"

# Regenerate Release
cd "dists/$CODENAME"
{
    echo "Origin: BookOS"
    echo "Label: BookOS APT"
    echo "Suite: stable"
    echo "Codename: $CODENAME"
    echo "Version: 1.0"
    echo "Architectures: amd64"
    echo "Components: main"
    echo "Description: BookOS APT repository for Debian/Ubuntu"
    echo "Date: $(LC_ALL=C date -u +'%a, %d %b %Y %H:%M:%S UTC')"
    echo "MD5Sum:"
    for f in main/binary-amd64/Packages main/binary-amd64/Packages.gz; do
        printf " %s %16d %s\n" "$(md5sum "$f" | awk '{print $1}')" "$(stat -c%s "$f")" "$f"
    done
    echo "SHA256:"
    for f in main/binary-amd64/Packages main/binary-amd64/Packages.gz; do
        printf " %s %16d %s\n" "$(sha256sum "$f" | awk '{print $1}')" "$(stat -c%s "$f")" "$f"
    done
} > Release

# Re-sign Release
rm -f Release.gpg InRelease
gpg --default-key "$GPG_KEY" --detach-sign --armor --output Release.gpg Release
gpg --default-key "$GPG_KEY" --clear-sign --output InRelease Release

cd "$WORKTREE"
echo
echo "==> Done. Repo updated at $WORKTREE"
echo "    Run the following to publish:"
echo "      cd $WORKTREE"
echo "      git add -A"
echo "      git commit -m \"$PKG_NAME $PKG_VER\""
echo "      git push origin gh-pages"
