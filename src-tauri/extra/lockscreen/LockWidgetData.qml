/*
    BookOS Lock Screen — datos de los widgets que solo existen en la sesión.
    SPDX-License-Identifier: GPL-2.0-or-later

    Notificaciones y eventos de calendario viven aquí, y no en LockScreenUi.qml,
    porque sus módulos (`org.kde.notificationmanager`, el plugin de calendario)
    pueden no estar instalados. Un import que no resuelve aborta la carga del
    fichero ENTERO, así que tenerlos en LockScreenUi dejaría la pantalla de
    bloqueo en negro por un widget opcional. Cargado con un Loader, un fallo se
    queda en `status === Loader.Error` y el resto sigue funcionando.

    Expone dos listas ya aplanadas, del tipo que espera GreeterWidgets.qml:
      notifList  → [{ app, t }]
      calToday / calTomorrow → [{ t, title }]
*/

import QtQml 2.15
import QtQuick 2.15

import org.kde.notificationmanager as NotificationManager
import org.kde.plasma.workspace.calendar 2.0 as PlasmaCalendar

QtObject {
    id: data

    // Traducido desde theme.conf por quien nos instancia (ver LockScreenUi).
    property string strNotification: "Notificación"
    property var notifList: []
    property var calToday: []
    property var calTomorrow: []

    // ── Notificaciones ────────────────────────────────────────────────────
    // Solo se saca de aquí el nombre de la aplicación y la hora. El texto no:
    // la tarjeta se ve con el equipo bloqueado y desatendido, y el panel lateral
    // ya tiene su propio interruptor para quien quiera mostrarlo.
    readonly property QtObject notifSource: NotificationManager.Notifications {
        id: notifModel
        showExpired: false
        showDismissed: false
        groupMode: NotificationManager.Notifications.GroupApplicationsFlat
        sortMode: NotificationManager.Notifications.SortByDate

        function rebuild() {
            var out = []
            for (var i = 0; i < Math.min(3, count); i++) {
                var idx = index(i, 0)
                var app = data(idx, NotificationManager.Notifications.ApplicationNameRole)
                var when = data(idx, NotificationManager.Notifications.CreatedRole)
                out.push({
                    app: app || data.strNotification,
                    t: when ? Qt.formatTime(when, "hh:mm") : ""
                })
            }
            data.notifList = out
        }
        onCountChanged: rebuild()
        Component.onCompleted: rebuild()
    }

    // ── Eventos ───────────────────────────────────────────────────────────
    // Dos días: hoy y mañana.
    //
    // Ojo con dónde vive cada cosa: `agendaUpdated` y `eventsForDate` NO están
    // en Calendar, sino en su `daysModel` (DaysModel). Declarar
    // `onAgendaUpdated` sobre Calendar es un error de carga —"Cannot assign to
    // non-existent property"— que aborta este fichero ENTERO, y con él las
    // notificaciones, que no tienen nada que ver con el calendario.
    //
    // Y sin `setPluginsManager` el modelo no tiene de dónde sacar eventos: la
    // agenda queda vacía para siempre y en silencio.
    readonly property QtObject pluginsManager: PlasmaCalendar.EventPluginsManager {
        id: evPlugins
        // Solo el plugin de PIM: es el que trae citas reales (Akonadi /
        // KOrganizer). Los otros dos que trae Plasma —festivos y efemérides
        // astronómicas— llenarían la pantalla de bloqueo de "Luna llena" y
        // "Día de la Constitución", que no es lo que se espera de una agenda.
        // Una ruta que no exista la ignora el gestor, así que no hace falta
        // comprobar antes si el plugin está instalado.
        Component.onCompleted: populateEnabledPluginsList(
            ["/usr/lib/qt6/plugins/plasmacalendarplugins/pimevents.so"])
    }

    readonly property QtObject calSource: PlasmaCalendar.Calendar {
        id: cal
        days: 2
        weeks: 1
        types: PlasmaCalendar.Calendar.Events
        Component.onCompleted: {
            daysModel.setPluginsManager(evPlugins)
            data.rebuildAgenda()
        }
    }

    // La agenda no está lista al arrancar: los plugins responden por su cuenta
    // y avisan con agendaUpdated cuando terminan.
    readonly property QtObject agendaWatch: Connections {
        target: cal.daysModel
        function onAgendaUpdated(updatedDate) { data.rebuildAgenda() }
    }

    function eventsOf(d) {
        var out = []
        try {
            var list = cal.daysModel.eventsForDate(d)
            for (var i = 0; i < Math.min(2, list.length); i++) {
                var e = list[i]
                out.push({
                    title: e.title || "",
                    t: e.startDateTime ? Qt.formatTime(e.startDateTime, "hh:mm") : ""
                })
            }
        } catch (err) { /* sin plugins de calendario no hay eventos */ }
        return out
    }
    function rebuildAgenda() {
        var today = new Date()
        var tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        data.calToday = eventsOf(today)
        data.calTomorrow = eventsOf(tomorrow)
    }
}
