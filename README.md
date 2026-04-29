<div align="center">

# ⚙️ BookOS Settings

**A native system settings app for KDE Plasma 6 on Samsung Galaxy Book laptops.**

Built with Tauri 2 + vanilla JS. Fast, lightweight, hardware-aware.

![Version](https://img.shields.io/badge/version-0.4.0-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Arch%20Linux-1793D1?style=flat-square&logo=arch-linux)
![KDE](https://img.shields.io/badge/KDE%20Plasma-6.6-5C2D91?style=flat-square&logo=kde)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## ✨ What is this?

BookOS Settings is a unified control panel designed specifically for **Samsung Galaxy Book** laptops running **BookOS** (an Arch-based KDE Plasma 6 distribution). It replaces the need to dig through multiple KDE menus by bringing hardware-specific controls, system tweaks, and appearance settings into one cohesive interface.

> Think of it like Samsung Settings — but for Linux.

---

## 🧩 Features

| Category | What you can do |
|---|---|
| **Battery** | Performance mode, fan control, adaptive charging, battery protection limit, USB-C charging |
| **Display** | Brightness, resolution, refresh rate, Night Light / Eye Comfort, HDR, Vision Booster |
| **Sound** | Per-app volume, output/input device selection, system sounds, media controls |
| **Lock Screen** | SDDM theme, fingerprint enrollment (animated), AOD, Book Bar |
| **Themes** | Kvantum theme, Plasma color scheme, dark/light mode toggle, scheduled switch |
| **Wallpaper** | Wallpaper picker with color palette extraction |
| **Connections** | Wi-Fi networks, Bluetooth devices, VPN, Airplane mode |
| **Devices** | Quick Share (rquickshare), Galaxy Buds |
| **Security** | UFW firewall control, app permissions |
| **Accounts** | Username, hostname, avatar |
| **General** | Language (ES/EN auto-detect), keyboard layout, date & time |
| **Maintenance** | Disk usage, cache cleanup, system logs |
| **Digital Wellbeing** | Per-app screen time tracking |
| **Advanced** | KWin compositor effects, autostart manager |
| **Updates** | System packages (paru), Flatpak updates |
| **Accessibility** | Vision, magnifier, high contrast |
| **About** | Hardware info, CPU, RAM, GPU, kernel, Plasma version |

### Additional highlights

- 🌍 **Full i18n** — Spanish and English, auto-detected from system locale. Switch in-app without restart.
- 🔍 **Granular search** — finds both top-level pages and nested settings (e.g. searching "fingerprint" opens the Lock Screen page directly).
- 🔒 **Fingerprint animation** — draw-in stroke animation, laser sweep during scan, green glow on success, red shake on error.
- 🎨 **Smooth page transitions** — subtle slide-in on navigation.
- ⚡ **Routines** — create automations that toggle settings combinations; supports undo/restore via snapshots.
- 🔋 **Battery services** — systemd units for adaptive charging, thermal logging, and power management.
- 🔎 **KRunner integration** — semantic search plugin indexes your files and surfaces them in KRunner.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| App shell | [Tauri 2](https://tauri.app) (Rust backend + WebView frontend) |
| Frontend | Vanilla JS (ES modules), no framework |
| Styling | Plain CSS with CSS custom properties |
| System integration | D-Bus (zbus), sysfs, shell commands |
| Hardware control | `kscreen-doctor`, `qdbus6`, `pactl`, `ufw`, sysfs backlight |
| Battery services | systemd system + user units |
| Search | Python semantic indexer + KRunner D-Bus plugin |

---

## 📦 Installation

### Option A — Package (recommended)

Install from the pre-built `.pkg.tar.zst`:

```bash
sudo pacman -U bookos-settings-0.4.0-1-x86_64.pkg.tar.zst
```

Or if you have a `.deb` (on Debian/Ubuntu-based systems, not officially supported):

```bash
sudo dpkg -i bookos-settings_0.4.0_amd64.deb
```

### Option B — Build from source

**1. Install dependencies:**

```bash
# Required
sudo pacman -S rust cargo webkit2gtk-4.1 gtk3 libsoup3 protobuf

# Optional but recommended
sudo pacman -S colord kscreen qdbus6 inotify-tools python python-dbus python-gobject
```

**2. Clone and build:**

```bash
git clone https://github.com/femby08/BookOS-Settings
cd BookOS-Settings
cargo tauri build --no-bundle
```

Binary lands at `src-tauri/target/release/bookos-settings`.

**3. Or build the full installable package:**

```bash
git clone https://github.com/femby08/BookOS-Settings
cd BookOS-Settings
makepkg -si
```

---

## 🚀 Running

```bash
bookos-settings
```

Or launch it from your application menu — a `.desktop` entry is installed automatically.

**Launch at login (background):**

Enable inside the app: *General Management → Autostart → Launch at login*.

---

## 📁 Project Structure

```
BookOS-Settings/
├── src/
│   ├── main.js              # App bootstrap, routing, search logic
│   ├── style.css            # All styles + animations
│   ├── index.html
│   ├── assets/              # SVG icons
│   └── modules/
│       ├── pages.js         # All settings page renderers
│       ├── home.js          # Sidebar items + search index
│       └── i18n.js          # ES/EN translations + locale detection
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # Tauri commands, hardware control
│   │   ├── hardware_control.rs
│   │   ├── quickshare.rs    # rquickshare integration
│   │   ├── buds.rs          # Galaxy Buds via BlueZ
│   │   ├── p2p.rs
│   │   └── search.rs        # Semantic search backend
│   ├── extra/               # systemd units, udev rules, shell scripts
│   │   └── search/          # KRunner plugin + Python indexer
│   └── tauri.conf.json
└── PKGBUILD
```

---

## 🔧 Optional Services

After installation, enable the battery management services:

```bash
# Adaptive charging (keeps battery ≤ 80% when plugged in for long periods)
sudo systemctl enable --now bookos-battery-adaptive.timer

# Battery health logger
sudo systemctl enable --now bookos-battery-logger.timer

# Hardware permissions (keyboard backlight, sensors)
sudo systemctl enable --now bookos-hw-perms.service
```

**Semantic search (KRunner integration):**

```bash
cd /opt/bookos-search
sudo ./setup.sh
systemctl --user enable --now bookos-search-watcher.service
systemctl --user enable --now bookos-krunner.service
```

---

## 🌐 Language

The app auto-detects your system locale. You can override it at any time:

*General Management → Application Language → English / Español / Auto*

The preference is saved in `localStorage` under the key `bookos_lang`.

---

## 🖥️ Supported Hardware

Primarily built for and tested on:

- Samsung Galaxy Book 5 Pro (Intel Core Ultra)
- Samsung Galaxy Book 4 series

Most features work on any KDE Plasma 6 system. Hardware-specific features (fan control, battery protection, keyboard backlight) require Samsung Galaxy Book sysfs interfaces.

---

## 📋 Requirements

| Requirement | Version |
|---|---|
| OS | Arch Linux (or derivative) |
| KDE Plasma | 6.6+ |
| Rust | stable |
| WebKit2GTK | 4.1 |
| Kernel | 6.x (Samsung sysfs support) |

---

## 🤝 Contributing

Issues and PRs welcome at [github.com/femby08/BookOS](https://github.com/femby08/BookOS).

---

## 📄 License

MIT © BookOS
