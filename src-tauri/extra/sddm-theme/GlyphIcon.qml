/*
 * BookOS — glifo relleno de Heroicons, dibujado en QML.
 *
 * Hermano de DeviceIcon.qml: aquel usa la variante Outline (Sistema B del HIG,
 * §3.2) para siluetas de dispositivo; este usa la variante Solid, que es la que
 * el HIG admite para "casos puntuales de icono relleno pequeño" — los
 * transportes de reproducción, donde un triángulo de trazo a 16 px se lee peor
 * que uno macizo.
 *
 * Los paths salen literales de BookOS-HIG/heroicons/24/solid/. Dibujados y no
 * cargados de fichero por lo mismo de siempre: la pantalla de bloqueo se
 * instala copiando QML, y una carpeta de imágenes al lado se queda fuera sin
 * que nadie se entere.
 */
import QtQuick 2.15
import QtQuick.Shapes 1.15

Item {
    id: glyph

    /** play | pause | backward | forward | musical-note */
    property string kind: "play"
    property color color: "#ffffff"

    readonly property string pathData: {
        switch (kind) {
        case "pause":
            return "M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z"
        case "backward":
            return "M9.195 18.44c1.25.714 2.805-.189 2.805-1.629v-2.34l6.945 3.968c1.25.715 2.805-.188 2.805-1.628V8.69c0-1.44-1.555-2.343-2.805-1.628L12 11.029v-2.34c0-1.44-1.555-2.343-2.805-1.628l-7.108 4.061c-1.26.72-1.26 2.536 0 3.256l7.108 4.061Z"
        case "forward":
            return "M5.055 7.06C3.805 6.347 2.25 7.25 2.25 8.69v8.122c0 1.44 1.555 2.343 2.805 1.628L12 14.471v2.34c0 1.44 1.555 2.343 2.805 1.628l7.108-4.061c1.26-.72 1.26-2.536 0-3.256L14.805 7.06C13.555 6.346 12 7.25 12 8.688v2.34L5.055 7.06Z"
        case "musical-note":
            return "M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.402-4.909l2.31-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z"
        default:
            return "M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
        }
    }

    Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        transform: Scale {
            xScale: glyph.width / 24
            yScale: glyph.height / 24
        }
        ShapePath {
            fillColor: glyph.color
            strokeColor: "transparent"
            fillRule: ShapePath.WindingFill
            PathSvg { path: glyph.pathData }
        }
    }
}
