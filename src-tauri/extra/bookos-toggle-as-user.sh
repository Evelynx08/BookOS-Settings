#!/bin/bash
# Runs bookos-settings --toggle as the active graphical user.
# acpid runs as root; we need user context for the GUI.
set -e

# Find the active session user (works on systemd-logind systems)
USER_NAME=$(loginctl list-sessions --no-legend | awk '$3 != "" && $4 == "seat0" {print $3; exit}')
[ -z "$USER_NAME" ] && USER_NAME=$(who | awk 'NR==1{print $1}')
[ -z "$USER_NAME" ] && exit 0

USER_UID=$(id -u "$USER_NAME")
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)

# Run as user with proper environment
sudo -u "$USER_NAME" \
    DISPLAY=:0 \
    WAYLAND_DISPLAY=wayland-0 \
    XDG_RUNTIME_DIR="/run/user/$USER_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \
    HOME="$USER_HOME" \
    /usr/bin/bookos-settings &
