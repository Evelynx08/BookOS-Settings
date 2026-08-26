/*
 * BookOS — icono meteorológico (Heroicons 24 solid).
 *
 * Los trazos son los de BookOS-HIG/heroicons/24/solid tal cual: `cloud`, `sun`
 * y `moon`. Antes se dibujaban con los contornos (24/outline) y a 15 px no se
 * leían: la maqueta los pide macizos.
 *
 * Heroicons no trae "sol tras nube" ni "nube con lluvia", así que esos dos se
 * COMPONEN aquí: el sol asomando por detrás de la nube, y tres gotas bajo ella.
 *
 * Se dibuja con Shapes y no cargando los SVG como Image porque el greeter
 * necesita teñir el icono según el fondo, y un SVG en un Image no se puede
 * recolorear sin una capa de efecto por cada icono.
 */
import QtQuick 2.15
import QtQuick.Shapes 1.15

Item {
    id: ico

    // clear | clouds | partly | night | rain
    property string kind: "clear"
    property color color: "#ffffff"

    implicitWidth: 24
    implicitHeight: 24

    // ── Trazos de Heroicons 24 solid ─────────────────────────────────────
    readonly property string pathCloud:
        "M4.5 9.75a6 6 0 0 1 11.573-2.226 3.75 3.75 0 0 1 4.133 4.303A4.5 4.5 0 0 1 18 20.25H6.75a5.25 5.25 0 0 1-2.23-10.004 6.072 6.072 0 0 1-.02-.496Z"
    readonly property string pathSun:
        "M12 2.25a.75.75 0 0 1 .75.75v2.25a.75.75 0 0 1-1.5 0V3a.75.75 0 0 1 .75-.75ZM7.5 12a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM18.894 6.166a.75.75 0 0 0-1.06-1.06l-1.591 1.59a.75.75 0 1 0 1.06 1.061l1.591-1.59ZM21.75 12a.75.75 0 0 1-.75.75h-2.25a.75.75 0 0 1 0-1.5H21a.75.75 0 0 1 .75.75ZM17.834 18.894a.75.75 0 0 0 1.06-1.06l-1.59-1.591a.75.75 0 1 0-1.061 1.06l1.59 1.591ZM12 18a.75.75 0 0 1 .75.75V21a.75.75 0 0 1-1.5 0v-2.25A.75.75 0 0 1 12 18ZM7.758 17.303a.75.75 0 0 0-1.061-1.06l-1.591 1.59a.75.75 0 0 0 1.06 1.061l1.591-1.59ZM6 12a.75.75 0 0 1-.75.75H3a.75.75 0 0 1 0-1.5h2.25A.75.75 0 0 1 6 12ZM6.697 7.757a.75.75 0 0 0 1.06-1.06l-1.59-1.591a.75.75 0 0 0-1.061 1.06l1.59 1.591Z"
    readonly property string pathMoon:
        "M9.528 1.718a.75.75 0 0 1 .162.819A8.97 8.97 0 0 0 9 6a9 9 0 0 0 9 9 8.97 8.97 0 0 0 3.463-.69.75.75 0 0 1 .981.98 10.503 10.503 0 0 1-9.694 6.46c-5.799 0-10.5-4.7-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 0 1 .818.162Z"

    /// Un trazo de Heroicons colocado y escalado dentro del icono.
    /// El lienzo de origen es SIEMPRE 24x24, así que la Shape se declara de ese
    /// tamaño y se escala; anclarla al item deformaría los trazos.
    component Glyph: Item {
        id: g
        property string d: ""
        property color fill: "#ffffff"
        Shape {
            width: 24
            height: 24
            transformOrigin: Item.TopLeft
            scale: g.width / 24
            preferredRendererType: Shape.CurveRenderer
            layer.enabled: true
            layer.samples: 4
            ShapePath {
                fillColor: g.fill
                strokeColor: "transparent"
                // Los trazos de Heroicons llevan fill-rule="evenodd": con el
                // relleno por defecto (winding) los huecos del sol se rellenan
                // y en vez de un sol sale un borrón redondo.
                fillRule: ShapePath.OddEvenFill
                PathSvg { path: g.d }
            }
        }
    }

    readonly property real s: Math.min(width, height)

    // ── Sol ──
    Glyph {
        visible: ico.kind === "clear"
        width: ico.s; height: ico.s
        d: ico.pathSun; fill: ico.color
    }

    // ── Luna ──
    Glyph {
        visible: ico.kind === "night"
        width: ico.s; height: ico.s
        d: ico.pathMoon; fill: ico.color
    }

    // ── Nube ──
    Glyph {
        visible: ico.kind === "clouds"
        width: ico.s; height: ico.s
        d: ico.pathCloud; fill: ico.color
    }

    // ── Sol tras nube ──
    // El sol asoma arriba a la izquierda y la nube lo tapa abajo a la derecha,
    // que es como se distingue de un vistazo a 15 px.
    Item {
        visible: ico.kind === "partly"
        anchors.fill: parent
        Glyph {
            x: 0; y: 0
            width: ico.s * 0.60; height: width
            d: ico.pathSun; fill: ico.color
        }
        Glyph {
            x: ico.s * 0.16; y: ico.s * 0.28
            width: ico.s * 0.84; height: width
            d: ico.pathCloud; fill: ico.color
        }
    }

    // ── Nube con lluvia ──
    Item {
        visible: ico.kind === "rain"
        anchors.fill: parent
        // La nube se encoge para dejar sitio a las gotas. Con el glifo a tamaño
        // completo su base cae en 0,84 del alto y las gotas salían pegadas: se
        // leía como una nube con flecos, no como lluvia.
        Glyph {
            x: ico.s * 0.04; y: 0
            width: ico.s * 0.86; height: width
            d: ico.pathCloud; fill: ico.color
        }
        Repeater {
            model: 3
            delegate: Rectangle {
                required property int index
                width: Math.max(1, ico.s * 0.07)
                height: ico.s * 0.18
                radius: width / 2
                color: ico.color
                x: ico.s * (0.22 + index * 0.24)
                y: ico.s * 0.80
            }
        }
    }
}
