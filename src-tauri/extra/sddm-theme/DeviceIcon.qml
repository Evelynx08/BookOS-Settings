/*
 * BookOS — icono de un dispositivo del ecosistema.
 *
 * Sistema B del HIG (AI-DESIGN-SYSTEM.md §3.2): trazo sobre lienzo 24x24,
 * stroke-width 2, extremos y uniones redondeados, y el color lo hereda del
 * texto que lo rodea. Los paths salen TAL CUAL de la copia local de Heroicons
 * 2.1.5 (BookOS-HIG/heroicons/24/outline/), que es lo que manda el sistema de
 * diseño: nada de iconos dibujados a mano para este sistema.
 *
 * Se dibujan con Shape y no con un Image de fichero porque la pantalla de
 * bloqueo se instala copiando una lista de QML: una carpeta de imágenes al lado
 * se queda fuera en cuanto alguien instala con una versión anterior del
 * instalador, y `Image` falla EN SILENCIO — círculos vacíos y a saber por qué.
 */
import QtQuick 2.15
import QtQuick.Shapes 1.15

Item {
    id: dev

    /** laptop | phone | tablet | buds */
    property string kind: "laptop"
    /** Hereda del texto que lo rodea, como pide el Sistema B. */
    property color color: "#ffffff"

    // Heroicons trae los paths a stroke-width 1.5; el HIG los sube a 2 al
    // integrarlos, que es el peso del resto de la interfaz.
    readonly property real sw: 2.0

    readonly property string pathData: {
        switch (kind) {
        case "phone":
            return "M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"
        case "tablet":
            return "M10.5 19.5h3m-6.75 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-15a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 4.5v15a2.25 2.25 0 0 0 2.25 2.25Z"
        case "buds":
            return "M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
        default:
            return "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"
        }
    }

    Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        // El lienzo de Heroicons es 24x24: se escala al tamaño pedido en vez de
        // reescribir coordenadas, así el path se copia literal del fichero.
        transform: Scale {
            xScale: dev.width / 24
            yScale: dev.height / 24
        }

        ShapePath {
            strokeColor: dev.color
            fillColor: "transparent"
            strokeWidth: dev.sw
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: dev.pathData }
        }
    }
}
