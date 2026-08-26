/*
 * BookOS SDDM — widgets del greeter.
 *
 * Dos modos de colocación:
 *  · stack → en fila bajo el reloj, se mueven con él.
 *  · free  → cada widget en SU PROPIA posición (widgetPos), así se puede tener
 *            uno arriba a la izquierda y otro abajo a la derecha.
 *
 * Cada widget es una tarjeta del HIG: radio 25, fondo de píldora, título
 * 14/Medium y subtítulo 11/Regular en text-2.
 *
 * NINGÚN widget hace red. El greeter arranca antes de que haya sesión y
 * consultar servicios externos desde la pantalla de acceso sería un riesgo de
 * privacidad y una fuente de cuelgues: el tiempo se lee de un fichero que la
 * sesión del escritorio dejó cacheado y que bookos-sddm-appearance-sync.service
 * copia a /var/lib/sddm/. Si no existe, ese widget no aparece.
 */
import QtQuick 2.15

Item {
    id: widgets

    // Lista separada por ';' — p.ej. "battery;weather;date".
    property string enabledList: ""
    // "battery:12,20;weather:50,34" — centro de cada uno en % de pantalla.
    property string positions: ""
    property string layoutMode: "stack"
    // "weather:large;battery:compact" — variante de cada widget.
    property string sizes: ""
    // "weather:120" — escala individual en %.
    property string scales: ""
    // "battery:70;date:100" — opacidad individual del FONDO, 20-100.
    // El tiempo NO entra: su color es el cielo del diseño y aguarlo lo
    // convierte en una mancha; los demás usan el fondo de píldora, que sí está
    // pensado para dejar ver lo de detrás.
    property string opacities: ""
    // Ancla del modo stack: centro del reloj y borde inferior del bloque.
    property real stackX: 0
    property real stackY: 0

    property bool  isDark: true
    property color accent: "#007aff"
    property color pillBg: "#CC1c1c1e"
    property color fg: "#ffffff"
    property color fg2: "#8e8e93"
    property string localeName: "es_ES"

    // ── Textos ───────────────────────────────────────────────────────────
    // Llegan ya traducidos desde theme.conf (los escribe BookOS Settings en el
    // idioma de la app). Aquí solo hay respaldos: este componente lo instancian
    // el greeter y la pantalla de bloqueo, y ninguno de los dos puede resolver
    // traducciones por su cuenta.
    property string strBattery: "Batería"
    property string strCharging: "Cargando"
    property string strNoEvents: "Sin eventos"
    property string strNotifications: "NOTIFICACIONES"
    // Tipografía del archivo de Figma. Se declara aquí y no suelta en cada
    // Text para que cambiarla sea un solo sitio. Si la familia no estuviera
    // instalada Qt cae a la del sistema EN SILENCIO, así que la comprobación
    // de que existe es parte del despliegue, no del código.
    property string designFont: "Onest"

    // ── Dispositivos del ecosistema ───────────────────────────────────────
    // La tarjeta grande de batería enseña portátil, móvil, tablet y auriculares.
    // El JSON lo escribe BookOS Settings desde UPower (~/.cache/bookos-devices
    // .json, copiado a /var/lib/sddm/ para el greeter): ni el greeter ni la
    // pantalla de bloqueo pueden lanzar `upower` por su cuenta.
    property string devicesJson: ""
    // [{kind:"laptop", name:"…", pct:80, charging:true}, …]
    property var devices: []
    onDevicesJsonChanged: {
        try {
            var j = JSON.parse(devicesJson || "{}")
            devices = (j.devices || []).filter(function (d) { return d && d.kind })
        } catch (e) { devices = [] }
    }
    // Cuando no hay caché, al menos está SIEMPRE el portátil: su batería la
    // conoce quien nos instancia sin pasar por UPower.
    readonly property var deviceList: {
        if (devices.length > 0) return devices
        if (battCapacity === "") return []
        return [{ kind: "laptop", name: "", pct: parseInt(battCapacity) || 0,
                  charging: battStatus === "Charging" }]
    }

    property string battCapacity: ""
    property string battStatus: ""
    property string battTimeLeft: ""

    // ── Fuentes que solo existen en la sesión ─────────────────────────────
    // Notificaciones y eventos llegan YA construidos desde fuera en vez de
    // importarse aquí: `org.kde.notificationmanager` y el plugin de calendario
    // no existen en el greeter de SDDM, y un import que no resuelve tumba el
    // componente entero — con él, los widgets de batería y tiempo que sí
    // funcionan allí. Con las listas vacías la tarjeta no se dibuja.
    // [{ app: "Telegram", t: "17:00" }, …] — ya aplanado por quien nos usa.
    property var notifList: []
    readonly property int notifCount: notifList.length
    // [{ t: "17:00", title: "Sacar la basura" }, …]
    property var calToday: []
    property var calTomorrow: []

    // ── Música ────────────────────────────────────────────────────────────
    // Igual que las notificaciones: los datos llegan YA resueltos desde fuera.
    // El modelo MPRIS de Plasma no existe en el greeter de SDDM y un import que
    // no resuelve tumba este componente entero, con él los widgets que allí sí
    // funcionan. La pantalla de bloqueo lo pasa desde la BookBar, que ya tiene
    // el reproductor abierto — un segundo modelo sería otra conexión al bus
    // para los mismos datos.
    property string mediaTitle: ""
    property string mediaArtist: ""
    property url    mediaArt: ""
    property bool   mediaPlaying: false
    signal mediaPrev()
    signal mediaPlayPause()
    signal mediaNext()

    anchors.fill: parent

    readonly property var list:
        enabledList === "" ? [] : enabledList.split(";").filter(function (w) { return w !== "" })

    /** Variante de un widget: "compact" (píldora) o "large" (tarjeta). */
    function sizeOf(key) {
        var parts = sizes.split(";")
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split(":")
            if (kv[0] === key && kv.length > 1) return kv[1]
        }
        return "compact"
    }
    /** Escala individual en % (100 = base). */
    function scaleOf(key) {
        var parts = scales.split(";")
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split(":")
            if (kv[0] === key && kv.length > 1) {
                var v = parseFloat(kv[1])
                if (!isNaN(v)) return Math.max(50, Math.min(200, v)) / 100
            }
        }
        return 1.0
    }

    /** Previsión de 7 días del caché: [{d:"27", t:"32", s:"clouds"}, …] */
    property var wxDays: []

    /** Opacidad del fondo de un widget (0-1). El tiempo siempre opaco. */
    function opacityOf(key) {
        if (key === "weather") return 1.0
        var parts = opacities.split(";")
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split(":")
            if (kv[0] === key && kv.length > 1) {
                var v = parseFloat(kv[1])
                if (!isNaN(v)) return Math.max(20, Math.min(100, v)) / 100
            }
        }
        return 1.0
    }

    /** Posición guardada de un widget, o un reparto por defecto si no tiene. */
    function posOf(key, axis) {
        var parts = positions.split(";")
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split(":")
            if (kv[0] === key && kv.length > 1) {
                var xy = kv[1].split(",")
                var v = parseFloat(axis === "x" ? xy[0] : xy[1])
                if (!isNaN(v)) return Math.max(0, Math.min(100, v))
            }
        }
        // Reparto inicial en abanico para que no nazcan todos apilados.
        var idx = list.indexOf(key)
        return axis === "x" ? (30 + idx * 20) : 34
    }

    // ── Tiempo, leído del caché ───────────────────────────────────────────
    property string wxTemp: ""
    property string wxDesc: ""
    property string wxCity: ""
    property string wxIcon: "☁"
    // Estado del tiempo: clear | clouds | partly | night | dawn | dusk.
    // Lo trae el caché; si falta, se deduce de la hora para no salir siempre
    // con el mismo color.
    property string wxState: ""
    readonly property string wxEffective: {
        if (wxState !== "") return wxState
        var h = new Date().getHours()
        if (h >= 21 || h < 6)  return "night"
        if (h < 9)             return "dawn"
        if (h >= 19)           return "dusk"
        return "clear"
    }
    // Colores exactos del archivo de Figma (ver BookOS-HIG/widgets-tokens.md).
    // Los dos últimos son degradados verticales.
    readonly property color wxTop: {
        switch (wxEffective) {
        case "clouds": return "#AEC5DD"
        case "partly": return "#225784"
        case "night":  return "#09253E"
        case "dawn":   return "#09253E"
        case "dusk":   return "#468ECD"
        default:       return "#4D9BDE"
        }
    }
    readonly property color wxBottom: {
        switch (wxEffective) {
        case "dawn": return "#2E6698"
        case "dusk": return "#1E4A71"
        default:     return wxTop
        }
    }
    // JSON del tiempo ya leído por quien nos instancia. La pantalla de bloqueo
    // lo pasa por aquí porque kscreenlocker no arranca con
    // QML_XHR_ALLOW_FILE_READ=1 y cualquier XHR sobre file:// le vuelve vacío.
    // Si llega vacío se lee la caché como siempre (camino del greeter de SDDM).
    property string weatherJson: ""

    function _applyWeather(text) {
        try {
            var j = JSON.parse(text || "{}")
            wxTemp = j.temp !== undefined ? String(j.temp) : ""
            wxDesc = j.desc || ""
            wxCity = j.city || ""
            if (j.icon) wxIcon = j.icon
            if (j.state) wxState = j.state
            if (j.days && j.days.length) wxDays = j.days
        } catch (e) {
            wxTemp = ""   // sin caché no hay widget del tiempo
        }
    }

    onWeatherJsonChanged: if (weatherJson !== "") _applyWeather(weatherJson)

    Component.onCompleted: {
        if (weatherJson !== "") { _applyWeather(weatherJson); return }
        try {
            var xhr = new XMLHttpRequest()
            xhr.open("GET", "file:///var/lib/sddm/bookos-weather.json", false)
            xhr.send()
            _applyWeather(xhr.responseText)
        } catch (e) {
            wxTemp = ""
        }
    }

    Repeater {
        model: widgets.list

        delegate: Rectangle {
            id: card
            required property string modelData
            required property int index

            readonly property bool isBattery: modelData === "battery"
            readonly property bool isWeather: modelData === "weather"
            readonly property bool isDate:    modelData === "date"
            readonly property bool isNotif:   modelData === "notifications"
            readonly property bool isCal:     modelData === "calendar"
            readonly property bool isMedia:   modelData === "media"
            // Cada tarjeta se esconde entera si no tiene nada que enseñar: el
            // tiempo sin caché, las notificaciones sin avisos (o sin modelo,
            // que es el caso del greeter de SDDM).
            visible: (!isWeather || widgets.wxTemp !== "")
                     && (!isNotif || widgets.notifCount > 0)
                     // Sin nada sonando no hay tarjeta: un reproductor vacío en
                     // la pantalla de bloqueo no dice nada y ocupa lo mismo.
                     && (!isMedia || widgets.mediaTitle !== "")

            readonly property bool large: widgets.sizeOf(modelData) === "large"
            readonly property real k: widgets.scaleOf(modelData)

            // Notificaciones y calendario son SIEMPRE tarjeta: una píldora de
            // 92 de alto no da para tres filas ni para dos columnas de día.
            readonly property bool tall: isNotif || isCal || isMedia

            // Proporciones del Figma (750x330) reducidas a la escala del
            // greeter; la píldora conserva el alto de 92 de antes.
            // La tarjeta grande pasa de 330x145 a 375x165, que es lo que mide
            // en el Figma (750x330 sobre un lienzo de 2880) una vez dividido
            // por el escalado HiDPI x2 del panel. Misma proporción que antes
            // (2,27), solo un 12 % más de sitio: con 330 el bloque de arriba
            // y la fila de días se comían todo el aire del diseño.
            // La tarjeta de batería se ajusta al número de dispositivos: con
            // uno solo, 375 de ancho dejarían un círculo perdido en el centro.
            readonly property int devCount: Math.max(1, widgets.deviceList.length)
            implicitWidth:  tall     ? Math.round(300 * k)
                          : isBattery && large ? Math.round((36 + 78 * devCount) * k)
                          : large    ? Math.round(375 * k) : content.implicitWidth + 32
            implicitHeight: isNotif  ? Math.round((34 + 46 * Math.min(3, widgets.notifCount)) * k)
                          : isMedia  ? Math.round(116 * k)
                          : isCal    ? Math.round(150 * k)
                          : isBattery && large ? Math.round(104 * k)
                          : large    ? Math.round(165 * k) : Math.round(92 * k)
            width: implicitWidth
            height: implicitHeight
            // El Figma da radio 40 sobre una tarjeta de 750 de ancho: en la
            // nuestra, de 330, eso son 17,6. Con los 25 de las píldoras salía
            // notablemente más redondeada que en el diseño.
            radius: isWeather && large ? Math.round(width * 40 / 750) : 25
            readonly property real bgAlpha: widgets.opacityOf(modelData)
            color: isWeather ? widgets.wxTop
                             : Qt.rgba(widgets.pillBg.r, widgets.pillBg.g,
                                       widgets.pillBg.b, widgets.pillBg.a * bgAlpha)

            // Degradado solo en amanecer y atardecer; en el resto los dos
            // extremos son el mismo color y Qt lo resuelve como relleno liso.
            gradient: isWeather && widgets.wxTop !== widgets.wxBottom
                ? weatherGradient : null
            Gradient {
                id: weatherGradient
                GradientStop { position: 0.0; color: widgets.wxTop }
                GradientStop { position: 1.0; color: widgets.wxBottom }
            }

            // stack: en fila centrada bajo el reloj. free: coordenadas propias.
            x: widgets.layoutMode === "free"
                 ? Math.round(widgets.width * widgets.posOf(modelData, "x") / 100 - width / 2)
                 : Math.round(widgets.stackX - stackTotal / 2 + stackOffset)
            y: widgets.layoutMode === "free"
                 ? Math.round(widgets.height * widgets.posOf(modelData, "y") / 100 - height / 2)
                 : Math.round(widgets.stackY)
            Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
            Behavior on y { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }

            // Ancho total de la fila y desplazamiento de esta tarjeta dentro de
            // ella. Se recalculan al cambiar la lista, no en cada frame.
            property real stackTotal: 0
            property real stackOffset: 0
            function relayout() {
                if (widgets.layoutMode !== "stack") return
                var total = 0, off = 0
                for (var i = 0; i < widgets.list.length; i++) {
                    var w = i === index ? implicitWidth : 148   // ancho típico
                    if (i < index) off += w + 14
                    total += w + (i < widgets.list.length - 1 ? 14 : 0)
                }
                stackTotal = total
                stackOffset = off
            }
            Component.onCompleted: relayout()
            onImplicitWidthChanged: relayout()

            // ── Tiempo, variante grande ──
            // Medidas tomadas del Figma (BookOS · "Login SDDM | Book Bar",
            // nodo 556:81), que mide 750x330. La tarjeta mide 330x145: MISMA
            // proporción, así que las coordenadas del diseño se aplican tal
            // cual multiplicadas por `u` y no hay que reconvertir nada cuando
            // cambia la escala del widget.
            //
            // Antes las medidas estaban a ojo y con anchors: la fila de días
            // quedaba pegada a la temperatura y sobraba aire abajo.
            Item {
                id: wxLarge
                anchors.fill: parent
                visible: card.isWeather && card.large
                readonly property real u: width / 750

                // Ciudad + icono del tiempo actual, arriba a la izquierda.
                // El icono se ancla al ANCHO REAL del texto y no a la x=136
                // del Figma: el nombre de la ciudad lo pone la máquina y
                // "Madrid" no mide lo mismo que "Sant Feliu de Guíxols". La
                // separación del diseño (5) sí se respeta.
                Text {
                    id: wxCityText
                    x: Math.round(34 * wxLarge.u)
                    y: Math.round(28 * wxLarge.u)
                    text: widgets.wxCity !== "" ? widgets.wxCity : "—"
                    font.family: widgets.designFont
                    font.pixelSize: Math.round(30 * wxLarge.u)
                    font.weight: Font.DemiBold
                    color: "#ffffff"
                }
                WxIcon {
                    x: Math.round(wxCityText.x + wxCityText.width + 5 * wxLarge.u)
                    y: Math.round(33 * wxLarge.u)
                    width: Math.round(26 * wxLarge.u); height: width
                    kind: widgets.wxEffective
                    color: "#ffffff"
                }
                Text {
                    x: Math.round(34 * wxLarge.u)
                    y: Math.round(56 * wxLarge.u)
                    text: widgets.wxTemp + "ºC"
                    font.family: widgets.designFont
                    font.pixelSize: Math.round(60 * wxLarge.u)
                    font.weight: Font.Light
                    color: "#ffffff"
                }

                // Previsión: siete columnas de paso fijo (92,7 en el diseño),
                // centradas. El paso es fijo y no un `spacing` entre columnas
                // de ancho variable, para que "01" y "30ºC" no desalineen la
                // rejilla respecto a los vecinos.
                Row {
                    anchors.horizontalCenter: parent.horizontalCenter
                    y: Math.round(224 * wxLarge.u)
                    visible: widgets.wxDays.length > 0

                    Repeater {
                        model: widgets.wxDays
                        delegate: Item {
                            required property var modelData
                            width:  Math.round(92.7 * wxLarge.u)
                            height: Math.round(94 * wxLarge.u)

                            Text {
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: 0
                                text: modelData.d || ""
                                font.family: widgets.designFont
                                font.pixelSize: Math.round(20 * wxLarge.u)
                                color: "#ffffff"
                            }
                            WxIcon {
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: Math.round(36 * wxLarge.u)
                                width: Math.round(22 * wxLarge.u); height: width
                                kind: modelData.s || "clear"
                                color: "#ffffff"
                            }
                            Text {
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: Math.round(59 * wxLarge.u)
                                text: (modelData.t || "") + "ºC"
                                font.family: widgets.designFont
                                font.pixelSize: Math.round(24 * wxLarge.u)
                                font.weight: Font.Light
                                color: "#ffffff"
                            }
                        }
                    }
                }
            }

            // ── Batería, variante grande ──
            // Un círculo por dispositivo del ecosistema, como en el archivo de
            // Figma: anillo de carga, la silueta del aparato dentro y el
            // porcentaje debajo. El primero es SIEMPRE este portátil y va
            // marcado con el anillo de acento; los demás, con el anillo suave.
            //
            // Los dibujos son los SVG de devices/ y no un trazo hecho aquí:
            // vienen del archivo de diseño y así el portátil de la pantalla de
            // bloqueo es el mismo que el de la app.
            Row {
                anchors.centerIn: parent
                spacing: Math.round(12 * card.k)
                visible: card.isBattery && card.large

                Repeater {
                    model: widgets.deviceList
                    delegate: Item {
                        required property var modelData
                        required property int index
                        width:  Math.round(66 * card.k)
                        height: Math.round(84 * card.k)

                        readonly property bool current: index === 0
                        readonly property real pct:
                            Math.max(0, Math.min(100, modelData.pct || 0)) / 100

                        // Anillo. El de fondo siempre; el de carga solo si el
                        // dispositivo reporta porcentaje — un aro completo en un
                        // aparato que no lo dice sería mentira.
                        Canvas {
                            id: ring
                            anchors.horizontalCenter: parent.horizontalCenter
                            width: Math.round(62 * card.k); height: width
                            renderTarget: Canvas.FramebufferObject
                            property real p: pct
                            property bool cur: current
                            onPChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d")
                                ctx.reset()
                                var r = width / 2 - Math.round(3 * card.k)
                                ctx.lineWidth = Math.round((cur ? 4 : 3.5) * card.k)
                                ctx.lineCap = "round"
                                // Pista del aro al 20 % del color del texto: se
                                // ve igual sobre tarjeta clara y oscura.
                                ctx.strokeStyle = Qt.rgba(widgets.fg.r, widgets.fg.g,
                                                          widgets.fg.b, 0.20)
                                ctx.beginPath()
                                ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2)
                                ctx.stroke()
                                if (p > 0) {
                                    // success / warning / accent, los tokens del
                                    // HIG. El de los demás aparatos ya no se
                                    // agua al 55 %: contra el fondo de la
                                    // tarjeta no se distinguía de la pista.
                                    ctx.strokeStyle = modelData.charging ? "#34C759"
                                                    : p <= 0.15 ? "#FF9500"
                                                    : widgets.accent
                                    ctx.beginPath()
                                    ctx.arc(width / 2, height / 2, r,
                                            -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p)
                                    ctx.stroke()
                                }
                            }
                        }

                        DeviceIcon {
                            anchors.centerIn: ring
                            width:  Math.round(29 * card.k)
                            height: Math.round(20 * card.k)
                            kind:   modelData.kind || "laptop"
                            // Hereda el color del texto de la tarjeta, como
                            // manda el Sistema B del HIG.
                            color:  widgets.fg
                        }

                        Text {
                            anchors.horizontalCenter: parent.horizontalCenter
                            y: Math.round(66 * card.k)
                            visible: (modelData.pct || 0) > 0
                            text: (modelData.pct || 0) + " %"
                            font.family: widgets.designFont
                            font.pixelSize: Math.round(11 * card.k)
                            font.weight: current ? Font.Bold : Font.Medium
                            color: widgets.fg
                            opacity: current ? 1.0 : 0.75
                        }
                    }
                }
            }

            // ── Notificaciones ──
            // Cabecera + hasta tres avisos. El contenido del texto NO se pinta
            // aquí a propósito: esto se ve con el equipo bloqueado y delante de
            // quien pase. Quien quiera el texto lo activa en el panel lateral,
            // que sí tiene su propio interruptor.
            Column {
                anchors.fill: parent
                anchors.margins: Math.round(12 * card.k)
                spacing: Math.round(6 * card.k)
                visible: card.isNotif

                Text {
                    text: widgets.strNotifications
                    font.pixelSize: Math.round(9 * card.k)
                    font.weight: Font.DemiBold
                    font.letterSpacing: 0.8
                    color: widgets.fg2
                }
                Repeater {
                    model: Math.min(3, widgets.notifCount)
                    delegate: Rectangle {
                        required property int index
                        width: parent.width
                        height: Math.round(38 * card.k)
                        radius: Math.round(12 * card.k)
                        color: Qt.rgba(widgets.accent.r, widgets.accent.g, widgets.accent.b, 0.22)

                        Column {
                            anchors.left: parent.left
                            anchors.leftMargin: Math.round(10 * card.k)
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 1
                            Text {
                                text: (widgets.notifList[index] && widgets.notifList[index].t) || ""
                                font.pixelSize: Math.round(8 * card.k)
                                color: widgets.fg2
                            }
                            Text {
                                text: (widgets.notifList[index] && widgets.notifList[index].app) || ""
                                font.pixelSize: Math.round(11 * card.k)
                                font.weight: Font.DemiBold
                                color: widgets.fg
                                elide: Text.ElideRight
                                width: card.width - Math.round(58 * card.k)
                            }
                        }
                        Rectangle {
                            anchors.right: parent.right
                            anchors.rightMargin: Math.round(10 * card.k)
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.round(9 * card.k); height: width; radius: width / 2
                            color: "#FF3B30"
                        }
                    }
                }
            }

            // ── Música ──
            // Carátula a la izquierda, título y artista, y los tres controles
            // debajo. Sin barra de progreso a propósito: obligaría a un
            // temporizador vivo en una pantalla que puede estar horas encendida.
            Item {
                anchors.fill: parent
                anchors.margins: Math.round(14 * card.k)
                visible: card.isMedia

                readonly property real art: Math.round(64 * card.k)

                Rectangle {
                    id: cover
                    width: parent.art; height: width
                    radius: Math.round(12 * card.k)
                    anchors.verticalCenter: parent.verticalCenter
                    color: Qt.rgba(widgets.fg.r, widgets.fg.g, widgets.fg.b, 0.10)
                    clip: true

                    Image {
                        anchors.fill: parent
                        source: widgets.mediaArt
                        fillMode: Image.PreserveAspectCrop
                        asynchronous: true
                        visible: status === Image.Ready
                    }
                    // Sin carátula, la nota musical: un hueco vacío parece que
                    // la tarjeta está a medio cargar.
                    GlyphIcon {
                        anchors.centerIn: parent
                        width: Math.round(26 * card.k); height: width
                        kind: "musical-note"
                        color: widgets.fg2
                        visible: String(widgets.mediaArt) === ""
                    }
                }

                Column {
                    anchors.left: cover.right
                    anchors.leftMargin: Math.round(12 * card.k)
                    anchors.right: parent.right
                    anchors.top: cover.top
                    anchors.topMargin: Math.round(2 * card.k)
                    spacing: Math.round(2 * card.k)

                    Text {
                        width: parent.width
                        text: widgets.mediaTitle
                        font.family: widgets.designFont
                        font.pixelSize: Math.round(14 * card.k)
                        font.weight: Font.Medium
                        color: widgets.fg
                        elide: Text.ElideRight
                    }
                    Text {
                        width: parent.width
                        text: widgets.mediaArtist
                        font.family: widgets.designFont
                        font.pixelSize: Math.round(11 * card.k)
                        color: widgets.fg2
                        elide: Text.ElideRight
                        visible: text !== ""
                    }

                    // Transportes. El del medio es el único con fondo: es la
                    // acción principal y el HIG pide una sola por fila.
                    Row {
                        spacing: Math.round(10 * card.k)
                        topPadding: Math.round(8 * card.k)

                        Repeater {
                            model: ["backward", "playpause", "forward"]
                            delegate: Rectangle {
                                required property string modelData
                                readonly property bool main: modelData === "playpause"
                                width: Math.round((main ? 34 : 28) * card.k)
                                height: width
                                radius: width / 2
                                color: main
                                    ? (mouse.containsMouse
                                        ? Qt.rgba(widgets.fg.r, widgets.fg.g, widgets.fg.b, 0.22)
                                        : Qt.rgba(widgets.fg.r, widgets.fg.g, widgets.fg.b, 0.14))
                                    : (mouse.containsMouse
                                        ? Qt.rgba(widgets.fg.r, widgets.fg.g, widgets.fg.b, 0.10)
                                        : "transparent")
                                Behavior on color { ColorAnimation { duration: 120 } }

                                GlyphIcon {
                                    anchors.centerIn: parent
                                    width: Math.round((main ? 16 : 15) * card.k); height: width
                                    kind: main ? (widgets.mediaPlaying ? "pause" : "play")
                                               : modelData
                                    color: widgets.fg
                                }
                                MouseArea {
                                    id: mouse
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (modelData === "backward")  widgets.mediaPrev()
                                        else if (modelData === "forward") widgets.mediaNext()
                                        else widgets.mediaPlayPause()
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ── Calendario: hoy y mañana ──
            Row {
                anchors.fill: parent
                anchors.margins: Math.round(14 * card.k)
                visible: card.isCal

                Repeater {
                    model: 2
                    delegate: Item {
                        required property int index
                        width: (card.width - Math.round(28 * card.k)) / 2
                        height: parent.height

                        readonly property var day: {
                            var d = new Date()
                            if (index === 1) d.setDate(d.getDate() + 1)
                            return d
                        }
                        readonly property var events: index === 0 ? widgets.calToday : widgets.calTomorrow

                        Column {
                            anchors.left: parent.left
                            anchors.leftMargin: index === 1 ? Math.round(12 * card.k) : 0
                            anchors.top: parent.top
                            spacing: Math.round(2 * card.k)
                            width: parent.width - Math.round(12 * card.k)

                            Text {
                                text: day.toLocaleDateString(Qt.locale(widgets.localeName), "dddd").toUpperCase()
                                font.pixelSize: Math.round(10 * card.k)
                                font.weight: Font.DemiBold
                                color: widgets.fg2
                                elide: Text.ElideRight
                                width: parent.width
                            }
                            Text {
                                text: day.getDate()
                                font.pixelSize: Math.round(30 * card.k)
                                font.weight: Font.Light
                                color: widgets.fg
                            }
                            Text {
                                visible: events.length === 0
                                text: widgets.strNoEvents
                                font.pixelSize: Math.round(9 * card.k)
                                color: widgets.fg2
                            }
                            Repeater {
                                model: Math.min(2, events.length)
                                delegate: Rectangle {
                                    required property int index
                                    width: parent.width
                                    height: Math.round(26 * card.k)
                                    radius: Math.round(8 * card.k)
                                    color: Qt.rgba(widgets.accent.r, widgets.accent.g, widgets.accent.b, 0.25)
                                    Column {
                                        anchors.left: parent.left
                                        anchors.leftMargin: Math.round(7 * card.k)
                                        anchors.verticalCenter: parent.verticalCenter
                                        Text {
                                            text: (events[index] && events[index].title) || ""
                                            font.pixelSize: Math.round(9 * card.k)
                                            color: widgets.fg
                                            elide: Text.ElideRight
                                            width: parent.parent.width - Math.round(14 * card.k)
                                        }
                                        Text {
                                            text: (events[index] && events[index].t) || ""
                                            font.pixelSize: Math.round(8 * card.k)
                                            color: widgets.fg2
                                        }
                                    }
                                }
                            }
                        }
                        // Separador vertical entre los dos días, como en la hoja.
                        Rectangle {
                            visible: index === 1
                            anchors.left: parent.left
                            width: 1; height: parent.height
                            color: Qt.rgba(widgets.fg2.r, widgets.fg2.g, widgets.fg2.b, 0.35)
                        }
                    }
                }
            }

            Row {
                id: content
                anchors.centerIn: parent
                visible: !(card.isWeather && card.large) && !(card.isBattery && card.large)
                         && !card.isNotif && !card.isCal && !card.isMedia
                spacing: 12

                // ── Batería: anillo de carga ──
                Item {
                    width: card.isBattery ? 52 : 0
                    height: 52
                    visible: card.isBattery
                    anchors.verticalCenter: parent.verticalCenter

                    Canvas {
                        anchors.fill: parent
                        renderTarget: Canvas.FramebufferObject
                        property real pct: parseFloat(widgets.battCapacity) / 100
                        onPctChanged: requestPaint()
                        onPaint: {
                            var ctx = getContext("2d")
                            ctx.reset()
                            var cx = width / 2, cy = height / 2, r = width / 2 - 4
                            ctx.lineWidth = 6
                            ctx.lineCap = "round"
                            ctx.strokeStyle = widgets.isDark ? "#3a3a3c" : "#d1d1d6"
                            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
                            if (pct > 0) {
                                ctx.strokeStyle = widgets.battStatus === "Charging" ? "#34C759"
                                                : pct <= 0.15 ? "#FF9500" : widgets.accent
                                ctx.beginPath()
                                ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct)
                                ctx.stroke()
                            }
                        }
                    }
                    Text {
                        anchors.centerIn: parent
                        text: widgets.battCapacity
                        font.pixelSize: 15; font.weight: Font.Bold; color: widgets.fg
                    }
                }

                // Mismo icono que la tarjeta grande, no el emoji del .json: el
                // emoji lo pinta la fuente del sistema, así que cambiaba de
                // estilo y de color según el equipo y no se podía teñir.
                WxIcon {
                    visible: card.isWeather
                    width: card.isWeather ? 34 : 0
                    height: 34
                    anchors.verticalCenter: parent.verticalCenter
                    kind: widgets.wxEffective
                    color: widgets.fg
                }

                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 2
                    Text {
                        text: card.isBattery
                                ? (widgets.battStatus === "Charging" ? widgets.strCharging
                                                                    : widgets.strBattery)
                            : card.isWeather ? widgets.wxTemp + "°"
                            : new Date().toLocaleDateString(Qt.locale(widgets.localeName), "ddd").toUpperCase()
                        font.pixelSize: card.isDate ? 11 : (card.isWeather ? 22 : 14)
                        font.weight: card.isBattery ? Font.Medium : Font.Bold
                        color: card.isDate ? widgets.accent : widgets.fg
                    }
                    Text {
                        text: card.isBattery
                                ? (widgets.battTimeLeft !== "" ? widgets.battTimeLeft : widgets.battCapacity + " %")
                            : card.isWeather ? (widgets.wxDesc !== "" ? widgets.wxDesc : widgets.wxCity)
                            : String(new Date().getDate())
                        font.pixelSize: card.isDate ? 32 : 11
                        font.weight: card.isDate ? Font.Bold : Font.Normal
                        color: card.isDate ? widgets.fg : widgets.fg2
                    }
                    // Próximo evento del día. Sin esto la píldora de fecha solo
                    // repetía el número que ya está bajo el reloj: ocupaba sitio
                    // y no contaba nada nuevo. Solo cabe uno; para la agenda
                    // entera está el widget de calendario.
                    // En el greeter de SDDM calToday llega siempre vacía (allí
                    // no hay sesión de la que sacar eventos), así que se lee
                    // "Sin eventos", que es la verdad y no un hueco.
                    Text {
                        visible: card.isDate
                        text: {
                            var e = widgets.calToday.length > 0 ? widgets.calToday[0] : null
                            if (!e) return widgets.strNoEvents
                            return (e.t ? e.t + "  " : "") + (e.title || "")
                        }
                        font.pixelSize: 10
                        font.weight: widgets.calToday.length > 0 ? Font.Medium : Font.Normal
                        color: widgets.calToday.length > 0 ? widgets.fg : widgets.fg2
                        elide: Text.ElideRight
                        // Tope de ancho para que un evento de título largo no
                        // estire la píldora por toda la pantalla.
                        width: Math.min(implicitWidth, 150)
                    }
                }
            }
        }
    }
}
