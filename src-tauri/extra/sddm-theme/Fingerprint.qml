/*
 * BookOS SDDM — indicador de huella animado.
 *
 * Mismo lenguaje visual que el sensor de BookOS Settings: crestas concéntricas
 * grises de base y las mismas crestas en color de acento encima, reveladas de
 * dentro hacia fuera según avanza la lectura.
 *
 * Se dibuja con Canvas y no con SVG ni Shapes porque el greeter arranca con la
 * GPU a medio inicializar: aquí se pinta una vez por cambio de estado y el
 * resto del tiempo solo se anima opacidad y escala, que van en el compositor.
 */
import QtQuick 2.15

Item {
    id: fp

    property color accent: "#007aff"
    property color base: "#3a3a3c"
    // 0 = en reposo · 1 = lectura completa. Lo anima el propio componente.
    property real progress: 0
    // El greeter lo pone a true mientras PAM está comprobando el dedo.
    property bool scanning: false
    // Se dispara al autenticar: onda expansiva y desvanecido.
    signal unlocked()

    implicitWidth: 62
    implicitHeight: 78

    // Nueve crestas: radios relativos para que escale a cualquier tamaño.
    readonly property var ridges: [1.0, 0.87, 0.73, 0.60, 0.47, 0.35, 0.25, 0.16, 0.08]

    function drawRidges(ctx, w, h, upto, color, alpha) {
        ctx.strokeStyle = color
        ctx.globalAlpha = alpha
        ctx.lineWidth = Math.max(1.5, w * 0.042)
        ctx.lineCap = "round"
        for (var i = 0; i < ridges.length; i++) {
            // Las crestas se revelan de dentro hacia fuera: el índice alto es
            // el centro del dedo, que es donde antes hay contacto.
            var idx = ridges.length - 1 - i
            if (idx > upto) continue
            var rx = w * 0.46 * ridges[i]
            var ry = h * 0.46 * ridges[i]
            ctx.beginPath()
            // Arcos abiertos por abajo: leen como huella, no como diana.
            ctx.ellipse(w / 2 - rx, h / 2 - ry, rx * 2, ry * 2)
            ctx.stroke()
        }
        ctx.globalAlpha = 1
    }

    Canvas {
        id: canvas
        anchors.fill: parent
        renderTarget: Canvas.FramebufferObject
        antialiasing: true
        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)
            fp.drawRidges(ctx, width, height, fp.ridges.length, fp.base, 0.9)
            var upto = Math.round(fp.progress * fp.ridges.length)
            if (upto > 0) fp.drawRidges(ctx, width, height, upto, fp.accent, 1.0)
        }
    }
    onProgressChanged: canvas.requestPaint()
    onAccentChanged:   canvas.requestPaint()

    // Respiración en reposo: indica "puedes poner el dedo" sin llamar la
    // atención. Solo opacidad — no fuerza repintados del Canvas.
    SequentialAnimation {
        running: !fp.scanning && fp.progress === 0
        loops: Animation.Infinite
        NumberAnimation { target: canvas; property: "opacity"; from: 0.55; to: 1.0
                          duration: 1100; easing.type: Easing.InOutSine }
        NumberAnimation { target: canvas; property: "opacity"; from: 1.0; to: 0.55
                          duration: 1100; easing.type: Easing.InOutSine }
    }

    // Lectura: las crestas se van encendiendo de dentro afuera.
    NumberAnimation {
        id: scanAnim
        target: fp; property: "progress"; to: 1.0
        duration: 900; easing.type: Easing.OutCubic
    }
    onScanningChanged: {
        if (scanning) { canvas.opacity = 1; scanAnim.start() }
        else if (fp.progress < 1) { scanAnim.stop(); resetAnim.start() }
    }
    NumberAnimation {
        id: resetAnim
        target: fp; property: "progress"; to: 0
        duration: 260; easing.type: Easing.OutCubic
    }

    // Onda expansiva al desbloquear.
    Rectangle {
        id: ripple
        anchors.centerIn: parent
        width: parent.width; height: parent.width
        radius: width / 2
        color: "transparent"
        border.width: 2
        border.color: fp.accent
        opacity: 0
        scale: 0.6
    }

    ParallelAnimation {
        id: unlockAnim
        NumberAnimation { target: ripple; property: "scale";   from: 0.6; to: 2.6
                          duration: 520; easing.type: Easing.OutCubic }
        SequentialAnimation {
            NumberAnimation { target: ripple; property: "opacity"; from: 0; to: 0.9; duration: 120 }
            NumberAnimation { target: ripple; property: "opacity"; to: 0; duration: 400 }
        }
        SequentialAnimation {
            NumberAnimation { target: canvas; property: "scale"; from: 1.0; to: 1.12
                              duration: 160; easing.type: Easing.OutBack }
            NumberAnimation { target: canvas; property: "scale"; to: 1.0
                              duration: 240; easing.type: Easing.OutCubic }
        }
    }

    function playUnlock() {
        progress = 1
        canvas.requestPaint()
        unlockAnim.start()
        fp.unlocked()
    }
}
