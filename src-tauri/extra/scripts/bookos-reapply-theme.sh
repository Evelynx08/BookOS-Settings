#!/bin/sh
# Vuelve a poner los QML de BookOS en su sitio después de una actualización.
#
# Hay dos formas de perderlos, y el hook cubre las dos:
#
#  1. Plasma 6 no respeta look-and-feel para la pantalla de bloqueo, así que
#     BookOS Settings parchea directamente el shell:
#       /usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen
#     Cualquier actualización de plasma-workspace sobrescribe esos ficheros con
#     los de serie y revierte la pantalla de bloqueo sin avisar.
#
#  2. Al actualizar el PROPIO bookos-settings (0.6 → 0.6.1), los QML nuevos
#     llegan al stage de /usr/share/bookos-settings/, pero las copias que de
#     verdad se usan siguen siendo las viejas. Antes el hook solo escuchaba a
#     plasma-workspace, así que arreglar un widget no servía de nada hasta que
#     el usuario volvía a pulsar "instalar" en Ajustes.
#
# Solo actúa si el usuario tenía el tema puesto: el marcador de la pantalla de
# bloqueo, y Current=bookos para el tema de SDDM.
#
# ALCANCE: solo pantalla de bloqueo (lockscreen) y SDDM. NO reaplica Kvantum,
# tema de escritorio Plasma, esquema de color ni la paleta de color dinámico —
# eso vive fuera de este script.
set -e

SHELL_LS="/usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen"
LS_STAGE="/usr/share/bookos-settings/lockscreen"
MARKER="$SHELL_LS/.bookos-installed"

SDDM_DEST="/usr/share/sddm/themes/bookos"
SDDM_STAGE="/usr/share/bookos-settings/sddm-theme"

# ── Pantalla de bloqueo ──────────────────────────────────────────────────
if [ -f "$MARKER" ] && [ -d "$LS_STAGE" ]; then
    # Se copia el directorio ENTERO, no una lista fija de ficheros. La lista
    # que había aquí se quedó corta en cuanto aparecieron LockNotifications.qml
    # y LockWidgetData.qml: el hook se ejecutaba, no daba error, y esos dos no
    # se actualizaban nunca.
    for src in "$LS_STAGE"/*; do
        [ -f "$src" ] || continue
        f=$(basename "$src")
        # Copia de seguridad del fichero de serie, una sola vez, para que
        # "desinstalar" en Ajustes pueda devolver la pantalla original.
        if [ -f "$SHELL_LS/$f" ] && [ ! -f "$SHELL_LS/.backup/$f" ]; then
            mkdir -p "$SHELL_LS/.backup"
            cp "$SHELL_LS/$f" "$SHELL_LS/.backup/$f"
        fi
        cp -f "$src" "$SHELL_LS/$f"
        chmod 644 "$SHELL_LS/$f"
    done
fi

# ── Pantalla de bloqueo, copias de los look-and-feel ─────────────────────
# ESTAS son las que Plasma carga de verdad cuando kscreenlockerrc apunta a un
# tema de BookOS (Theme=BookOS Light), que es lo normal en cuanto se aplica el
# tema global. El bloque de arriba solo toca la del shell, así que tras una
# actualización la pantalla seguía siendo la vieja aunque el hook se ejecutara
# sin dar error: se copiaba a una carpeta que nadie estaba mirando.
#
# Aquí no hace falta centinela: si la carpeta existe y el paquete trae los QML,
# es que ese look-and-feel es de BookOS y sus QML son los nuestros.
if [ -d "$LS_STAGE" ]; then
    for base in /home/*/.local/share/plasma/look-and-feel /usr/share/plasma/look-and-feel; do
        [ -d "$base" ] || continue
        for lnf in "$base"/BookOS*; do
            dest="$lnf/contents/lockscreen"
            [ -d "$dest" ] || continue
            for src in "$LS_STAGE"/*; do
                [ -f "$src" ] || continue
                cp -f "$src" "$dest/$(basename "$src")"
                chmod 644 "$dest/$(basename "$src")"
            done
            # Los de /home son del usuario, no de root: si se copian como root
            # se quedan con dueño root y el siguiente cambio desde Ajustes (que
            # corre sin privilegios sobre ~) fallaría con permiso denegado.
            case "$lnf" in
                /home/*) owner=$(echo "$lnf" | cut -d/ -f3)
                         chown -R "$owner" "$dest" 2>/dev/null || true ;;
            esac
        done
    done
fi

# ── Tema de SDDM ─────────────────────────────────────────────────────────
# El tema activo se elige en /etc/sddm.conf o en CUALQUIER fichero de
# /etc/sddm.conf.d/ (Arch usa kde_settings.conf, no el nuestro), así que se
# miran todos, igual que hace is_sddm_theme_installed().
if [ -d "$SDDM_STAGE" ] && [ -d "$SDDM_DEST" ] &&
   grep -qs "Current=bookos" /etc/sddm.conf /etc/sddm.conf.d/* 2>/dev/null; then
    # `cp` y no `rsync --delete`: theme.conf.user (los ajustes del usuario) y
    # los fondos que haya importado viven en esta misma carpeta y no los trae
    # el paquete. Borrar lo que no está en el stage se los llevaría por delante.
    cp -r "$SDDM_STAGE/." "$SDDM_DEST/"
    find "$SDDM_DEST" -type f -exec chmod 644 {} +
fi

exit 0
