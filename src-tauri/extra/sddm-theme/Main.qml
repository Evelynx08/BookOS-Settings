/*
 * BookOS SDDM Theme — iOS/Samsung inspired
 * variant=dark (default) | variant=light
 * background=solid (default) | image | blur
 * bgImage=<absolute path to image>
 */

import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15
import Qt5Compat.GraphicalEffects
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
    readonly property bool  isDark:   config.variant !== "light"
    readonly property color bgColor:  isDark ? "#000000" : "#f2f2f7"
    readonly property color fgColor:  isDark ? "#ffffff" : "#000000"
    readonly property color fg2Color: isDark ? "#8e8e93" : "#8e8e93"
    readonly property color fieldBg:  isDark ? "#1c1c1e" : "#ffffff"
    readonly property color enterBg:  isDark ? "#3a3a3c" : "#e5e5ea"
    readonly property color enterFg:  isDark ? "#ffffff" : "#3a3a3c"
    readonly property color pillBg:   isDark ? "#CC1c1c1e" : "#CCffffff"
    readonly property color overlayColor: isDark ? "#80000000" : "#60ffffff"
    readonly property color accentColor: config.accentColor || root.accentColor

    // ── User-configurable ─────────────────────────────────────────────────
    readonly property string clockFormat: config.clockFormat || "24h"
    readonly property real   blurRadius:  parseFloat(config.blurRadius || "24") / 100.0
    readonly property bool   showDate:    (config.showDate    || "true") !== "false"
    readonly property bool   showBattery: (config.showBattery || "true") !== "false"
    readonly property bool   showBookBar: (config.showBookBar || "true") !== "false"
    readonly property string clockFont:   config.clockFont   || "serif"
    // Login error state
    property bool loginError: false
    property string loginErrorText: ""

    // ── Background mode ───────────────────────────────────────────────────
    readonly property string bgMode:      config.background || "solid"
    readonly property string bgImagePath: config.bgImage    || ""

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
        source: root.bgImagePath !== "" ? ("file://" + root.bgImagePath) : ""
        fillMode: Image.PreserveAspectCrop
        visible: root.bgMode === "image" && root.bgImagePath !== ""
        cache: false
    }

    // Blur background — Qt6 GaussianBlur via Qt5Compat.GraphicalEffects (works in Qt5+Qt6)
    Image {
        id: blurSrc
        anchors.fill: parent
        source: root.bgImagePath !== "" ? ("file://" + root.bgImagePath) : ""
        fillMode: Image.PreserveAspectCrop
        visible: false
        cache: false
        sourceSize.width: Screen.width
        sourceSize.height: Screen.height
    }
    GaussianBlur {
        anchors.fill: parent
        source: blurSrc
        radius: Math.min(64, Math.max(8, parseFloat(config.blurRadius || "24")))
        samples: 33
        deviation: 8
        visible: root.bgMode === "blur" && root.bgImagePath !== ""
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

    function prevUser() {
        if (userCount <= 1) return
        avatarFade.start()
        currentUserIndex = (currentUserIndex - 1 + userCount) % userCount
        passwordField.text = ""
        loginError = false
        passwordField.forceActiveFocus()
    }
    function nextUser() {
        if (userCount <= 1) return
        avatarFade.start()
        currentUserIndex = (currentUserIndex + 1) % userCount
        passwordField.text = ""
        loginError = false
        passwordField.forceActiveFocus()
    }

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
                battTimeLeft = (mins > 0 && mins < 600) ? mins + " min para carga completa" : ""
            } else { battTimeLeft = "" }
        } else { battTimeLeft = "" }
    }

    Timer { interval: 60000; running: true; repeat: true; onTriggered: updateBattery() }

    // ── Clock ─────────────────────────────────────────────────────────────
    function fmtTime() {
        return Qt.formatTime(new Date(),
            root.clockFormat === "12h" ? "h:mm AP" : "hh:mm")
    }
    property string clockTime: fmtTime()
    property string clockDate: Qt.formatDate(new Date(), "dddd, d 'de' MMMM")
    Timer {
        interval: 1000; running: true; repeat: true
        onTriggered: {
            root.clockTime = fmtTime()
            root.clockDate = Qt.formatDate(new Date(), "dddd, d 'de' MMMM")
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

    Timer {
        id: fpTimer
        interval: 2500
        running: passwordField.text === "" && !root.loggingIn
        repeat: true
        onTriggered: {
            if (passwordField.text === "" && !root.loggingIn) {
                root.loggingIn = true
                root.fingerprintActive = true
                sddm.login(root.loginUsername, "", currentSessionIndex)
            }
        }
    }

    Connections {
        target: sddm
        function onLoginSucceeded() {
            root.loggingIn = false
            root.fingerprintActive = false
            root.loginError = false
        }
        function onLoginFailed() {
            root.loggingIn = false
            if (!root.fingerprintActive) {
                shakeAnim.start()
                root.loginError = true
                root.loginErrorText = "Contraseña incorrecta"
            }
            root.fingerprintActive = false
            passwordField.text = ""
            passwordField.forceActiveFocus()
        }
    }

    // ── Clock — top center ────────────────────────────────────────────────
    Column {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Math.round(root.height * 0.08)
        spacing: 4

        Text {
            text: root.clockTime
            font.family: root.clockFont === "sans" ? "sans-serif"
                       : root.clockFont === "mono" ? "monospace"
                       : "serif"
            font.pixelSize: Math.round(root.height * 0.115)
            font.weight: Font.Bold
            color: root.fgColor
            anchors.horizontalCenter: parent.horizontalCenter
        }
        Text {
            text: root.clockDate
            visible: root.showDate
            font.pixelSize: Math.round(root.height * 0.022)
            font.weight: Font.Medium
            color: root.fgColor
            opacity: 0.85
            anchors.horizontalCenter: parent.horizontalCenter
        }
    }

    // ── Center column: avatar + name + password ───────────────────────────
    Column {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: Math.round(root.height * 0.02)
        spacing: 14

        // ── User switcher row (arrow · avatar · arrow) ────────────────────
        Item {
            width: 260; height: 120
            anchors.horizontalCenter: parent.horizontalCenter

            // Left arrow — prev user
            Text {
                text: "‹"
                font.pixelSize: 48
                color: root.fg2Color
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                visible: root.userCount > 1
                MouseArea {
                    anchors.fill: parent
                    anchors.margins: -10
                    onClicked: root.prevUser()
                }
            }

            // Avatar circle — Canvas clip (Qt5, no extra modules needed)
            Item {
                id: avatarCircle
                width: 120; height: 120
                anchors.centerIn: parent

                property string currentSrc: ""

                // Fade + scale animation on user switch
                SequentialAnimation {
                    id: avatarFade
                    ParallelAnimation {
                        NumberAnimation { target: avatarCircle; property: "opacity"; from: 1.0; to: 0.0; duration: 140; easing.type: Easing.OutCubic }
                        NumberAnimation { target: avatarCircle; property: "scale";   from: 1.0; to: 0.85; duration: 140; easing.type: Easing.OutCubic }
                    }
                    ParallelAnimation {
                        NumberAnimation { target: avatarCircle; property: "opacity"; from: 0.0; to: 1.0; duration: 220; easing.type: Easing.OutCubic }
                        NumberAnimation { target: avatarCircle; property: "scale";   from: 0.85; to: 1.0; duration: 220; easing.type: Easing.OutBack }
                    }
                }

                // Hidden Image for status detection + canvas source
                Image {
                    id: faceImg
                    anchors.fill: parent
                    fillMode: Image.PreserveAspectCrop
                    visible: false
                    asynchronous: false
                    cache: false
                    sourceSize.width: 256
                    sourceSize.height: 256
                    source: "file:///var/lib/AccountsService/icons/" + root.loginUsername
                    onStatusChanged: {
                        if (status === Image.Error) {
                            var fb = "file:///home/" + root.loginUsername + "/.face.icon"
                            if (source.toString() !== fb) {
                                source = fb
                            }
                        } else if (status === Image.Ready) {
                            avatarCircle.currentSrc = source.toString()
                            avatarCanvas.loadImage(avatarCircle.currentSrc)
                        }
                    }
                }

                // Fallback circle + initial letter
                Rectangle {
                    anchors.fill: parent
                    radius: 60
                    color: isDark ? "#2c2c2e" : "#c7c7cc"
                    visible: faceImg.status !== Image.Ready
                }
                Text {
                    anchors.centerIn: parent
                    visible: faceImg.status === Image.Error
                    text: root.displayName.length > 0 ? root.displayName[0].toUpperCase() : "?"
                    font.pixelSize: 48
                    font.weight: Font.Medium
                    color: isDark ? "#8e8e93" : "#636366"
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
                    onWidthChanged:  if (avatarCircle.currentSrc !== "") requestPaint()
                    onHeightChanged: if (avatarCircle.currentSrc !== "") requestPaint()

                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.imageSmoothingEnabled = true
                        ctx.clearRect(0, 0, width, height)
                        if (avatarCircle.currentSrc === "") return
                        ctx.save()
                        ctx.beginPath()
                        ctx.arc(width/2, height/2, width/2, 0, Math.PI * 2)
                        ctx.closePath()
                        ctx.clip()
                        // Cover-fit: draw image filling the circle while preserving aspect
                        var iw = faceImg.sourceSize.width
                        var ih = faceImg.sourceSize.height
                        if (iw > 0 && ih > 0) {
                            var scale = Math.max(width / iw, height / ih)
                            var sw = iw * scale
                            var sh = ih * scale
                            ctx.drawImage(avatarCircle.currentSrc,
                                          (width - sw) / 2, (height - sh) / 2, sw, sh)
                        } else {
                            ctx.drawImage(avatarCircle.currentSrc, 0, 0, width, height)
                        }
                        ctx.restore()
                    }
                }
            }

            // Right arrow — next user
            Text {
                text: "›"
                font.pixelSize: 48
                color: root.fg2Color
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                visible: root.userCount > 1
                MouseArea {
                    anchors.fill: parent
                    anchors.margins: -10
                    onClicked: root.nextUser()
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
                width: 56; height: 56; radius: 15
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

        // Fingerprint hint
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.fingerprintActive ? "Coloca tu dedo en el lector" : "o usa tu huella dactilar"
            font.pixelSize: 13
            color: root.accentColor
            opacity: root.fingerprintActive ? 1.0 : 0.7
            Behavior on opacity { NumberAnimation { duration: 250 } }
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
                text: "Bloqueo de mayúsculas activado"
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
                text: sessionModel.data(sessionModel.index(root.currentSessionIndex, 0), Qt.UserRole + 4) || "Sesión"
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
        readRoutine()
        passwordField.forceActiveFocus()
        root.opacity = 1
    }

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
            text: "✕  Salir (Esc)"
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
        if (bbHasRoutine) return "routine"
        if (!root.showBattery) return ""
        if (bbCharging)   return "charging"
        if (bbHasBattery) return "battery"
        return ""
    }

    // ── Book Bar pill ─────────────────────────────────────────────────────
    Rectangle {
        id: bookBar
        visible: root.bbMode !== ""
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 40

        height: 56
        width: bbContent.implicitWidth + 40
        radius: 28

        color: root.bbMode === "charging" ? "#25C1C9"
             : root.bbMode === "routine"  ? "#2D2B6B"
             : root.bbMode === "battery"  ? root.pillBg
             : root.pillBg

        Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
        Behavior on color { ColorAnimation  { duration: 400 } }

        Row {
            id: bbContent
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
                    font.pixelSize: 22
                    color: root.bbMode === "charging" ? "#1c1c1e" : root.fgColor
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    text: root.battCapacity + "%"
                    font.pixelSize: 20
                    font.weight: Font.Bold
                    color: root.bbMode === "charging" ? "#1c1c1e" : root.fgColor
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    visible: root.battTimeLeft !== ""
                    text: "· " + root.battTimeLeft
                    font.pixelSize: 14
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
                    font.pixelSize: 22
                    anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                    text: root.bbRoutineName
                    font.pixelSize: 18
                    font.weight: Font.Bold
                    color: "white"
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }
    }
}
