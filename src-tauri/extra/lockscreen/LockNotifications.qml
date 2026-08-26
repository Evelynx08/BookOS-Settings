/*
 * BookOS — notificaciones en la pantalla de bloqueo (Win+L).
 *
 * Plasma no las muestra aquí de fábrica. Se leen del mismo servidor de
 * notificaciones del escritorio a través de org.kde.notificationmanager.
 *
 * PRIVACIDAD: por defecto se ve QUIÉN notifica pero NO el contenido. Una
 * pantalla bloqueada es justo el momento en que el portátil está desatendido,
 * así que enseñar el texto de los mensajes por defecto sería filtrarlos a
 * cualquiera que pase por delante. El usuario puede activar el contenido
 * completo desde Ajustes (lockNotificationContent=true en theme.conf.user).
 *
 * Estilo tomado de BookOS-HIG/AI-DESIGN-SYSTEM.md: tarjetas de 25px de radio,
 * título 14/Medium, subtítulo 11/Regular en text-2, iconos de 30px, sombra solo
 * en tema claro y separación de 16px entre tarjetas.
 */
import QtQuick 2.15
import QtQuick.Layouts 1.15
// Sin número de versión: el qmldir de Plasma 6 declara el módulo como
// versionless, y pedir "1.0" lo deja como no instalado — con eso el greeter
// tira todo LockScreenUi y cae al bloqueo de emergencia de Plasma.
import org.kde.notificationmanager as NotificationManager
import org.kde.kirigami 2.20 as Kirigami

Item {
    id: notif

    property bool isDark: true
    property bool showContent: false
    property color accent: "#007AFF"
    // Traducido desde theme.conf por quien nos instancia (ver LockScreenUi).
    property string strNotification: "Notificación"

    // Tokens del HIG. Se repiten aquí porque el greeter de bloqueo no puede
    // importar el CSS de la app; si cambian en el HIG, hay que actualizarlos.
    readonly property color cardBg:   isDark ? "#CC1c1c1e" : "#E6ffffff"
    readonly property color txt:      isDark ? "#ffffff"   : "#000000"
    readonly property color txt2:     "#8e8e93"
    readonly property color divider:  isDark ? "#14ffffff" : "#14000000"

    implicitWidth: 380
    // Se encoge a lo que ocupen las tarjetas, hasta un máximo: si hay veinte
    // notificaciones no debe comerse la pantalla entera.
    implicitHeight: Math.min(list.contentHeight, notif.maxHeight)
    property real maxHeight: 420
    visible: list.count > 0
    opacity: visible ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }

    NotificationManager.Notifications {
        id: model
        showExpired: true
        showDismissed: false
        showJobs: false
        // Agrupadas por aplicación: en una pantalla de bloqueo importa más de
        // quién es el aviso que cada mensaje suelto.
        groupMode: NotificationManager.Notifications.GroupApplicationsFlat
        sortMode: NotificationManager.Notifications.SortByDate
        sortOrder: Qt.DescendingOrder
    }

    ListView {
        id: list
        anchors.fill: parent
        model: model
        spacing: 10
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        // Solo intercepta el ratón si de verdad hay que desplazar; si no, los
        // clics deben llegar al fondo para no romper el desbloqueo.
        interactive: contentHeight > height

        delegate: Rectangle {
            width: list.width
            height: row.implicitHeight + 24
            radius: 25
            color: notif.cardBg
            // El HIG prohíbe sombra en tarjetas sobre tema oscuro.
            layer.enabled: !notif.isDark

            RowLayout {
                id: row
                anchors.fill: parent
                anchors.margins: 12
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                spacing: 12

                Kirigami.Icon {
                    Layout.preferredWidth: 30
                    Layout.preferredHeight: 30
                    Layout.alignment: Qt.AlignTop
                    source: model.applicationIconName || "dialog-information"
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2

                    Text {
                        Layout.fillWidth: true
                        text: model.applicationName || notif.strNotification
                        font.pixelSize: 14
                        font.weight: Font.Medium
                        color: notif.txt
                        elide: Text.ElideRight
                    }
                    Text {
                        Layout.fillWidth: true
                        // Con el contenido oculto se dice cuántos avisos hay,
                        // que es información útil sin revelar nada.
                        text: notif.showContent
                                ? (model.summary || model.body || "")
                                : "Contenido oculto"
                        font.pixelSize: 11
                        color: notif.txt2
                        elide: Text.ElideRight
                        maximumLineCount: 1
                        visible: text !== ""
                    }
                    Text {
                        Layout.fillWidth: true
                        text: model.body || ""
                        visible: notif.showContent && text !== "" && text !== model.summary
                        font.pixelSize: 11
                        color: notif.txt2
                        wrapMode: Text.WordWrap
                        elide: Text.ElideRight
                        maximumLineCount: 2
                    }
                }
            }
        }
    }
}
