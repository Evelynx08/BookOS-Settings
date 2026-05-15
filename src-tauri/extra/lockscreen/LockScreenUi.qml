/*
    BookOS Lock Screen UI — SDDM-inspired
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQml 2.15
import QtQuick 2.8
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.1
import Qt5Compat.GraphicalEffects

import org.kde.plasma.components 3.0 as PlasmaComponents3
import org.kde.plasma.workspace.components 2.0 as PW
import org.kde.plasma.plasma5support 2.0 as P5Support
import org.kde.kirigami 2.20 as Kirigami
import org.kde.kscreenlocker 1.0 as ScreenLocker

import org.kde.plasma.private.sessions 2.0
import org.kde.breeze.components

Item {
    id: lockScreenUi

    readonly property bool softwareRendering: GraphicsInfo.api === GraphicsInfo.Software

    property bool hadPrompt: false

    property bool bookBarEnabled: true
    P5Support.DataSource {
        id: bookBarCfg
        engine: "executable"
        connectedSources: ["sh -c 'cat $HOME/.config/bookos-bookbar.json 2>/dev/null'"]
        interval: 3000
        onNewData: (src, data) => {
            try {
                var j = JSON.parse((data["stdout"] || "").trim())
                lockScreenUi.bookBarEnabled = (j && j.enabled !== false)
            } catch(e) { lockScreenUi.bookBarEnabled = true }
        }
    }

    function handleMessage(msg) {
        if (!root.notification) {
            root.notification += msg;
        } else if (root.notification.includes(msg)) {
            root.notificationRepeated();
        } else {
            root.notification += "\n" + msg
        }
    }

    Kirigami.Theme.inherit: false
    Kirigami.Theme.colorSet: Kirigami.Theme.Complementary

    Connections {
        target: authenticator
        function onFailed(kind) {
            if (kind != 0) return;
            const msg = i18nd("plasma_lookandfeel_org.kde.lookandfeel", "Unlocking failed");
            lockScreenUi.handleMessage(msg);
            graceLockTimer.restart();
            notificationRemoveTimer.restart();
            lockScreenUi.hadPrompt = false;
        }

        function onSucceeded() {
            if (lockScreenUi.hadPrompt) {
                Qt.quit();
            } else {
                mainStack.replace(null, Qt.resolvedUrl("NoPasswordUnlock.qml"),
                    { userListModel: users },
                    StackView.Immediate,
                );
                mainStack.forceActiveFocus();
            }
        }

        function onInfoMessageChanged() {
            lockScreenUi.handleMessage(authenticator.infoMessage);
            lockScreenUi.hadPrompt = true;
        }

        function onErrorMessageChanged() {
            lockScreenUi.handleMessage(authenticator.errorMessage);
        }

        function onPromptChanged(msg) {
            lockScreenUi.handleMessage(authenticator.prompt);
        }
        function onPromptForSecretChanged(msg) {
            mainBlock.showPassword = false;
            mainBlock.mainPasswordBox.forceActiveFocus();
            lockScreenUi.hadPrompt = true;
        }
    }

    SessionManagement {
        id: sessionManagement
    }

    Connections {
        target: sessionManagement
        function onAboutToSuspend() {
            root.clearPassword();
        }
    }

    P5Support.DataSource {
        id: keystateSource
        engine: "keystate"
        connectedSources: "Caps Lock"
    }

    MouseArea {
        id: lockScreenRoot

        property bool uiVisible: true
        property bool blockUI: mainStack.depth > 1 || mainBlock.mainPasswordBox.text.length > 0 || inputPanel.keyboardActive

        x: parent.x
        y: parent.y
        width: parent.width
        height: parent.height
        hoverEnabled: true
        cursorShape: uiVisible ? Qt.ArrowCursor : Qt.BlankCursor
        drag.filterChildren: true
        onPressed: uiVisible = true;
        onPositionChanged: uiVisible = true;
        onUiVisibleChanged: {
            if (blockUI) {
                fadeoutTimer.running = false;
            } else if (uiVisible) {
                fadeoutTimer.restart();
            }
            authenticator.startAuthenticating();
        }
        onBlockUIChanged: {
            if (blockUI) {
                fadeoutTimer.running = false;
                uiVisible = true;
            } else {
                fadeoutTimer.restart();
            }
        }
        Keys.onEscapePressed: {
            if (uiVisible) {
                uiVisible = false;
                if (inputPanel.keyboardActive) {
                    inputPanel.showHide();
                }
                root.clearPassword();
            }
        }
        Keys.onPressed: event => {
            uiVisible = true;
            event.accepted = false;
        }

        Timer {
            id: fadeoutTimer
            interval: 10000
            onTriggered: {
                if (!lockScreenRoot.blockUI) {
                    mainBlock.showPassword = false;
                    lockScreenRoot.uiVisible = false;
                }
            }
        }
        Timer {
            id: notificationRemoveTimer
            interval: 3000
            onTriggered: root.notification = ""
        }
        Timer {
            id: graceLockTimer
            interval: 3000
            onTriggered: {
                root.clearPassword();
                authenticator.startAuthenticating();
            }
        }

        PropertyAnimation {
            id: launchAnimation
            target: lockScreenRoot
            property: "opacity"
            from: 0
            to: 1
            duration: Kirigami.Units.veryLongDuration * 2
        }

        Component.onCompleted: { launchAnimation.start(); readSddmConf(); authenticator.startAuthenticating(); }

        // Wallpaper with blur fader
        WallpaperFader {
            anchors.fill: parent
            state: lockScreenRoot.uiVisible ? "on" : "off"
            source: wallpaper
            mainStack: mainStack
            clock: sddmClockRow
        }

        // Clock — SDDM style: top center
        // Read SDDM theme.conf — share config with login screen
        property var sddmConf: ({})
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
                sddmConf = out
            } catch(e) { sddmConf = {} }
        }

        readonly property bool conf_isDark: (sddmConf.variant || "dark") !== "light"
        readonly property string conf_clockFmt: sddmConf.clockFormat || "24h"
        readonly property string conf_clockFont: sddmConf.clockFont || "serif"
        readonly property bool conf_showDate: (sddmConf.showDate || "true") !== "false"
        readonly property bool conf_showBattery: (sddmConf.showBattery || "true") !== "false"

        Item {
            id: sddmClockRow
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.topMargin: Math.round(lockScreenRoot.height * 0.08)

            function fmtTime() {
                return Qt.formatTime(new Date(), lockScreenRoot.conf_clockFmt === "12h" ? "h:mm AP" : "hh:mm")
            }
            property string clockTime: fmtTime()
            property string clockDate: Qt.formatDate(new Date(), "dddd, d 'de' MMMM")

            Timer {
                interval: 1000; running: true; repeat: true
                onTriggered: {
                    sddmClockRow.clockTime = sddmClockRow.fmtTime()
                    sddmClockRow.clockDate = Qt.formatDate(new Date(), "dddd, d 'de' MMMM")
                }
            }

            Column {
                anchors.centerIn: parent
                spacing: 4

                Text {
                    text: sddmClockRow.clockTime
                    font.family: lockScreenRoot.conf_clockFont === "mono" ? "monospace"
                                : lockScreenRoot.conf_clockFont === "sans" ? "sans-serif"
                                : "serif"
                    font.pixelSize: Math.round(lockScreenRoot.height * 0.115)
                    font.weight: Font.Bold
                    color: lockScreenRoot.conf_isDark ? "#ffffff" : "#000000"
                    anchors.horizontalCenter: parent.horizontalCenter
                    layer.enabled: true
                    layer.effect: DropShadow {
                        transparentBorder: true
                        color: lockScreenRoot.conf_isDark ? "#80000000" : "#80ffffff"
                        radius: 8
                        samples: 17
                    }
                }
                Text {
                    visible: lockScreenRoot.conf_showDate
                    text: sddmClockRow.clockDate
                    font.pixelSize: Math.round(lockScreenRoot.height * 0.022)
                    font.weight: Font.Medium
                    color: lockScreenRoot.conf_isDark ? "#ffffff" : "#000000"
                    opacity: 0.85
                    anchors.horizontalCenter: parent.horizontalCenter
                    layer.enabled: true
                    layer.effect: DropShadow {
                        transparentBorder: true
                        color: lockScreenRoot.conf_isDark ? "#80000000" : "#80ffffff"
                        radius: 4
                        samples: 9
                    }
                }
            }
        }

        ListModel {
            id: users

            Component.onCompleted: {
                users.append({
                    name: kscreenlocker_userName,
                    realName: kscreenlocker_userName,
                    icon: kscreenlocker_userImage !== ""
                          ? "file://" + kscreenlocker_userImage.split("/").map(encodeURIComponent).join("/")
                          : "",
                })
            }
        }

        StackView {
            id: mainStack
            anchors {
                left: parent.left
                right: parent.right
            }
            height: lockScreenRoot.height + Kirigami.Units.gridUnit * 3
            focus: true
            visible: opacity > 0

            initialItem: MainBlock {
                id: mainBlock
                lockScreenUiVisible: lockScreenRoot.uiVisible
                enabled: !graceLockTimer.running

                StackView.onStatusChanged: {
                    if (StackView.status === StackView.Activating) {
                        mainPasswordBox.clear();
                        mainPasswordBox.focus = true;
                        root.notification = "";
                    }
                }

                onPasswordResult: password => {
                    authenticator.respond(password)
                }
            }
        }

        VirtualKeyboardLoader {
            id: inputPanel
            z: 1
            screenRoot: lockScreenRoot
            mainStack: mainStack
            mainBlock: mainBlock
            passwordField: mainBlock.mainPasswordBox
        }

        Loader {
            z: 2
            active: root.viewVisible
            source: "LockOsd.qml"
            anchors {
                horizontalCenter: parent.horizontalCenter
                bottom: parent.bottom
                bottomMargin: Kirigami.Units.gridUnit
            }
        }

        // ── Book Bar ──────────────────────────────────────────────────────
        BookBar {
            id: bookBar
            z: 1
            visible: lockScreenUi.bookBarEnabled
            anchors {
                horizontalCenter: parent.horizontalCenter
                bottom: parent.bottom
                bottomMargin: Kirigami.Units.gridUnit * 2
            }
        }

        // ── SDDM-style Footer Controls ──────────────────────────────────────

        // ── Session picker — bottom-left ────────────────────────────────────
        Item {
            id: sessionPicker
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            anchors.leftMargin: 24
            anchors.bottomMargin: 24
            width: 170; height: 36
            z: 10
            visible: sessionManagement.canSwitchUser

            Rectangle {
                anchors.fill: parent
                radius: 18
                color: sessionPillArea.containsMouse ? "#e5e5ea" : "#CCffffff"
                Behavior on color { ColorAnimation { duration: 150 } }

                Text {
                    anchors.left: parent.left; anchors.leftMargin: 14
                    anchors.verticalCenter: parent.verticalCenter
                    text: "👥"
                    font.pixelSize: 14
                    color: "#000000"
                }
                Text {
                    anchors.left: parent.left; anchors.leftMargin: 36
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Cambiar usuario"
                    font.pixelSize: 13
                    color: "#000000"
                }
                MouseArea {
                    id: sessionPillArea
                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: sessionManagement.switchUser()
                }
            }
        }

        // ── Power buttons — bottom-right ────────────────────────────────────
        Row {
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.rightMargin: 24
            anchors.bottomMargin: 24
            spacing: 10

            // Suspender
            Rectangle {
                width: 44; height: 44; radius: 22
                color: suspArea.containsMouse ? "#e5e5ea" : "#CCffffff"
                Behavior on color { ColorAnimation { duration: 150 } }
                visible: root.suspendToRamSupported
                Text { anchors.centerIn: parent; text: "☾"; font.pixelSize: 18; color: "#000000" }
                MouseArea { id: suspArea; anchors.fill: parent; hoverEnabled: true; onClicked: root.suspendToRam() }
            }
            
            // Teclado virtual
            Rectangle {
                width: 44; height: 44; radius: 22
                color: vkArea.containsMouse ? "#e5e5ea" : "#CCffffff"
                Behavior on color { ColorAnimation { duration: 150 } }
                visible: inputPanel.status === Loader.Ready
                Text { anchors.centerIn: parent; text: "⌨"; font.pixelSize: 18; color: inputPanel.keyboardActive ? "#007aff" : "#000000" }
                MouseArea { 
                    id: vkArea; anchors.fill: parent; hoverEnabled: true; 
                    onClicked: { mainBlock.mainPasswordBox.forceActiveFocus(); inputPanel.showHide(); }
                }
            }
        }
    }
}
