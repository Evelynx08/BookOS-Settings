//! Extra system integration: KWin input devices (touchpad/mouse) over DBus,
//! display layout via kscreen-doctor, cursor/icon theme management, and a
//! kglobalaccel restart used by the shortcuts editor.

use serde::Serialize;
use zbus::Connection;

const KWIN: &str = "org.kde.KWin";
const DEV_MGR_PATH: &str = "/org/kde/KWin/InputDevice";
const DEV_MGR_IFACE: &str = "org.kde.KWin.InputDeviceManager";
const DEV_IFACE: &str = "org.kde.KWin.InputDevice";

// ── KWin input devices ───────────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct InputDevice {
    sys_name: String,
    name: String,
    touchpad: bool,
    pointer: bool,
    enabled: bool,
    tap_to_click: bool,
    natural_scroll: bool,
    disable_while_typing: bool,
    supports_disable_while_typing: bool,
    left_handed: bool,
    middle_emulation: bool,
    pointer_acceleration: f64,
    accel_profile_flat: bool,
    scroll_factor: f64,
    click_method_clickfinger: bool,
    supports_click_methods: bool,
    vendor: u32,
    product: u32,
}

async fn dev_proxy<'a>(conn: &'a Connection, sys: &str) -> Result<zbus::Proxy<'a>, String> {
    let path = format!("{DEV_MGR_PATH}/{sys}");
    zbus::Proxy::new(conn, KWIN, path, DEV_IFACE)
        .await
        .map_err(|e| e.to_string())
}

