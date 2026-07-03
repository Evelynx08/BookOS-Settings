#!/bin/sh
# Re-apply the BookOS lockscreen patch after a plasma-workspace upgrade.
#
# Plasma 6 doesn't honor look-and-feel for the lockscreen, so BookOS Settings
# patches the Plasma shell directly:
#   /usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen
# Any plasma-workspace update overwrites those QML files with the stock ones,
# silently reverting the BookOS lockscreen. This pacman hook restores them.
#
# Only acts if the user had the BookOS theme installed (marker file present) and
# the staged source shipped by bookos-settings exists.
set -e

SHELL_LS="/usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen"
STAGE="/usr/share/bookos-settings/lockscreen"
MARKER="$SHELL_LS/.bookos-installed"

[ -f "$MARKER" ] || exit 0
[ -d "$STAGE" ]  || exit 0

for f in MainBlock.qml LockScreenUi.qml BookBar.qml MediaControls.qml; do
    if [ -f "$STAGE/$f" ]; then
        # Back up the freshly-installed stock file once, then overlay ours.
        if [ -f "$SHELL_LS/$f" ] && [ ! -f "$SHELL_LS/.backup/$f" ]; then
            mkdir -p "$SHELL_LS/.backup"
            cp "$SHELL_LS/$f" "$SHELL_LS/.backup/$f"
        fi
        cp -f "$STAGE/$f" "$SHELL_LS/$f"
    fi
done

exit 0
