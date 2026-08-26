/*
 * BookOS SDDM — avatar circular de usuario.
 *
 * Extraído de Main.qml porque el selector necesita N avatares a la vez y antes
 * el recorte circular estaba escrito inline para uno solo.
 *
 * El recorte se hace con Canvas en vez de MultiEffect+máscara: se pinta una
 * única vez al cargar la imagen (no en cada frame) y no añade una capa de
 * render por avatar, que con una fila de cuentas sería el coste dominante.
 */
import QtQuick 2.15

Item {
    id: av

    // Ruta al retrato. Vacío o inexistente → se cae a la inicial del nombre.
    property string source: ""
    // Texto de respaldo: la primera letra del nombre a mostrar.
    property string initial: "?"
    // Anillo de selección (el usuario activo en la fila).
    property bool   selected: false
    property color  accent: "#007aff"
    property color  fallbackText: "#ffffff"
    // Atenúa los no seleccionados.
    property real   dimOpacity: 0.55

    implicitWidth: 96
    implicitHeight: 96

    opacity: selected ? 1.0 : dimOpacity
    Behavior on opacity { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
    Behavior on scale   { NumberAnimation { duration: 220; easing.type: Easing.OutBack } }

    property string currentSrc: ""

    // Círculo de respaldo con la inicial: siempre presente debajo, así nunca
    // hay un hueco vacío mientras la imagen carga o si no existe.
    Rectangle {
        anchors.fill: parent
        radius: width / 2
        color: av.accent
        visible: av.currentSrc === ""
        Text {
            anchors.centerIn: parent
            text: av.initial
            color: av.fallbackText
            font.pixelSize: Math.round(parent.width * 0.42)
            font.weight: Font.Bold
        }
    }

    // Imagen oculta: solo sirve para detectar carga y alimentar al Canvas.
    Image {
        id: faceImg
        source: av.source
        visible: false
        asynchronous: true
        cache: true
        sourceSize.width:  Math.round(av.width  * Screen.devicePixelRatio)
        sourceSize.height: Math.round(av.height * Screen.devicePixelRatio)
        onStatusChanged: {
            if (status === Image.Ready) {
                av.currentSrc = source.toString()
                faceCanvas.loadImage(av.currentSrc)
            } else if (status === Image.Error) {
                av.currentSrc = ""
            }
        }
    }

    Canvas {
        id: faceCanvas
        anchors.fill: parent
        visible: av.currentSrc !== ""
        renderTarget: Canvas.FramebufferObject
        onImageLoaded: requestPaint()
        onWidthChanged:  if (av.currentSrc !== "") requestPaint()
        onHeightChanged: if (av.currentSrc !== "") requestPaint()
        onPaint: {
            if (av.currentSrc === "") return
            var ctx = getContext("2d")
            ctx.reset()
            ctx.save()
            ctx.beginPath()
            ctx.arc(width / 2, height / 2, width / 2, 0, Math.PI * 2)
            ctx.closePath()
            ctx.clip()
            // Cover-fit: llena el círculo sin deformar la foto.
            var iw = faceImg.sourceSize.width
            var ih = faceImg.sourceSize.height
            if (iw > 0 && ih > 0) {
                var s  = Math.max(width / iw, height / ih)
                var sw = iw * s, sh = ih * s
                ctx.drawImage(av.currentSrc, (width - sw) / 2, (height - sh) / 2, sw, sh)
            } else {
                ctx.drawImage(av.currentSrc, 0, 0, width, height)
            }
            ctx.restore()
        }
    }

    // Anillo de selección por fuera del borde, sin recortar la foto.
    Rectangle {
        anchors.centerIn: parent
        width: parent.width + 8
        height: parent.height + 8
        radius: width / 2
        color: "transparent"
        border.width: 3
        border.color: av.accent
        opacity: av.selected ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 160 } }
    }
}
