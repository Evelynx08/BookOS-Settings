/*
    BookOS Lock Screen — MainBlock (SDDM-inspired panel)
    SPDX-License-Identifier: LGPL-2.0-or-later
*/

import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15 as QQC2

import org.kde.plasma.components 3.0 as PlasmaComponents3
import org.kde.plasma.extras 2.0 as PlasmaExtras
import org.kde.plasma.plasma5support 2.0 as P5Support
import org.kde.kirigami 2.20 as Kirigami
import org.kde.kscreenlocker 1.0 as ScreenLocker

import org.kde.breeze.components

SessionManagementScreen {
    id: sessionManager

    readonly property alias mainPasswordBox: passwordField
    property bool lockScreenUiVisible: false
    property alias showPassword: passwordBoxRoot.showPassword

    property int visibleBoundary: mapFromItem(passwordRow, 0, 0).y
    onHeightChanged: visibleBoundary = mapFromItem(passwordRow, 0, 0).y + passwordRow.height + Kirigami.Units.smallSpacing

    signal passwordResult(string password)

    onUserSelected: {
        passwordField.forceActiveFocus(Qt.TabFocusReason);
    }

    function startLogin() {
        const password = passwordField.text
        passwordField.forceActiveFocus();
        passwordResult(password);
    }

    // ── Read SDDM theme.conf so lockscreen matches what user picked in app ──
    // User override at ~/.config/bookos-sddm-variant takes precedence (set by
    // BookOS Settings when theme switches, no sudo required).
    property var themeConf: ({})
    // Con `cat` y no con XMLHttpRequest: Qt 6 bloquea GET sobre file:// salvo
    // QML_XHR_ALLOW_FILE_READ=1, que el greeter no define. Con XHR esto volvía
    // siempre vacío y el panel se quedaba en los colores por defecto.
    //
    // Gana el último: theme.conf de fábrica → theme.conf.user que escribe
    // Settings → ~/.config/bookos-sddm-variant (por usuario, sin sudo). Antes
    // faltaba theme.conf.user, así que el panel ignoraba lo guardado en la app.
    //
    // Va en una property y no como hijo suelto: SessionManagementScreen es un
    // layout y su default property solo admite Item, así que un DataSource
    // declarado ahí aborta la carga del componente entero ("Cannot assign
    // object of type DataSource to list property _children").
    readonly property QtObject themeConfSrc: P5Support.DataSource {
        engine: "executable"
        connectedSources: ["sh -c 'cat /usr/share/sddm/themes/bookos/theme.conf 2>/dev/null; echo; cat /usr/share/sddm/themes/bookos/theme.conf.user 2>/dev/null; echo; cat $HOME/.config/bookos-sddm-variant 2>/dev/null; echo; printf \"sessionScheme=%s\\n\" \"$(kreadconfig6 --file kdeglobals --group General --key ColorScheme 2>/dev/null)\"'"]
        interval: 0
        onNewData: (src, data) => {
            sessionManager.themeConf = sessionManager._parseConf(data["stdout"] || "")
        }
    }
    function _parseConf(text) {
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
    // La fuente ya lanza el `cat` al conectarse; esto solo relee si el .conf
    // cambia con el bloqueo abierto.
    function readSddmConf() {
        var s = themeConfSrc.connectedSources[0]
        themeConfSrc.disconnectSource(s)
        themeConfSrc.connectSource(s)
    }

    // Misma resolución que LockScreenUi: "auto" seguía al valor por defecto y
    // se quedaba en oscuro pasara lo que pasara.
    readonly property bool isDark: {
        var v = themeConf.variant || "auto"
        if (v === "light") return false
        if (v === "dark")  return true
        var s = (themeConf.sessionScheme || "").toLowerCase()
        return s === "" ? true : s.indexOf("dark") !== -1
    }
    readonly property color fgColor:    isDark ? "#ffffff" : "#000000"
    readonly property color fg2Color:   "#8e8e93"
    // Igual que en el tema SDDM: campo y botón translúcidos, con la misma
    // opacidad configurable que las píldoras. Opacos quedaban como un parche
    // sólido sobre el fondo desenfocado.
    readonly property real pillOpacity: _mbNum(themeConf.pillOpacity, 80) / 100.0
    readonly property color fieldBg:    isDark ? Qt.rgba(0.109, 0.109, 0.118, pillOpacity)
                                               : Qt.rgba(1, 1, 1, pillOpacity)
    readonly property color enterBg:    isDark ? Qt.rgba(0.227, 0.227, 0.235, pillOpacity)
                                               : Qt.rgba(0.898, 0.898, 0.918, pillOpacity)
    readonly property color enterFg:    isDark ? "#ffffff" : "#3a3a3c"
    readonly property color accentColor: themeConf.accentColor || "#007aff"

    // Medidas reales de la pantalla, que las pasa LockScreenUi: el StackView
    // que contiene este bloque es más alto que la pantalla, así que su propio
    // height no sirve para colocar nada por porcentaje.
    property real screenW: sessionManager.width
    property real screenH: sessionManager.height

    // Centro del bloque en % de la pantalla, la misma clave que coloca el
    // editor de la pantalla de acceso (usersX/usersY en theme.conf).
    function _mbNum(v, def) {
        var n = parseFloat(v)
        if (isNaN(n)) return def
        return Math.max(0, Math.min(100, n))
    }
    readonly property real usersXPct: _mbNum(themeConf.usersX, 50)
    readonly property real usersYPct: _mbNum(themeConf.usersY, 52)

    // SessionManagementScreen declara `default property alias _children:
    // innerLayout.children`, así que todo hijo nuestro acaba dentro de un
    // ColumnLayout limitado a 16 gridUnits de ancho. Un layout manda sobre x/y,
    // de modo que las coordenadas de abajo se ignoraban y el bloque, más ancho
    // que ese contenedor, se desbordaba hacia la derecha — el motivo del viejo
    // parche `horizontalCenterOffset: -width * 0.04`.
    // Reparentar al FocusScope raíz lo saca del layout y deja x/y en
    // coordenadas de pantalla (este item se ancla a 0 en el StackView).
    Component.onCompleted: mainCol.parent = sessionManager

    // La lista de usuarios y la fila de acciones de Breeze no se usan: el bloque
    // pinta su propio avatar y su propio campo. Dejarlas activas además hacía
    // que SessionManagementScreen.qml:160 leyera `children[0].implicitWidth`
    // sobre una fila vacía → "TypeError: Cannot read property 'implicitWidth'
    // of undefined" en cada bloqueo.
    showUserList: false
    actionItemsVisible: false

    Column {
        id: mainCol
        x: Math.round(sessionManager.screenW * sessionManager.usersXPct / 100 - width  / 2)
        y: Math.round(sessionManager.screenH * sessionManager.usersYPct / 100 - height / 2)
        spacing: 14

        // ── Avatar circle ──────────────────────────────────────────────────
        Item {
            width: 120; height: 120
            anchors.horizontalCenter: parent.horizontalCenter

            property string currentSrc: ""

            Image {
                id: faceImg
                anchors.fill: parent
                fillMode: Image.PreserveAspectCrop
                visible: false
                asynchronous: false
                cache: false
                sourceSize.width: 256
                sourceSize.height: 256
                // kscreenlocker_userImage es la ruta que YA resolvió Plasma, así
                // que va primero. Las otras dos se construían con
                // kscreenlocker_userName, que es el nombre MOSTRADO ("Evelyn"),
                // no el de login ("evelyn"): en cuanto difieren en mayúsculas
                // apuntan a rutas que no existen y el avatar se caía.
                readonly property string byName: "file:///var/lib/AccountsService/icons/" + kscreenlocker_userName
                readonly property string byHome: "file:///home/" + kscreenlocker_userName + "/.face.icon"
                readonly property string byPlasma: kscreenlocker_userImage !== ""
                    ? "file://" + kscreenlocker_userImage.split("/").map(encodeURIComponent).join("/") : ""
                source: byPlasma !== "" ? byPlasma : byName
                onStatusChanged: {
                    if (status === Image.Error) {
                        var s = source.toString()
                        if (s !== byName && s !== byHome) source = byName
                        else if (s !== byHome) source = byHome
                    } else if (status === Image.Ready) {
                        parent.currentSrc = source.toString()
                        avatarCanvas.loadImage(parent.currentSrc)
                    }
                }
            }

            Rectangle {
                anchors.fill: parent
                radius: 60
                color: "#c7c7cc"
                visible: faceImg.status !== Image.Ready
            }
            Text {
                anchors.centerIn: parent
                visible: faceImg.status === Image.Error
                text: kscreenlocker_userName.length > 0 ? kscreenlocker_userName[0].toUpperCase() : "?"
                font.pixelSize: 48
                font.weight: Font.Medium
                color: "#636366"
                z: 1
            }

            Canvas {
                id: avatarCanvas
                anchors.fill: parent
                visible: faceImg.status === Image.Ready
                renderTarget: Canvas.FramebufferObject
                smooth: true
                antialiasing: true

                onImageLoaded: requestPaint()
                onWidthChanged:  if (parent.currentSrc !== "") requestPaint()
                onHeightChanged: if (parent.currentSrc !== "") requestPaint()

                onPaint: {
                    var ctx = getContext("2d")
                    ctx.imageSmoothingEnabled = true
                    ctx.clearRect(0, 0, width, height)
                    if (parent.currentSrc === "") return
                    ctx.save()
                    ctx.beginPath()
                    ctx.arc(width/2, height/2, width/2, 0, Math.PI * 2)
                    ctx.closePath()
                    ctx.clip()
                    var iw = faceImg.sourceSize.width
                    var ih = faceImg.sourceSize.height
                    if (iw > 0 && ih > 0) {
                        var scale = Math.max(width / iw, height / ih)
                        var sw = iw * scale
                        var sh = ih * scale
                        ctx.drawImage(parent.currentSrc, (width - sw) / 2, (height - sh) / 2, sw, sh)
                    } else {
                        ctx.drawImage(parent.currentSrc, 0, 0, width, height)
                    }
                    ctx.restore()
                }
            }
        }

        Text {
            text: kscreenlocker_userName
            font.pixelSize: 18
            font.weight: Font.Medium
            color: fgColor
            anchors.horizontalCenter: parent.horizontalCenter
        }

        Item {
            id: passwordRow
            width: Math.min(420, sessionManager.width * 0.42)
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

            // Bind the reject animation to authenticator failures
            Connections {
                target: authenticator
                function onFailed(kind) {
                    if (kind === 0) {
                        shakeAnim.start();
                    }
                }
            }

            Rectangle {
                id: inputBg
                anchors.left: parent.left
                anchors.right: enterBtn.left
                anchors.rightMargin: 10
                anchors.verticalCenter: parent.verticalCenter
                height: 56; radius: 30
                color: sessionManager.fieldBg

                border.color: passwordField.activeFocus ? sessionManager.accentColor : "transparent"
                border.width: passwordField.activeFocus ? 2 : 0
                Behavior on border.color { ColorAnimation { duration: 150 } }

                Item {
                    id: passwordBoxRoot
                    property bool showPassword: false
                }

                QQC2.TextField {
                    id: passwordField
                    anchors {
                        left: parent.left; leftMargin: 22
                        right: showPwBtn.left; rightMargin: 8
                        verticalCenter: parent.verticalCenter
                    }
                    echoMode: passwordBoxRoot.showPassword ? TextInput.Normal : TextInput.Password
                    color: sessionManager.fgColor
                    font.pixelSize: 17
                    passwordCharacter: "●"
                    verticalAlignment: TextInput.AlignVCenter
                    enabled: !authenticator.graceLocked
                    focus: true
                    background: null

                    Keys.onReturnPressed: startLogin()
                    Keys.onEnterPressed:  startLogin()

                    Connections {
                        target: root
                        function onClearPassword() {
                            passwordField.forceActiveFocus();
                            passwordField.text = "";
                        }
                    }
                }

                Rectangle {
                    id: showPwBtn
                    width: 30; height: 30; radius: 15
                    color: sessionManager.accentColor
                    anchors.right: parent.right
                    anchors.rightMargin: 13
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                        anchors.centerIn: parent
                        text: passwordBoxRoot.showPassword ? "◉" : "◎"
                        font.pixelSize: 14
                        color: "#ffffff"
                    }
                    MouseArea {
                        anchors.fill: parent
                        onPressed:  passwordBoxRoot.showPassword = true
                        onReleased: passwordBoxRoot.showPassword = false
                    }
                }
            }

            Rectangle {
                id: enterBtn
                width: 56; height: 56; radius: width / 2
                color: enterBtnArea.containsMouse ? sessionManager.accentColor : sessionManager.enterBg
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                Behavior on color { ColorAnimation { duration: 120 } }
                Text {
                    anchors.centerIn: parent
                    text: "→"
                    font.pixelSize: 22
                    color: sessionManager.enterFg
                }
                MouseArea {
                    id: enterBtnArea
                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: startLogin()
                }
            }
        }

        // Fingerprint hints
        component FailableLabel : PlasmaComponents3.Label {
            id: _failableLabel
            required property int kind
            required property string label

            visible: authenticator.authenticatorTypes & kind
            text: label
            horizontalAlignment: Text.AlignHCenter
            Layout.fillWidth: true
            color: sessionManager.accentColor
            opacity: 0.7
            font.pixelSize: 13

            Connections {
                target: authenticator
                function onNoninteractiveError(kind, authenticator) {
                    if (kind & _failableLabel.kind) {
                        _failableLabel.text = Qt.binding(() => authenticator.errorMessage)
                    }
                }
            }
            Timer {
                id: _timer
                interval: Kirigami.Units.humanMoment
                onTriggered: {
                    _failableLabel.text = Qt.binding(() => _failableLabel.label)
                }
            }
        }

        FailableLabel {
            kind: ScreenLocker.Authenticator.Fingerprint
            label: "o usa tu huella dactilar"
            anchors.horizontalCenter: parent.horizontalCenter
        }

        // Caps Lock warning — uses kscreenlocker's keystate engine
        P5Support.DataSource {
            id: capsState
            engine: "keystate"
            connectedSources: ["Caps Lock"]
        }
        Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 6
            visible: capsState.data["Caps Lock"] !== undefined && capsState.data["Caps Lock"]["Locked"] === true
            Text {
                text: "⇪"
                font.pixelSize: 14
                color: "#FF9500"
                anchors.verticalCenter: parent.verticalCenter
            }
            Text {
                // Ya traducido en theme.conf (lo escribe BookOS Settings en el
                // idioma de la app); a la derecha el respaldo de fábrica.
                text: sessionManager.themeConf.strCapsLock || "Bloqueo de mayúsculas activado"
                font.pixelSize: 13
                color: "#FF9500"
            }
        }
    }
}
