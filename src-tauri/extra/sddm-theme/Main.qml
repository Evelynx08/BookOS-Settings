/*
 * Tema de inicio de sesión de BookOS
 * variant=dark (default) | variant=light
 * background=solid (default) | image | blur
 * bgImage=<absolute path to image>
 */

import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import QtQuick.Effects
import SddmComponents 2.0

Item {
    id: root
    width:  Screen.width
    height: Screen.height
    opacity: 0
    Behavior on opacity { NumberAnimation { duration: 450; easing.type: Easing.OutCubic } }
    focus: true

    // Detect test mode: in real SDDM, primaryScreen is set; in test, certain props differ.
    // Simple heuristic: enable exit shortcut always — harmless in real mode (Ctrl+Q won't trigger).
    Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape ||
            (event.key === Qt.Key_Q && (event.modifiers & Qt.ControlModifier))) {
            Qt.quit()
            event.accepted = true
            return
        }
        // User switcher with arrow keys (only when password is empty to avoid conflict)
        if (root.userCount > 1 && passwordField.text === "") {
            if (event.key === Qt.Key_Left) {
                root.prevUser()
                event.accepted = true
                return
            }
            if (event.key === Qt.Key_Right) {
                root.nextUser()
                event.accepted = true
                return
            }
        }
    }

    // ── Color variants ────────────────────────────────────────────────────
    // Lo escribe bookos-sddm-appearance-sync.service justo antes de arrancar
    // SDDM, leyendo el look-and-feel del último usuario que entró. Así el
    // greeter aparece en claro u oscuro igual que dejó el escritorio, como lo
    // dejó. Si el fichero no existe (primer
    // arranque, sesión live), manda el variant de theme.conf.
    // variant=auto (por defecto) sigue al escritorio; light/dark lo fuerzan.
    property string syncedVariant: ""
    readonly property string variantSetting: config.variant || "auto"
    readonly property bool isDark:
        variantSetting === "light" ? false
      : variantSetting === "dark"  ? true
      : (syncedVariant !== "" ? syncedVariant !== "light" : true)

    Item {
        // Item aparte para no tocar el Component.onCompleted de root.
        Component.onCompleted: {
            var xhr = new XMLHttpRequest()
            try {
                xhr.open("GET", "file:///var/lib/sddm/bookos-appearance.conf", false)
                xhr.send()
                var m = /^\s*variant\s*=\s*(dark|light)\s*$/m.exec(xhr.responseText || "")
                if (m) root.syncedVariant = m[1]
            } catch (e) {
                // Fichero ausente o ilegible: nos quedamos con theme.conf.
            }
        }
    }
    // Fondo sólido: color propio si se ha elegido, si no el del tema.
    readonly property color bgColor: config.bgColor ? config.bgColor
                                                    : (isDark ? "#000000" : "#f2f2f7")
    readonly property color fgColor:  isDark ? "#ffffff" : "#000000"
    readonly property color fg2Color: isDark ? "#8e8e93" : "#8e8e93"
    // Campo de contraseña y botón de entrar: translúcidos como las píldoras,
    // no opacos. Antes eran #1c1c1e/#ffffff planos y quedaban como un parche
    // sólido pegado encima del fondo desenfocado.
    readonly property color fieldBg:  isDark ? Qt.rgba(0.109, 0.109, 0.118, pillOpacity)
                                             : Qt.rgba(1, 1, 1, pillOpacity)
    readonly property color enterBg:  isDark ? Qt.rgba(0.227, 0.227, 0.235, pillOpacity)
                                             : Qt.rgba(0.898, 0.898, 0.918, pillOpacity)
    readonly property color enterFg:  isDark ? "#ffffff" : "#3a3a3c"
    // Opacidad de las píldoras configurable (0-100). Se recompone el ARGB a
    // mano porque Qt no deja modular el alfa de un color literal en un binding
    // sin recrearlo.
    readonly property real pillOpacity: clampPct(config.pillOpacity, 80) / 100.0
    readonly property color pillBg: isDark ? Qt.rgba(0.109, 0.109, 0.118, pillOpacity)
                                           : Qt.rgba(1, 1, 1, pillOpacity)
    // Oscurecimiento sobre el fondo: sube el contraste del texto sin tocar el
    // wallpaper. Es lo que salva la legibilidad con fondos claros o ruidosos.
    readonly property real overlayStrength: clampPct(config.overlayOpacity, isDark ? 50 : 38) / 100.0
    readonly property color overlayColor: isDark ? Qt.rgba(0, 0, 0, overlayStrength)
                                                 : Qt.rgba(1, 1, 1, overlayStrength)
    readonly property color accentColor: config.accentColor || "#007AFF"

    // Normaliza un porcentaje del .conf a 0-100 (vacío o basura → def).
    function clampPct(v, def) {
        var n = parseFloat(v)
        return isNaN(n) ? def : Math.max(0, Math.min(100, n))
    }

    // ── User-configurable ─────────────────────────────────────────────────
    readonly property string clockFormat: config.clockFormat || "24h"
    readonly property bool   showDate:    (config.showDate    || "true") !== "false"
    readonly property bool   showBattery: (config.showBattery || "true") !== "false"
    readonly property bool   showBookBar: (config.showBookBar || "true") !== "false"
    readonly property string clockFont:   config.clockFont   || "bookos"
    // Familias reales instaladas. Si se añade una aquí, comprobar antes con
    // `fc-list : family` que existe: Qt cae al tipo por defecto en silencio.
    function fontFamily(key) {
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

    // Idioma con el que se escriben día y mes. Sin esto Qt usa el locale del
    // proceso greeter (inglés) y la fecha salía mezclada: "Monday, 27 de July".
    readonly property string localeName: config.locale || "es_ES"

    // ── Textos ────────────────────────────────────────────────────────────
    // Ya traducidos en theme.conf: los escribe BookOS Settings en el idioma en
    // el que esté la app. El greeter arranca sin sesión y no tiene forma de
    // resolver traducciones por su cuenta, así que el idioma viaja con el
    // texto. Los valores de la derecha son el respaldo de fábrica.
    readonly property string strBattery:      config.strBattery      || "Batería"
    readonly property string strCharging:     config.strCharging     || "Cargando"
    readonly property string strToFull:       config.strToFull       || "%1 min para carga completa"
    readonly property string strNoEvents:     config.strNoEvents     || "Sin eventos"
    readonly property string strNotifications:config.strNotifications|| "NOTIFICACIONES"
    readonly property string strWrongPassword:config.strWrongPassword|| "Contraseña incorrecta"
    readonly property string strCapsLock:     config.strCapsLock     || "Bloqueo de mayúsculas activado"
    readonly property string strSession:      config.strSession      || "Sesión"
    readonly property string strExit:         config.strExit         || "✕  Salir (Esc)"
    readonly property var    dateLocale: Qt.locale(localeName)

    // ── Reloj: posición y tamaño LIBRES ───────────────────────────────────
    // clockX/clockY son el centro del bloque en % de la pantalla, no una de
    // cinco casillas: el editor deja arrastrarlo a donde sea. clockPosition se
    // sigue leyendo solo para convertir configuraciones antiguas.
    function legacyClockXY(axis) {
        switch (config.clockPosition || "") {
        case "center":   return axis === "x" ? 50 : 50
        case "bottom":   return axis === "x" ? 50 : 82
        case "topLeft":  return axis === "x" ? 18 : 14
        case "topRight": return axis === "x" ? 82 : 14
        default:         return axis === "x" ? 50 : 14
        }
    }
    readonly property real clockX: {
        var v = parseFloat(config.clockX)
        return isNaN(v) ? legacyClockXY("x") : Math.max(0, Math.min(100, v))
    }
    readonly property real clockY: {
        var v = parseFloat(config.clockY)
        return isNaN(v) ? legacyClockXY("y") : Math.max(0, Math.min(100, v))
    }
    // Porcentaje sobre el tamaño base (11.5% del alto). Se mantiene relativo a
    // la altura para que se vea igual en 1080p y en 4K.
    readonly property real clockScalePct: {
        var v = parseFloat(config.clockScale)
        // Config antigua: small/medium/large.
        if (isNaN(v)) {
            var s = config.clockSize || "medium"
            return s === "small" ? 65 : s === "large" ? 135 : 100
        }
        return Math.max(40, Math.min(260, v))
    }
    readonly property real clockScale: 0.115 * clockScalePct / 100
    // Grosor del trazo, de Fina a Negrita (100-900), de fina a negrita.
    readonly property int clockWeight: {
        var v = parseInt(config.clockWeight)
        return isNaN(v) ? Font.Bold : Math.max(100, Math.min(900, v))
    }
    // Color del reloj:
    //  · "auto" (por defecto) → clockTint, el tono del FONDO aclarado, que
    //    calcula BookOS Settings al aplicar (el QML no puede analizar la
    //    imagen). Si aún no hay tinte, se cae al color del tema.
    //  · un #RRGGBB → ese color fijo.
    readonly property string clockColorMode: config.clockColor || "auto"
    readonly property color clockColor:
        clockColorMode !== "auto" ? clockColorMode
      : (config.clockTint ? config.clockTint : autoClockFallback)
    // Sobre una foto manda el blanco aunque el tema sea claro: el overlay
    // oscurece el fondo y el negro se pierde. Solo con fondo liso se sigue al
    // tema, que ahí sí es el color que hay detrás de verdad.
    readonly property color autoClockFallback:
        (bgMode === "image" || bgMode === "blur") ? "#ffffff" : fgColor
    // Opacidad del reloj (20-100). A 100 sólido; por debajo las cifras dejan
    // ver el fondo a través.
    readonly property real clockOpacity: {
        var v = parseFloat(config.clockOpacity)
        return isNaN(v) ? 1.0 : Math.max(20, Math.min(100, v)) / 100
    }
    // Estiramiento VERTICAL de las cifras (100 = sin estirar). Se sube el cuerpo
    // y se comprime la anchura en la misma proporción, así los dígitos crecen
    // solo a lo alto y siguen rasterizados a su tamaño final (nítidos).
    // Con clockAdapt=true manda clockAdaptV, que lo calcula BookOS Settings
    // midiendo el hueco libre del fondo; el QML no puede analizar la imagen.
    readonly property bool clockAdapt: (config.clockAdapt || "false") === "true"
    readonly property real clockStretch: {
        var v = parseFloat(clockAdapt ? config.clockAdaptV : config.clockStretch)
        return isNaN(v) ? 1.0 : Math.max(100, Math.min(260, v)) / 100
    }
    // Tracking en % del cuerpo (-8 a 8). Se compensa con el estirado más abajo.
    readonly property real clockTracking: {
        var v = parseFloat(config.clockTracking)
        return (isNaN(v) ? -2 : Math.max(-8, Math.min(8, v))) / 100
    }
    // ── Fecha, con ajustes propios ──
    readonly property real dateScale: {
        var v = parseFloat(config.dateScale)
        return (isNaN(v) ? 100 : Math.max(50, Math.min(200, v))) / 100
    }
    readonly property int dateWeight: {
        var v = parseInt(config.dateWeight)
        return isNaN(v) ? Font.Medium : Math.max(100, Math.min(900, v))
    }
    readonly property real dateGap: {
        var v = parseFloat(config.dateGap)
        return isNaN(v) ? 4 : Math.max(0, Math.min(40, v))
    }
    readonly property color dateColor: config.dateColor ? config.dateColor : clockColor

    readonly property bool showSeconds: (config.showSeconds || "false") === "true"
    // full: "lunes, 27 de julio" · short: "27/07/2026" · weekday: "lunes"
    readonly property string dateStyle: config.dateStyle || "full"

    // BookBar: qué puede aparecer (lista separada por ';') y cuándo.
    readonly property string bbContent: config.bookBarContent || "battery;media;routine"
    function bbAllows(kind) { return bbContent.indexOf(kind) !== -1 }
    // always = siempre visible · charging = solo mientras carga, para que en
    // uso normal la pantalla quede limpia y la píldora sea un aviso, no un
    // elemento fijo más.
    readonly property string bookBarShow: config.bookBarShow || "always"

    // BookBar: posición y densidad.
    readonly property string bookBarPosition: config.bookBarPosition || "bottom"
    readonly property bool   bookBarCompact:  (config.bookBarSize || "normal") === "compact"

    // Selector de usuario: row = todas las cuentas en fila · single = solo la
    // última (el patrón anterior, para pantallas muy estrechas).
    readonly property string userSwitcherStyle: config.userSwitcher || "row"

    // Posición del bloque de acceso, en % de la pantalla (centro del bloque).
    readonly property real usersX: {
        var v = parseFloat(config.usersX); return isNaN(v) ? 50 : Math.max(0, Math.min(100, v))
    }
    readonly property real usersY: {
        var v = parseFloat(config.usersY); return isNaN(v) ? 52 : Math.max(0, Math.min(100, v))
    }

    // ── Widgets ───────────────────────────────────────────────────────────
    // Lista separada por ';' (battery;weather;date). Vacío = ninguno.
    readonly property string widgetsEnabled: config.widgets || ""
    // stack = pegados bajo el reloj y se mueven con él · free = grupo suelto
    // colocado por coordenadas propias.
    readonly property string widgetsLayout: config.widgetsLayout || "stack"
    readonly property real widgetsX: {
        var v = parseFloat(config.widgetsX); return isNaN(v) ? 50 : Math.max(0, Math.min(100, v))
    }
    readonly property real widgetsY: {
        var v = parseFloat(config.widgetsY); return isNaN(v) ? 34 : Math.max(0, Math.min(100, v))
    }
    // Posición individual de cada widget en modo libre.
    readonly property string widgetPositions: config.widgetPos || ""
    // Login error state
    property bool loginError: false
    property string loginErrorText: ""

    // ── Background mode ───────────────────────────────────────────────────
    readonly property string bgMode:      config.background || "solid"
    readonly property string bgImagePath: config.bgImage    || ""
    // bgImage puede ser ABSOLUTA (/home/... o /usr/...) o RELATIVA al tema
    // (p.ej. backgrounds/bookos.png) para que el tema sea autocontenido en la ISO.
    readonly property url bgImageUrl:
        bgImagePath === "" ? Qt.resolvedUrl("")
        : (bgImagePath.charAt(0) === "/" ? ("file://" + bgImagePath)
                                         : Qt.resolvedUrl(bgImagePath))

    // Versión ya desenfocada del fondo, generada al empaquetar: mismo nombre
    // con sufijo -blur (backgrounds/bookos.png → backgrounds/bookos-blur.png).
    readonly property string blurPrecomputedPath:
        bgImagePath === "" ? "" : bgImagePath.replace(/\.([^.\/]+)$/, "-blur.$1")
    readonly property url blurPrecomputedUrl:
        blurPrecomputedPath === "" ? Qt.resolvedUrl("")
        : (blurPrecomputedPath.charAt(0) === "/" ? ("file://" + blurPrecomputedPath)
                                                 : Qt.resolvedUrl(blurPrecomputedPath))
    // Lo pone a true el propio Image si el PNG precomputado no existe; entonces
    // el MultiEffect de runtime toma el relevo. Nunca al revés, así que no hay
    // dependencia circular entre la visibilidad y el estado de carga.
    property bool blurProbeFailed: false

    // Solid background
    Rectangle {
        anchors.fill: parent
        color: root.bgColor
        visible: root.bgMode === "solid"
    }

    // Image background (plain)
    Image {
        id: bgImage
        anchors.fill: parent
        source: root.bgImageUrl
        fillMode: Image.PreserveAspectCrop
        visible: root.bgMode === "image" && root.bgImagePath !== ""
        cache: false
    }

    // Blur background ────────────────────────────────────────────────────
    // El blur se PRECOMPUTA al construir el paquete (backgrounds/*-blur.png) y
    // aquí solo se pinta la imagen ya desenfocada. Antes se calculaba en cada
    // arranque del greeter: MultiEffect sobre el wallpaper a resolución de
    // pantalla completa, justo en el instante en que la GPU aún está
    // inicializándose — el momento más caro posible para hacerlo.
    // Si el PNG precomputado falta (tema modificado a mano, wallpaper del
    // usuario), se cae al MultiEffect en runtime y se ve igual, solo más lento.
    Image {
        id: bgBlurred
        anchors.fill: parent
        source: root.blurPrecomputedUrl
        fillMode: Image.PreserveAspectCrop
        visible: root.bgMode === "blur" && !root.blurProbeFailed
        cache: false
        asynchronous: true
        // Sin sourceSize a propósito: el PNG ya viene a 2560 de ancho, así que
        // en la práctica no hay que estirar nada y el ajuste final lo hace la
        // GPU. Fijar sourceSize obligaría a reescalarlo en CPU al decodificar,
        // que es justo el coste que queremos evitar.
        onStatusChanged: if (status === Image.Error) root.blurProbeFailed = true
    }

    Image {
        id: blurSrc
        anchors.fill: parent
        source: root.bgImageUrl
        fillMode: Image.PreserveAspectCrop
        visible: false
        cache: false
        sourceSize.width: Screen.width
        sourceSize.height: Screen.height
        layer.enabled: root.bgMode === "blur" && root.blurProbeFailed
        layer.smooth: true
    }
    MultiEffect {
        anchors.fill: parent
        source: blurSrc
        visible: root.bgMode === "blur" && root.bgImagePath !== "" && root.blurProbeFailed
        blurEnabled: true
        blur: 1.0
        blurMax: 64
        autoPaddingEnabled: false
    }

    // Semi-transparent overlay for image/blur modes (keeps text readable)
    Rectangle {
        anchors.fill: parent
        color: root.overlayColor
        visible: root.bgMode !== "solid"
    }

    // Fallback solid bg when image/blur has no path
    Rectangle {
        anchors.fill: parent
        color: root.bgColor
        visible: root.bgMode !== "solid" && root.bgImagePath === ""
    }

    // ── User info ─────────────────────────────────────────────────────────
    property int    currentUserIndex: userModel.lastIndex >= 0 ? userModel.lastIndex : 0
    property int    userCount:        userModel.rowCount()

    property string loginUsername: userModel.data(userModel.index(currentUserIndex, 0), Qt.UserRole + 1) || ""
    property string displayName:   userModel.data(userModel.index(currentUserIndex, 0), Qt.UserRole + 2) || loginUsername
    property string userIcon:      userModel.data(userModel.index(currentUserIndex, 0), Qt.UserRole + 4) || ""

    // Punto único de cambio de cuenta: la fila de avatares, las flechas del
    // teclado y cualquier otra vía pasan por aquí, así el reseteo del campo de
    // contraseña y del estado de error no se puede olvidar en un camino.
    function selectUser(idx) {
        if (idx < 0 || idx >= userCount || idx === currentUserIndex) return
        currentUserIndex = idx
        passwordField.text = ""
        loginError = false
        passwordField.forceActiveFocus()
    }
    function prevUser() { if (userCount > 1) selectUser((currentUserIndex - 1 + userCount) % userCount) }
    function nextUser() { if (userCount > 1) selectUser((currentUserIndex + 1) % userCount) }

    // ── Profundidad ───────────────────────────────────────────────────────
    // Recorte del sujeto del fondo, pintado ENCIMA del reloj. Lo genera BookOS
    // Settings al aplicar; si el fichero no está, no hay efecto.
    readonly property bool clockDepth: (config.clockDepth || "false") === "true"
    readonly property string cutoutPath:
        bgImagePath === "" ? "" : bgImagePath.replace(/\.([^.\/]+)$/, "-cutout.png")
    readonly property url cutoutUrl:
        cutoutPath === "" ? Qt.resolvedUrl("")
        : (cutoutPath.charAt(0) === "/" ? ("file://" + cutoutPath) : Qt.resolvedUrl(cutoutPath))

    Image {
        z: 1
        anchors.fill: parent
        visible: root.clockDepth && status === Image.Ready
        source: root.clockDepth ? root.cutoutUrl : ""
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: false
    }

    // ── Dispositivos del ecosistema ───────────────────────────────────────
    // Para la tarjeta grande de batería. El greeter no puede lanzar procesos,
    // así que lee el caché que deja la sesión (bookos-sddm-appearance-sync lo
    // copia a /var/lib/sddm/). Sin fichero, la tarjeta enseña solo el portátil.
    property string devicesJson: ""

    // ── Battery ───────────────────────────────────────────────────────────
    property string battCapacity: ""
    property string battStatus:   ""
    property string battTimeLeft: ""

    function readSys(path) {
        try {
            var xhr = new XMLHttpRequest()
            xhr.open("GET", "file://" + path, false)
            xhr.send()
            return xhr.responseText.trim()
        } catch(e) { return "" }
    }

    function updateDevices() {
        devicesJson = readSys("/var/lib/sddm/bookos-devices.json")
    }

    function updateBattery() {
        var base = "/sys/class/power_supply/"
        var bat  = ""
        var cap  = readSys(base + "BAT1/capacity")
        if (cap !== "") { bat = "BAT1" }
        else {
            cap = readSys(base + "BAT0/capacity")
            if (cap !== "") bat = "BAT0"
        }
        battCapacity = cap
        if (bat === "") return
        var st = readSys(base + bat + "/status")
        battStatus = st
        if (st === "Charging") {
            var chargeNow  = parseInt(readSys(base + bat + "/charge_now"))
            var chargeFull = parseInt(readSys(base + bat + "/charge_full"))
            var currentNow = parseInt(readSys(base + bat + "/current_now"))
            if (!isNaN(chargeNow) && !isNaN(chargeFull) && !isNaN(currentNow) && currentNow > 0) {
                var mins = Math.round((chargeFull - chargeNow) / currentNow * 60)
                battTimeLeft = (mins > 0 && mins < 600)
                             ? root.strToFull.replace("%1", mins) : ""
            } else { battTimeLeft = "" }
        } else { battTimeLeft = "" }
    }

    Timer { interval: 60000; running: true; repeat: true
            onTriggered: { updateBattery(); updateDevices() } }

    // Solo al PASAR a cargar, no cada vez que se relee la batería: si no, la
    // píldora daría un salto cada minuto mientras esté enchufada.
    property bool wasCharging: false
    onBattStatusChanged: {
        var nowCharging = (battStatus === "Charging")
        if (nowCharging && !wasCharging && typeof plugAnim !== "undefined") plugAnim.start()
        wasCharging = nowCharging
    }

    // ── Clock ─────────────────────────────────────────────────────────────
    function fmtTime() {
        var f = root.clockFormat === "12h"
                    ? (root.showSeconds ? "h:mm:ss AP" : "h:mm AP")
                    : (root.showSeconds ? "hh:mm:ss"   : "hh:mm")
        return new Date().toLocaleTimeString(root.dateLocale, f)
    }
    // toLocaleDateString CON locale explícito: Qt.formatDate usaba el locale
    // del proceso (inglés) contra un "de" escrito a mano en español y salía
    // "Monday, 27 de July".
    function fmtDate() {
        var d = new Date()
        if (root.dateStyle === "short")   return d.toLocaleDateString(root.dateLocale, "dd/MM/yyyy")
        if (root.dateStyle === "weekday") return d.toLocaleDateString(root.dateLocale, "dddd")
        return d.toLocaleDateString(root.dateLocale, "dddd, d 'de' MMMM")
    }
    property string clockTime: fmtTime()
    property string clockDate: fmtDate()
    Timer {
        // Sin segundos basta con despertar cada 30 s: el minuto cambia como
        // mucho con esa latencia y son 30 veces menos repintados.
        interval: root.showSeconds ? 1000 : 30000
        running: true; repeat: true
        onTriggered: {
            root.clockTime = fmtTime()
            // La fecha solo cambia a medianoche; recalcularla cada tick era
            // formatear una cadena por segundo para nada.
            var d = fmtDate()
            if (d !== root.clockDate) root.clockDate = d
        }
    }

    // ── Login / fingerprint ───────────────────────────────────────────────
    property bool showPassword:      false
    property bool loggingIn:         false
    property bool fingerprintActive: false

    function doLogin() {
        if (loggingIn) return
        loggingIn = true
        fingerprintActive = false
        sddm.login(loginUsername, passwordField.text, currentSessionIndex)
    }

    // Fingerprint availability — true only if user has enrolled prints
    property bool fingerprintEnrolled: false
    function checkFingerprint() {
        // Look for enrolled prints in fprintd storage (root-readable, but readable by user too in some setups)
        try {
            var xhr = new XMLHttpRequest()
            xhr.open("GET", "file:///var/lib/fprint/" + root.loginUsername + "/", false)
            xhr.send()
            if (xhr.status === 0 || xhr.status === 200) {
                if (xhr.responseText && xhr.responseText.length > 0) {
                    root.fingerprintEnrolled = true
                    return
                }
            }
        } catch(e) {}
        // Fallback: per-user state file written by BookOS Settings on enroll
        try {
            var xhr2 = new XMLHttpRequest()
            xhr2.open("GET", "file:///home/" + root.loginUsername + "/.config/bookos-fp-enrolled", false)
            xhr2.send()
            root.fingerprintEnrolled = (xhr2.responseText.trim() === "true")
        } catch(e) { root.fingerprintEnrolled = false }
    }

    Timer {
        id: fpTimer
        interval: 2500
        running: root.fingerprintEnrolled && passwordField.text === "" && !root.loggingIn
        repeat: true
        onTriggered: {
            if (root.fingerprintEnrolled && passwordField.text === "" && !root.loggingIn) {
                root.loggingIn = true
                root.fingerprintActive = true
                sddm.login(root.loginUsername, "", currentSessionIndex)
            }
        }
    }

    Connections {
        target: sddm
        function onLoginSucceeded() {
            // La animación se lanza ANTES de bajar fingerprintActive: si no, el
            // indicador se resetea y el desbloqueo pasa sin verse.
            if (root.fingerprintActive && typeof fpIndicator !== "undefined")
                fpIndicator.playUnlock()
            root.loggingIn = false
            root.fingerprintActive = false
            root.loginError = false
        }
        function onLoginFailed() {
            root.loggingIn = false
            if (!root.fingerprintActive) {
                shakeAnim.start()
                root.loginError = true
                root.loginErrorText = root.strWrongPassword
            }
            root.fingerprintActive = false
            passwordField.text = ""
            passwordField.forceActiveFocus()
        }
    }

    // ── Clock — posición y tamaño libres ──────────────────────────────────
    // Se coloca por coordenadas (centro del bloque) en vez de por anchors: eso
    // es lo que permite arrastrarlo a cualquier punto desde el editor en vez de
    // encajarlo en unas pocas posiciones fijas.
    Column {
        id: clockBlock
        z: 2
        spacing: Math.round(root.dateGap)
        x: Math.round(root.width  * root.clockX / 100 - width  / 2)
        y: Math.round(root.height * root.clockY / 100 - height / 2)
        Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }

        Text {
            id: clockText
            text: root.clockTime
            font.family: root.fontFamily(root.clockFont)
            font.pixelSize: Math.round(root.height * root.clockScale * root.clockStretch)
            font.weight: root.clockWeight
            // Tracking del editor, medido sobre el cuerpo SIN estirar: el
            // estiramiento no debe abrir ni cerrar el espaciado entre cifras,
            // así que se multiplica por él para compensar la Scale de abajo.
            font.letterSpacing: root.height * root.clockScale * root.clockTracking
                                * root.clockStretch
            color: root.clockColor
            opacity: root.clockOpacity
            anchors.horizontalCenter: parent.horizontalCenter
            transform: Scale {
                xScale: 1 / root.clockStretch
                yScale: 1
                origin.x: clockText.width / 2
                origin.y: 0
            }
        }
        Text {
            text: root.clockDate
            visible: root.showDate
            font.family: root.fontFamily(root.clockFont)
            font.pixelSize: Math.round(root.height * 0.022 * root.dateScale)
            font.weight: root.dateWeight
            color: root.dateColor
            // Ya iba al 85 %: se multiplica para que siga un peldaño por
            // debajo de la hora en vez de igualarla.
            opacity: 0.85 * root.clockOpacity
            anchors.horizontalCenter: parent.horizontalCenter
        }
    }

    // ── Widgets ───────────────────────────────────────────────────────────
    // En modo "stack" cuelgan del bloque del reloj, así que al arrastrar el
    // reloj se mueven con él sin necesidad de recolocarlos aparte.
    GreeterWidgets {
        id: greeterWidgets
        z: 2
        enabledList: root.widgetsEnabled
        positions: root.widgetPositions
        sizes: config.widgetSize || ""
        scales: config.widgetScale || ""
        opacities: config.widgetOpacity || ""
        layoutMode: root.widgetsLayout
        // Ancla del modo stack: centro del reloj y justo debajo de su bloque.
        stackX: clockBlock.x + clockBlock.width / 2
        stackY: clockBlock.y + clockBlock.height + root.height * 0.035
        isDark: root.isDark
        accent: root.accentColor
        pillBg: root.pillBg
        fg: root.fgColor
        fg2: root.fg2Color
        localeName: root.localeName
        strBattery: root.strBattery
        strCharging: root.strCharging
        strNoEvents: root.strNoEvents
        strNotifications: root.strNotifications
        devicesJson: root.devicesJson
        battCapacity: root.battCapacity
        battStatus: root.battStatus
        battTimeLeft: root.battTimeLeft
    }

    // ── Center column: avatar + name + password ───────────────────────────
    Column {
        id: loginBlock
        x: Math.round(root.width  * root.usersX / 100 - width  / 2)
        y: Math.round(root.height * root.usersY / 100 - height / 2)
        Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        spacing: 14
        // ── Selector de usuario ───────────────────────────────────────────
        // Todas las cuentas a la vez, la activa
        // más grande y con anillo de acento. Con una sola cuenta la fila es
        // simplemente ese avatar, sin adornos de navegación.
        Item {
            id: switcherRow
            anchors.horizontalCenter: parent.horizontalCenter
            width:  Math.min(avatarFlow.implicitWidth, root.width * 0.8)
            height: 132

            readonly property int bigSize:   112
            readonly property int smallSize: 76

            // ListView en vez de Row para que con muchas cuentas se pueda
            // desplazar en lugar de desbordar la pantalla.
            ListView {
                id: avatarFlow
                anchors.centerIn: parent
                width:  Math.min(implicitWidth, root.width * 0.8)
                height: parent.height
                orientation: ListView.Horizontal
                spacing: 22
                model: userModel
                currentIndex: root.currentUserIndex
                boundsBehavior: Flickable.StopAtBounds
                highlightMoveDuration: 260
                // Mantiene el seleccionado centrado al navegar con el teclado.
                preferredHighlightBegin: width / 2 - switcherRow.bigSize / 2
                preferredHighlightEnd:   width / 2 + switcherRow.bigSize / 2
                highlightRangeMode: ListView.ApplyRange
                interactive: contentWidth > width
                implicitWidth: Math.max(1, contentWidth)

                delegate: Item {
                    // Reserva siempre el ancho del avatar grande para que los
                    // vecinos no se desplacen al cambiar de selección.
                    width:  switcherRow.bigSize
                    height: switcherRow.bigSize
                    readonly property bool isCurrent: index === root.currentUserIndex

                    UserAvatar {
                        anchors.centerIn: parent
                        width:  parent.isCurrent ? switcherRow.bigSize : switcherRow.smallSize
                        height: width
                        Behavior on width { NumberAnimation { duration: 220; easing.type: Easing.OutBack } }
                        source:   model.icon !== undefined && model.icon !== "" ? model.icon : ""
                        initial:  (model.realName || model.name || "?").charAt(0).toUpperCase()
                        selected: parent.isCurrent
                        accent:   root.accentColor
                        fallbackText: "#ffffff"

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.selectUser(index)
                        }
                    }
                }
            }
        }

        Text {
            text: root.displayName
            font.pixelSize: 18
            font.weight: Font.Medium
            color: root.fgColor
            anchors.horizontalCenter: parent.horizontalCenter
        }

        Item {
            id: passwordRow
            width: Math.min(420, root.width * 0.42)
            height: 56
            anchors.horizontalCenter: parent.horizontalCenter

            SequentialAnimation {
                id: shakeAnim
                PropertyAnimation { target: passwordRow; property: "x"; to: passwordRow.x - 14; duration: 45 }
                PropertyAnimation { target: passwordRow; property: "x"; to: passwordRow.x + 14; duration: 45 }
                PropertyAnimation { target: passwordRow; property: "x"; to: passwordRow.x - 10; duration: 45 }
                PropertyAnimation { target: passwordRow; property: "x"; to: passwordRow.x + 10; duration: 45 }
                PropertyAnimation { target: passwordRow; property: "x"; to: passwordRow.x;      duration: 45 }
            }

            Rectangle {
                id: inputBg
                anchors.left: parent.left
                anchors.right: enterBtn.left
                anchors.rightMargin: 10
                anchors.verticalCenter: parent.verticalCenter
                height: 56; radius: 30
                color: root.fieldBg

                TextInput {
                    id: passwordField
                    anchors {
                        left: parent.left; leftMargin: 22
                        right: showPwBtn.left; rightMargin: 8
                        verticalCenter: parent.verticalCenter
                    }
                    echoMode: root.showPassword ? TextInput.Normal : TextInput.Password
                    color: root.fgColor
                    font.pixelSize: 17
                    passwordCharacter: "●"
                    verticalAlignment: TextInput.AlignVCenter
                    Keys.onReturnPressed: root.doLogin()
                    Keys.onEnterPressed:  root.doLogin()
                    onTextChanged: {
                        if (text !== "") fpTimer.stop()
                        if (root.loginError) root.loginError = false
                    }
                }

                Rectangle {
                    id: showPwBtn
                    width: 30; height: 30; radius: 15
                    color: root.accentColor
                    anchors.right: parent.right
                    anchors.rightMargin: 13
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                        anchors.centerIn: parent
                        text: root.showPassword ? "◉" : "◎"
                        font.pixelSize: 14
                        color: "#ffffff"
                    }
                    MouseArea {
                        anchors.fill: parent
                        onPressed:  root.showPassword = true
                        onReleased: root.showPassword = false
                    }
                }
            }

            Rectangle {
                id: enterBtn
                width: 56; height: 56; radius: width / 2
                color: root.loggingIn && !root.fingerprintActive ? root.accentColor : root.enterBg
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                Behavior on color { ColorAnimation { duration: 120 } }

                // Arrow (idle)
                Text {
                    anchors.centerIn: parent
                    text: "→"
                    font.pixelSize: 22
                    color: root.enterFg
                    visible: !root.loggingIn || root.fingerprintActive
                }

                // Spinner (logging in)
                Item {
                    anchors.centerIn: parent
                    width: 24; height: 24
                    visible: root.loggingIn && !root.fingerprintActive
                    Rectangle {
                        anchors.fill: parent
                        radius: width / 2
                        color: "transparent"
                        border.color: "#ffffff"
                        border.width: 2
                        opacity: 0.25
                    }
                    Canvas {
                        id: spinnerArc
                        anchors.fill: parent
                        onPaint: {
                            var ctx = getContext("2d")
                            ctx.clearRect(0, 0, width, height)
                            ctx.strokeStyle = "#ffffff"
                            ctx.lineWidth = 2
                            ctx.lineCap = "round"
                            ctx.beginPath()
                            ctx.arc(width/2, height/2, width/2 - 1, -Math.PI/2, Math.PI/2)
                            ctx.stroke()
                        }
                        RotationAnimator on rotation {
                            from: 0; to: 360; duration: 900
                            loops: Animation.Infinite
                            running: root.loggingIn && !root.fingerprintActive
                        }
                    }
                }

                MouseArea { anchors.fill: parent; onClicked: root.doLogin() }
            }
        }

        // Login error message
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.loginError
            text: root.loginErrorText
            font.pixelSize: 13
            font.weight: Font.Medium
            color: "#FF453A"
            opacity: root.loginError ? 1.0 : 0.0
            Behavior on opacity { NumberAnimation { duration: 200 } }
        }

        // Huella: indicador animado + texto. Antes solo había texto, así que no
        // había ninguna señal visual de que el sensor estuviera leyendo.
        Column {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.fingerprintEnrolled
            spacing: 6

            Fingerprint {
                id: fpIndicator
                anchors.horizontalCenter: parent.horizontalCenter
                width: 54; height: 68
                accent: root.accentColor
                base: root.isDark ? "#3a3a3c" : "#c7c7cc"
                scanning: root.fingerprintActive
            }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: root.fingerprintActive ? "Leyendo huella…" : "o usa tu huella dactilar"
                font.pixelSize: 13
                color: root.accentColor
                opacity: root.fingerprintActive ? 1.0 : 0.7
                Behavior on opacity { NumberAnimation { duration: 250 } }
            }
        }

        // Caps Lock warning
        Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 6
            visible: keyboard.capsLock
            Text {
                text: "⇪"
                font.pixelSize: 14
                color: "#FF9500"
                anchors.verticalCenter: parent.verticalCenter
            }
            Text {
                text: root.strCapsLock
                font.pixelSize: 13
                color: "#FF9500"
            }
        }
    }

    // ── Session picker — bottom-left ──────────────────────────────────────
    property int  currentSessionIndex: sessionModel.lastIndex
    property bool sessionMenuOpen: false

    Item {
        id: sessionPicker
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        anchors.leftMargin: 24
        anchors.bottomMargin: 24
        width: 220; height: 36
        z: 10

        Rectangle {
            id: sessionPill
            anchors.fill: parent
            radius: 18
            color: sessionPillArea.containsMouse ? (root.isDark ? "#2a2a2c" : "#e5e5ea") : root.pillBg
            Behavior on color { ColorAnimation { duration: 150 } }

            Text {
                anchors.left: parent.left; anchors.leftMargin: 14
                anchors.verticalCenter: parent.verticalCenter
                text: "⚙"
                font.pixelSize: 14
                color: root.fgColor
            }
            Text {
                anchors.left: parent.left; anchors.leftMargin: 36
                anchors.right: caretIcon.left; anchors.rightMargin: 8
                anchors.verticalCenter: parent.verticalCenter
                text: sessionModel.data(sessionModel.index(root.currentSessionIndex, 0), Qt.UserRole + 4) || root.strSession
                font.pixelSize: 13
                color: root.fgColor
                elide: Text.ElideRight
            }
            Text {
                id: caretIcon
                anchors.right: parent.right; anchors.rightMargin: 14
                anchors.verticalCenter: parent.verticalCenter
                text: root.sessionMenuOpen ? "▾" : "▴"
                font.pixelSize: 10
                color: root.fg2Color
            }

            MouseArea {
                id: sessionPillArea
                anchors.fill: parent
                hoverEnabled: true
                onClicked: root.sessionMenuOpen = !root.sessionMenuOpen
            }
        }

        // Custom dropdown
        Rectangle {
            id: sessionDropdown
            visible: root.sessionMenuOpen
            opacity: root.sessionMenuOpen ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 150 } }
            anchors.left: parent.left
            anchors.bottom: parent.top
            anchors.bottomMargin: 6
            width: parent.width
            height: Math.min(sessionList.contentHeight + 12, 240)
            radius: 14
            color: root.isDark ? "#1c1c1e" : "#ffffff"
            border.color: root.isDark ? "#2c2c2e" : "#d1d1d6"
            border.width: 1

            ListView {
                id: sessionList
                anchors.fill: parent
                anchors.margins: 6
                clip: true
                model: sessionModel
                delegate: Rectangle {
                    width: sessionList.width
                    height: 34
                    radius: 10
                    color: itemArea.containsMouse
                            ? (root.isDark ? "#2c2c2e" : "#f2f2f7")
                            : "transparent"
                    Behavior on color { ColorAnimation { duration: 100 } }

                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 12
                        anchors.right: checkMark.left; anchors.rightMargin: 6
                        anchors.verticalCenter: parent.verticalCenter
                        text: model.name
                        font.pixelSize: 13
                        color: root.fgColor
                        elide: Text.ElideRight
                    }
                    Text {
                        id: checkMark
                        anchors.right: parent.right; anchors.rightMargin: 12
                        anchors.verticalCenter: parent.verticalCenter
                        visible: index === root.currentSessionIndex
                        text: "✓"
                        font.pixelSize: 13
                        color: root.accentColor
                    }
                    MouseArea {
                        id: itemArea
                        anchors.fill: parent
                        hoverEnabled: true
                        onClicked: {
                            root.currentSessionIndex = index
                            root.sessionMenuOpen = false
                        }
                    }
                }
            }
        }
    }

    // Click-outside to close session menu
    MouseArea {
        anchors.fill: parent
        visible: root.sessionMenuOpen
        z: 9
        onClicked: root.sessionMenuOpen = false
    }

    // ── Power buttons — bottom-right ──────────────────────────────────────
    Row {
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: 24
        anchors.bottomMargin: 24
        spacing: 10

        // Suspender
        Rectangle {
            width: 44; height: 44; radius: 22
            color: suspArea.containsMouse ? (root.isDark ? "#3a3a3c" : "#e5e5ea") : root.pillBg
            Behavior on color { ColorAnimation { duration: 150 } }
            visible: sddm.canSuspend
            Text { anchors.centerIn: parent; text: "☾"; font.pixelSize: 18; color: root.fgColor }
            MouseArea { id: suspArea; anchors.fill: parent; hoverEnabled: true; onClicked: sddm.suspend() }
        }
        // Reiniciar
        Rectangle {
            width: 44; height: 44; radius: 22
            color: rebArea.containsMouse ? (root.isDark ? "#3a3a3c" : "#e5e5ea") : root.pillBg
            Behavior on color { ColorAnimation { duration: 150 } }
            visible: sddm.canReboot
            Text { anchors.centerIn: parent; text: "↻"; font.pixelSize: 18; color: root.fgColor }
            MouseArea { id: rebArea; anchors.fill: parent; hoverEnabled: true; onClicked: sddm.reboot() }
        }
        // Apagar
        Rectangle {
            width: 44; height: 44; radius: 22
            color: pwrArea.containsMouse ? "#FF3B30" : root.pillBg
            Behavior on color { ColorAnimation { duration: 150 } }
            visible: sddm.canPowerOff
            Text { anchors.centerIn: parent; text: "⏻"; font.pixelSize: 18; color: pwrArea.containsMouse ? "#ffffff" : root.fgColor }
            MouseArea { id: pwrArea; anchors.fill: parent; hoverEnabled: true; onClicked: sddm.powerOff() }
        }
    }

    // ── Routine ───────────────────────────────────────────────────────────
    property var   bbRoutine: null
    property string bbRoutineIcon: ""
    property string bbRoutineName: ""

    function readRoutine() {
        try {
            var xhr = new XMLHttpRequest()
            xhr.open("GET", "file:///home/" + root.loginUsername + "/.config/bookos-active-routine.json", false)
            xhr.send()
            var j = JSON.parse(xhr.responseText.trim())
            if (j && j.active && j.name) {
                bbRoutine     = j
                bbRoutineIcon = j.icon  || "⚙"
                bbRoutineName = j.name  || ""
            } else {
                bbRoutine = null
            }
        } catch(e) { bbRoutine = null }
    }

    // Test-mode detection: in real SDDM, sddm.hostName is set; in test it's empty
    property bool testMode: {
        try { return !sddm.hostName || sddm.hostName === "" } catch(e) { return true }
    }

    Component.onCompleted: {
        updateBattery()
        updateDevices()
        readRoutine()
        checkFingerprint()
        passwordField.forceActiveFocus()
        root.opacity = 1
    }

    // Re-check fingerprint when user switches
    onLoginUsernameChanged: checkFingerprint()

    // Test-mode exit hint (top-right)
    Rectangle {
        visible: root.testMode
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: 16
        anchors.rightMargin: 16
        width: exitText.implicitWidth + 28
        height: 32
        radius: 16
        color: root.pillBg
        z: 100

        Text {
            id: exitText
            anchors.centerIn: parent
            text: root.strExit
            font.pixelSize: 12
            color: root.fgColor
        }
        MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: Qt.quit()
        }
    }

    // ── Book Bar modes ────────────────────────────────────────────────────
    readonly property bool bbCharging:   battStatus === "Charging"
    readonly property bool bbHasBattery: battCapacity !== ""
    readonly property bool bbHasRoutine: bbRoutine !== null

    // priority: routine > charging > battery (always show if battery known)
    property string bbMode: {
        if (!root.showBookBar) return ""
        if (bbHasRoutine && root.bbAllows("routine")) return "routine"
        if (!root.showBattery || !root.bbAllows("battery")) return ""
        if (bbCharging)   return "charging"
        // En modo "charging" la píldora solo existe mientras carga.
        if (root.bookBarShow === "charging") return ""
        if (bbHasBattery) return "battery"
        return ""
    }

    // ── Book Bar pill ─────────────────────────────────────────────────────
    Rectangle {
        id: bookBar
        visible: root.bbMode !== ""
        anchors.horizontalCenter: parent.horizontalCenter
        // Arriba o abajo según bookBarPosition; el margen opuesto queda
        // desactivado con undefined para que solo mande un anclaje.
        anchors.bottom: root.bookBarPosition === "bottom" ? parent.bottom : undefined
        anchors.top:    root.bookBarPosition === "top"    ? parent.top    : undefined
        anchors.bottomMargin: 40
        anchors.topMargin: 28

        height: root.bookBarCompact ? 42 : 56
        width: bbRow.implicitWidth + (root.bookBarCompact ? 28 : 40)
        // Radio = mitad de la altura: la píldora sigue siendo una cápsula
        // perfecta en ambas densidades sin tener que fijar dos valores.
        radius: height / 2

        color: root.bbMode === "charging" ? "#25C1C9"
             : root.bbMode === "routine"  ? "#2D2B6B"
             : root.bbMode === "battery"  ? root.pillBg
             : root.pillBg

        Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
        Behavior on color { ColorAnimation  { duration: 400 } }

        // Al enchufar el cargador la píldora da un pequeño salto y un destello.
        // Se anima solo scale y opacity (lo que pide el HIG); el ancho ya tiene
        // su propio Behavior y no entra aquí.
        transformOrigin: Item.Center
        SequentialAnimation {
            id: plugAnim
            ParallelAnimation {
                NumberAnimation { target: bookBar; property: "scale"; from: 1.0; to: 1.10
                                  duration: 180; easing.type: Easing.OutBack }
                NumberAnimation { target: plugFlash; property: "opacity"; from: 0; to: 0.55
                                  duration: 180 }
            }
            ParallelAnimation {
                NumberAnimation { target: bookBar; property: "scale"; to: 1.0
                                  duration: 260; easing.type: Easing.OutCubic }
                NumberAnimation { target: plugFlash; property: "opacity"; to: 0
                                  duration: 380 }
            }
        }
        // Destello: capa blanca por encima que sube y baja de opacidad.
        Rectangle {
            id: plugFlash
            anchors.fill: parent
            radius: parent.radius
            color: "#ffffff"
            opacity: 0
        }

        Row {
            id: bbRow
            anchors.centerIn: parent
            spacing: 10

            // Charging / battery content
            Row {
                visible: root.bbMode === "charging" || root.bbMode === "battery"
                spacing: 8
                anchors.verticalCenter: parent.verticalCenter

                Text {
                    visible: root.bbMode === "charging"
                    text: "⚡"
                    font.pixelSize: root.bookBarCompact ? 17 : 22
                    color: root.bbMode === "charging" ? "#1c1c1e" : root.fgColor
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    text: root.battCapacity + "%"
                    font.pixelSize: root.bookBarCompact ? 15 : 20
                    font.weight: Font.Bold
                    color: root.bbMode === "charging" ? "#1c1c1e" : root.fgColor
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    visible: root.battTimeLeft !== ""
                    text: "· " + root.battTimeLeft
                    font.pixelSize: root.bookBarCompact ? 12 : 14
                    color: root.bbMode === "charging" ? "#1c1c1e" : root.fg2Color
                    opacity: 0.75
                    anchors.verticalCenter: parent.verticalCenter
                }
            }

            // Routine content
            Row {
                visible: root.bbMode === "routine"
                spacing: 10
                anchors.verticalCenter: parent.verticalCenter

                Text {
                    text: root.bbRoutineIcon
                    font.pixelSize: root.bookBarCompact ? 17 : 22
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    text: root.bbRoutineName
                    font.pixelSize: root.bookBarCompact ? 14 : 18
                    font.weight: Font.Bold
                    color: "white"
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }
    }
}
