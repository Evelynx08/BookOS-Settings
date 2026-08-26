/*
    BookOS Lock Screen UI — SDDM-inspired
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQml 2.15
import QtQuick 2.8
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.1
import Qt5Compat.GraphicalEffects

import org.kde.plasma.components 3.0 as PlasmaComponents3
import org.kde.plasma.workspace.components 2.0 as PW
import org.kde.plasma.plasma5support 2.0 as P5Support
import org.kde.kirigami 2.20 as Kirigami
import org.kde.kscreenlocker 1.0 as ScreenLocker

import org.kde.plasma.private.sessions 2.0
import org.kde.breeze.components

Item {
    id: lockScreenUi

    readonly property bool softwareRendering: GraphicsInfo.api === GraphicsInfo.Software

    property bool hadPrompt: false

    property bool bookBarEnabled: true
    P5Support.DataSource {
        id: bookBarCfg
        engine: "executable"
        connectedSources: ["sh -c 'cat $HOME/.config/bookos-bookbar.json 2>/dev/null'"]
        interval: 3000
        onNewData: (src, data) => {
            try {
                var j = JSON.parse((data["stdout"] || "").trim())
                lockScreenUi.bookBarEnabled = (j && j.enabled !== false)
            } catch(e) { lockScreenUi.bookBarEnabled = true }
        }
    }

    function handleMessage(msg) {
        if (!root.notification) {
            root.notification += msg;
        } else if (root.notification.includes(msg)) {
            root.notificationRepeated();
        } else {
            root.notification += "\n" + msg
        }
    }

    Kirigami.Theme.inherit: false
    Kirigami.Theme.colorSet: Kirigami.Theme.Complementary

    Connections {
        target: authenticator
        function onFailed(kind) {
            if (kind != 0) return;
            const msg = i18nd("plasma_lookandfeel_org.kde.lookandfeel", "Unlocking failed");
            lockScreenUi.handleMessage(msg);
            graceLockTimer.restart();
            notificationRemoveTimer.restart();
            lockScreenUi.hadPrompt = false;
        }

        function onSucceeded() {
            if (lockScreenUi.hadPrompt) {
                Qt.quit();
            } else {
                mainStack.replace(null, Qt.resolvedUrl("NoPasswordUnlock.qml"),
                    { userListModel: users },
                    StackView.Immediate,
                );
                mainStack.forceActiveFocus();
            }
        }

        function onInfoMessageChanged() {
            lockScreenUi.handleMessage(authenticator.infoMessage);
            lockScreenUi.hadPrompt = true;
        }

        function onErrorMessageChanged() {
            lockScreenUi.handleMessage(authenticator.errorMessage);
        }

        function onPromptChanged(msg) {
            lockScreenUi.handleMessage(authenticator.prompt);
        }
        function onPromptForSecretChanged(msg) {
            mainBlock.showPassword = false;
            mainBlock.mainPasswordBox.forceActiveFocus();
            lockScreenUi.hadPrompt = true;
        }
    }

    SessionManagement {
        id: sessionManagement
    }

    Connections {
        target: sessionManagement
        function onAboutToSuspend() {
            root.clearPassword();
        }
    }

    P5Support.DataSource {
        id: keystateSource
        engine: "keystate"
        connectedSources: "Caps Lock"
    }

    MouseArea {
        id: lockScreenRoot

        property bool uiVisible: true
        property bool blockUI: mainStack.depth > 1 || mainBlock.mainPasswordBox.text.length > 0 || inputPanel.keyboardActive

        x: parent.x
        y: parent.y
        width: parent.width
        height: parent.height
        hoverEnabled: true
        cursorShape: uiVisible ? Qt.ArrowCursor : Qt.BlankCursor
        drag.filterChildren: true
        onPressed: uiVisible = true;
        onPositionChanged: uiVisible = true;
        onUiVisibleChanged: {
            if (blockUI) {
                fadeoutTimer.running = false;
            } else if (uiVisible) {
                fadeoutTimer.restart();
            }
            authenticator.startAuthenticating();
        }
        onBlockUIChanged: {
            if (blockUI) {
                fadeoutTimer.running = false;
                uiVisible = true;
            } else {
                fadeoutTimer.restart();
            }
        }
        Keys.onEscapePressed: {
            if (uiVisible) {
                uiVisible = false;
                if (inputPanel.keyboardActive) {
                    inputPanel.showHide();
                }
                root.clearPassword();
            }
        }
        Keys.onPressed: event => {
            uiVisible = true;
            event.accepted = false;
        }

        Timer {
            id: fadeoutTimer
            interval: 10000
            onTriggered: {
                if (!lockScreenRoot.blockUI) {
                    mainBlock.showPassword = false;
                    lockScreenRoot.uiVisible = false;
                }
            }
        }
        Timer {
            id: notificationRemoveTimer
            interval: 3000
            onTriggered: root.notification = ""
        }
        Timer {
            id: graceLockTimer
            interval: 3000
            onTriggered: {
                root.clearPassword();
                authenticator.startAuthenticating();
            }
        }

        PropertyAnimation {
            id: launchAnimation
            target: lockScreenRoot
            property: "opacity"
            from: 0
            to: 1
            duration: Kirigami.Units.veryLongDuration * 2
        }

        Component.onCompleted: { launchAnimation.start(); readSddmConf(); authenticator.startAuthenticating(); }

        // Sin WallpaperFader de Breeze. Ese componente, con state "on", aplica
        // FastBlur de 50 px y un ShaderEffect que multiplica el brillo por 1,6
        // en esquema claro (1,5 de saturación, 0,8 de contraste). Es su diseño,
        // pero deja el fondo lavado y difuminado, que es justo lo contrario de
        // lo que se ve en el editor. Aquí el desenfoque es una OPCIÓN del tema
        // (background=blur) y el oscurecimiento se controla con overlayOpacity.
        //
        // No hace falta dibujar nada en su lugar: el item `wallpaper` lo pinta
        // kscreenlocker por su cuenta. El fader solo lo tomaba como origen y lo
        // ocultaba con hideSource para pintar su versión procesada.
        //
        // Lo único que sí hacía falta reponer es el desvanecido de la interfaz
        // al quedarse inactiva, que iba en sus estados (ver mainStack.opacity).

        // Clock — SDDM style: top center
        // Read SDDM theme.conf — share config with login screen.
        // Per-user override at ~/.config/bookos-sddm-variant takes precedence (no sudo needed).
        property var sddmConf: ({})
        // Los .conf se leen con `cat`, no con XMLHttpRequest: Qt 6 bloquea GET
        // sobre file:// salvo que el proceso arranque con QML_XHR_ALLOW_FILE_READ=1,
        // y el greeter no lo hace. Con XHR todas las lecturas volvían vacías y la
        // pantalla se quedaba siempre en los valores por defecto.
        //
        // Orden de precedencia (gana el último): theme.conf de fábrica →
        // theme.conf.user que escribe Settings → override por usuario en
        // ~/.config/bookos-sddm-variant, que no necesita sudo. Como el parser
        // sobrescribe claves repetidas, basta con concatenarlos en ese orden.
        P5Support.DataSource {
            id: sddmConfSrc
            engine: "executable"
            connectedSources: ["sh -c 'cat /usr/share/sddm/themes/bookos/theme.conf 2>/dev/null; echo; cat /usr/share/sddm/themes/bookos/theme.conf.user 2>/dev/null; echo; cat $HOME/.config/bookos-sddm-variant 2>/dev/null; echo; printf \"sessionScheme=%s\\n\" \"$(kreadconfig6 --file kdeglobals --group General --key ColorScheme 2>/dev/null)\"'"]
            interval: 0
            onNewData: (src, data) => {
                lockScreenRoot.sddmConf = lockScreenRoot._lsParseConf(data["stdout"] || "")
            }
        }
        function _lsParseConf(text) {
            var out = {}
            var lines = text.split("\n")
            for (var i = 0; i < lines.length; i++) {
                var l = lines[i].trim()
                if (l === "" || l[0] === "#" || l[0] === "[") continue
                var eq = l.indexOf("=")
                if (eq <= 0) continue
                out[l.substring(0, eq).trim()] = l.substring(eq + 1).trim()
            }
            return out
        }
        // Relanza el `cat`. La fuente ya se ejecuta sola al conectarse, así que
        // esto solo hace falta si algo cambia el .conf con el bloqueo abierto.
        function readSddmConf() {
            var s = sddmConfSrc.connectedSources[0]
            sddmConfSrc.disconnectSource(s)
            sddmConfSrc.connectSource(s)
        }

        // variant: light | dark | auto. "auto" seguía al valor por defecto y
        // acababa SIEMPRE en oscuro; ahora mira el esquema de color de la
        // sesión (el lockscreen sí corre como el usuario y puede leerlo).
        // ~/.config/bookos-sddm-variant, que escribe Settings al cambiar de
        // tema, sigue teniendo la última palabra porque se concatena al final.
        readonly property bool conf_isDark: {
            var v = sddmConf.variant || "auto"
            if (v === "light") return false
            if (v === "dark")  return true
            var s = (sddmConf.sessionScheme || "").toLowerCase()
            return s === "" ? true : s.indexOf("dark") !== -1
        }
        readonly property string conf_clockFmt: sddmConf.clockFormat || "24h"
        readonly property string conf_clockFont: sddmConf.clockFont || "serif"
        readonly property bool conf_showDate: (sddmConf.showDate || "true") !== "false"
        readonly property bool conf_showBattery: (sddmConf.showBattery || "true") !== "false"
        // Notificaciones en la pantalla de bloqueo. El contenido va OCULTO por
        // defecto: la pantalla bloqueada es justo cuando el equipo está
        // desatendido, así que mostrar el texto sería filtrarlo a quien pase.
        readonly property bool conf_showNotifications:
            (sddmConf.lockNotifications || "true") !== "false"
        readonly property bool conf_notificationContent:
            (sddmConf.lockNotificationContent || "false") === "true"
        readonly property color conf_accent: sddmConf.accentColor || "#007AFF"

        // ── Textos ─────────────────────────────────────────────────────────
        // Ya traducidos en theme.conf: los escribe BookOS Settings en el idioma
        // de la app. Este QML lo carga kscreenlocker, que no comparte el
        // diccionario de Settings, así que el idioma viaja con el texto. A la
        // derecha, el respaldo de fábrica.
        readonly property string conf_strBattery:      sddmConf.strBattery      || "Batería"
        readonly property string conf_strCharging:     sddmConf.strCharging     || "Cargando"
        readonly property string conf_strToFull:       sddmConf.strToFull       || "%1 min para carga completa"
        readonly property string conf_strNoEvents:     sddmConf.strNoEvents     || "Sin eventos"
        readonly property string conf_strNotifications:sddmConf.strNotifications|| "NOTIFICACIONES"
        readonly property string conf_strNotification: sddmConf.strNotification || "Notificación"
        readonly property string conf_strCapsLock:     sddmConf.strCapsLock     || "Bloqueo de mayúsculas activado"

        // ── Paridad con el editor de la pantalla de acceso ─────────────────
        // Las claves de abajo son EXACTAMENTE las del tema SDDM (Main.qml) y se
        // interpretan igual, para que lo que se coloca en el editor se vea
        // igual en Win+L. Antes solo se leían el formato de hora, la fuente y
        // poco más, así que la pantalla ignoraba posición, escala y color.
        function _lsNum(v, def, lo, hi) {
            var n = parseFloat(v)
            if (isNaN(n)) return def
            return Math.max(lo, Math.min(hi, n))
        }
        // Familias reales instaladas; mismo mapa que Main.qml. Qt cae al tipo
        // por defecto en silencio si la familia no existe.
        function _lsFontFamily(key) {
            switch (key) {
            case "bookos":    return "SN Pro"
            case "sans":      return "Noto Sans"
            case "serif":     return "Noto Serif"
            case "mono":      return "DejaVu Sans Mono"
            case "condensed": return "Fira Sans Compressed"
            case "round":     return "Cantarell"
            default:          return "SN Pro"
            }
        }

        // Reloj: centro del bloque en % de la pantalla, escala en % sobre el
        // 11,5% del alto, grosor 100-900.
        readonly property real conf_clockX: _lsNum(sddmConf.clockX, 50, 0, 100)
        readonly property real conf_clockY: _lsNum(sddmConf.clockY, 14, 0, 100)
        readonly property real conf_clockScale: _lsNum(sddmConf.clockScale, 100, 40, 260) / 100
        readonly property int  conf_clockWeight: Math.round(_lsNum(sddmConf.clockWeight, 700, 100, 900))
        readonly property bool conf_showSeconds: (sddmConf.showSeconds || "false") === "true"
        readonly property string conf_dateStyle: sddmConf.dateStyle || "full"
        readonly property var conf_dateLocale: Qt.locale(sddmConf.locale || "es_ES")
        // "auto" → clockTint, el tono que calcula Settings desde el fondo; si
        // aún no hay tinte se cae al color del tema, que es lo que se veía antes.
        readonly property string conf_clockColorMode: sddmConf.clockColor || "auto"
        readonly property color conf_clockColor:
            conf_clockColorMode !== "auto" ? conf_clockColorMode
          : (sddmConf.clockTint ? sddmConf.clockTint
                                : conf_autoFallback)

        // Opacidad del reloj (20-100 en el .conf). Va como alfa del elemento y
        // no del color para que arrastre también a la sombra: si solo se
        // transparentara el relleno, con las cifras a medio gas quedaría una
        // sombra sólida flotando alrededor de nada.
        readonly property real conf_clockOpacity: _lsNum(sddmConf.clockOpacity, 100, 20, 100) / 100

        // Respaldo de clockColor="auto" cuando todavía no hay tinte calculado
        // (config antigua, o un fondo puesto desde fuera del editor). Sobre una
        // FOTO manda el blanco pase lo que pase con el tema: el overlay oscurece
        // el fondo, así que el negro del tema claro quedaba ilegible — y con la
        // opacidad baja, directamente invisible. Solo sobre fondo liso se sigue
        // al tema, que ahí sí es el color del fondo real.
        readonly property color conf_autoFallback:
            (conf_bgMode === "image" || conf_bgMode === "blur")
                ? "#ffffff" : (conf_isDark ? "#ffffff" : "#000000")

        // Tracking en % del cuerpo. Se aplica DESPUÉS del estirado, así que se
        // multiplica por él: la Scale que comprime la anchura también comprime
        // el espaciado, y sin compensar las cifras se juntaban al estirar.
        readonly property real conf_clockTracking: _lsNum(sddmConf.clockTracking, -2, -8, 8) / 100

        // ── Fecha, con ajustes propios ──
        readonly property real conf_dateScale: _lsNum(sddmConf.dateScale, 100, 50, 200) / 100
        readonly property int  conf_dateWeight: Math.round(_lsNum(sddmConf.dateWeight, 500, 100, 900))
        readonly property real conf_dateGap: _lsNum(sddmConf.dateGap, 4, 0, 40)
        // Vacío = el mismo color del reloj, que es como se comportaba antes.
        readonly property color conf_dateColor:
            sddmConf.dateColor ? sddmConf.dateColor : conf_clockColor

        // Profundidad: recorte del sujeto del fondo, pintado ENCIMA del reloj.
        // El fichero lo genera Settings al aplicar (bookos-cutout.png junto al
        // fondo); si no existe, no hay efecto y el reloj se queda delante.
        readonly property bool conf_clockDepth: (sddmConf.clockDepth || "false") === "true"
        readonly property string conf_cutoutUrl:
            conf_bgPath === "" ? ""
              : _lsBgUrl(conf_bgPath.replace(/\.([^.\/]+)$/, "-cutout.png"))

        // ── Tipografía adaptable ──
        // Estiramiento VERTICAL de las cifras (100 = sin estirar). Se consigue
        // subiendo el cuerpo y comprimiendo la anchura en la misma proporción:
        // el ancho de los dígitos no cambia y solo crecen a lo alto. Con
        // clockAdapt=true se usa el valor que calcula Settings midiendo el hueco
        // libre del fondo (clockAdaptV); si no hay medida, se queda sin estirar.
        readonly property bool conf_clockAdapt: (sddmConf.clockAdapt || "false") === "true"
        readonly property real conf_clockStretch:
            conf_clockAdapt ? _lsNum(sddmConf.clockAdaptV, 100, 100, 260) / 100
                            : _lsNum(sddmConf.clockStretch, 100, 100, 260) / 100

        // Bloque de cuentas: centro en % de la pantalla.
        readonly property real conf_usersX: _lsNum(sddmConf.usersX, 50, 0, 100)
        readonly property real conf_usersY: _lsNum(sddmConf.usersY, 52, 0, 100)

        // BookBar.
        readonly property bool   conf_showBookBar: (sddmConf.showBookBar || "true") !== "false"
        readonly property string conf_bookBarPosition: sddmConf.bookBarPosition || "bottom"
        readonly property bool   conf_bookBarCompact: (sddmConf.bookBarSize || "normal") === "compact"
        readonly property string conf_bookBarContent: sddmConf.bookBarContent || "battery;media;routine"
        readonly property string conf_bookBarShow: sddmConf.bookBarShow || "always"
        // 0-100 en el .conf; 0 dejaría la píldora invisible sin querer, así que
        // por debajo de 5 se trata como "sin ajustar" y se pinta opaca.
        readonly property real conf_pillOpacity: {
            var v = _lsNum(sddmConf.pillOpacity, 100, 0, 100)
            return v < 5 ? 1.0 : v / 100
        }

        // Mismos colores de píldora que Main.qml, para que los controles de
        // abajo (cambiar usuario, suspender, teclado) dejen de estar cableados
        // a blanco con texto negro y sigan claro/oscuro como todo lo demás.
        readonly property color conf_fg:  conf_isDark ? "#ffffff" : "#000000"
        readonly property color conf_fg2: "#8e8e93"
        readonly property color conf_pillBg:
            conf_isDark ? Qt.rgba(0.109, 0.109, 0.118, conf_pillOpacity)
                        : Qt.rgba(1, 1, 1, conf_pillOpacity)
        readonly property color conf_pillHover:
            conf_isDark ? Qt.rgba(0.23, 0.23, 0.24, conf_pillOpacity)
                        : Qt.rgba(0.898, 0.898, 0.918, conf_pillOpacity)

        // Fondo. Vacío o "solid" = se deja el wallpaper de Plasma tal cual; el
        // greeter ya lo pinta con su propio fader. Solo se superpone cuando el
        // editor pide una imagen concreta.
        readonly property string conf_bgMode: sddmConf.background || "solid"
        readonly property string conf_bgPath: sddmConf.bgImage || ""
        // Ruta ABSOLUTA o RELATIVA al tema SDDM (backgrounds/bookos.png). El
        // lockscreen no vive en esa carpeta, así que la relativa se resuelve
        // contra el tema, no contra este QML.
        function _lsBgUrl(p) {
            if (p === "") return ""
            return p.charAt(0) === "/" ? "file://" + p
                                       : "file:///usr/share/sddm/themes/bookos/" + p
        }
        readonly property string conf_bgUrl: _lsBgUrl(conf_bgPath)
        // Color plano. Vacío = no se pinta nada y se ve el wallpaper de Plasma,
        // que es lo que había antes de tocar el fondo desde el editor.
        readonly property string conf_bgColor: sddmConf.bgColor || ""
        // Versión ya desenfocada que genera Settings al aplicar (bookos.png →
        // bookos-blur.png). Si falta, se usa la nítida: se ve peor, no se rompe.
        readonly property string conf_bgBlurUrl:
            conf_bgPath === "" ? "" : _lsBgUrl(conf_bgPath.replace(/\.([^.\/]+)$/, "-blur.$1"))
        property bool bgBlurMissing: false
        // Oscurecimiento sobre el fondo. Vacío = 50 en oscuro / 38 en claro,
        // los mismos valores que documenta theme.conf.
        readonly property real conf_overlay:
            _lsNum(sddmConf.overlayOpacity, conf_isDark ? 50 : 38, 0, 100) / 100

        // ── Fondo del editor ──────────────────────────────────────────────
        // Solo se superpone al wallpaper de Plasma si el editor pide una imagen.
        // Va bajo todo lo demás (z negativo) para no tapar reloj ni panel.
        Rectangle {
            z: -1
            anchors.fill: parent
            visible: lockScreenRoot.conf_bgMode === "solid" && lockScreenRoot.conf_bgColor !== ""
            color: lockScreenRoot.conf_bgColor
        }

        Image {
            z: -1
            anchors.fill: parent
            visible: lockScreenRoot.conf_bgPath !== ""
                     && (lockScreenRoot.conf_bgMode === "image" || lockScreenRoot.conf_bgMode === "blur")
            source: lockScreenRoot.conf_bgMode === "blur" && !lockScreenRoot.bgBlurMissing
                    ? lockScreenRoot.conf_bgBlurUrl : lockScreenRoot.conf_bgUrl
            fillMode: Image.PreserveAspectCrop
            cache: false
            asynchronous: true
            onStatusChanged: if (status === Image.Error && lockScreenRoot.conf_bgMode === "blur"
                                 && !lockScreenRoot.bgBlurMissing) lockScreenRoot.bgBlurMissing = true
        }
        Rectangle {
            z: -1
            anchors.fill: parent
            visible: lockScreenRoot.conf_bgPath !== ""
                     && (lockScreenRoot.conf_bgMode === "image" || lockScreenRoot.conf_bgMode === "blur")
            color: lockScreenRoot.conf_isDark ? "#000000" : "#ffffff"
            opacity: lockScreenRoot.conf_overlay
        }

        Item {
            id: sddmClockRow
            width: clockCol.width
            height: clockCol.height
            // Posición LIBRE: el editor guarda el CENTRO del bloque en % de la
            // pantalla, igual que en el tema SDDM.
            x: Math.round(lockScreenRoot.width  * lockScreenRoot.conf_clockX / 100 - width  / 2)
            y: Math.round(lockScreenRoot.height * lockScreenRoot.conf_clockY / 100 - height / 2)

            function fmtTime() {
                var f = lockScreenRoot.conf_clockFmt === "12h"
                        ? (lockScreenRoot.conf_showSeconds ? "h:mm:ss AP" : "h:mm AP")
                        : (lockScreenRoot.conf_showSeconds ? "hh:mm:ss"   : "hh:mm")
                return Qt.formatTime(new Date(), f)
            }
            // toLocaleDateString con locale EXPLÍCITO: Qt.formatDate usa el del
            // proceso greeter (inglés) y salía "Monday, 27 de julio".
            function fmtDate() {
                var d = new Date()
                var loc = lockScreenRoot.conf_dateLocale
                if (lockScreenRoot.conf_dateStyle === "short")   return d.toLocaleDateString(loc, "dd/MM/yyyy")
                if (lockScreenRoot.conf_dateStyle === "weekday") return d.toLocaleDateString(loc, "dddd")
                return d.toLocaleDateString(loc, "dddd, d 'de' MMMM")
            }
            property string clockTime: fmtTime()
            property string clockDate: fmtDate()

            Timer {
                interval: 1000; running: true; repeat: true
                onTriggered: {
                    sddmClockRow.clockTime = sddmClockRow.fmtTime()
                    sddmClockRow.clockDate = sddmClockRow.fmtDate()
                }
            }

            Column {
                id: clockCol
                spacing: Math.round(lockScreenRoot.conf_dateGap)

                Text {
                    id: lockClockText
                    text: sddmClockRow.clockTime
                    font.family: lockScreenRoot._lsFontFamily(lockScreenRoot.conf_clockFont)
                    // El cuerpo lleva ya el estiramiento; la Scale de abajo
                    // devuelve la anchura a su sitio. Hacerlo así y no con un
                    // yScale sobre el tamaño base mantiene el trazo nítido: la
                    // rasteriza Qt al tamaño final, no se escala un mapa de bits.
                    font.pixelSize: Math.round(lockScreenRoot.height * 0.115
                                               * lockScreenRoot.conf_clockScale
                                               * lockScreenRoot.conf_clockStretch)
                    font.weight: lockScreenRoot.conf_clockWeight
                    font.letterSpacing: lockClockText.font.pixelSize
                                        * lockScreenRoot.conf_clockTracking
                    color: lockScreenRoot.conf_clockColor
                    opacity: lockScreenRoot.conf_clockOpacity
                    anchors.horizontalCenter: parent.horizontalCenter
                    transform: Scale {
                        xScale: 1 / lockScreenRoot.conf_clockStretch
                        yScale: 1
                        origin.x: lockClockText.width / 2
                        origin.y: 0
                    }
                    layer.enabled: true
                    layer.effect: DropShadow {
                        transparentBorder: true
                        color: lockScreenRoot.conf_isDark ? "#80000000" : "#80ffffff"
                        radius: 8
                        samples: 17
                    }
                }
                Text {
                    visible: lockScreenRoot.conf_showDate
                    text: sddmClockRow.clockDate
                    font.family: lockScreenRoot._lsFontFamily(lockScreenRoot.conf_clockFont)
                    // Escala propia SOBRE la del reloj: sigue creciendo con él
                    // al tirar de una esquina, pero se puede afinar aparte.
                    font.pixelSize: Math.round(lockScreenRoot.height * 0.022
                                               * lockScreenRoot.conf_clockScale
                                               * lockScreenRoot.conf_dateScale)
                    font.weight: lockScreenRoot.conf_dateWeight
                    color: lockScreenRoot.conf_dateColor
                    // La fecha ya iba al 85 %: se multiplica, no se sustituye,
                    // para que siga un peldaño por debajo de la hora.
                    opacity: 0.85 * lockScreenRoot.conf_clockOpacity
                    anchors.horizontalCenter: parent.horizontalCenter
                    layer.enabled: true
                    layer.effect: DropShadow {
                        transparentBorder: true
                        color: lockScreenRoot.conf_isDark ? "#80000000" : "#80ffffff"
                        radius: 4
                        samples: 9
                    }
                }
            }
        }

        // El sujeto recortado. z=1 lo deja sobre el reloj (z por defecto) y bajo
        // los widgets y el panel de acceso, que tienen z=2.
        Image {
            id: depthCutout
            z: 1
            anchors.fill: parent
            visible: lockScreenRoot.conf_clockDepth && status === Image.Ready
            source: lockScreenRoot.conf_clockDepth ? lockScreenRoot.conf_cutoutUrl : ""
            fillMode: Image.PreserveAspectCrop
            asynchronous: true
            cache: false
        }

        // ── Widgets del editor ────────────────────────────────────────────
        // Mismo componente que el greeter de SDDM, con las mismas claves.
        // La caché del tiempo se lee con `cat` y se le pasa ya en texto: el XHR
        // sobre file:// que usa en SDDM aquí vuelve siempre vacío.
        property string weatherCache: ""
        // Dispositivos del ecosistema para la tarjeta grande de batería. Mismo
        // camino que el tiempo: lo escribe BookOS Settings desde UPower y aquí
        // solo se lee, porque kscreenlocker no puede hablar con el bus del
        // sistema ni lanzar `upower`.
        property string devicesCache: ""
        P5Support.DataSource {
            id: devSrc
            engine: "executable"
            connectedSources: ["sh -c 'cat $HOME/.cache/bookos-devices.json 2>/dev/null || cat /var/lib/sddm/bookos-devices.json 2>/dev/null'"]
            interval: 60000
            onNewData: (src, data) => {
                lockScreenRoot.devicesCache = (data["stdout"] || "").trim()
            }
        }
        P5Support.DataSource {
            id: wxSrc
            engine: "executable"
            connectedSources: ["sh -c 'cat $HOME/.cache/bookos-weather.json 2>/dev/null || cat /var/lib/sddm/bookos-weather.json 2>/dev/null'"]
            interval: 0
            onNewData: (src, data) => {
                lockScreenRoot.weatherCache = (data["stdout"] || "").trim()
            }
        }

        // Notificaciones y eventos, en un Loader: si el módulo de alguno de los
        // dos no está instalado el fichero falla al cargar y aquí se queda,
        // en vez de llevarse por delante toda la pantalla de bloqueo.
        Loader {
            id: widgetData
            source: "LockWidgetData.qml"
            onLoaded: item.strNotification = lockScreenRoot.conf_strNotification
            onStatusChanged: if (status === Loader.Error)
                console.warn("[BookOS] widgets de sesión no disponibles:", source)
        }

        GreeterWidgets {
            id: greeterWidgets
            z: 2
            notifList:   widgetData.item ? widgetData.item.notifList   : []
            calToday:    widgetData.item ? widgetData.item.calToday    : []
            calTomorrow: widgetData.item ? widgetData.item.calTomorrow : []
            enabledList: lockScreenRoot.sddmConf.widgets || ""
            positions:   lockScreenRoot.sddmConf.widgetPos || ""
            sizes:       lockScreenRoot.sddmConf.widgetSize || ""
            scales:      lockScreenRoot.sddmConf.widgetScale || ""
            opacities:   lockScreenRoot.sddmConf.widgetOpacity || ""
            layoutMode:  lockScreenRoot.sddmConf.widgetsLayout || "stack"
            // Ancla del modo stack: centro del reloj y justo bajo su bloque,
            // igual que en Main.qml, para que se muevan con él.
            stackX: sddmClockRow.x + sddmClockRow.width / 2
            stackY: sddmClockRow.y + sddmClockRow.height + lockScreenRoot.height * 0.035
            isDark: lockScreenRoot.conf_isDark
            accent: lockScreenRoot.conf_accent
            pillBg: lockScreenRoot.conf_pillBg
            fg:     lockScreenRoot.conf_fg
            fg2:    lockScreenRoot.conf_fg2
            localeName: lockScreenRoot.sddmConf.locale || "es_ES"
            strBattery: lockScreenRoot.conf_strBattery
            strCharging: lockScreenRoot.conf_strCharging
            strNoEvents: lockScreenRoot.conf_strNoEvents
            strNotifications: lockScreenRoot.conf_strNotifications
            weatherJson: lockScreenRoot.weatherCache
            devicesJson: lockScreenRoot.devicesCache
            // Música: se reaprovecha el reproductor que la BookBar ya tiene
            // abierto en este mismo proceso, en vez de abrir un segundo modelo
            // MPRIS contra el bus para los mismos datos.
            mediaTitle:   bookBar.hasMusic ? bookBar.songTitle  : ""
            mediaArtist:  bookBar.hasMusic ? bookBar.songArtist : ""
            mediaArt:     bookBar.hasMusic ? bookBar.artUrl     : ""
            mediaPlaying: bookBar.isPlaying
            onMediaPrev:      bookBar.mprisPrev()
            onMediaNext:      bookBar.mprisNext()
            onMediaPlayPause: bookBar.mprisPlay()
            // La batería la calcula ya la BookBar (mismo proceso, mismo engine),
            // así que se reaprovecha en vez de abrir una segunda fuente.
            battCapacity: bookBar.hasBattery ? String(bookBar.battPct) : ""
            battStatus:   bookBar.isCharging ? "Charging" : "Discharging"
            battTimeLeft: (bookBar.isCharging && bookBar.minsToFull > 0 && bookBar.minsToFull < 600)
                          ? lockScreenRoot.conf_strToFull.replace("%1", bookBar.minsToFull) : ""
        }

        ListModel {
            id: users

            Component.onCompleted: {
                users.append({
                    name: kscreenlocker_userName,
                    realName: kscreenlocker_userName,
                    icon: kscreenlocker_userImage !== ""
                          ? "file://" + kscreenlocker_userImage.split("/").map(encodeURIComponent).join("/")
                          : "",
                })
            }
        }

        StackView {
            id: mainStack
            anchors {
                left: parent.left
                right: parent.right
            }
            height: lockScreenRoot.height + Kirigami.Units.gridUnit * 3
            focus: true
            visible: opacity > 0
            // Lo ponían los estados del WallpaperFader. El reloj y los widgets
            // NO se desvanecen: con la interfaz inactiva la pantalla se queda
            // como un reloj de mesa, que es lo que se espera de un portátil
            // bloqueado y enchufado.
            opacity: lockScreenRoot.uiVisible ? 1 : 0
            Behavior on opacity {
                NumberAnimation { duration: Kirigami.Units.veryLongDuration; easing.type: Easing.InOutQuad }
            }

            initialItem: MainBlock {
                id: mainBlock
                lockScreenUiVisible: lockScreenRoot.uiVisible
                enabled: !graceLockTimer.running
                // El StackView es más alto que la pantalla (height + 3 gridUnit),
                // así que el bloque no puede colocarse por porcentaje sobre su
                // propio alto: se le pasan las medidas reales de la pantalla.
                screenW: lockScreenRoot.width
                screenH: lockScreenRoot.height

                StackView.onStatusChanged: {
                    if (StackView.status === StackView.Activating) {
                        mainPasswordBox.clear();
                        mainPasswordBox.focus = true;
                        root.notification = "";
                    }
                }

                onPasswordResult: password => {
                    authenticator.respond(password)
                }
            }
        }

        VirtualKeyboardLoader {
            id: inputPanel
            z: 1
            screenRoot: lockScreenRoot
            mainStack: mainStack
            mainBlock: mainBlock
            passwordField: mainBlock.mainPasswordBox
        }

        Loader {
            z: 2
            active: root.viewVisible
            source: "LockOsd.qml"
            anchors {
                horizontalCenter: parent.horizontalCenter
                bottom: parent.bottom
                bottomMargin: Kirigami.Units.gridUnit
            }
        }

        // ── Notificaciones ────────────────────────────────────────────────
        // A la derecha y en columna, para no pisar el reloj ni el campo de
        // contraseña, que van centrados. Se ocultan solas si no hay ninguna.
        LockNotifications {
            id: lockNotifications
            z: 3
            strNotification: lockScreenRoot.conf_strNotification
            visible: lockScreenRoot.conf_showNotifications
            isDark: lockScreenRoot.conf_isDark
            showContent: lockScreenRoot.conf_notificationContent
            accent: lockScreenRoot.conf_accent
            width: Math.min(380, lockScreenRoot.width * 0.28)
            maxHeight: lockScreenRoot.height * 0.5
            anchors {
                right: parent.right
                top: parent.top
                rightMargin: 28
                topMargin: 28
            }
        }

        // ── Live States ───────────────────────────────────────────────────
        // Isla dinámica: música, batería, rutina y temporizador. Se alimenta
        // del broker org.bookos.LiveStates; si no está corriendo, `order` sale
        // vacío y la isla se oculta sola, así que no estorba.
        //
        // Va JUSTO ENCIMA de la BookBar y no en su lugar: son dos cosas
        // distintas —la BookBar resume, la isla detalla— y ambas pueden
        // convivir. Se ancla a la BookBar para que suba con ella.
        //
        // Viene del fork de plasma-desktop (BookOS-Envoiroment). Estaba solo
        // allí, y como el parche de Settings sustituye este fichero entero, la
        // isla se instalaba pero nunca se instanciaba: el commit que la portó
        // al fork no se veía en pantalla.
        LiveStatesIsland {
            id: liveStates
            z: 1
            dark: lockScreenRoot.conf_isDark
            anchors {
                horizontalCenter: parent.horizontalCenter
                bottom: bookBar.visible ? bookBar.top : parent.bottom
                bottomMargin: Kirigami.Units.gridUnit
            }
        }

        // ── Book Bar ──────────────────────────────────────────────────────
        BookBar {
            id: bookBar
            z: 1
            strStarted: lockScreenRoot.sddmConf.strStarted || "Inicio"
            strFinish: lockScreenRoot.sddmConf.strFinish || "Fin"
            strObjective: lockScreenRoot.sddmConf.strObjective || "Objetivo"
            strDeactivateRoutine: lockScreenRoot.sddmConf.strDeactivateRoutine || "Desactivar rutina"
            // Dos interruptores distintos: el del widget (bookos-bookbar.json)
            // y el del editor de la pantalla de acceso. Basta con que uno diga
            // que no para ocultarla. Con bookBarShow=charging solo aparece
            // mientras carga, para que en uso normal la pantalla quede limpia.
            allowShow: lockScreenUi.bookBarEnabled && lockScreenRoot.conf_showBookBar
                       && (lockScreenRoot.conf_bookBarShow !== "charging" || bookBar.isCharging)
            pillOpacity: lockScreenRoot.conf_pillOpacity
            allowedContent: lockScreenRoot.conf_bookBarContent
            allowBattery: lockScreenRoot.conf_showBattery
            // La píldora no tiene modo compacto propio, así que la densidad del
            // editor se aplica escalando el conjunto.
            scale: lockScreenRoot.conf_bookBarCompact ? 0.82 : 1.0
            transformOrigin: lockScreenRoot.conf_bookBarPosition === "top" ? Item.Top : Item.Bottom
            anchors {
                horizontalCenter: parent.horizontalCenter
                bottom: lockScreenRoot.conf_bookBarPosition === "top" ? undefined : parent.bottom
                top:    lockScreenRoot.conf_bookBarPosition === "top" ? parent.top : undefined
                bottomMargin: Kirigami.Units.gridUnit * 2
                topMargin: Kirigami.Units.gridUnit * 1.5
            }
        }

        // ── SDDM-style Footer Controls ──────────────────────────────────────

        // La píldora "Cambiar usuario" de abajo a la izquierda se ha quitado:
        // en una pantalla de bloqueo lo único que se espera es desbloquear, y
        // el conmutador de sesiones ensuciaba la esquina. Sigue accesible por
        // los atajos de Plasma si hace falta.

        // ── Power buttons — bottom-right ────────────────────────────────────
        Row {
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.rightMargin: 24
            anchors.bottomMargin: 24
            spacing: 10

            // Suspender
            Rectangle {
                width: 44; height: 44; radius: 22
                color: suspArea.containsMouse ? lockScreenRoot.conf_pillHover
                                              : lockScreenRoot.conf_pillBg
                Behavior on color { ColorAnimation { duration: 150 } }
                // root no expone suspendToRamSupported/suspendToRam: eran
                // undefined, así que el botón nunca se dibujaba (y el log
                // escupía "Unable to assign [undefined] to bool" en cada
                // bloqueo). SessionManagement sí lo tiene.
                visible: sessionManagement.canSuspend
                Text { anchors.centerIn: parent; text: "☾"; font.pixelSize: 18; color: lockScreenRoot.conf_fg }
                MouseArea { id: suspArea; anchors.fill: parent; hoverEnabled: true; onClicked: sessionManagement.suspend() }
            }
            // El botón de teclado virtual se ha quitado: en un portátil no
            // pinta nada y era el icono más ruidoso de la esquina. El
            // VirtualKeyboardLoader sigue cargado, así que en un equipo táctil
            // Plasma lo levanta solo al enfocar el campo.
        }
    }
}
