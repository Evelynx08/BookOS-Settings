# BookOS Settings

A native system settings application for KDE Plasma 6, designed for Samsung Galaxy Book laptops running BookOS — an Arch-based Linux distribution.

Built with Tauri 2 and vanilla JavaScript. Lightweight, fast, hardware-aware.

[![Version](https://img.shields.io/badge/version-0.4.0-blue?style=flat-square)](https://github.com/Evelynx08/BookOS-Settings/releases)
[![Platform](https://img.shields.io/badge/platform-Arch%20%7C%20Debian%20%7C%20Ubuntu-1793D1?style=flat-square)](#installation)
[![KDE Plasma](https://img.shields.io/badge/KDE%20Plasma-6.6-1d4ed8?style=flat-square)](https://kde.org)
[![License](https://img.shields.io/badge/license-GPLv3-green?style=flat-square)](LICENSE)

---

## Overview

BookOS Settings is a unified control panel that consolidates hardware-specific controls, system preferences, and appearance options into a single cohesive interface. It complements KDE System Settings by exposing Samsung Galaxy Book features (fan control, battery protection, keyboard backlight, USB-C charging) that are not surfaced by the standard KDE modules.

---

## Features

| Category | Capabilities |
|---|---|
| Battery | Performance mode, fan control, adaptive charging, battery protection limit, USB-C charging |
| Display | Brightness, resolution, refresh rate, eye comfort mode, HDR, Vision Booster |
| Sound | Per-app volume, output and input device selection, system sounds, media controls |
| Lock screen | SDDM theme, fingerprint enrollment, Always-On Display, Book Bar |
| Themes | Kvantum theme, Plasma color scheme, dark and light mode toggle, scheduled switching |
| Wallpaper | Wallpaper picker with color palette extraction |
| Connections | Wi-Fi, Bluetooth, VPN, airplane mode |
| Devices | Quick Share (rquickshare), Galaxy Buds |
| Security | UFW firewall control, application permissions |
| Accounts | Username, hostname, avatar |
| General | Language (Spanish and English with auto-detection), keyboard layout, date and time |
| Maintenance | Disk usage, cache cleanup, system logs |
| Digital wellbeing | Per-application screen time tracking |
| Advanced | KWin compositor effects, autostart manager |
| Updates | System packages (paru), Flatpak updates |
| Accessibility | Vision aids, magnifier, high contrast |
| About | Hardware information, CPU, RAM, GPU, kernel, Plasma version |

### Additional capabilities

- Localization in Spanish and English with automatic locale detection. Manual override stored in `localStorage` under `bookos_lang`.
- Granular search that finds both top-level pages and nested settings.
- Animated fingerprint enrollment dialog with stroke draw-in, scan laser sweep, success glow, and error feedback.
- Smooth page transitions on navigation.
- Routines engine for automating combinations of toggles, with snapshot-based undo.
- Bundled systemd units for adaptive charging, thermal logging, and hardware permissions.
- KRunner integration via a semantic search plugin.

---

## Technology

| Layer | Technology |
|---|---|
| Application shell | [Tauri 2](https://tauri.app) — Rust backend with WebView frontend |
| Frontend | Vanilla JavaScript ES modules (no framework) |
| Styling | Plain CSS with custom properties |
| System integration | D-Bus (zbus), sysfs, shell commands |
| Hardware control | `kscreen-doctor`, `qdbus6`, `pactl`, `ufw`, sysfs backlight |
| Background services | systemd system and user units |
| Search | Python semantic indexer with KRunner D-Bus plugin |

---

## Installation

### Arch Linux (AUR)

```bash
yay -S bookos-settings
```

The AUR package downloads the pre-built binary from GitHub Releases and installs in seconds without compiling.

### Debian and Ubuntu (APT repository)

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://evelynx08.github.io/BookOS-Settings/KEY.gpg \
    | sudo tee /etc/apt/keyrings/bookos.asc > /dev/null

echo "deb [signed-by=/etc/apt/keyrings/bookos.asc] https://evelynx08.github.io/BookOS-Settings bookworm main" \
    | sudo tee /etc/apt/sources.list.d/bookos.list

sudo apt update
sudo apt install bookos-settings
```

Compatible with Debian 12 and newer, and Ubuntu 22.04 and newer. The repository is GPG-signed.

### Standalone packages

Download the appropriate file from [Releases](https://github.com/Evelynx08/BookOS-Settings/releases):

| Distribution | File |
|---|---|
| Arch Linux | `bookos-settings-0.4.0-1-x86_64.pkg.tar.zst` |
| Debian / Ubuntu | `Bookos Settings_0.4.0_amd64.deb` |
| Fedora / RHEL | `Bookos Settings-0.4.0-1.x86_64.rpm` |

### Build from source

Required build dependencies:

```bash
sudo pacman -S rust cargo webkit2gtk-4.1 gtk3 libsoup3 protobuf
```

Optional dependencies:

```bash
sudo pacman -S colord kscreen qdbus6 inotify-tools python python-dbus python-gobject
```

Clone and build:

```bash
git clone https://github.com/Evelynx08/BookOS-Settings
cd BookOS-Settings
cargo tauri build
```

The compiled binary is at `src-tauri/target/release/bookos-settings`. Distribution bundles are produced in `src-tauri/target/release/bundle/`.

---

## Running

```bash
bookos-settings
```

A `.desktop` entry is installed automatically and the application appears in the KDE menu under Settings.

To launch at login in the background, enable the option inside *General Management → Autostart → Launch at login*.

---

## Project structure

```
BookOS-Settings/
├── src/
│   ├── main.js              Application bootstrap, routing, search logic
│   ├── style.css            Styles and animations
│   ├── index.html
│   ├── assets/              SVG icons
│   └── modules/
│       ├── pages.js         Settings page renderers
│       ├── home.js          Sidebar items and search index
│       └── i18n.js          Translations and locale detection
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          Tauri commands and hardware control
│   │   ├── hardware_control.rs
│   │   ├── quickshare.rs    rquickshare integration
│   │   ├── buds.rs          Galaxy Buds via BlueZ
│   │   ├── p2p.rs
│   │   └── search.rs        Semantic search backend
│   ├── extra/               systemd units, udev rules, shell scripts
│   │   └── search/          KRunner plugin and Python indexer
│   └── tauri.conf.json
├── scripts/
│   └── publish-apt.sh       APT repository update automation
└── PKGBUILD
```

---

## Optional services

After installation, enable the bundled systemd services as needed.

Adaptive charging (limits charge to 80% during prolonged AC use):

```bash
sudo systemctl enable --now bookos-battery-adaptive.timer
```

Battery health logger:

```bash
sudo systemctl enable --now bookos-battery-logger.timer
```

Hardware permissions for keyboard backlight and sensor access:

```bash
sudo systemctl enable --now bookos-hw-perms.service
```

Semantic search with KRunner integration:

```bash
cd /opt/bookos-search
sudo ./setup.sh
systemctl --user enable --now bookos-search-watcher.service
systemctl --user enable --now bookos-krunner.service
```

---

## Language

The application detects the system locale on startup. To change manually, navigate to *General Management → Application Language* and select Spanish, English, or Auto. The preference is persisted in `localStorage` under `bookos_lang`.

---

## Supported hardware

Primary target hardware:

- Samsung Galaxy Book 5 Pro (Intel Core Ultra)
- Samsung Galaxy Book 4 series

Most features work on any KDE Plasma 6 system. Hardware-specific features (fan control, battery protection limit, keyboard backlight) require the Samsung Galaxy Book sysfs interfaces provided by recent Linux kernels.

---

## Requirements

| Requirement | Version |
|---|---|
| Operating system | Arch Linux, Debian 12+, Ubuntu 22.04+ |
| KDE Plasma | 6.6 or newer |
| Linux kernel | 6.x with Samsung sysfs support |
| WebKit2GTK | 4.1 |
| Rust toolchain | stable (build only) |

---

## Contributing

Issues and pull requests are welcome at [github.com/Evelynx08/BookOS-Settings](https://github.com/Evelynx08/BookOS-Settings).

---

## License

Released under the GNU General Public License v3.0. See [LICENSE](LICENSE) for the full text.

Copyright (C) 2026 Jose Reyes (Evelynx08).
