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
    property var themeConf: ({})
    function readSddmConf() {
        try {
            var xhr = new XMLHttpRequest()
            xhr.open("GET", "file:///usr/share/sddm/themes/bookos/theme.conf", false)
            xhr.send()
            var lines = (xhr.responseText || "").split("\n")
            var out = {}
            for (var i = 0; i < lines.length; i++) {
                var l = lines[i].trim()
                if (l === "" || l[0] === "#" || l[0] === "[") continue
                var eq = l.indexOf("=")
                if (eq <= 0) continue
                out[l.substring(0, eq).trim()] = l.substring(eq + 1).trim()
            }
            themeConf = out
        } catch(e) { themeConf = {} }
    }
    Component.onCompleted: readSddmConf()

    readonly property bool isDark: (themeConf.variant || "dark") !== "light"
    readonly property color fgColor:    isDark ? "#ffffff" : "#000000"
    readonly property color fg2Color:   "#8e8e93"
    readonly property color fieldBg:    isDark ? "#1c1c1e" : "#ffffff"
    readonly property color enterBg:    isDark ? "#3a3a3c" : "#e5e5ea"
    readonly property color enterFg:    isDark ? "#ffffff" : "#3a3a3c"
    readonly property color accentColor: themeConf.accentColor || "#007aff"

    Column {
        id: mainCol
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.horizontalCenterOffset: -Math.round(sessionManager.width * 0.04)
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: -Math.round(mainCol.height / 2) - Math.round(sessionManager.height * 0.05)
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
                source: "file:///var/lib/AccountsService/icons/" + kscreenlocker_userName
                onStatusChanged: {
                    if (status === Image.Error) {
                        var fb = "file:///home/" + kscreenlocker_userName + "/.face.icon"
                        if (source.toString() !== fb) {
                            source = fb
                        } else if (kscreenlocker_userImage !== "") {
                            var fb2 = "file://" + kscreenlocker_userImage.split("/").map(encodeURIComponent).join("/");
                            if (source.toString() !== fb2) source = fb2;
                        }
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
                width: 56; height: 56; radius: 15
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
                text: "Bloqueo de mayúsculas activado"
                font.pixelSize: 13
                color: "#FF9500"
            }
        }
    }
}