/// List pointer-capable input devices (mice + touchpads) with their current
/// libinput settings, as JSON.
#[tauri::command]
pub async fn list_input_devices() -> Result<String, String> {
    let conn = Connection::session().await.map_err(|e| e.to_string())?;
    let mgr = zbus::Proxy::new(&conn, KWIN, DEV_MGR_PATH, DEV_MGR_IFACE)
        .await
        .map_err(|e| e.to_string())?;
    let sys_names: Vec<String> = mgr
        .get_property("devicesSysNames")
        .await
        .map_err(|e| format!("devicesSysNames: {e}"))?;

    let mut out: Vec<InputDevice> = Vec::new();
    for sys in sys_names {
        let Ok(dev) = dev_proxy(&conn, &sys).await else { continue };
        let pointer: bool = dev.get_property("pointer").await.unwrap_or(false);
        let keyboard: bool = dev.get_property("keyboard").await.unwrap_or(false);
        let touch: bool = dev.get_property("touch").await.unwrap_or(false);
        if !pointer || keyboard || touch {
            continue;
        }
        let name: String = dev.get_property("name").await.unwrap_or_default();
        // Skip virtual/system pointer sources that aren't a real mouse/touchpad
        let lname = name.to_lowercase();
        if lname.contains("video bus") || lname.contains("virtual") || lname.contains("button array") || lname.contains("hid events") {
            continue;
        }
        out.push(InputDevice {
            sys_name: sys.clone(),
            name,
            touchpad: dev.get_property("touchpad").await.unwrap_or(false),
            pointer,
            enabled: dev.get_property("enabled").await.unwrap_or(true),
            tap_to_click: dev.get_property("tapToClick").await.unwrap_or(false),
            natural_scroll: dev.get_property("naturalScroll").await.unwrap_or(false),
            disable_while_typing: dev.get_property("disableWhileTyping").await.unwrap_or(false),
            supports_disable_while_typing: dev.get_property("supportsDisableWhileTyping").await.unwrap_or(false),
            left_handed: dev.get_property("leftHanded").await.unwrap_or(false),
            middle_emulation: dev.get_property("middleEmulation").await.unwrap_or(false),
            pointer_acceleration: dev.get_property("pointerAcceleration").await.unwrap_or(0.0),
            accel_profile_flat: dev.get_property("pointerAccelerationProfileFlat").await.unwrap_or(false),
            scroll_factor: dev.get_property("scrollFactor").await.unwrap_or(1.0),
            click_method_clickfinger: dev.get_property("clickMethodClickfinger").await.unwrap_or(false),
            supports_click_methods: dev.get_property("supportsClickMethodAreas").await.unwrap_or(false)
                && dev.get_property("supportsClickMethodClickfinger").await.unwrap_or(false),
            vendor: dev.get_property("vendor").await.unwrap_or(0),
            product: dev.get_property("product").await.unwrap_or(0),
        });
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// DBus property → kcminputrc key (for persistence across sessions).
fn kcminputrc_key(prop: &str) -> Option<&'static str> {
    Some(match prop {
        "enabled" => "Enabled",
        "tapToClick" => "TapToClick",
        "naturalScroll" => "NaturalScroll",
        "disableWhileTyping" => "DisableWhileTyping",
        "leftHanded" => "LeftHanded",
        "middleEmulation" => "MiddleButtonEmulation",
        "pointerAcceleration" => "PointerAcceleration",
        "scrollFactor" => "ScrollFactor",
        // profile / click method: two bool props → one int key
        "pointerAccelerationProfileFlat" | "pointerAccelerationProfileAdaptive" => "PointerAccelerationProfile",
        "clickMethodAreas" | "clickMethodClickfinger" => "ClickMethod",
        _ => return None,
    })
}

/// Set one libinput property on a device: applies immediately via KWin DBus
/// and persists to kcminputrc so it survives the session.
#[tauri::command]
pub async fn set_input_device_prop(sys_name: String, prop: String, value: String) -> Result<String, String> {
    const FLOAT_PROPS: [&str; 2] = ["pointerAcceleration", "scrollFactor"];
    let Some(rc_key) = kcminputrc_key(&prop) else {
        return Err(format!("property not allowed: {prop}"));
    };
    if !sys_name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad sys_name".into());
    }

    let conn = Connection::session().await.map_err(|e| e.to_string())?;
    let dev = dev_proxy(&conn, &sys_name).await?;

    if FLOAT_PROPS.contains(&prop.as_str()) {
        let v: f64 = value.parse().map_err(|_| "bad float value")?;
        dev.set_property(prop.as_str(), v).await.map_err(|e| e.to_string())?;
    } else {
        let v: bool = value.parse().map_err(|_| "bad bool value")?;
        dev.set_property(prop.as_str(), v).await.map_err(|e| e.to_string())?;
    }

    // Persist: kcminputrc → [Libinput][<vendor>][<product>][<name>]
    let vendor: u32 = dev.get_property("vendor").await.unwrap_or(0);
    let product: u32 = dev.get_property("product").await.unwrap_or(0);
    let name: String = dev.get_property("name").await.unwrap_or_default();
    let rc_value = if rc_key == "PointerAccelerationProfile" {
        // KCM convention: 1 = flat, 2 = adaptive
        let flat_selected = (prop == "pointerAccelerationProfileFlat") == (value == "true");
        if flat_selected { "1".to_string() } else { "2".to_string() }
    } else if rc_key == "ClickMethod" {
        // KCM convention: 1 = button areas, 2 = clickfinger (two-finger right click)
        let areas_selected = (prop == "clickMethodAreas") == (value == "true");
        if areas_selected { "1".to_string() } else { "2".to_string() }
    } else {
        value.clone()
    };
    let _ = tokio::process::Command::new("kwriteconfig6")
        .args([
            "--file", "kcminputrc",
            "--group", "Libinput",
            "--group", &vendor.to_string(),
            "--group", &product.to_string(),
            "--group", &name,
            "--key", rc_key,
            &rc_value,
        ])
        .output()
        .await;
    Ok(r#"{"ok":true}"#.into())
}

// ── Displays (kscreen-doctor) ────────────────────────────────────────────────

/// Current output configuration as kscreen JSON.
#[tauri::command]
pub async fn kscreen_get() -> Result<String, String> {
    let out = tokio::process::Command::new("kscreen-doctor")
        .arg("-j")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Apply kscreen-doctor output settings. Every argument must be an
/// `output.<id>.<setting>` string — anything else is rejected.
#[tauri::command]
pub async fn kscreen_set(args: Vec<String>) -> Result<String, String> {
    if args.is_empty() {
        return Err("no args".into());
    }
    for a in &args {
        let ok = a.starts_with("output.")
            && a.len() < 128
            && a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '@' | ','));
        if !ok {
            return Err(format!("bad arg: {a}"));
        }
    }
    let out = tokio::process::Command::new("kscreen-doctor")
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let ok = out.status.success();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Ok(format!(r#"{{"ok":{},"error":"{}"}}"#, ok, err.replace('"', "'")))
}

// ── Cursor / icon themes ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct ThemeEntry {
    id: String,
    name: String,
}

fn theme_dirs() -> Vec<std::path::PathBuf> {
    let mut v = vec![std::path::PathBuf::from("/usr/share/icons")];
    if let Ok(home) = std::env::var("HOME") {
        v.push(std::path::PathBuf::from(format!("{home}/.icons")));
        v.push(std::path::PathBuf::from(format!("{home}/.local/share/icons")));
    }
    v
}

/// Pretty Name= from an index.theme, falling back to the directory name.
fn index_theme_name(dir: &std::path::Path) -> Option<String> {
    let txt = std::fs::read_to_string(dir.join("index.theme")).ok()?;
    txt.lines()
        .find(|l| l.trim_start().starts_with("Name="))
        .map(|l| l.splitn(2, '=').nth(1).unwrap_or_default().trim().to_string())
}

fn scan_themes(cursors: bool) -> Vec<ThemeEntry> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for base in theme_dirs() {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            if id == "default" || seen.contains(&id) {
                continue;
            }
            let is_cursor = dir.join("cursors").is_dir();
            let has_index = dir.join("index.theme").is_file();
            if cursors != is_cursor || (!cursors && !has_index) {
                continue;
            }
            // Icon themes must declare directories (excludes stub/inherit-only themes)
            if !cursors {
                let ok = std::fs::read_to_string(dir.join("index.theme"))
                    .map(|t| t.contains("Directories="))
                    .unwrap_or(false);
                if !ok {
                    continue;
                }
            }
            let name = index_theme_name(&dir).unwrap_or_else(|| id.clone());
            seen.insert(id.clone());
            out.push(ThemeEntry { id, name });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn list_cursor_themes() -> String {
    serde_json::to_string(&scan_themes(true)).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub fn list_icon_themes() -> String {
    serde_json::to_string(&scan_themes(false)).unwrap_or_else(|_| "[]".into())
}

fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && !id.starts_with('.')
        && id.len() < 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

#[tauri::command]
pub async fn apply_cursor_theme(id: String) -> Result<String, String> {
    if !valid_theme_id(&id) {
        return Err("bad theme id".into());
    }
    let out = tokio::process::Command::new("plasma-apply-cursortheme")
        .arg(&id)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!(r#"{{"ok":{}}}"#, out.status.success()))
}

#[tauri::command]
pub async fn apply_icon_theme(id: String) -> Result<String, String> {
    if !valid_theme_id(&id) {
        return Err("bad theme id".into());
    }
    // plasma-changeicons updates kdeglobals AND notifies running apps
    let changeicons = ["/usr/lib/plasma-changeicons", "/usr/libexec/plasma-changeicons"]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .copied();
    if let Some(bin) = changeicons {
        let out = tokio::process::Command::new(bin)
            .arg(&id)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        return Ok(format!(r#"{{"ok":{}}}"#, out.status.success()));
    }
    // Fallback: write config + broadcast the change notification
    let _ = tokio::process::Command::new("kwriteconfig6")
        .args(["--file", "kdeglobals", "--group", "Icons", "--key", "Theme", &id])
        .output()
        .await;
    let _ = tokio::process::Command::new("dbus-send")
        .args(["--session", "--type=signal", "/KGlobalSettings", "org.kde.KGlobalSettings.notifyChange", "int32:4", "int32:0"])
        .output()
        .await;
    Ok(r#"{"ok":true}"#.into())
}

// ── Keyboard layouts ─────────────────────────────────────────────────────────

/// Pretty layout names from the XKB registry: [{"id":"es","name":"Spanish"},…]
#[tauri::command]
pub fn list_keymaps_pretty() -> String {
    let txt = std::fs::read_to_string("/usr/share/X11/xkb/rules/evdev.lst")
        .or_else(|_| std::fs::read_to_string("/usr/share/X11/xkb/rules/base.lst"))
        .unwrap_or_default();
    let mut out: Vec<ThemeEntry> = Vec::new();
    let mut in_layout = false;
    for line in txt.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('!') {
            in_layout = trimmed == "! layout";
            continue;
        }
        if !in_layout || trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        if let (Some(code), Some(name)) = (parts.next(), parts.next()) {
            out.push(ThemeEntry { id: code.to_string(), name: name.trim().to_string() });
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

// ── Global shortcuts ─────────────────────────────────────────────────────────

/// Write one entry in kglobalshortcutsrc safely: the daemon persists its
/// in-memory state on exit, so it must be STOPPED before the write (otherwise
/// a later shutdown overwrites the edit) and started again after.
#[tauri::command]
pub async fn set_global_shortcut(groups: Vec<String>, key: String, value: String) -> Result<String, String> {
    let ok_text = |s: &str, extra: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.len() < 200
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || extra.contains(c))
    };
    if groups.is_empty() || groups.len() > 3 || !groups.iter().all(|g| ok_text(g, "._-")) {
        return Err("bad group".into());
    }
    if !ok_text(&key, "._- ") {
        return Err("bad key".into());
    }
    // Shortcut field: "Meta+X,none,desc" — allow typical combo/description chars
    if value.is_empty() || value.len() > 300 || value.starts_with('-') || value.chars().any(|c| c.is_control() && c != '\t') {
        return Err("bad value".into());
    }

    let _ = tokio::process::Command::new("systemctl")
        .args(["--user", "stop", "plasma-kglobalaccel.service"])
        .output()
        .await;
    let mut args: Vec<String> = vec!["--file".into(), "kglobalshortcutsrc".into()];
    for g in &groups {
        args.push("--group".into());
        args.push(g.clone());
    }
    args.push("--key".into());
    args.push(key.clone());
    args.push(value.clone());
    let w = tokio::process::Command::new("kwriteconfig6")
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::process::Command::new("systemctl")
        .args(["--user", "start", "plasma-kglobalaccel.service"])
        .output()
        .await;
    Ok(format!(r#"{{"ok":{}}}"#, w.status.success()))
}

/// Restart the kglobalaccel daemon so edits to kglobalshortcutsrc take effect.
#[tauri::command]
pub async fn restart_kglobalaccel() -> Result<String, String> {
    let out = tokio::process::Command::new("systemctl")
        .args(["--user", "restart", "plasma-kglobalaccel.service"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!(r#"{{"ok":{}}}"#, out.status.success()))
}

// ── Custom shortcuts (launch a command with a key combo) ─────────────────────
//
// KDE mechanism: a hidden .desktop file in ~/.local/share/applications plus a
// [services][<file>] _launch=<combo> entry in kglobalshortcutsrc. kglobalaccel
// launches the desktop file when the combo fires. Ours are namespaced
// `bookos-custom-*.desktop` so we can list/delete safely.

const CUSTOM_PREFIX: &str = "bookos-custom-";

fn apps_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    Ok(std::path::PathBuf::from(format!("{home}/.local/share/applications")))
}

fn valid_custom_id(id: &str) -> bool {
    id.starts_with(CUSTOM_PREFIX)
        && id.ends_with(".desktop")
        && id.len() < 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

fn desktop_field<'a>(txt: &'a str, key: &str) -> &'a str {
    txt.lines()
        .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
        .unwrap_or("")
        .trim()
}

#[tauri::command]
pub fn list_custom_shortcuts() -> String {
    let Ok(dir) = apps_dir() else { return "[]".into() };
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            if !valid_custom_id(&id) {
                continue;
            }
            let txt = std::fs::read_to_string(e.path()).unwrap_or_default();
            let combo = std::process::Command::new("kreadconfig6")
                .args(["--file", "kglobalshortcutsrc", "--group", "services", "--group", &id, "--key", "_launch"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            out.push(serde_json::json!({
                "id": id,
                "name": desktop_field(&txt, "Name"),
                "command": desktop_field(&txt, "Exec"),
                "combo": if combo == "none" { String::new() } else { combo },
            }));
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub async fn create_custom_shortcut(name: String, command: String, combo: String) -> Result<String, String> {
    let bad = |s: &str, max: usize| s.is_empty() || s.len() > max || s.chars().any(|c| c.is_control());
    if bad(&name, 60) || bad(&command, 300) || bad(&combo, 100) {
        return Err("datos inválidos".into());
    }
    let dir = apps_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = format!(
        "{}{}.desktop",
        CUSTOM_PREFIX,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let content = format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={command}\nNoDisplay=true\nStartupNotify=false\n"
    );
    std::fs::write(dir.join(&id), content).map_err(|e| e.to_string())?;
    // Same stop→write→start dance as set_global_shortcut (daemon persists on exit)
    set_global_shortcut(vec!["services".into(), id.clone()], "_launch".into(), combo).await?;
    Ok(format!(r#"{{"ok":true,"id":"{id}"}}"#))
}

#[tauri::command]
pub async fn delete_custom_shortcut(id: String) -> Result<String, String> {
    if !valid_custom_id(&id) {
        return Err("bad id".into());
    }
    let _ = tokio::process::Command::new("systemctl")
        .args(["--user", "stop", "plasma-kglobalaccel.service"])
        .output()
        .await;
    let _ = tokio::process::Command::new("kwriteconfig6")
        .args(["--file", "kglobalshortcutsrc", "--group", "services", "--group", &id, "--key", "_launch", "--delete"])
        .output()
        .await;
    let _ = tokio::process::Command::new("systemctl")
        .args(["--user", "start", "plasma-kglobalaccel.service"])
        .output()
        .await;
    let dir = apps_dir()?;
    let _ = std::fs::remove_file(dir.join(&id));
    Ok(r#"{"ok":true}"#.into())
}

// ── Avatar from cropped image bytes ──────────────────────────────────────────

/// Write the user avatar (~/.face) from raw PNG bytes produced by the in-app
/// crop dialog. AccountsService/SDDM read this file directly.
#[tauri::command]
pub fn set_avatar_data(data: Vec<u8>) -> Result<String, String> {
    if data.is_empty() || data.len() > 5_000_000 {
        return Err("imagen inválida".into());
    }
    // PNG magic check — the crop dialog always exports PNG
    if !data.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("formato no soportado".into());
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME")?;
    std::fs::write(format!("{home}/.face"), &data).map_err(|e| e.to_string())?;
    Ok(r#"{"ok":true}"#.into())
}
