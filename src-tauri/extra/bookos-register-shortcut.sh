#!/bin/bash
# Registers a KDE Plasma 6 global shortcut so that the Samsung Galaxy Book
# Fn+F1 key (kernel keycode 0x7c, mapped to XF86Launch1 by default) toggles
# the BookOS Settings window.
#
# Run once per user. Idempotent.

set -e

# 1. Map the samsung-galaxybook input event to a usable Wayland/X key.
# The kernel reports KEY_PROG1 (148) for this hotkey on the SAM0430 platform
# device. We bind it via libinput → KWin's global shortcut system.
SHORTCUT_FILE="$HOME/.config/kglobalshortcutsrc"

# Make sure the file exists
[[ -f "$SHORTCUT_FILE" ]] || touch "$SHORTCUT_FILE"

# Ensure the [bookos-settings] section binds Launch1 → toggle command
if ! grep -q '^\[bookos-settings\]' "$SHORTCUT_FILE"; then
    cat >> "$SHORTCUT_FILE" <<EOF

[bookos-settings]
_k_friendly_name=BookOS Settings
toggle=Launch (1)\\tnone,none,Mostrar/ocultar BookOS Settings
EOF
fi

# 2. Drop a tiny .desktop entry that Plasma can launch on shortcut press.
DESKTOP="$HOME/.local/share/applications/bookos-settings-toggle.desktop"
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=BookOS Settings — Toggle
Exec=bookos-settings --toggle
Icon=bookos-settings
NoDisplay=true
StartupNotify=false
X-KDE-Shortcuts=Launch1
EOF

# 3. Reload KGlobalAccel so the new binding is picked up immediately.
# kglobalaccel runs as a kded5/kded6 module — kquitapp restarts it cleanly.
if command -v qdbus6 >/dev/null 2>&1; then
    qdbus6 org.kde.kglobalaccel /kglobalaccel reloadConfig 2>/dev/null || true
elif command -v qdbus >/dev/null 2>&1; then
    qdbus org.kde.kglobalaccel /kglobalaccel reloadConfig 2>/dev/null || true
fi

echo "OK: Fn+F1 ahora alterna BookOS Settings."
echo "Si no funciona, abre Ajustes del Sistema → Atajos → busca \"BookOS Settings\""
echo "y asigna manualmente la tecla deseada."
