#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tokio::process::Command;
use std::process::Command as StdCommand;
use std::fs;
use std::sync::{Arc, Mutex, OnceLock};

// Cache the upower battery device path — discovered once per process lifetime.
// Avoids running `upower --enumerate` on every battery status request.
static UPOWER_BAT_PATH: OnceLock<String> = OnceLock::new();
async fn upower_bat_path() -> String {
    if let Some(p) = UPOWER_BAT_PATH.get() { return p.clone(); }
    let devices = run("upower",&["--enumerate"]).await;
    let path = devices.lines()
        .find(|l| l.contains("battery_BAT")||(l.contains("battery_")&&!l.contains("mouse")&&!l.contains("keyboard")&&!l.contains("headset")&&!l.contains("buds")))
        .unwrap_or("/org/freedesktop/UPower/devices/battery_BAT0")
        .trim().to_string();
    UPOWER_BAT_PATH.get_or_init(||path.clone()).clone()
}

mod hardware_control;
mod buds;
mod bluez_profile;
mod quickshare;
mod p2p;
mod search;

// ── Estado global de actualización ───────────────────────────────────────────
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    running: bool,
    done: bool,
    ok: bool,
    output: String,
    child_pid: Option<u32>,
}
impl Default for UpdateProgress {
    fn default() -> Self { Self { running: false, done: false, ok: false, output: String::new(), child_pid: None } }
}
type UpdateState = Arc<Mutex<UpdateProgress>>;

async fn run(cmd: &str, args: &[&str]) -> String {
    run_timeout(cmd, args, 12_000).await
}

async fn run_timeout(cmd: &str, args: &[&str], timeout_ms: u64) -> String {
    let child = Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                child.wait_with_output()
            ).await;

            match result {
                Ok(Ok(output)) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !stdout.is_empty() { stdout } else { String::from_utf8_lossy(&output.stderr).trim().to_string() }
                }
                _ => String::new(),
            }
        }
        Err(_) => String::new(),
    }
}
fn read(p: &str) -> String { fs::read_to_string(p).unwrap_or_default().trim().to_string() }
fn esc(s: &str) -> String { s.replace('\\',"\\\\").replace('"',"\\\"").replace('\n',"\\n").replace('\r',"") }

// ── User ─────────────────────────────────────────────────────────────────
#[tauri::command] async fn get_user_info() -> String {
    let user = run("whoami",&[]).await;
    let home = std::env::var("HOME").unwrap_or_default();
    let cfg = format!("{}/.config/bookos/settings.json", home);
    let display = fs::read_to_string(&cfg).ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("display_name").and_then(|n| n.as_str().map(String::from)))
        .unwrap_or_else(|| {
            read("/etc/passwd").lines().find(|l| l.starts_with(&format!("{}:", user)))
                .and_then(|l| l.split(':').nth(4)).map(|s| s.split(',').next().unwrap_or("").to_string())
                .filter(|s| !s.is_empty()).unwrap_or_else(|| user.clone())
        });
    let host = run("hostname",&[]).await;
    let avatar = format!("{}/.face", home);
    let has_av = std::path::Path::new(&avatar).exists();
    format!(r#"{{"username":"{}","display_name":"{}","hostname":"{}","has_avatar":{},"avatar_path":"{}"}}"#,
        esc(&user),esc(&display),esc(&host),has_av,esc(&avatar))
}
#[tauri::command] async fn set_display_name(name: String) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.config/bookos", home);
    let _ = fs::create_dir_all(&dir);
    let p = format!("{}/settings.json", dir);
    let mut c: serde_json::Value = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
    c["display_name"] = serde_json::json!(name);
    let _ = fs::write(&p, serde_json::to_string_pretty(&c).unwrap_or_default());
    r#"{"ok":true}"#.to_string()
}
#[tauri::command] async fn set_hostname(name: String) -> String { run("hostnamectl",&["set-hostname",&name]).await; r#"{"ok":true}"#.into() }

fn regex_strip_rev(s: &str) -> String {
    // Remove trailing " (rev XX)" suffix from lspci output
    if let Some(idx) = s.rfind(" (rev ") {
        s[..idx].to_string()
    } else {
        s.to_string()
    }
}

// ── System Info ──────────────────────────────────────────────────────────
#[tauri::command] async fn get_system_info() -> String {
    let host = run("hostname",&[]).await;
    let kern = run("uname",&["-r"]).await;
    let os = read("/etc/os-release");
    let distro = os.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string()).unwrap_or("Linux".into());
    // Try /proc/cpuinfo first (locale-independent), fall back to lscpu
    let cpu = {
        let proc = read("/proc/cpuinfo");
        let from_proc = proc.lines()
            .find(|l| l.starts_with("model name"))
            .and_then(|l| l.splitn(2,':').nth(1))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !from_proc.is_empty() { from_proc } else {
            run("lscpu",&[]).await.lines()
                .find(|l| l.contains("Model name") || l.contains("Nombre del modelo") || l.contains("model name"))
                .and_then(|l| l.splitn(2,':').nth(1))
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        }
    };
    // Parse RAM in bytes and show in GB (decimal, rounded to nearest power of 2 for display)
    let mem_bytes: u64 = run("free",&["-b"]).await.lines()
        .find(|l| l.starts_with("Mem:"))
        .and_then(|l| l.split_whitespace().nth(1).map(|s| s.parse().unwrap_or(0)))
        .unwrap_or(0);
    let ram = if mem_bytes > 0 {
        let gb = (mem_bytes as f64) / 1_073_741_824.0; // GiB
        // Round to nearest standard size (4,8,16,32,64...)
        let rounded = [4u32,6,8,12,16,24,32,48,64,96,128].iter().copied()
            .min_by_key(|&s| ((gb - s as f64).abs() * 100.0) as i64)
            .unwrap_or(gb.round() as u32);
        format!("{} GB", rounded)
    } else { "—".into() };
    let gpu = run("lspci",&[]).await.lines()
        .find(|l| l.contains("VGA")||l.contains("3D"))
        .map(|l| {
            let s = l.find(": ").map(|i| l[i+2..].to_string()).unwrap_or(l.to_string());
            // Strip trailing "(rev XX)"
            let s = regex_strip_rev(&s);
            s.trim().to_string()
        })
        .unwrap_or_default();
    let plasma = { let v = run("plasmashell",&["--version"]).await; v.split_whitespace().last().unwrap_or(&v).to_string() };
    format!(r#"{{"hostname":"{}","kernel":"{}","distro":"{}","cpu":"{}","ram":"{}","gpu":"{}","plasma":"{}"}}"#,
        esc(&host),esc(&kern),esc(&distro),esc(&cpu),esc(&ram),esc(&gpu),esc(&plasma))
}

// ── Hardware feature detection (generic Linux — no vendor assumptions) ────
#[tauri::command] async fn check_hw_features() -> String {
    // Read platform-profile sysfs first (knows "low-power"), fallback to PPD
    let mut perf = read("/sys/class/platform-profile/platform-profile-0/profile")
        .trim().to_string();
    if perf.is_empty() {
        perf = read("/sys/firmware/acpi/platform_profile").trim().to_string();
    }
    let ppd = run("powerprofilesctl",&["get"]).await;
    if perf.is_empty() { perf = ppd.trim().to_string(); }
    let perf_supported = !ppd.trim().is_empty()
        && !ppd.contains("not found")
        && !ppd.contains("No such")
        && !ppd.contains("error");

    // Charge limit via standard Linux ACPI sysfs (ThinkPad, ASUS, Huawei, Dell, etc.)
    let bat_paths = [
        "/sys/class/power_supply/BAT0/charge_control_end_threshold",
        "/sys/class/power_supply/BAT1/charge_control_end_threshold",
        "/sys/class/power_supply/BATT/charge_control_end_threshold",
    ];
    let mut cl = String::new();
    for p in &bat_paths {
        let v = read(p);
        if !v.trim().is_empty() { cl = v.trim().to_string(); break; }
    }
    let charge_limit_supported = !cl.is_empty();

    format!(r#"{{"perf_supported":{},"charge_limit_supported":{},"performance_mode":"{}","charge_limit":"{}"}}"#,
        perf_supported, charge_limit_supported, esc(perf.trim()), esc(&cl))
}
#[tauri::command] async fn set_performance_mode(mode: String) -> String {
    // "ahorro" is Samsung-specific (low-power); PPD doesn't know it.
    // Let aplicar_perfil_termico handle that branch via modern platform-profile path.
    if mode != "ahorro" {
        run("powerprofilesctl",&["set",&mode]).await;
    }
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_charge_limit(limit: u32) -> String {
    // Standard Linux ACPI charge threshold — supported on many laptops
    let end_limit = limit.clamp(50, 100);
    let bat_paths = [
        "/sys/class/power_supply/BAT0/charge_control_end_threshold",
        "/sys/class/power_supply/BAT1/charge_control_end_threshold",
        "/sys/class/power_supply/BATT/charge_control_end_threshold",
    ];
    // Persist limit for adaptive charging script
    if let Ok(()) = fs::create_dir_all("/etc/bookos") {
        let _ = fs::write("/etc/bookos/charge_limit", end_limit.to_string());
    }
    for p in &bat_paths {
        if std::path::Path::new(p).exists() {
            return match fs::write(p, end_limit.to_string()) {
                Ok(_) => format!(r#"{{"ok":true,"limit":{}}}"#, end_limit),
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied =>
                    r#"{"ok":false,"error":"sin permisos — instala bookos-hw-perms.service"}"#.into(),
                Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
            };
        }
    }
    r#"{"ok":false,"error":"límite de carga no compatible con este hardware"}"#.into()
}

// ── WiFi ─────────────────────────────────────────────────────────────────
#[tauri::command] async fn get_wifi_status() -> String {
    let st = run("nmcli",&["-t","-f","WIFI","radio"]).await;
    let conn = run("nmcli",&["-t","-f","NAME,TYPE","connection","show","--active"]).await;
    let ssid = conn.lines().find(|l| l.contains("wireless")||l.contains("wifi")).map(|l| l.split(':').next().unwrap_or("").to_string()).unwrap_or_default();
    format!(r#"{{"enabled":{},"ssid":"{}"}}"#,st=="enabled",esc(&ssid))
}
#[tauri::command] async fn toggle_wifi(enable: bool) -> String { run("nmcli",&["radio","wifi",if enable{"on"}else{"off"}]).await; format!(r#"{{"ok":true}}"#) }
#[tauri::command] async fn get_wifi_list() -> String {
    let scan = run("nmcli",&["-t","-f","SSID,SIGNAL,SECURITY,IN-USE,FREQ","device","wifi","list","--rescan","no"]).await;
    let mut seen = std::collections::HashSet::new();
    let nets: Vec<String> = scan.lines().filter(|l| !l.is_empty()).filter_map(|l| {
        let p: Vec<&str> = l.splitn(5,':').collect();
        let ssid = p.first().unwrap_or(&"").to_string();
        if ssid.is_empty() || !seen.insert(ssid.clone()) { return None; }
        let freq_str = p.get(4).unwrap_or(&"").replace("\\:",":");
        let freq_mhz: u32 = freq_str.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
        let band = if freq_mhz >= 5925 { "6G" } else if freq_mhz >= 3000 { "5G" } else if freq_mhz > 0 { "2.4G" } else { "" };
        Some(format!(r#"{{"ssid":"{}","signal":{},"security":"{}","active":{},"band":"{}"}}"#,
            esc(&ssid),p.get(1).unwrap_or(&"0"),esc(p.get(2).unwrap_or(&"")),p.get(3).unwrap_or(&"")==&"*",band))
    }).collect();
    format!("[{}]",nets.join(","))
}
#[tauri::command] async fn connect_wifi(ssid: String, password: String) -> String {
    let r = if password.is_empty() { run("nmcli",&["device","wifi","connect",&ssid]).await }
    else { run("nmcli",&["device","wifi","connect",&ssid,"password",&password]).await };
    format!(r#"{{"ok":{},"result":"{}"}}"#,r.contains("successfully")||r.contains("activated"),esc(&r))
}
#[tauri::command] async fn wifi_rescan() -> String { run("nmcli",&["device","wifi","rescan"]).await; r#"{"ok":true}"#.into() }

// ── Bluetooth ────────────────────────────────────────────────────────────
#[tauri::command] async fn get_bluetooth_status() -> String {
    let s = run("bluetoothctl",&["show"]).await;
    format!(r#"{{"enabled":{}}}"#,s.lines().any(|l| l.contains("Powered:")&&l.contains("yes")))
}
#[tauri::command] async fn toggle_bluetooth(enable: bool) -> String {
    run("rfkill",&[if enable{"unblock"}else{"block"},"bluetooth"]).await;
    run("bluetoothctl",&["power",if enable{"on"}else{"off"}]).await;
    format!(r#"{{"ok":true}}"#)
}
#[tauri::command] async fn get_bluetooth_devices() -> String {
    // "devices Paired" needs bluez ≥5.65. Fall back to plain "devices" (all known) if empty.
    let mut paired = run("bluetoothctl",&["devices","Paired"]).await;
    if paired.trim().is_empty() || paired.to_lowercase().contains("invalid") {
        paired = run("bluetoothctl",&["devices"]).await;
    }
    let connected_out = run("bluetoothctl",&["devices","Connected"]).await;

    // Strip ANSI escapes that some bluetoothctl builds emit
    let strip_ansi = |s: &str| -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\x1b' { while let Some(nc) = chars.next() { if nc.is_ascii_alphabetic() { break; } } }
            else { out.push(c); }
        }
        out
    };
    let paired_clean = strip_ansi(&paired);

    let entries: Vec<(String,String,bool)> = paired_clean.lines().filter_map(|l| {
        let l = l.trim();
        // Skip prompts like "[bluetooth]#" or "[NEW]" prefixes
        let l = l.trim_start_matches(|c: char| c=='[' || c==']' || c=='#' || c.is_whitespace());
        let idx = l.find("Device ")?;
        let rest = &l[idx + "Device ".len()..];
        let (mac, name) = rest.split_once(' ')?;
        // MAC sanity: 17 chars with colons
        if mac.len()!=17 || mac.matches(':').count()!=5 { return None; }
        Some((mac.to_string(), name.trim().to_string(), connected_out.contains(mac)))
    }).collect();

    // Fetch info for all devices in parallel
    let mut tasks = Vec::new();
    for (mac, name, is_conn) in entries {
        tasks.push(tokio::spawn(async move {
            let info = run_timeout("bluetoothctl",&["info",&mac], 2_000).await;
            let icon = info.lines().find(|l| l.trim_start().starts_with("Icon:"))
                .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
                .unwrap_or_default();
            format!(r#"{{"mac":"{}","name":"{}","connected":{},"icon":"{}"}}"#,
                esc(&mac),esc(&name),is_conn,esc(&icon))
        }));
    }
    
    let mut devs = Vec::new();
    for t in futures::future::join_all(tasks).await {
        if let Ok(d) = t { devs.push(d); }
    }
    format!("[{}]",devs.join(","))
}
#[tauri::command] async fn connect_bluetooth(mac: String) -> String { let r=run("bluetoothctl",&["connect",&mac]).await; format!(r#"{{"ok":{}}}"#,r.contains("successful")||r.contains("Connected")) }
#[tauri::command] async fn disconnect_bluetooth(mac: String) -> String { run("bluetoothctl",&["disconnect",&mac]).await; r#"{"ok":true}"#.into() }
#[tauri::command] async fn bluetooth_scan() -> String {
    tokio::spawn(async move {
        let _ = Command::new("bluetoothctl")
            .args(["--timeout","6","scan","on"])
            .output()
            .await;
    });
    r#"{"ok":true}"#.into()
}

// ── Airplane ─────────────────────────────────────────────────────────────
#[tauri::command] async fn get_airplane_mode() -> String {
    let r = run("rfkill",&["list"]).await;
    format!(r#"{{"enabled":{}}}"#,r.lines().filter(|l| l.contains("Soft blocked:")).all(|l| l.contains("yes")))
}
#[tauri::command] async fn toggle_airplane_mode(enable: bool) -> String { run("rfkill",&[if enable{"block"}else{"unblock"},"all"]).await; r#"{"ok":true}"#.into() }

// ── Brightness ───────────────────────────────────────────────────────────
#[tauri::command] async fn get_brightness() -> String {
    let c: f64 = run("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","brightness"]).await.parse().unwrap_or(0.0);
    let m: f64 = run("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","brightnessMax"]).await.parse().unwrap_or(100.0);
    format!(r#"{{"brightness":{}}}"#,if m>0.0{(c/m*100.0)as u32}else{0})
}
#[tauri::command] async fn set_brightness(value: u32) -> String {
    // Get max from KDE, convert percentage to raw value, set via KDE D-Bus
    let m: f64 = run("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","brightnessMax"]).await.parse().unwrap_or(100.0);
    let raw = (m * value as f64 / 100.0).round() as u32;
    run("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","setBrightness",&raw.to_string()]).await;
    r#"{"ok":true}"#.into()
}

// ── Keyboard Brightness (3 levels: 0,1,2) ────────────────────────────────
#[tauri::command] async fn get_kbd_brightness() -> String {
    let c = run("brightnessctl",&["--device=*::kbd_backlight","get"]).await;
    let m = run("brightnessctl",&["--device=*::kbd_backlight","max"]).await;
    let cv: u32 = c.parse().unwrap_or(0);
    let mv: u32 = m.parse().unwrap_or(0);
    format!(r#"{{"level":{},"max":{},"available":{}}}"#,cv,mv,mv>0)
}
#[tauri::command] async fn set_kbd_brightness(level: u32) -> String {
    run("brightnessctl",&["--device=*::kbd_backlight","set",&level.to_string()]).await;
    r#"{"ok":true}"#.into()
}

// ── Night Light ──────────────────────────────────────────────────────────
#[tauri::command] async fn get_nightlight() -> String {
    let a = run("kreadconfig6",&["--file","kwinrc","--group","NightColor","--key","Active"]).await;
    let t = run("kreadconfig6",&["--file","kwinrc","--group","NightColor","--key","NightTemperature"]).await;
    format!(r#"{{"active":{},"temperature":{}}}"#,a=="true",if t.is_empty(){"4500".into()}else{t})
}
#[tauri::command] async fn set_nightlight(active: bool, temperature: Option<u32>) -> String {
    run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","Active",if active{"true"}else{"false"}]).await;
    if let Some(t) = temperature {
        run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","NightTemperature",&t.to_string()]).await;
    }
    run("qdbus6",&["org.kde.KWin","/KWin","reconfigure"]).await;
    if temperature.is_none() {
        // Toggle only: force immediate re-apply via inhibit+uninhibit cycle
        run("dbus-send",&["--session","--dest=org.kde.KWin","--type=method_call",
            "/org/kde/KWin/NightLight","org.kde.KWin.NightLight.inhibit"]).await;
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
        run("dbus-send",&["--session","--dest=org.kde.KWin","--type=method_call",
            "/org/kde/KWin/NightLight","org.kde.KWin.NightLight.uninhibit"]).await;
    }
    r#"{"ok":true}"#.into()
}

// ── Sound ────────────────────────────────────────────────────────────────
#[tauri::command] async fn get_volume() -> String {
    let v = run("pactl",&["get-sink-volume","@DEFAULT_SINK@"]).await;
    let m = run("pactl",&["get-sink-mute","@DEFAULT_SINK@"]).await;
    let pct = v.split('/').nth(1).map(|s| s.trim().trim_end_matches('%').trim().to_string()).unwrap_or("50".into());
    format!(r#"{{"volume":{},"muted":{}}}"#,pct,m.contains("yes"))
}
#[tauri::command] async fn set_volume(value: u32) -> String {
    run("pactl",&["set-sink-volume","@DEFAULT_SINK@",&format!("{}%",value)]).await;
    set_bookos_setting("Volume".into(), value.to_string());
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn toggle_mute() -> String { run("pactl",&["set-sink-mute","@DEFAULT_SINK@","toggle"]).await; r#"{"ok":true}"#.into() }

#[tauri::command] async fn get_battery_status() -> String {
    let path = upower_bat_path().await;
    let info = run("upower", &["-i", &path]).await;
    if info.is_empty() {
        return r#"{"percentage":"0","state":"unknown","time":"","energy_rate":"","energy":"","energy_full":"","energy_full_design":"","capacity":""}"#.into();
    }
    parse_upower(&info)
}

fn parse_upower(info: &str) -> String {
    let find = |key: &str| -> String {
        for line in info.lines() {
            let t = line.trim();
            if t.starts_with(key) {
                if let Some(val) = t.split(':').nth(1) {
                    return val.trim().to_string();
                }
            }
        }
        String::new()
    };
    let pct_raw = find("percentage");
    let pct = pct_raw.replace('%',"").trim().to_string();
    let state = find("state");
    let time = if state.contains("discharging") { find("time to empty") } else { find("time to full") };
    let rate = find("energy-rate");
    let energy = find("energy:");
    let efull = find("energy-full:");
    let edesign = find("energy-full-design");
    let capacity = find("capacity:");
    format!(r#"{{"percentage":"{}","state":"{}","time":"{}","energy_rate":"{}","energy":"{}","energy_full":"{}","energy_full_design":"{}","capacity":"{}"}}"#,
        esc(&pct),esc(&state),esc(&time),esc(&rate),esc(&energy),esc(&efull),esc(&edesign),esc(&capacity))
}

#[tauri::command] async fn get_battery_history() -> Result<String, String> {
    let dir = "/var/lib/upower";
    let mut best_file = String::new();
    let mut max_size = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("history-charge-") && !name.to_lowercase().contains("buds") && !name.contains("generic") && !name.contains("Ultra") {
                if let Ok(meta) = entry.metadata() {
                    // We select the largest log since it represents the internal battery the most
                    if meta.len() > max_size {
                        max_size = meta.len();
                        best_file = entry.path().to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    if best_file.is_empty() { return Ok("[]".into()); }
    
    let content = fs::read_to_string(&best_file).unwrap_or_default();
    let lines = content.lines().collect::<Vec<&str>>();
    
    // Reverse iterating to get latest up to 500 lines so JSON isn't massive
    let iter = lines.iter().rev().take(500);
    let mut recent: Vec<String> = iter.filter_map(|l| {
        let p: Vec<&str> = l.split_whitespace().collect();
        if p.len() >= 3 {
             Some(format!(r#"{{"t":{},"p":{},"s":"{}"}}"#, p[0], p[1], esc(p[2])))
        } else { None }
    }).collect();
    
    // We reverse again to make it chronological
    recent.reverse();
    
    Ok(format!("[{}]", recent.join(",")))
}

// ── Adaptive Battery (BookOS CSV system) ─────────────────────────────────

/// Returns last 288 rows from /var/log/bookos/battery.csv for chart display.
#[tauri::command] fn get_battery_csv_data() -> String {
    let content = match std::fs::read_to_string("/var/log/bookos/battery.csv") {
        Ok(c) => c,
        Err(_) => return r#"{"ok":false,"rows":[]}"#.to_string(),
    };
    let mut rows: Vec<String> = Vec::new();
    for line in content.lines().skip(1) { // skip header
        let p: Vec<&str> = line.split(',').collect();
        if p.len() >= 5 {
            if let (Ok(day), Ok(h), Ok(m), Ok(lvl)) = (
                p[0].trim().parse::<u32>(),
                p[1].trim().parse::<u32>(),
                p[2].trim().parse::<u32>(),
                p[3].trim().parse::<u32>(),
            ) {
                let power_uw: u64 = p.get(5).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                rows.push(format!(r#"{{"day":{},"h":{},"m":{},"level":{},"state":"{}","power_uw":{}}}"#,
                    day, h, m, lvl, esc(p[4].trim()), power_uw));
            }
        }
    }
    let start = if rows.len() > 288 { rows.len() - 288 } else { 0 };
    format!(r#"{{"ok":true,"rows":[{}]}}"#, rows[start..].join(","))
}

/// Returns last 900 rows (~30 min @ 2s) from /var/log/bookos/thermal.csv.
#[tauri::command] fn get_thermal_csv_data() -> String {
    let content = match std::fs::read_to_string("/var/log/bookos/thermal.csv") {
        Ok(c) => c,
        Err(_) => return r#"{"ok":false,"rows":[]}"#.to_string(),
    };
    let mut rows: Vec<String> = Vec::new();
    for line in content.lines().skip(1) {
        let p: Vec<&str> = line.split(',').collect();
        if p.len() < 15 { continue; }
        let ts:    i64 = p[0].trim().parse().unwrap_or(0);
        let prof = esc(p[1].trim());
        let fan:   i32 = p[2].trim().parse().unwrap_or(0);
        let cpu_pkg: i32 = p[3].trim().parse().unwrap_or(0);
        let cpu_core: i32 = p[4].trim().parse().unwrap_or(0);
        let nvme: i32 = p[5].trim().parse().unwrap_or(0);
        let wifi: i32 = p[6].trim().parse().unwrap_or(0);
        let pl1: u64 = p[11].trim().parse().unwrap_or(0);
        let pl2: u64 = p[12].trim().parse().unwrap_or(0);
        let bat_ua: i64 = p[13].trim().parse().unwrap_or(0);
        let ac: i32 = p[14].trim().parse().unwrap_or(0);
        rows.push(format!(
            r#"{{"ts":{},"profile":"{}","fan":{},"cpu_pkg":{},"cpu_core":{},"nvme":{},"wifi":{},"pl1":{},"pl2":{},"bat_ua":{},"ac":{}}}"#,
            ts, prof, fan, cpu_pkg, cpu_core, nvme, wifi, pl1, pl2, bat_ua, ac
        ));
    }
    let start = if rows.len() > 900 { rows.len() - 900 } else { 0 };
    format!(r#"{{"ok":true,"rows":[{}]}}"#, rows[start..].join(","))
}

/// USB-C charging info — voltage/current, PD mode, negotiated power.
#[tauri::command] fn get_charging_info() -> String {
    fn read_u64(p: &str) -> u64 { std::fs::read_to_string(p).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0) }
    fn read_str(p: &str) -> String { std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).unwrap_or_default() }

    // Battery charging rate
    let bat = if std::path::Path::new("/sys/class/power_supply/BAT1").exists() { "BAT1" } else { "BAT0" };
    let current_ua = read_u64(&format!("/sys/class/power_supply/{bat}/current_now"));
    let voltage_uv = read_u64(&format!("/sys/class/power_supply/{bat}/voltage_now"));
    let status     = read_str(&format!("/sys/class/power_supply/{bat}/status"));
    let power_uw   = current_ua.saturating_mul(voltage_uv) / 1_000_000;
    let charging   = status == "Charging";

    // AC adapter type + USB-PD if applicable
    let ac_online  = read_u64("/sys/class/power_supply/ADP1/online") == 1 ||
                     read_u64("/sys/class/power_supply/AC/online") == 1;

    // Scan typec ports
    let mut pd_rev    = String::new();
    let mut op_mode   = String::new();
    let mut usb_type  = String::new();
    if let Ok(rd) = std::fs::read_dir("/sys/class/typec") {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("port") { continue; }
            let role = read_str(&format!("{}/power_role", p.display()));
            // Solo el puerto que está recibiendo energía (sink)
            if role.contains("[sink]") {
                pd_rev   = read_str(&format!("{}/usb_power_delivery_revision", p.display()));
                op_mode  = read_str(&format!("{}/power_operation_mode", p.display()));
                break;
            }
        }
    }
    // Fallback: mirar ucsi-source-psy para voltaje/corriente max negociada
    let (mut v_max, mut c_max) = (0u64, 0u64);
    if let Ok(rd) = std::fs::read_dir("/sys/class/power_supply") {
        for e in rd.flatten() {
            let n = e.file_name().into_string().unwrap_or_default();
            if !n.starts_with("ucsi-source-psy") { continue; }
            if read_u64(&format!("/sys/class/power_supply/{n}/online")) != 1 { continue; }
            v_max = read_u64(&format!("/sys/class/power_supply/{n}/voltage_max"));
            c_max = read_u64(&format!("/sys/class/power_supply/{n}/current_max"));
            if read_str(&format!("/sys/class/power_supply/{n}/usb_type")).contains("[PD") {
                if op_mode.is_empty() { op_mode = "USB Power Delivery".into(); }
            }
        }
    }
    let adapter_w = v_max.saturating_mul(c_max) / 1_000_000_000_000; // µV*µA → W

    format!(r#"{{"ok":true,"charging":{},"ac_online":{},"current_ua":{},"voltage_uv":{},"power_uw":{},"status":"{}","pd_rev":"{}","op_mode":"{}","adapter_w":{},"usb_type":"{}"}}"#,
        charging, ac_online, current_ua, voltage_uv, power_uw, esc(&status), esc(&pd_rev), esc(&op_mode), adapter_w, esc(&usb_type))
}

/// Camera privacy toggle — enable/disable kernel module or device access.
#[tauri::command] async fn set_camera_enabled(enable: bool) -> String {
    // Intel IPU7 camera stack on Galaxy Book 5 Pro
    let module = "intel_ipu7";
    let arg = if enable { "" } else { "-r" };
    let r = if enable {
        Command::new("pkexec").args(&["modprobe", module]).output().await
    } else {
        Command::new("pkexec").args(&["modprobe", arg, module]).output().await
    };
    match r {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{e}"}}"#),
    }
}

#[tauri::command] fn get_camera_enabled() -> String {
    let loaded = std::fs::read_to_string("/proc/modules")
        .map(|c| c.lines().any(|l| l.starts_with("intel_ipu7 ")))
        .unwrap_or(true);
    let has_videos = std::fs::read_dir("/sys/class/video4linux").is_ok();
    format!(r#"{{"enabled":{}}}"#, loaded && has_videos)
}

/// Microphone global mute — via PulseAudio/PipeWire.
#[tauri::command] async fn set_mic_muted(muted: bool) -> String {
    let val = if muted { "1" } else { "0" };
    let r = Command::new("pactl")
        .args(&["set-source-mute", "@DEFAULT_SOURCE@", val])
        .output().await;
    // También mutear todas las sources de entrada para bloqueo total
    if let Ok(list) = Command::new("pactl").args(&["list","short","sources"]).output().await {
        let s = String::from_utf8_lossy(&list.stdout);
        for line in s.lines() {
            if let Some(name) = line.split_whitespace().nth(1) {
                if name.contains(".monitor") { continue; }
                let _ = Command::new("pactl").args(&["set-source-mute", name, val]).output().await;
            }
        }
    }
    match r {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        _ => format!(r#"{{"ok":false}}"#),
    }
}

#[tauri::command] async fn get_mic_muted() -> String {
    let r = Command::new("pactl")
        .args(&["get-source-mute", "@DEFAULT_SOURCE@"])
        .output().await;
    let muted = r.map(|o| String::from_utf8_lossy(&o.stdout).contains("yes")).unwrap_or(false);
    format!(r#"{{"muted":{}}}"#, muted)
}

/// Computes median disconnect times per weekday from the CSV.
/// Disconnect = transition Charging/Full → Discharging.
#[tauri::command] fn get_adaptive_predictions() -> String {
    let content = match std::fs::read_to_string("/var/log/bookos/battery.csv") {
        Ok(c) => c,
        Err(_) => return r#"{"ok":false,"predictions":[]}"#.to_string(),
    };
    struct Row { day: u32, h: u32, m: u32, state: String }
    let mut all: Vec<Row> = Vec::new();
    for line in content.lines().skip(1) {
        let p: Vec<&str> = line.split(',').collect();
        if p.len() >= 5 {
            if let (Ok(day), Ok(h), Ok(m), Ok(_lvl)) = (
                p[0].trim().parse::<u32>(),
                p[1].trim().parse::<u32>(),
                p[2].trim().parse::<u32>(),
                p[3].trim().parse::<u32>(),
            ) {
                all.push(Row { day, h, m, state: p[4].trim().to_string() });
            }
        }
    }
    // Find transitions Charging/Full → Discharging
    let mut by_day: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for i in 1..all.len() {
        let prev_charging = all[i-1].state == "Charging" || all[i-1].state == "Full";
        let curr_discharging = all[i].state == "Discharging";
        if prev_charging && curr_discharging {
            let mins = all[i].h * 60 + all[i].m;
            by_day.entry(all[i].day).or_default().push(mins);
        }
    }
    let mut preds: Vec<String> = Vec::new();
    for day in 1u32..=7 {
        if let Some(times) = by_day.get_mut(&day) {
            times.sort_unstable();
            let median = times[times.len() / 2];
            preds.push(format!(r#"{{"day":{},"hour":{},"minute":{},"samples":{}}}"#,
                day, median / 60, median % 60, times.len()));
        }
    }
    format!(r#"{{"ok":true,"predictions":[{}]}}"#, preds.join(","))
}

/// Enables or disables the adaptive charging systemd timer.
#[tauri::command] async fn set_adaptive_charging(enabled: bool) -> String {
    // Try system-level timer first, then user-level
    let timer = "bookos-battery-adaptive.timer";
    let args: &[&str] = if enabled { &["enable", "--now", timer] } else { &["disable", "--now", timer] };
    let sys = run("systemctl", args).await;
    if sys.is_empty() || sys.contains("error") || sys.contains("not found") {
        // try user-level
        let mut user_args = vec!["--user"];
        user_args.extend_from_slice(args);
        let _ = run("systemctl", &user_args).await;
    }
    format!(r#"{{"ok":true,"enabled":{}}}"#, enabled)
}

// ── Display / Resolution ─────────────────────────────────────────────────
#[tauri::command] async fn get_display_info() -> String {
    let out = run("kscreen-doctor",&["-o"]).await;
    // Parse outputs and their modes
    let mut outputs = Vec::new();
    let mut current_output = String::new();
    let mut modes = Vec::new();
    let mut current_res = String::new();
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("Output:") {
            if !current_output.is_empty() {
                outputs.push(format!(r#"{{"name":"{}","modes":[{}],"current":"{}"}}"#,esc(&current_output),modes.join(","),esc(&current_res)));
                modes.clear();
            }
            current_output = t.trim_start_matches("Output:").trim().split_whitespace().next().unwrap_or("").to_string();
        }
        if t.starts_with("Modes:") || (t.contains("x") && t.contains("@")) {
            for mode_part in t.split_whitespace() {
                if !mode_part.contains("x") || !mode_part.contains("@") { continue; }
                let mut res = mode_part.to_string();
                if let Some(pos) = res.find(':') {
                    res = res[pos+1..].to_string();
                }
                let is_current = res.contains("*");
                res = res.trim_end_matches('*').trim_end_matches('!').to_string();
                if is_current { current_res = res.clone(); }
                let quoted = format!(r#""{}""#, esc(&res));
                if !res.is_empty() && !modes.contains(&quoted) {
                    modes.push(quoted);
                }
            }
        }
    }
    if !current_output.is_empty() {
        outputs.push(format!(r#"{{"name":"{}","modes":[{}],"current":"{}"}}"#,esc(&current_output),modes.join(","),esc(&current_res)));
    }
    format!("[{}]",outputs.join(","))
}
#[tauri::command] async fn set_resolution(output: String, resolution: String) -> String {
    run("kscreen-doctor",&[&format!("output.{}.mode.{}",output,resolution)]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_vrr_policy(output: String, policy: String) -> String {
    run("kscreen-doctor",&[&format!("output.{}.vrrpolicy.{}",output,policy)]).await;
    r#"{"ok":true}"#.into()
}

// Detección de tema oscuro — keywords de claro tienen prioridad sobre keywords de oscuro
// Ej: "Claro Frappe" → light (claro gana sobre frappe)
fn theme_is_dark(name: &str) -> bool {
    let nl = name.to_lowercase();
    let is_light = nl.starts_with("claro") || nl.starts_with("light") || nl.starts_with("latte")
        || nl.contains(" claro") || nl.contains(" light") || nl.contains(" latte")
        || nl.contains("breeze-light") || nl.contains("breezelight");
    if is_light { return false; }
    nl.contains("dark") || nl.contains("oscuro") || nl.contains("mocha") || nl.contains("frappe")
        || nl.contains("macchiato") || nl.contains("noir") || nl.contains("night")
        || nl.contains("midnight") || nl.contains("dracula") || nl.contains("gruvbox")
        || nl.contains("nord") || nl.contains("tokyo") || nl.contains("onedark")
        || nl.contains("heimdal") || nl.contains("emerald-smooth") || nl.contains("cachyos-dark")
}

// ── Themes ───────────────────────────────────────────────────────────────
#[tauri::command] async fn get_current_theme() -> String {
    // Primero leer preferencia guardada en nuestro JSON (fuente de verdad para la app)
    let cfg = load_bookos_settings();
    let saved_dark = cfg.get("ThemeIsDark").and_then(|v| {
        v.as_bool().or_else(|| v.as_str().map(|s| s == "true"))
    });
    if let Some(is_dark) = saved_dark {
        let scheme = cfg.get("ThemeScheme").and_then(|v| v.as_str()).unwrap_or("").to_string();
        return format!(r#"{{"scheme":"{}","is_dark":{}}}"#, esc(&scheme), is_dark);
    }
    // Fallback: leer de KDE
    let scheme = run("kreadconfig6",&["--file","kdeglobals","--group","General","--key","ColorScheme"]).await;
    let gtk = run("gsettings",&["get","org.gnome.desktop.interface","color-scheme"]).await;
    let is_dark = theme_is_dark(&scheme) || gtk.contains("dark");
    // Auto-sync Kvantum + Plasma Desktop Theme to match color scheme
    let (kv, pt) = get_kv_pt(&cfg, is_dark);
    run("kvantummanager",&["--set",&kv]).await;
    run("plasma-apply-desktoptheme",&[&pt]).await;
    apply_gtk_theme(&cfg, is_dark).await;
    apply_lockscreen_theme(is_dark).await;
    format!(r#"{{"scheme":"{}","is_dark":{}}}"#,esc(&scheme),is_dark)
}

// ── Theme config helpers ─────────────────────────────────────────────────
fn get_kv_pt(cfg: &serde_json::Value, is_dark: bool) -> (String, String) {
    let kv = if is_dark {
        cfg.get("KvantumDark").and_then(|v|v.as_str()).unwrap_or("bookos-dark-blue").to_string()
    } else {
        cfg.get("KvantumLight").and_then(|v|v.as_str()).unwrap_or("bookos-light-blue").to_string()
    };
    let pt = if is_dark {
        cfg.get("PlasmaDark").and_then(|v|v.as_str()).unwrap_or("bookos-dark").to_string()
    } else {
        cfg.get("PlasmaLight").and_then(|v|v.as_str()).unwrap_or("bookos-light").to_string()
    };
    (kv, pt)
}
async fn apply_lockscreen_theme(is_dark: bool) {
    let theme = if is_dark { "BookOS Dark" } else { "BookOS Light" };
    run("kwriteconfig6",&["--file","kscreenlockerrc","--group","Greeter","--key","theme",theme]).await;
}
async fn apply_gtk_theme(cfg: &serde_json::Value, is_dark: bool) {
    let gtk = if is_dark {
        cfg.get("GtkDark").and_then(|v|v.as_str()).unwrap_or("BookOS-Dark").to_string()
    } else {
        cfg.get("GtkLight").and_then(|v|v.as_str()).unwrap_or("BookOS-Light").to_string()
    };
    let scheme = if is_dark { "prefer-dark" } else { "prefer-light" };
    run("gsettings",&["set","org.gnome.desktop.interface","gtk-theme",&gtk]).await;
    run("gsettings",&["set","org.gnome.desktop.interface","color-scheme",scheme]).await;
}
#[tauri::command] fn get_available_kvantum_themes() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{}/.config/Kvantum", home);
    let mut themes: Vec<String> = fs::read_dir(&path).ok()
        .map(|entries| entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect())
        .unwrap_or_default();
    themes.sort();
    let active = fs::read_to_string(format!("{}/.config/Kvantum/kvantum.kvconfig", home))
        .unwrap_or_default()
        .lines()
        .find_map(|l| l.strip_prefix("theme=").map(|v| v.trim().to_string()))
        .unwrap_or_default();
    let items: Vec<String> = themes.iter()
        .map(|n| format!(r#"{{"name":"{}","active":{}}}"#, esc(n), *n == active))
        .collect();
    format!("[{}]", items.join(","))
}
#[tauri::command] fn get_available_plasma_themes() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut themes = std::collections::BTreeSet::new();
    for base in &[
        format!("{}/.local/share/plasma/desktoptheme", home),
        "/usr/share/plasma/desktoptheme".to_string(),
    ] {
        if let Ok(entries) = fs::read_dir(base) {
            for e in entries.filter_map(|e| e.ok()) {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Ok(name) = e.file_name().into_string() {
                        if !name.starts_with('.') { themes.insert(name); }
                    }
                }
            }
        }
    }
    let active = fs::read_to_string(format!("{}/.config/plasmarc", home))
        .unwrap_or_default()
        .lines()
        .find_map(|l| l.strip_prefix("name=").map(|v| v.trim().to_string()))
        .unwrap_or_default();
    let items: Vec<String> = themes.iter()
        .map(|n| format!(r#"{{"name":"{}","active":{}}}"#, esc(n), *n == active))
        .collect();
    format!("[{}]", items.join(","))
}
#[tauri::command] fn get_style_themes() -> String {
    let cfg = load_bookos_settings();
    let kv_dark  = cfg.get("KvantumDark").and_then(|v|v.as_str()).unwrap_or("bookos-dark-blue");
    let kv_light = cfg.get("KvantumLight").and_then(|v|v.as_str()).unwrap_or("bookos-light-blue");
    let pt_dark  = cfg.get("PlasmaDark").and_then(|v|v.as_str()).unwrap_or("bookos-dark");
    let pt_light = cfg.get("PlasmaLight").and_then(|v|v.as_str()).unwrap_or("bookos-light");
    format!(r#"{{"kvantum_dark":"{}","kvantum_light":"{}","plasma_dark":"{}","plasma_light":"{}"}}"#,
        esc(kv_dark), esc(kv_light), esc(pt_dark), esc(pt_light))
}
#[tauri::command] async fn set_style_themes(
    kvantum_dark: String, kvantum_light: String,
    plasma_dark: String,  plasma_light: String,
) -> String {
    let mut cfg = load_bookos_settings();
    cfg["KvantumDark"]  = serde_json::Value::String(kvantum_dark.clone());
    cfg["KvantumLight"] = serde_json::Value::String(kvantum_light.clone());
    cfg["PlasmaDark"]   = serde_json::Value::String(plasma_dark.clone());
    cfg["PlasmaLight"]  = serde_json::Value::String(plasma_light.clone());
    save_bookos_settings(&cfg);
    // Apply immediately if we know current mode
    if let Some(is_dark) = cfg.get("ThemeIsDark").and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true"))) {
        let (kv, pt) = get_kv_pt(&cfg, is_dark);
        run("kvantummanager",&["--set",&kv]).await;
        run("plasma-apply-desktoptheme",&[&pt]).await;
        apply_gtk_theme(&cfg, is_dark).await;
        apply_lockscreen_theme(is_dark).await;
    }
    r#"{"ok":true}"#.into()
}

// ── KDE Control Station theme integration ────────────────────────────────
#[tauri::command] fn get_kde_light_dark_themes() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let cfg = format!("{}/.config/plasma-org.kde.plasma.desktop-appletsrc", home);
    let content = fs::read_to_string(&cfg).unwrap_or_default();
    // Find key=value anywhere in the file (KCS settings appear only once)
    let find = |key: &str| -> String {
        content.lines()
            .find(|l| l.trim_start().starts_with(&format!("{}=", key)))
            .and_then(|l| l.find('=').map(|i| l[i+1..].trim().to_string()))
            .unwrap_or_default()
    };
    let prefer_global = find("preferChangeGlobalTheme") == "true";
    let light = if prefer_global { find("lightGlobalTheme") } else { find("lightTheme") };
    let dark  = if prefer_global { find("darkGlobalTheme")  } else { find("darkTheme")  };
    format!(r#"{{"light":"{}","dark":"{}","is_global":{}}}"#, esc(&light), esc(&dark), prefer_global)
}
#[tauri::command] async fn apply_kde_theme(name: String, is_global: bool) -> String {
    if is_global {
        run("plasma-apply-lookandfeel",&["--apply",&name]).await;
    } else {
        run("plasma-apply-colorscheme",&[&name]).await;
    }
    let is_dark = theme_is_dark(&name);
    run("gsettings",&["set","org.gnome.desktop.interface","color-scheme",if is_dark{"prefer-dark"}else{"prefer-light"}]).await;
    // Guardar en JSON para que persista entre reinicios de la app
    let mut cfg = load_bookos_settings();
    cfg["ThemeIsDark"] = serde_json::Value::Bool(is_dark);
    cfg["ThemeScheme"] = serde_json::Value::String(name);
    save_bookos_settings(&cfg);
    // Switch Kvantum + Plasma Desktop Theme + GTK + Lockscreen
    let (kv, pt) = get_kv_pt(&cfg, is_dark);
    run("kvantummanager",&["--set",&kv]).await;
    run("plasma-apply-desktoptheme",&[&pt]).await;
    apply_gtk_theme(&cfg, is_dark).await;
    apply_lockscreen_theme(is_dark).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn get_available_themes() -> String {
    let list = run("plasma-apply-colorscheme",&["--list-schemes"]).await;
    let current = run("kreadconfig6",&["--file","kdeglobals","--group","General","--key","ColorScheme"]).await;
    // Skip any line that doesn't look like a theme name (contains spaces at start = theme)
    let themes: Vec<String> = list.lines().filter_map(|l| {
        // Theme lines are indented with spaces, optionally with " * " for active
        if !l.starts_with(' ') && !l.starts_with('*') { return None; }
        let trimmed = l.trim().trim_start_matches("* ").trim_start_matches('*').trim();
        if trimmed.is_empty() || trimmed.len() < 3 { return None; }
        // Skip description lines (contain spaces in the middle typical of sentences)
        if trimmed.contains("sistema") || trimmed.contains("system") || trimmed.contains("siguientes") || trimmed.contains("following") || trimmed.contains("esquemas") || trimmed.contains("schemes") { return None; }
        let name = trimmed.to_string();
        let is_dark = theme_is_dark(&name);
        let active = name == current;
        Some(format!(r#"{{"name":"{}","is_dark":{},"active":{}}}"#,esc(&name),is_dark,active))
    }).collect();
    format!("[{}]",themes.join(","))
}
#[tauri::command] async fn set_color_scheme(scheme: String) -> String {
    run("plasma-apply-colorscheme",&[&scheme]).await;
    let sl = scheme.to_lowercase();
    let is_dark = sl.contains("dark") || sl.contains("mocha") || sl.contains("frappe") || sl.contains("macchiato") || sl.contains("noir") || sl.contains("night") || sl.contains("midnight") || sl.contains("dracula") || sl.contains("gruvbox") || sl.contains("nord") || sl.contains("tokyo") || sl.contains("onedark") || sl.contains("heimdal") || sl.contains("emerald-smooth") || sl.contains("cachyos-dark");
    let mut cfg = load_bookos_settings();
    cfg["ThemeIsDark"] = serde_json::Value::Bool(is_dark);
    cfg["ThemeScheme"] = serde_json::Value::String(scheme.clone());
    save_bookos_settings(&cfg);
    // Switch Kvantum + Plasma Desktop Theme + GTK + Lockscreen
    let (kv, pt) = get_kv_pt(&cfg, is_dark);
    run("kvantummanager",&["--set",&kv]).await;
    run("plasma-apply-desktoptheme",&[&pt]).await;
    apply_gtk_theme(&cfg, is_dark).await;
    apply_lockscreen_theme(is_dark).await;
    r#"{"ok":true}"#.into()
}

// ── Notifications ────────────────────────────────────────────────────────
#[tauri::command] async fn get_dnd_status() -> String {
    let d = run("kreadconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until"]).await;
    format!(r#"{{"dnd_active":{}}}"#,!d.is_empty())
}
#[tauri::command] async fn toggle_dnd(enable: bool) -> String {
    if enable { run("kwriteconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until","2099-12-31T23:59:59"]).await; }
    else { run("kwriteconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until",""]).await; }
    r#"{"ok":true}"#.into()
}

// ── Lock Screen ──────────────────────────────────────────────────────────
#[tauri::command] async fn get_lock_timeout() -> String {
    let t = run("kreadconfig6",&["--file","kscreenlockerrc","--group","Daemon","--key","Timeout"]).await;
    format!(r#"{{"timeout":{}}}"#,if t.is_empty(){"5".into()}else{t})
}
#[tauri::command] async fn get_autostart_bookos() -> String {
    let p = format!("{}/.config/autostart/bookos-settings.desktop", std::env::var("HOME").unwrap_or_default());
    format!(r#"{{"enabled":{}}}"#, std::path::Path::new(&p).exists())
}
#[tauri::command] async fn toggle_autostart_bookos(enable: bool) -> String {
    let p = format!("{}/.config/autostart/bookos-settings.desktop", std::env::var("HOME").unwrap_or_default());
    if enable {
        let _ = std::fs::create_dir_all(format!("{}/.config/autostart", std::env::var("HOME").unwrap_or_default()));
        let desktop = "[Desktop Entry]\nName=BookOS Settings\nExec=bookos-settings --hidden\nIcon=preferences-system\nType=Application\nNoDisplay=true\nX-KDE-autostart-phase=1\n";
        let _ = std::fs::write(&p, desktop);
    } else {
        let _ = std::fs::remove_file(&p);
    }
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_lock_timeout(minutes: u32) -> String {
    run("kwriteconfig6",&["--file","kscreenlockerrc","--group","Daemon","--key","Timeout",&minutes.to_string()]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn check_fingerprint() -> String {
    let user = run("whoami",&[]).await;
    let r = run("fprintd-list",&[&user]).await;
    let available = !r.is_empty() && !r.contains("No devices") && !r.contains("not found");
    let enrolled = r.contains("finger") && !r.contains("no fingers");
    format!(r#"{{"available":{},"enrolled":{}}}"#,available,enrolled)
}
#[tauri::command] async fn enroll_fingerprint(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let user = run("whoami",&[]).await;
    let mut child = Command::new("fprintd-enroll")
        .arg(&user)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut stages: u32 = 0;
    let mut full_output = String::new();

    while let Ok(Some(line)) = reader.next_line().await {
        full_output.push_str(&line);
        full_output.push('\n');
        if line.contains("stage-passed") || line.contains("enroll-stage-passed") {
            stages += 1;
            let _ = app.emit("fp-progress", serde_json::json!({"stage": stages}));
        }
        if line.contains("enroll-completed") {
            stages += 1;
            let _ = app.emit("fp-progress", serde_json::json!({"stage": stages, "done": true}));
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let ok = full_output.contains("enroll-completed") || status.success();
    Ok(format!(r#"{{"ok":{},"output":"{}","stages":{}}}"#, ok, esc(&full_output), stages))
}

// ── Updates (separated: system, flatpak) ─────────────────────────────────
#[tauri::command] async fn check_system_updates() -> Result<String, String> {
    let u = run("checkupdates",&[]).await;
    let pkgs: Vec<String> = u.lines().filter(|l| !l.is_empty()).take(100).map(|l| {
        let p: Vec<&str> = l.split_whitespace().collect();
        format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#,esc(p.first().unwrap_or(&"")),esc(p.get(1).unwrap_or(&"")),esc(p.last().unwrap_or(&"")))
    }).collect();
    Ok(format!(r#"{{"count":{},"packages":[{}]}}"#,pkgs.len(),pkgs.join(",")))
}
#[tauri::command] async fn check_aur_updates() -> Result<String, String> {
    let u = run("paru",&["-Qua"]).await;
    let pkgs: Vec<String> = u.lines().filter(|l| !l.is_empty()).take(100).map(|l| {
        let p: Vec<&str> = l.split_whitespace().collect();
        format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#,esc(p.first().unwrap_or(&"")),esc(p.get(1).unwrap_or(&"")),esc(p.last().unwrap_or(&"")))
    }).collect();
    Ok(format!(r#"{{"count":{},"packages":[{}]}}"#,pkgs.len(),pkgs.join(",")))
}
#[tauri::command] async fn check_flatpak_updates() -> Result<String, String> {
    let u = run("flatpak",&["remote-ls","--updates","--columns=application,version"]).await;
    let pkgs: Vec<String> = u.lines().filter(|l| !l.is_empty()).map(|l| {
        let p: Vec<&str> = l.split('\t').collect();
        format!(r#"{{"name":"{}","version":"{}"}}"#,esc(p.first().unwrap_or(&"")),esc(p.get(1).unwrap_or(&"")))
    }).collect();
    Ok(format!(r#"{{"count":{},"packages":[{}]}}"#,pkgs.len(),pkgs.join(",")))
}

#[tauri::command] async fn run_system_update(packages: Vec<String>) -> Result<String, String> {
    let mut args = vec!["--hold".to_string(), "-e".to_string(), "paru".to_string(), "-Syu".to_string(), "--noconfirm".to_string()];
    if !packages.is_empty() {
        args = vec!["--hold".to_string(), "-e".to_string(), "paru".to_string(), "-S".to_string(), "--noconfirm".to_string()];
        args.extend(packages);
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = run("konsole", &args_ref).await;
    Ok(format!(r#"{{"ok":true,"output":"{}"}}"#, esc(&output)))
}

// Arranca la actualización en background y retorna inmediatamente.
// Usa paru -Syu para actualizar tanto paquetes oficiales como AUR.
// La contraseña se envía por stdin; paru la reenvía a sudo mediante --sudoflags=-S.
#[tauri::command] fn run_pacman_update_silent(password: String, state: tauri::State<UpdateState>) -> String {
    use std::io::Write;
    {
        let mut s = state.lock().unwrap();
        if s.running { return r#"{"ok":false,"error":"Ya hay una actualización en curso"}"#.into(); }
        *s = UpdateProgress { running: true, done: false, ok: false, output: "Iniciando...".into(), child_pid: None };
    }
    let state_clone = Arc::clone(&state);
    std::thread::spawn(move || {
        // Try paru first (handles both official + AUR). Fall back to sudo pacman if paru isn't installed.
        let use_paru = StdCommand::new("which").arg("paru").output()
            .map(|o| o.status.success()).unwrap_or(false);

        let child = if use_paru {
            StdCommand::new("paru")
                .args(["-Syu", "--noconfirm", "--sudoflags", "-S"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        } else {
            StdCommand::new("sudo")
                .args(["-k", "-S", "pacman", "-Syu", "--noconfirm"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        };

        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let mut s = state_clone.lock().unwrap();
                *s = UpdateProgress { running: false, done: true, ok: false, output: e.to_string(), child_pid: None };
                return;
            }
        };
        // Save child PID so cancel_update can kill it
        { let mut s = state_clone.lock().unwrap(); s.child_pid = Some(child.id()); }
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{}\n", password).as_bytes());
        }
        // Stream stdout lines into shared state so the UI can show live progress
        use std::io::BufRead;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let state_out = Arc::clone(&state_clone);
        let stdout_thread = stdout.map(|s| {
            let state_out = Arc::clone(&state_out);
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(s);
                for line in reader.lines().flatten() {
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        if let Ok(mut st) = state_out.lock() {
                            st.output = trimmed;
                        }
                    }
                }
            })
        });
        // Drain stderr (needed to avoid blocking; we don't surface it live)
        let stderr_thread = stderr.map(|s| std::thread::spawn(move || {
            let _ = std::io::BufReader::new(s).lines().count();
        }));
        let status = child.wait();
        if let Some(t) = stdout_thread { let _ = t.join(); }
        if let Some(t) = stderr_thread { let _ = t.join(); }
        let ok = status.map(|s| s.success()).unwrap_or(false);
        {
            let cur_out = state_clone.lock().unwrap().output.clone();
            let ok_final = ok
                || cur_out.contains("nothing to do")
                || cur_out.contains("there is nothing to do")
                || cur_out.contains("No hay nada que hacer");
            let mut s = state_clone.lock().unwrap();
            *s = UpdateProgress { running: false, done: true, ok: ok_final, output: cur_out, child_pid: None };
        }
    });
    r#"{"ok":true,"started":true}"#.into()
}

#[tauri::command] fn get_update_progress(state: tauri::State<UpdateState>) -> String {
    let s = state.lock().unwrap();
    format!(r#"{{"running":{},"done":{},"ok":{},"output":"{}"}}"#,
        s.running, s.done, s.ok, esc(&s.output))
}

/// Cancels a running update by killing the child process (paru/pacman).
#[tauri::command] fn cancel_update(state: tauri::State<UpdateState>) -> String {
    let pid = { state.lock().unwrap().child_pid };
    if let Some(pid) = pid {
        // Kill child processes first, then the main process
        let _ = StdCommand::new("pkill").args(["-TERM", "-P", &pid.to_string()]).output();
        let _ = StdCommand::new("kill").args(["-TERM", &pid.to_string()]).output();
    }
    let mut s = state.lock().unwrap();
    *s = UpdateProgress { running: false, done: true, ok: false, output: "Cancelado por el usuario".into(), child_pid: None };
    r#"{"ok":true}"#.into()
}

// Get per-app CPU/power stats using ps
#[tauri::command] fn get_app_power_usage() -> String {
    // Known system/daemon process name prefixes (lowercase)
    let system_procs: &[&str] = &[
        "kwin_wayland","kwin_x11","plasmashell","systemd","dbus-daemon","dbus-broker",
        "xwayland","krunner","polkit-kde-au","gsd-","gnome-","akonadi",
        "webkitwebproces","webkitnetworkpro","bwrap","dconf","pulseaudio","pipewire",
        "wireplumber","xdg-","at-spi","ibus","fcitx","udisksd","udevd","bluetoothd",
        "networkmanager","wpa_supplicant","thermald","tlp","irqbalance","alsactl",
        "kaccess","kded","ksystemstats","ksmserver","kscreenlocker","kscreen","baloo",
        "akonadiserver","mysqld","gvfsd","gvfs-","pcscd","upowerd","logind",
        "accounts-daemon","colord","cups","avahi","chronyd","sshd","containerd",
        "dockerd","sh","bash","fish","zsh","cat","grep","sed","awk","ps","top",
        "htop","less","more","tail","head","cargo","rustc","cc","ld","bookos-settings",
        "sd-pam","(sd-pam)","[kworker","[kswapd","[migration","[rcu_","[watchdog",
        "krb5kdc","sssd","gssproxy","packagekitd","snapd","flatpak-session",
        "xdg-document","xdg-permission","xdg-desktop-po",
    ];
    let icon_dirs = [
        "/usr/share/pixmaps",
        "/usr/share/icons/hicolor/48x48/apps",
        "/usr/share/icons/hicolor/32x32/apps",
        "/usr/share/icons/hicolor/scalable/apps",
        "/usr/share/icons/breeze/apps/48",
    ];
    let icon_exts = ["png", "svg", "xpm"];

    let out = StdCommand::new("ps")
        .args(["--no-headers", "-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let apps: Vec<String> = out.lines()
        .filter(|l| !l.trim().is_empty())
        .take(40)
        .filter_map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            let name = p.get(1).unwrap_or(&"").to_string();
            let cpu = p.get(2).unwrap_or(&"0").to_string();
            let mem = p.get(3).unwrap_or(&"0").to_string();
            if name.is_empty() { return None; }

            let nl = name.to_lowercase();
            let is_sys = name.starts_with('(') || name.starts_with('[') ||
                system_procs.iter().any(|s| nl == *s || nl.starts_with(s));

            // Find icon in common directories
            let mut icon = String::new();
            'outer: for dir in &icon_dirs {
                for ext in &icon_exts {
                    for candidate in [name.as_str(), &nl] {
                        let path = format!("{}/{}.{}", dir, candidate, ext);
                        if std::path::Path::new(&path).exists() {
                            icon = path;
                            break 'outer;
                        }
                    }
                }
            }

            Some(format!(r#"{{"name":"{}","cpu":"{}","mem":"{}","is_system":{},"icon":"{}"}}"#,
                esc(&name), esc(&cpu), esc(&mem), is_sys, esc(&icon)))
        }).collect();
    format!("[{}]", apps.join(","))
}

// Get SDDM themes
#[tauri::command] fn get_sddm_themes() -> String {
    let dirs = ["/usr/share/sddm/themes", "/usr/local/share/sddm/themes"];
    let mut themes: Vec<String> = Vec::new();
    for dir in &dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.is_empty() {
                    themes.push(format!(r#""{}""#, esc(&name)));
                }
            }
        }
    }
    // Get current SDDM theme from /etc/sddm.conf or /etc/sddm.conf.d/
    let conf = fs::read_to_string("/etc/sddm.conf").unwrap_or_default();
    let current = conf.lines()
        .find(|l| l.trim().starts_with("Current="))
        .map(|l| l.split('=').nth(1).unwrap_or("").trim().to_string())
        .unwrap_or_default();
    format!(r#"{{"themes":[{}],"current":"{}"}}"#, themes.join(","), esc(&current))
}

// Set SDDM theme (requires sudo)
#[tauri::command] fn set_sddm_theme(theme: String, password: String) -> String {
    use std::io::Write;
    let conf = format!("[Theme]\nCurrent={}\n", theme);
    // Write to /etc/sddm.conf.d/bookos.conf via sudo tee
    let mut child = StdCommand::new("sudo")
        .args(["-S", "tee", "/etc/sddm.conf.d/bookos-theme.conf"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().expect("spawn failed");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n{}", password, conf).as_bytes());
    }
    let output = child.wait_with_output().unwrap();
    format!(r#"{{"ok":{}}}"#, output.status.success())
}

// Get BookOS SDDM theme config (variant, background, bgImage)
#[tauri::command] fn get_sddm_config() -> String {
    let conf = fs::read_to_string("/usr/share/sddm/themes/bookos/theme.conf").unwrap_or_default();
    let mut variant = "dark".to_string();
    let mut background = "solid".to_string();
    let mut bg_image = String::new();
    for line in conf.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("variant=")    { variant    = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("background=") { background = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("bgImage=")    { bg_image   = v.trim().to_string(); }
    }
    format!(r#"{{"variant":"{}","background":"{}","bgImage":"{}"}}"#,
        esc(&variant), esc(&background), esc(&bg_image))
}

// Set BookOS SDDM theme config (requires sudo)
#[tauri::command] async fn set_sddm_config(
    variant: String, background: String, bg_image: String, password: String
) -> String {
    use tokio::io::AsyncWriteExt;
    let conf = format!("[General]\nvariant={}\nbackground={}\nbgImage={}\n",
        variant, background, bg_image);
    let mut child = Command::new("sudo")
        .args(["-S", "tee", "/usr/share/sddm/themes/bookos/theme.conf"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().expect("spawn failed");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n{}", password, conf).as_bytes()).await;
    }
    let output = child.wait_with_output().await.unwrap();
    format!(r#"{{"ok":{}}}"#, output.status.success())
}

// Get digital wellbeing / app usage (reads from bookos usage log if available)
#[tauri::command] fn get_app_usage() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let log = format!("{}/.local/share/bookos/app_usage.json", home);
    fs::read_to_string(&log).unwrap_or_else(|_| "[]".into())
}

#[tauri::command] async fn run_flatpak_update() -> Result<String, String> {
    let output = run("flatpak", &["update", "-y"]).await;
    Ok(format!(r#"{{"ok":true,"output":"{}"}}"#, esc(&output)))
}

// ── Locale ───────────────────────────────────────────────────────────────
#[tauri::command] async fn get_locale_info() -> String {
    let s = run("localectl",&["status"]).await;
    let locale = s.lines().find(|l| l.contains("LANG=")).map(|l| l.split('=').last().unwrap_or("").trim().to_string()).unwrap_or_default();
    let keymap = s.lines().find(|l| l.contains("X11 Layout")).map(|l| l.split(':').last().unwrap_or("").trim().to_string()).unwrap_or_default();
    format!(r#"{{"locale":"{}","keymap":"{}"}}"#,esc(&locale),esc(&keymap))
}
#[tauri::command] async fn get_available_locales() -> String {
    let l = run("localectl",&["list-locales"]).await;
    let locs: Vec<String> = l.lines().filter(|l| l.contains("UTF-8")||l.contains("utf8")).take(80).map(|l| format!(r#""{}""#,esc(l.trim()))).collect();
    format!("[{}]",locs.join(","))
}
#[tauri::command] async fn set_locale(locale: String) -> String { run("localectl",&["set-locale",&format!("LANG={}",locale)]).await; r#"{"ok":true}"#.into() }
#[tauri::command] async fn get_available_keymaps() -> String {
    let l = run("localectl",&["list-x11-keymap-layouts"]).await;
    let maps: Vec<String> = l.lines().take(150).map(|l| format!(r#""{}""#,esc(l.trim()))).collect();
    format!("[{}]",maps.join(","))
}
#[tauri::command] async fn set_keymap(layout: String) -> String { run("localectl",&["set-x11-keymap",&layout]).await; r#"{"ok":true}"#.into() }

// ── Scheduled Theme ──────────────────────────────────────────────────────
#[tauri::command] fn get_theme_schedule() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = format!("{}/.config/bookos/settings.json", home);
    let cfg: serde_json::Value = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
    let enabled = cfg.get("theme_schedule_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let light_time = cfg.get("theme_light_time").and_then(|v| v.as_str()).unwrap_or("07:00").to_string();
    let dark_time = cfg.get("theme_dark_time").and_then(|v| v.as_str()).unwrap_or("20:00").to_string();
    let light_theme = cfg.get("theme_light").and_then(|v| v.as_str()).unwrap_or("BookOS Light").to_string();
    let dark_theme = cfg.get("theme_dark").and_then(|v| v.as_str()).unwrap_or("BookOS Dark").to_string();
    format!(r#"{{"enabled":{},"light_time":"{}","dark_time":"{}","light_theme":"{}","dark_theme":"{}"}}"#,
        enabled,esc(&light_time),esc(&dark_time),esc(&light_theme),esc(&dark_theme))
}
#[tauri::command] fn set_theme_schedule(enabled: bool, light_time: String, dark_time: String, light_theme: String, dark_theme: String) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.config/bookos", home);
    let _ = fs::create_dir_all(&dir);
    let p = format!("{}/settings.json", dir);
    let mut cfg: serde_json::Value = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
    cfg["theme_schedule_enabled"] = serde_json::json!(enabled);
    cfg["theme_light_time"] = serde_json::json!(light_time);
    cfg["theme_dark_time"] = serde_json::json!(dark_time);
    cfg["theme_light"] = serde_json::json!(light_theme);
    cfg["theme_dark"] = serde_json::json!(dark_theme);
    let _ = fs::write(&p, serde_json::to_string_pretty(&cfg).unwrap_or_default());
    r#"{"ok":true}"#.into()
}

// ── Maintenance ────────────────────────────────────────────────────────
#[tauri::command] async fn run_maintenance(target: String) -> String {
    let r = match target.as_str() {
        "flatpak" => run("flatpak", &["uninstall", "--unused", "-y"]).await,
        "packages" => run("paru", &["-Sc", "--noconfirm"]).await,
        "cache" => {
            let home = std::env::var("HOME").unwrap_or_default();
            run("rm", &["-rf", &format!("{}/.cache/thumbnails/*", home)]).await
        },
        _ => "Invalid target".to_string(),
    };
    format!(r#"{{"ok":true,"output":"{}"}}"#, esc(&r))
}

#[tauri::command] async fn setup_polkit_rules() -> String {
    let rule = r#"polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.policykit.exec" && 
        action.lookup("program") == "/usr/bin/bash" && 
        subject.isInGroup("power")) {
        return polkit.Result.YES;
    }
});"#;
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new("pkexec")
        .args(["tee", "/etc/polkit-1/rules.d/51-bookos-hw.rules"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn().unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(rule.as_bytes()).await;
    }
    let _ = child.wait_with_output().await;
    r#"{"ok":true}"#.into()
}

// ── KWin Effects ───────────────────────────────────────────────────────
#[tauri::command] async fn get_kwin_effects() -> String {
    let blur_t = run("kreadconfig6", &["--file", "kwinrc", "--group", "Plugins", "--key", "blurEnabled"]);
    let wobbly_t = run("kreadconfig6", &["--file", "kwinrc", "--group", "Plugins", "--key", "wobblywindowsEnabled"]);
    let magic_t = run("kreadconfig6", &["--file", "kwinrc", "--group", "Plugins", "--key", "magiclampEnabled"]);
    
    let (blur, wobbly, magic) = tokio::join!(blur_t, wobbly_t, magic_t);
    
    format!(r#"{{"blur":{},"wobbly":{},"magic":{}}}"#, blur == "true", wobbly == "true", magic == "true")
}
#[tauri::command] async fn toggle_kwin_effect(effect: String, enable: bool) -> String {
    let key = match effect.as_str() {
        "blur" => "blurEnabled",
        "wobbly" => "wobblywindowsEnabled",
        "magic" => "magiclampEnabled",
        _ => return r#"{"ok":false}"#.into(),
    };
    run("kwriteconfig6", &["--file", "kwinrc", "--group", "Plugins", "--key", key, if enable { "true" } else { "false" }]).await;
    run("qdbus", &["org.kde.KWin", "/KWin", "reconfigure"]).await;
    r#"{"ok":true}"#.into()
}

/// Fix cursor feeling laggy/low-Hz under KWin Wayland.
/// - Forces hardware cursor (bypasses compositor latency for cursor rendering)
/// - Sets MaxFPS to 0 (unlimited, vsync-driven) so KWin doesn't cap frame delivery
/// - Enables unredirect for fullscreen to reduce compositing overhead
#[tauri::command] async fn fix_cursor_hz() -> String {
    // Hardware cursor — rendered directly by the GPU scanout, not composited
    run("kwriteconfig6", &["--file","kwinrc","--group","Compositing","--key","HiddenPreviews","5"]).await;
    // Allow KWin to deliver frames as fast as the display allows (no artificial cap)
    run("kwriteconfig6", &["--file","kwinrc","--group","Compositing","--key","MaxFPS","0"]).await;
    // Latency policy: prefer low latency over throughput
    run("kwriteconfig6", &["--file","kwinrc","--group","Compositing","--key","LatencyPolicy","Low"]).await;
    // Apply without restarting KWin
    run("qdbus6", &["org.kde.KWin","/KWin","reconfigure"]).await;
    r#"{"ok":true}"#.into()
}

#[tauri::command] async fn get_cursor_fix_status() -> String {
    let latency_t = run("kreadconfig6",&["--file","kwinrc","--group","Compositing","--key","LatencyPolicy"]);
    let maxfps_t  = run("kreadconfig6",&["--file","kwinrc","--group","Compositing","--key","MaxFPS"]);
    let (latency, maxfps) = tokio::join!(latency_t, maxfps_t);
    let enabled = latency == "Low" || maxfps == "0";
    format!(r#"{{"enabled":{}}}"#, enabled)
}

// ── Input Devices ──────────────────────────────────────────────────────
#[tauri::command] async fn get_input_devices() -> String {
    let accel_t = run("kreadconfig6", &["--file", "kcminputrc", "--group", "Mouse", "--key", "Acceleration"]);
    let tap_t = run("kreadconfig6", &["--file", "kcminputrc", "--group", "Touchpad", "--key", "Tapping"]);
    let nat_t = run("kreadconfig6", &["--file", "kcminputrc", "--group", "Touchpad", "--key", "NaturalScrolling"]);
    
    let (accel, tap, nat) = tokio::join!(accel_t, tap_t, nat_t);
    
    format!(r#"{{"accel":"{}","tap":{},"natural":{}}}"#, esc(&accel), tap == "true", nat == "true")
}
#[tauri::command] async fn set_input_setting(group: String, key: String, value: String) -> String {
    run("kwriteconfig6", &["--file", "kcminputrc", "--group", &group, "--key", &key, &value]).await;
    r#"{"ok":true}"#.into()
}

// ── Firewall ───────────────────────────────────────────────────────────
#[tauri::command] async fn get_firewall_status() -> String {
    let s = run("ufw", &["status"]).await;
    format!(r#"{{"active":{},"raw":"{}"}}"#, s.contains("active") && !s.contains("inactive"), esc(&s))
}
// Note: toggle_firewall was removed here -> handled by run_sudo_command from frontend

#[tauri::command] async fn run_sudo_command(cmd: String, args: Vec<String>, password: String) -> String {
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new("sudo")
        .arg("-k").arg("-S")
        .arg(&cmd)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().expect("failed to spawn sudo");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", password).as_bytes()).await;
    }
    let output = child.wait_with_output().await.unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    format!(r#"{{"ok":{},"stdout":"{}","stderr":"{}"}}"#, output.status.success(), esc(&stdout), esc(&stderr))
}

// ── Wallpaper ─────────────────────────────────────────────────────────
#[tauri::command] fn get_wallpapers() -> String {
    let mut wallpapers: Vec<String> = Vec::new();
    let dirs = ["/usr/share/wallpapers", &format!("{}/.local/share/wallpapers", std::env::var("HOME").unwrap_or_default())];
    for dir in &dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                // KDE wallpapers are directories with contents/images/
                let img_dir = path.join("contents").join("images");
                if img_dir.is_dir() {
                    if let Ok(imgs) = fs::read_dir(&img_dir) {
                        // Get the highest resolution image
                        let mut best = String::new();
                        for img in imgs.flatten() {
                            let name = img.file_name().to_string_lossy().to_string();
                            if name.ends_with(".jpg") || name.ends_with(".png") {
                                if name > best || best.is_empty() { best = img.path().to_string_lossy().to_string(); }
                            }
                        }
                        if !best.is_empty() {
                            let wp_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            // Use screenshot.png as thumbnail if available
                            let thumb = path.join("contents").join("screenshot.png");
                            let thumb_str = if thumb.exists() { thumb.to_string_lossy().to_string() } else { best.clone() };
                            wallpapers.push(format!(r#"{{"name":"{}","path":"{}","thumbnail":"{}"}}"#, esc(&wp_name), esc(&best), esc(&thumb_str)));
                        }
                    }
                } else if path.is_file() {
                    let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    if ["jpg","jpeg","png","webp"].contains(&ext.as_str()) {
                        let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                        let p = path.to_string_lossy().to_string();
                        wallpapers.push(format!(r#"{{"name":"{}","path":"{}","thumbnail":"{}"}}"#, esc(&name), esc(&p), esc(&p)));
                    }
                }
            }
        }
    }
    // Also check ~/Imágenes and ~/Pictures
    let home = std::env::var("HOME").unwrap_or_default();
    for pic_dir in &[format!("{}/Imágenes", home), format!("{}/Pictures", home)] {
        if let Ok(entries) = fs::read_dir(pic_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    if ["jpg","jpeg","png","webp"].contains(&ext.as_str()) {
                        let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                        let p = path.to_string_lossy().to_string();
                        wallpapers.push(format!(r#"{{"name":"{}","path":"{}","thumbnail":"{}"}}"#, esc(&name), esc(&p), esc(&p)));
                    }
                }
            }
        }
    }
    format!("[{}]", wallpapers.join(","))
}
#[tauri::command] async fn get_current_wallpaper() -> String {
    let out = run("kreadconfig6", &["--file", "plasma-org.kde.plasma.desktop-appletsrc", "--group", "Containments", "--group", "1", "--group", "Wallpaper", "--group", "org.kde.image", "--group", "General", "--key", "Image"]).await;
    format!(r#"{{"path":"{}"}}"#, esc(&out.replace("file://", "")))
}
#[tauri::command] async fn set_wallpaper(path: String) -> String {
    run("plasma-apply-wallpaperimage", &[&path]).await;
    r#"{"ok":true}"#.into()
}

// ── Default Apps ──────────────────────────────────────────────────────
#[tauri::command] async fn get_default_apps() -> String {
    let browser = run("xdg-settings", &["get", "default-web-browser"]).await;
    let email = run("xdg-settings", &["get", "default-url-scheme-handler", "mailto"]).await;
    let fm_raw = run("xdg-mime", &["query", "default", "inode/directory"]).await;
    format!(r#"{{"browser":"{}","email":"{}","filemanager":"{}"}}"#, esc(&browser), esc(&email), esc(&fm_raw))
}
#[tauri::command] async fn open_mime_settings() -> String {
    run("xdg-open", &["settings://filetypes"]).await;
    // Fallback: open KDE systemsettings
    run("kcmshell6", &["filetypes"]).await;
    r#"{"ok":true}"#.into()
}

// ── BookOS Generic Settings ─────────────────────────────────────────────
// ── Accessibility / Display Scale ────────────────────────────────────────
#[tauri::command] async fn get_accessibility_settings() -> String {
    let scale = run("kreadconfig6",&["--file","kcmfonts","--group","General","--key","forceFontDPI","--default","0"]).await;
    let contrast = run("kreadconfig6",&["--file","kdeglobals","--group","KDE","--key","contrast","--default","5"]).await;
    let invert = run("kreadconfig6",&["--file","kwinrc","--group","Plugins","--key","invertEnabled","--default","false"]).await;
    let large_cursor = run("kreadconfig6",&["--file","kcminputrc","--group","Mouse","--key","cursorSize","--default","24"]).await;
    format!(r#"{{"font_dpi":"{}","contrast":"{}","invert":"{}","cursor_size":"{}"}}"#,
        esc(&scale), esc(&contrast), esc(&invert), esc(&large_cursor))
}
#[tauri::command] async fn set_font_scale(dpi: i32) -> String {
    run("kwriteconfig6",&["--file","kcmfonts","--group","General","--key","forceFontDPI",&dpi.to_string()]).await;
    run("qdbus6",&["org.kde.KWin","/KWin","reconfigure"]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_display_scale(scale: f32) -> String {
    let s = format!("{:.2}", scale);
    run("kwriteconfig6",&["--file","kdeglobals","--group","KScreen","--key","ScaleFactor",&s]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn toggle_invert_colors(enable: bool) -> String {
    run("kwriteconfig6",&["--file","kwinrc","--group","Plugins","--key","invertEnabled",if enable {"true"} else {"false"}]).await;
    run("qdbus6",&["org.kde.KWin","/KWin","reconfigure"]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_cursor_size(size: i32) -> String {
    run("kwriteconfig6",&["--file","kcminputrc","--group","Mouse","--key","cursorSize",&size.to_string()]).await;
    r#"{"ok":true}"#.into()
}

// ── Password change ──────────────────────────────────────────────────────
#[tauri::command] fn change_password(username: String, old_pwd: String, new_pwd: String) -> String {
    use std::io::Write;
    // Use chpasswd: feed "user:newpwd" via stdin, authenticated with sudo -S
    let mut child = StdCommand::new("sudo")
        .args(["-k", "-S", "--", "chpasswd"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().expect("spawn");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n{}:{}\n", old_pwd, esc(&username), esc(&new_pwd)).as_bytes());
    }
    let out = child.wait_with_output().unwrap();
    format!(r#"{{"ok":{}}}"#, out.status.success())
}

// ── Avatar change ────────────────────────────────────────────────────────
#[tauri::command] fn set_avatar(source_path: String) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dest = format!("{}/.face", home);
    match fs::copy(&source_path, &dest) {
        Ok(_) => r#"{"ok":true}"#.into(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string()))
    }
}

// ── Labs / Advanced features ─────────────────────────────────────────────
#[tauri::command] fn get_labs_settings() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = format!("{}/.config/bookos/settings.json", home);
    let cfg: serde_json::Value = fs::read_to_string(&p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    let get = |k: &str| cfg.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    format!(r#"{{"floating_taskbar":{},"transparency_effects":{},"adaptive_refresh":{},"smart_notifications":{},"experimental_widgets":{}}}"#,
        get("lab_floating_taskbar"), get("lab_transparency_effects"),
        get("lab_adaptive_refresh"), get("lab_smart_notifications"), get("lab_experimental_widgets"))
}
#[tauri::command] fn set_lab_setting(key: String, value: bool) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.config/bookos", home);
    let _ = fs::create_dir_all(&dir);
    let p = format!("{}/settings.json", dir);
    let mut c: serde_json::Value = fs::read_to_string(&p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    c[format!("lab_{}", key)] = serde_json::json!(value);
    let _ = fs::write(&p, serde_json::to_string_pretty(&c).unwrap_or_default());
    r#"{"ok":true}"#.into()
}

// ── WiFi forget network ──────────────────────────────────────────────────
#[tauri::command] async fn forget_wifi(ssid: String) -> String {
    let list = run("nmcli",&["-t","-f","NAME,UUID","connection","show"]).await;
    for line in list.lines() {
        let parts: Vec<&str> = line.splitn(2,':').collect();
        if parts.len()==2 && parts[0]==ssid {
            run("nmcli",&["connection","delete",parts[1]]).await;
            return r#"{"ok":true}"#.into();
        }
    }
    r#"{"ok":false}"#.into()
}

// ── WiFi network details (IP, gateway, DNS, MAC) ─────────────────────────
#[tauri::command] async fn get_wifi_details(_ssid: String) -> String {
    let dev_out = run("nmcli",&["-t","-f","DEVICE,TYPE,STATE","device"]).await;
    let iface = dev_out
        .lines()
        .find(|l| l.contains(":wifi:") && l.contains("connected"))
        .and_then(|l| l.split(':').next().map(|s| s.to_string()))
        .unwrap_or_else(|| "wlan0".to_string());
    let info = run("nmcli",&["-t","-f","IP4.ADDRESS,IP4.GATEWAY,IP4.DNS[1],GENERAL.HWADDR","device","show",&iface]).await;
    let mut ip = String::new(); let mut gateway = String::new();
    let mut dns = String::new(); let mut mac = String::new();
    for line in info.lines() {
        if let Some(v) = line.strip_prefix("IP4.ADDRESS[1]:") { ip = v.split('/').next().unwrap_or("").to_string(); }
        else if let Some(v) = line.strip_prefix("IP4.GATEWAY:") { gateway = v.to_string(); }
        else if let Some(v) = line.strip_prefix("IP4.DNS[1]:") { dns = v.to_string(); }
        else if let Some(v) = line.strip_prefix("GENERAL.HWADDR:") { mac = v.to_string(); }
    }
    format!(r#"{{"ip":"{}","gateway":"{}","dns":"{}","mac":"{}","iface":"{}"}}"#,
        esc(&ip),esc(&gateway),esc(&dns),esc(&mac),esc(&iface))
}

// ── Get WiFi saved password (tries without sudo, then with sudo) ──────────
#[tauri::command] async fn get_wifi_password(ssid: String, sudo_password: String) -> String {
    // Try unprivileged first (works if user is in right group)
    let out = run("nmcli",&["-s","-t","-f","802-11-wireless-security.psk","connection","show",&ssid]).await;
    if let Some(line) = out.lines().find(|l| l.starts_with("802-11-wireless-security.psk:")) {
        let psk = line.splitn(2,':').nth(1).unwrap_or("").to_string();
        if !psk.is_empty() {
            return format!(r#"{{"ok":true,"password":"{}","needs_auth":false}}"#,esc(&psk));
        }
    }
    if sudo_password.is_empty() {
        return r#"{"ok":false,"password":"","needs_auth":true}"#.into();
    }
    // Run with sudo -S (sync because it needs stdin piping)
    let mut child = match StdCommand::new("sudo")
        .args(["-k","-S","nmcli","-s","-t","-f","802-11-wireless-security.psk","connection","show",&ssid])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn() { Ok(c)=>c, Err(_)=>return r#"{"ok":false,"password":"","needs_auth":true}"#.into() };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write; let _ = stdin.write_all(format!("{}\n",sudo_password).as_bytes());
    }
    let output = match child.wait_with_output() { Ok(o)=>o, Err(_)=>return r#"{"ok":false,"password":"","needs_auth":true}"#.into() };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        let psk = stdout.lines()
            .find(|l| l.starts_with("802-11-wireless-security.psk:"))
            .map(|l| l.splitn(2,':').nth(1).unwrap_or("").to_string())
            .unwrap_or_default();
        format!(r#"{{"ok":true,"password":"{}","needs_auth":false}}"#,esc(&psk))
    } else {
        r#"{"ok":false,"password":"","needs_auth":true,"error":"wrong_password"}"#.into()
    }
}

// ── Salud digital daemon helper ──────────────────────────────────────────
// Logs app focus events — called periodically from the frontend via a simple script
#[tauri::command] fn log_app_usage(app_name: String, minutes: f32) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.local/share/bookos", home);
    let _ = fs::create_dir_all(&dir);
    let p = format!("{}/app_usage.json", dir);
    let mut data: Vec<serde_json::Value> = fs::read_to_string(&p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let today = {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        // Simple day bucket: seconds / 86400
        t / 86400
    };
    // Find existing entry for today+app
    if let Some(entry) = data.iter_mut().find(|e| e["name"]==app_name && e["day"]==today) {
        let cur = entry["minutes"].as_f64().unwrap_or(0.0);
        entry["minutes"] = serde_json::json!(cur + minutes as f64);
    } else {
        data.push(serde_json::json!({"name": app_name, "minutes": minutes, "day": today}));
    }
    // Keep only last 7 days
    let cutoff = today.saturating_sub(7);
    data.retain(|e| e["day"].as_u64().unwrap_or(0) >= cutoff);
    let _ = fs::write(&p, serde_json::to_string(&data).unwrap_or_default());
    r#"{"ok":true}"#.into()
}

// ── Audio devices + per-app volume ──────────────────────────────────────
#[tauri::command] async fn get_audio_devices() -> String {
    let (sinks_short, sources_short, default_sink, default_source) = tokio::join!(
        run("pactl",&["list","short","sinks"]),
        run("pactl",&["list","short","sources"]),
        run("pactl",&["get-default-sink"]),
        run("pactl",&["get-default-source"])
    );
    // Parse sinks: "idx\tname\tdriver\tformat\tstate"
    let parse_short = |raw: &str, default: &str| -> Vec<serde_json::Value> {
        raw.lines().filter(|l| !l.is_empty()).map(|l| {
            let p: Vec<&str> = l.splitn(5,'\t').collect();
            let name = p.get(1).unwrap_or(&"").trim().to_string();
            let is_def = name == default.trim();
            serde_json::json!({"index": p.first().unwrap_or(&"0").trim().parse::<u32>().unwrap_or(0), "name": name, "state": p.get(4).unwrap_or(&"").trim().to_string(), "isDefault": is_def})
        }).collect()
    };
    let sinks = parse_short(&sinks_short, &default_sink);
    // Filter out monitor sources
    let sources: Vec<serde_json::Value> = parse_short(&sources_short, &default_source)
        .into_iter().filter(|s| !s["name"].as_str().unwrap_or("").ends_with(".monitor")).collect();
    format!(r#"{{"sinks":{},"sources":{},"defaultSink":"{}","defaultSource":"{}"}}"#,
        serde_json::to_string(&sinks).unwrap_or_default(),
        serde_json::to_string(&sources).unwrap_or_default(),
        esc(default_sink.trim()), esc(default_source.trim()))
}
#[tauri::command] async fn set_default_sink(name: String) -> String {
    run("pactl",&["set-default-sink",&name]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_default_source(name: String) -> String {
    run("pactl",&["set-default-source",&name]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn get_app_audio() -> String {
    let out = run("pactl",&["list","sink-inputs"]).await;
    let mut apps: Vec<serde_json::Value> = Vec::new();
    let mut cur_idx: Option<u32> = None;
    let mut cur_name = String::new();
    let mut cur_vol: u32 = 100;
    let mut cur_mute = false;
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("Sink Input #") {
            if let Some(idx) = cur_idx {
                if !cur_name.is_empty() {
                    apps.push(serde_json::json!({"index":idx,"name":cur_name,"volume":cur_vol,"muted":cur_mute}));
                }
            }
            cur_idx = t.split('#').nth(1).and_then(|s| s.parse().ok());
            cur_name = String::new(); cur_vol = 100; cur_mute = false;
        } else if t.starts_with("application.name") {
            if let Some(v) = t.split('"').nth(1) { cur_name = v.to_string(); }
        } else if t.starts_with("Mute:") {
            cur_mute = t.contains("yes");
        } else if t.starts_with("Volume:") {
            if let Some(pct) = t.split('/').nth(1) {
                cur_vol = pct.trim().trim_end_matches('%').parse().unwrap_or(100);
            }
        }
    }
    if let Some(idx) = cur_idx {
        if !cur_name.is_empty() { apps.push(serde_json::json!({"index":idx,"name":cur_name,"volume":cur_vol,"muted":cur_mute})); }
    }
    serde_json::to_string(&apps).unwrap_or_else(|_| "[]".into())
}
#[tauri::command] async fn set_app_volume(index: u32, volume: u32) -> String {
    run("pactl",&["set-sink-input-volume",&index.to_string(),&format!("{}%",volume)]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn get_sink_descriptions() -> String {
    let out = run("pactl",&["list","sinks"]).await;
    let mut map: Vec<serde_json::Value> = Vec::new();
    let mut cur_name = String::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(n) = t.strip_prefix("Name:") { cur_name = n.trim().to_string(); }
        else if let Some(d) = t.strip_prefix("Description:") {
            if !cur_name.is_empty() {
                map.push(serde_json::json!({"name":cur_name,"desc":d.trim()}));
                cur_name = String::new();
            }
        }
    }
    serde_json::to_string(&map).unwrap_or_else(|_| "[]".into())
}
// ── Autostart apps ───────────────────────────────────────────────────────
#[tauri::command] fn get_autostart_apps() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::Path::new(&home).join(".config/autostart");
    let mut apps: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") { continue; }
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if filename == "bookos-settings.desktop" { continue; } // handled separately
            let content = fs::read_to_string(&path).unwrap_or_default();
            let get = |key: &str| -> String {
                content.lines().find(|l| l.trim_start().starts_with(key))
                    .and_then(|l| l.split('=').nth(1)).unwrap_or("").trim().to_string()
            };
            let name = get("Name");
            if name.is_empty() { continue; }
            let exec = get("Exec");
            let icon = get("Icon");
            let enabled_str = get("X-GNOME-Autostart-enabled");
            let hidden_str = get("Hidden");
            let enabled = enabled_str != "false" && hidden_str != "true";
            apps.push(serde_json::json!({"filename":filename,"name":name,"exec":exec,"icon":icon,"enabled":enabled}));
        }
    }
    apps.sort_by(|a,b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    serde_json::to_string(&apps).unwrap_or_else(|_| "[]".into())
}
#[tauri::command] fn toggle_autostart_app(filename: String, enabled: bool) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = std::path::Path::new(&home).join(".config/autostart").join(&filename);
    if let Ok(content) = fs::read_to_string(&path) {
        let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
        let key = "X-GNOME-Autostart-enabled";
        if let Some(i) = lines.iter().position(|l| l.trim_start().starts_with(key)) {
            lines[i] = format!("{}={}", key, if enabled {"true"} else {"false"});
        } else {
            lines.push(format!("{}={}", key, if enabled {"true"} else {"false"}));
        }
        let _ = fs::write(&path, lines.join("\n") + "\n");
        r#"{"ok":true}"#.into()
    } else {
        r#"{"ok":false,"error":"file not found"}"#.into()
    }
}
// Fast sysfs battery read — instant, no subprocess. Used as immediate render data.
#[tauri::command] fn get_battery_sysfs() -> String {
    let bases = ["/sys/class/power_supply/BAT0","/sys/class/power_supply/BAT1","/sys/class/power_supply/BATT","/sys/class/power_supply/BAT"];
    for base in &bases {
        let p = std::path::Path::new(base);
        if !p.exists() { continue; }
        let rd = |f: &str| fs::read_to_string(p.join(f)).unwrap_or_default().trim().to_string();
        let pct = rd("capacity"); if pct.is_empty() { continue; }
        let raw_status = rd("status").to_lowercase();
        let state = if raw_status.contains("charging") { "charging" } else if raw_status.contains("full") { "fully-charged" } else { "discharging" };
        // energy values in µWh → convert to Wh
        let ef_uw = rd("energy_full").parse::<f64>().unwrap_or(0.0);
        let ef_d_uw = rd("energy_full_design").parse::<f64>().unwrap_or(0.0);
        let en_uw = rd("energy_now").parse::<f64>().unwrap_or(0.0);
        let pw_uw = rd("power_now").parse::<f64>().unwrap_or(0.0);
        // charge values in µAh (some laptops) — skip conversion, just flag
        let ef = if ef_uw > 0.0 { ef_uw / 1_000_000.0 } else { 0.0 };
        let efd = if ef_d_uw > 0.0 { ef_d_uw / 1_000_000.0 } else { 0.0 };
        let en = if en_uw > 0.0 { en_uw / 1_000_000.0 } else { 0.0 };
        let pw = if pw_uw > 0.0 { pw_uw / 1_000_000.0 } else { 0.0 };
        let cycle = rd("cycle_count");
        return format!(r#"{{"ok":true,"percentage":"{}","state":"{}","energy_full":"{:.2}","energy_full_design":"{:.2}","energy":"{:.2}","energy_rate":"{:.2}","cycle_count":"{}"}}"#,
            esc(&pct),state,ef,efd,en,pw,esc(&cycle));
    }
    r#"{"ok":false}"#.into()
}
// Batch-read multiple settings keys in a single file parse.
#[tauri::command] fn get_settings_batch(keys: Vec<String>) -> String {
    let path = bookos_settings_path();
    let map: serde_json::Map<String,serde_json::Value> = fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let out: serde_json::Map<String,serde_json::Value> = keys.iter()
        .map(|k| (k.clone(), map.get(k).and_then(|v| v.as_str()).map(|s| serde_json::Value::String(s.to_string())).unwrap_or(serde_json::Value::Null)))
        .collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".into())
}
fn bookos_settings_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    std::path::PathBuf::from(home).join(".config").join("bookos").join("settings.json")
}

/// Writes IPC state to /tmp/bookos-state.json so the battery applet can pick up changes instantly.
#[tauri::command]
fn write_ipc_state(state: String) -> String {
    let _ = std::fs::write("/tmp/bookos-state.json", &state);
    r#"{"ok":true}"#.into()
}

/// Reads the current IPC state from /tmp/bookos-state.json.
#[tauri::command]
fn read_ipc_state() -> String {
    std::fs::read_to_string("/tmp/bookos-state.json").unwrap_or_default()
}

/// Returns the startup page: checks /tmp/bookos-start-page first (written by external launchers),
/// then falls back to the --page CLI argument.
#[tauri::command]
fn get_startup_page() -> String {
    // Temp file approach — most reliable, written before the app launches
    let tmp = "/tmp/bookos-start-page";
    if let Ok(page) = std::fs::read_to_string(tmp) {
        let _ = std::fs::remove_file(tmp);
        let p = page.trim().to_string();
        if !p.is_empty() { return p; }
    }
    // Fallback: --page CLI argument
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len().saturating_sub(1) {
        if args[i] == "--page" {
            return args[i + 1].clone();
        }
    }
    String::new()
}

/// Checks if another process has requested a page navigation (single-instance signal).
/// Called periodically by the running instance. Reads and deletes /tmp/bookos-start-page.
#[tauri::command]
fn check_navigation_request() -> String {
    let tmp = "/tmp/bookos-start-page";
    if let Ok(page) = std::fs::read_to_string(tmp) {
        let _ = std::fs::remove_file(tmp);
        let p = page.trim().to_string();
        if !p.is_empty() { return p; }
    }
    String::new()
}

/// Called once at startup — re-applies battery limit and performance mode from saved settings.
#[tauri::command] async fn restore_startup_settings() -> String {
    let cfg = load_bookos_settings();
    let bprot = cfg.get("BatteryProtection").and_then(|v|v.as_str()).unwrap_or("false") == "true";
    if bprot {
        let limit: u32 = cfg.get("ChargeLimit")
            .and_then(|v|v.as_str())
            .and_then(|s|s.parse().ok())
            .unwrap_or(80)
            .clamp(50, 100);
        let bat_paths = [
            "/sys/class/power_supply/BAT0/charge_control_end_threshold",
            "/sys/class/power_supply/BAT1/charge_control_end_threshold",
            "/sys/class/power_supply/BATT/charge_control_end_threshold",
        ];
        for p in &bat_paths {
            if std::path::Path::new(p).exists() {
                let _ = fs::write(p, limit.to_string());
                break;
            }
        }
    }
    let perf = cfg.get("PowerSaver").and_then(|v|v.as_str()).unwrap_or("balanced").to_string();
    if !perf.is_empty() && perf != "balanced" {
        let _ = run("powerprofilesctl", &["set", &perf]).await;
    }
    // Sync Kvantum + Plasma Desktop Theme + GTK on startup
    if let Some(is_dark) = cfg.get("ThemeIsDark").and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true"))) {
        let (kv, pt) = get_kv_pt(&cfg, is_dark);
        let _ = run("kvantummanager",&["--set",&kv]).await;
        let _ = run("plasma-apply-desktoptheme",&[&pt]).await;
        apply_gtk_theme(&cfg, is_dark).await;
        apply_lockscreen_theme(is_dark).await;
    }
    r#"{"ok":true}"#.into()
}
fn load_bookos_settings() -> serde_json::Value {
    let path = bookos_settings_path();
    fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}
fn save_bookos_settings(v: &serde_json::Value) {
    let path = bookos_settings_path();
    if let Some(dir) = path.parent() { let _ = fs::create_dir_all(dir); }
    let _ = fs::write(&path, serde_json::to_string_pretty(v).unwrap_or_default());
}

#[tauri::command] fn get_bookos_setting(key: String, default_val: String) -> String {
    let cfg = load_bookos_settings();
    let val = cfg.get(&key)
        .and_then(|v| {
            if let Some(s) = v.as_str() { if !s.is_empty() { return Some(s.to_string()); } }
            if let Some(b) = v.as_bool() { return Some(b.to_string()); }
            if let Some(n) = v.as_i64()  { return Some(n.to_string()); }
            None
        })
        .unwrap_or(default_val);
    format!(r#"{{"value":"{}"}}"#, esc(&val))
}
#[tauri::command] fn set_bookos_setting(key: String, value: String) -> String {
    let mut cfg = load_bookos_settings();
    cfg[key] = serde_json::Value::String(value);
    save_bookos_settings(&cfg);
    r#"{"ok":true}"#.into()
}

#[tauri::command] async fn configure_auto_update(enable: bool) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let service_dir = format!("{}/.config/systemd/user", home);
    let service_path = format!("{}/bookos-autoupdate.service", service_dir);
    let timer_path = format!("{}/bookos-autoupdate.timer", service_dir);
    if enable {
        let _ = fs::create_dir_all(&service_dir);
        let service = "[Unit]\nDescription=BookOS Auto Update Check\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -c 'COUNT=$(checkupdates 2>/dev/null | wc -l); [ \"$COUNT\" -gt 0 ] && notify-send \"BookOS\" \"$COUNT actualizaciones disponibles. Abre Ajustes para instalar.\" --icon=software-update-available'\n";
        let timer = "[Unit]\nDescription=BookOS Auto Update Check Timer\n\n[Timer]\nOnCalendar=daily\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n";
        let _ = fs::write(&service_path, service);
        let _ = fs::write(&timer_path, timer);
        let _ = StdCommand::new("systemctl").args(["--user","daemon-reload"]).output();
        let ok = StdCommand::new("systemctl").args(["--user","enable","--now","bookos-autoupdate.timer"]).output().is_ok();
        format!(r#"{{"ok":{}}}"#, ok)
    } else {
        let _ = StdCommand::new("systemctl").args(["--user","disable","--now","bookos-autoupdate.timer"]).output();
        let _ = fs::remove_file(&service_path);
        let _ = fs::remove_file(&timer_path);
        r#"{"ok":true}"#.into()
    }
}

// Returns battery % for a paired BT device via UPower
#[tauri::command] async fn get_bt_device_battery(mac: String) -> String {
    let mac_under = mac.replace(':', "_").to_lowercase();
    // Use short timeout — BT battery info should be instant or not available
    let devices = run_timeout("upower", &["-e"], 3_000).await;
    let path = devices.lines()
        .find(|l| l.to_lowercase().contains(&mac_under))
        .map(|l| l.trim().to_string());
    if let Some(p) = path {
        let info = run_timeout("upower", &["-i", &p], 3_000).await;
        let pct = info.lines()
            .find(|l| l.contains("percentage:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().trim_end_matches('%').to_string())
            .unwrap_or_default();
        return format!(r#"{{"percentage":"{}","found":true}}"#, esc(&pct));
    }
    r#"{"percentage":"","found":false}"#.into()
}

// Returns KDE Connect paired devices (phone battery etc.)
#[tauri::command] async fn get_kdeconnect_devices() -> String {
    let out = run("kdeconnect-cli", &["-l", "--id-name-only"]).await;
    if out.trim().is_empty() || out.contains("not found") || out.contains("No devices") {
        return "[]".into();
    }
    let mut devs = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(2, ' ').collect();
        if parts.len() < 2 { continue; }
        let id = parts[0].trim();
        let name = parts[1].trim();
        let info = run("kdeconnect-cli", &["-d", id, "--refresh"]).await;
        let battery = run("kdeconnect-cli", &["--device", id, "--battery"]).await;
        let batt_pct = battery.lines()
            .find(|l| l.contains("Battery:") || l.contains("charge:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().trim_end_matches('%').to_string())
            .unwrap_or_default();
        let reachable = !info.contains("unreachable") && !info.is_empty();
        devs.push(format!(r#"{{"id":"{}","name":"{}","battery":"{}","reachable":{}}}"#,
            esc(id), esc(name), esc(&batt_pct), reachable));
    }
    format!("[{}]", devs.join(","))
}

// ── Location (geoclue) ───────────────────────────────────────────────────
#[tauri::command] async fn get_location_status() -> String {
    let out = run("systemctl", &["is-active", "geoclue"]).await;
    let enabled = out.trim() == "active";
    format!(r#"{{"enabled":{}}}"#, enabled)
}
#[tauri::command] async fn set_location_enabled(enable: bool) -> String {
    let action = if enable { "start" } else { "stop" };
    run("systemctl", &[action, "geoclue"]).await;
    r#"{"ok":true}"#.into()
}
// ── Generic command runner (for kwriteconfig6, qdbus, etc.) ──────────────
#[tauri::command] async fn run_command(cmd: String, args: Vec<String>) -> String {
    // Allowlist: only safe KDE config tools
    let allowed = ["kwriteconfig6","kreadconfig6","qdbus","kcmshell6","qdbus6","kquitapp6"];
    if !allowed.contains(&cmd.as_str()) {
        return r#"{"ok":false,"error":"command not allowed"}"#.into();
    }
    let ref_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run(&cmd, &ref_args).await;
    format!(r#"{{"ok":true,"output":"{}"}}"#, esc(&out))
}

/// Launch an external app from a fixed allowlist. Returns {"ok":true} or {"ok":false,"error":"..."}.
#[tauri::command] async fn launch_app(app: String) -> String {
    let allowed = ["rquickshare", "quick-share", "gs-connect", "galaxy-buds-client", "GalaxyBudsClient", "kdeconnect-app"];
    if !allowed.contains(&app.as_str()) {
        return r#"{"ok":false,"error":"app not allowed"}"#.into();
    }
    match std::process::Command::new(&app).spawn() {
        Ok(_)  => r#"{"ok":true}"#.into(),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, e),
    }
}

#[tauri::command] async fn which_app(app: String) -> String {
    let allowed = ["rquickshare", "quick-share", "gs-connect", "galaxy-buds-client", "GalaxyBudsClient", "kdeconnect-app"];
    if !allowed.contains(&app.as_str()) {
        return r#"{"found":false}"#.into();
    }
    let found = std::process::Command::new("which").arg(&app).output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if found { r#"{"found":true}"#.into() } else { r#"{"found":false}"#.into() }
}

#[tauri::command] fn get_system_users() -> String {
    let passwd = read("/etc/passwd");
    let mut users = Vec::new();
    for line in passwd.lines() {
        let p: Vec<&str> = line.split(':').collect();
        if p.len() >= 7 {
            let uid: u32 = p[2].parse().unwrap_or(0);
            if uid >= 1000 && uid < 65000 {
                let un = p[0];
                let display = p[4].split(',').next().unwrap_or("");
                let home = p[5];
                let avatar = format!("{}/.face", home);
                let has_av = std::path::Path::new(&avatar).exists();
                users.push(format!(r#"{{"username":"{}","display_name":"{}","has_avatar":{},"avatar_path":"{}"}}"#,
                    esc(un), esc(display), has_av, esc(&avatar)));
            }
        }
    }
    format!("[{}]", users.join(","))
}

#[tauri::command] fn export_settings(dest: String) -> String {
    let p = format!("{}/.config/bookos/settings.json", std::env::var("HOME").unwrap_or_default());
    if std::fs::copy(&p, &dest).is_ok() { r#"{"ok":true}"#.into() } else { r#"{"ok":false}"#.into() }
}
#[tauri::command] fn import_settings(src: String) -> String {
    let p = format!("{}/.config/bookos/settings.json", std::env::var("HOME").unwrap_or_default());
    let _ = std::fs::create_dir_all(format!("{}/.config/bookos", std::env::var("HOME").unwrap_or_default()));
    if std::fs::copy(&src, &p).is_ok() { r#"{"ok":true}"#.into() } else { r#"{"ok":false}"#.into() }
}

const LOCK_FILE: &str = "/tmp/bookos-settings.lock";

/// Returns true if a process with the given PID is currently running.
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{}", pid)).exists()
}

/// Single-instance guard.
/// If another instance is already running, signal it (write the desired page to
/// /tmp/bookos-start-page) and return false → caller should exit immediately.
/// Otherwise write our PID to the lock file and return true → caller continues.
fn acquire_instance_lock() -> bool {
    if let Ok(contents) = std::fs::read_to_string(LOCK_FILE) {
        if let Ok(pid) = contents.trim().parse::<u32>() {
            if pid_alive(pid) {
                // Another instance is alive: forward the page request and bail out.
                // (The page may have been written to /tmp/bookos-start-page already
                //  by the applet before launching us — leave it for the live instance.)
                return false;
            }
        }
        // Stale lock — remove it before we write ours.
        let _ = std::fs::remove_file(LOCK_FILE);
    }
    let _ = std::fs::write(LOCK_FILE, std::process::id().to_string());
    true
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    // ── Single-instance guard ─────────────────────────────────────────────
    if !acquire_instance_lock() {
        // A live instance is already running; it will pick up /tmp/bookos-start-page
        // via its check_navigation_request polling interval.
        std::process::exit(0);
    }

    let is_hidden = std::env::args().any(|arg| arg == "--hidden");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(UpdateState::default())
        .manage(buds::BudsState::default())
        .manage(quickshare::QsState::default())
        .manage(p2p::P2PState::default())
        .setup(move |app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                if is_hidden {
                    let _ = window.set_skip_taskbar(true);
                    // Stay hidden — launched as background service
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(tauri::include_image!("icons/icon.png"));
            }
            // Removed dynamic creation of bookos-settings-dev.desktop to fix KDE Plasma pin icon issues.
            
            // ── Background battery check thread ───────────────────────
            std::thread::spawn(|| {
                // Sync helper — runs upower via StdCommand (can't use async in std::thread)
                let battery_sync = || -> String {
                    let devices = StdCommand::new("upower").args(["--enumerate"])
                        .output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
                    let path = devices.lines()
                        .find(|l| l.contains("battery_BAT") || (l.contains("battery_") && !l.contains("mouse") && !l.contains("keyboard") && !l.contains("headset") && !l.contains("buds")))
                        .unwrap_or("/org/freedesktop/UPower/devices/battery_BAT0").trim().to_string();
                    let info = StdCommand::new("upower").args(["-i", &path])
                        .output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
                    if info.is_empty() {
                        return r#"{"percentage":"0","state":"unknown"}"#.into();
                    }
                    parse_upower(&info)
                };

                let mut warned_15 = false;
                let mut warned_5 = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    let b = battery_sync();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&b) {
                        let pct = v.get("percentage").and_then(|p| p.as_str()).and_then(|p| p.parse::<u32>().ok()).unwrap_or(100);
                        let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
                        if state.contains("discharging") {
                            if pct <= 5 && !warned_5 {
                                let _ = StdCommand::new("notify-send")
                                    .args(["-u", "critical", "-A", "OK=Aceptar", "-i", "battery-empty", "Batería Muy Baja", &format!("{}% restante. Conecta el cargador.", pct)])
                                    .spawn();
                                warned_5 = true;
                                warned_15 = true;
                            } else if pct <= 15 && pct > 5 && !warned_15 {
                                let _ = StdCommand::new("notify-send")
                                    .args(["-u", "normal", "-A", "OK=Aceptar", "-i", "battery-low", "Batería Baja", &format!("{}% restante.", pct)])
                                    .spawn();
                                warned_15 = true;
                            }
                        } else if state.contains("charging") {
                            warned_15 = false;
                            warned_5 = false;
                        }
                    }
                }
            });

            // ── Routine trigger monitor ──────────────────────────────
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                // Helper: read WiFi state ("enabled" or other)
                let wifi_enabled = || -> bool {
                    let st = StdCommand::new("nmcli")
                        .args(["-t", "-f", "WIFI", "radio"])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .unwrap_or_default();
                    st == "enabled"
                };
                // Helper: read Bluetooth state
                let bt_enabled = || -> bool {
                    let s = StdCommand::new("bluetoothctl")
                        .args(["show"])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .unwrap_or_default();
                    s.lines().any(|l| l.contains("Powered:") && l.contains("yes"))
                };
                // Check if AC adapter is physically online via sysfs (most reliable)
                let ac_online = || -> bool {
                    for p in &[
                        "/sys/class/power_supply/ACAD/online",
                        "/sys/class/power_supply/AC/online",
                        "/sys/class/power_supply/AC0/online",
                        "/sys/class/power_supply/ADP1/online",
                        "/sys/class/power_supply/adp1/online",
                    ] {
                        if let Ok(s) = fs::read_to_string(p) {
                            return s.trim() == "1";
                        }
                    }
                    false
                };
                let bat_charging = || -> (bool, u32) {
                    let charging = ac_online();
                    // Get percentage from sysfs or upower
                    let pct_sysfs = || -> Option<u32> {
                        for p in &["/sys/class/power_supply/BAT0/capacity", "/sys/class/power_supply/BAT1/capacity"] {
                            if let Ok(s) = fs::read_to_string(p) { return s.trim().parse().ok(); }
                        }
                        None
                    };
                    let pct = pct_sysfs().unwrap_or_else(|| {
                        let devices = StdCommand::new("upower").args(["--enumerate"])
                            .output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
                        let path = devices.lines()
                            .find(|l| l.contains("battery_BAT") || (l.contains("battery_") && !l.contains("mouse") && !l.contains("keyboard")))
                            .unwrap_or("/org/freedesktop/UPower/devices/battery_BAT0").trim().to_string();
                        let info = StdCommand::new("upower").args(["-i", &path])
                            .output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
                        let b = parse_upower(&info);
                        serde_json::from_str::<serde_json::Value>(&b).ok()
                            .and_then(|v| v.get("percentage").and_then(|p| p.as_str()).and_then(|p| p.parse::<u32>().ok()))
                            .unwrap_or(100)
                    });
                    (charging, pct)
                };

                let emit = |trigger: &str| {
                    let payload = serde_json::json!({ "trigger_type": trigger });
                    let _ = app_handle.emit("routine-trigger", payload);
                };

                let mut prev_wifi = wifi_enabled();
                let mut prev_bt   = bt_enabled();
                let (c, p) = bat_charging();
                let mut prev_charging = c;
                let mut prev_pct      = p;
                let mut low_bat_fired = false;

                loop {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let cur_wifi = wifi_enabled();
                    if cur_wifi != prev_wifi { emit(if cur_wifi { "wifi_on" } else { "wifi_off" }); prev_wifi = cur_wifi; }
                    let cur_bt = bt_enabled();
                    if cur_bt != prev_bt { emit(if cur_bt { "bt_on" } else { "bt_off" }); prev_bt = cur_bt; }
                    let (cur_charging, cur_pct) = bat_charging();
                    if cur_charging != prev_charging {
                        emit(if cur_charging { "power_connected" } else { "power_disconnected" });
                        prev_charging = cur_charging;
                        if cur_charging { low_bat_fired = false; }
                    }
                    if !cur_charging && cur_pct < 20 && prev_pct >= 20 && !low_bat_fired {
                        emit("low_battery");
                        low_bat_fired = true;
                    }
                    prev_pct = cur_pct;
                }
            });

            // ── Automatic Update Daemon ──────────────────────────────
            std::thread::spawn(|| {
                // Wait 5 minutes after start to not saturate CPU
                std::thread::sleep(std::time::Duration::from_secs(300));
                loop {
                    let cfg = load_bookos_settings();
                    let auto_upd = cfg.get("AutoUpdate").and_then(|v| v.as_str()).unwrap_or("false") == "true";
                    
                    if auto_upd {
                        // Check updates (sync)
                        let _ = StdCommand::new("pacman").arg("-Sy").output();
                        let pac_out = StdCommand::new("pacman").arg("-Qu").output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
                        let aur_out = StdCommand::new("paru").arg("-Qua").output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
                        let total = pac_out.lines().count() + aur_out.lines().count();
                        
                        if total > 0 {
                            let _ = StdCommand::new("notify-send")
                                .args(["-u", "normal", "-i", "software-update-available", "Actualizaciones disponibles", &format!("Hay {} paquetes nuevos para instalar.", total)])
                                .spawn();
                        }
                    }
                    // Wait 6 hours for next check
                    std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_user_info,set_display_name,set_hostname,get_system_info,
            check_hw_features,set_performance_mode,set_charge_limit,
            get_wifi_status,toggle_wifi,get_wifi_list,connect_wifi,wifi_rescan,
            get_bluetooth_status,toggle_bluetooth,get_bluetooth_devices,connect_bluetooth,disconnect_bluetooth,bluetooth_scan,
            get_airplane_mode,toggle_airplane_mode,
            get_brightness,set_brightness,get_kbd_brightness,set_kbd_brightness,
            get_nightlight,set_nightlight,
            get_volume,set_volume,toggle_mute,
            get_battery_status,get_battery_sysfs,get_battery_history,get_battery_csv_data,get_adaptive_predictions,set_adaptive_charging,
            get_display_info,set_resolution,set_vrr_policy,
            get_current_theme,get_available_themes,set_color_scheme,get_theme_schedule,set_theme_schedule,
            get_kde_light_dark_themes,apply_kde_theme,
            get_dnd_status,toggle_dnd,
            get_lock_timeout,set_lock_timeout,check_fingerprint,enroll_fingerprint,
            get_locale_info,get_available_locales,set_locale,get_available_keymaps,set_keymap,
            check_system_updates,check_aur_updates,check_flatpak_updates,run_system_update,run_pacman_update_silent,get_update_progress,cancel_update,run_flatpak_update,
            get_app_power_usage,get_sddm_themes,set_sddm_theme,get_sddm_config,set_sddm_config,get_app_usage,
            run_maintenance,get_kwin_effects,toggle_kwin_effect,fix_cursor_hz,get_cursor_fix_status,get_input_devices,set_input_setting,
            get_firewall_status,run_sudo_command,get_system_users,
            get_autostart_bookos,toggle_autostart_bookos,get_autostart_apps,toggle_autostart_app,setup_polkit_rules,export_settings,import_settings,
            get_accessibility_settings,set_font_scale,set_display_scale,toggle_invert_colors,set_cursor_size,
            change_password,set_avatar,get_labs_settings,set_lab_setting,
            forget_wifi,get_wifi_details,get_wifi_password,log_app_usage,
            get_wallpapers,get_current_wallpaper,set_wallpaper,
            get_default_apps,open_mime_settings,
            get_bookos_setting,set_bookos_setting,get_settings_batch,configure_auto_update,restore_startup_settings,get_startup_page,check_navigation_request,write_ipc_state,read_ipc_state,
            get_available_kvantum_themes,get_available_plasma_themes,get_style_themes,set_style_themes,
            get_bt_device_battery,get_kdeconnect_devices,
            get_audio_devices,set_default_sink,set_default_source,get_app_audio,set_app_volume,get_sink_descriptions,
            get_location_status,set_location_enabled,run_command,launch_app,which_app,
            hardware_control::aplicar_perfil_termico,
            hardware_control::activar_vision_booster,hardware_control::desactivar_vision_booster,
            hardware_control::activar_hdr,hardware_control::desactivar_hdr,
            hardware_control::activar_ahorro_pantalla,hardware_control::desactivar_ahorro_pantalla,
            hardware_control::aplicar_perfil_color,
            hardware_control::set_brillo,
            hardware_control::obtener_estado_pantalla,
            buds::buds_connect,buds::buds_disconnect,buds::buds_get_status,
            buds::buds_set_anc,buds::buds_set_eq,buds::buds_set_touch_lock,
            buds::gbc_is_available,buds::gbc_get_device,
            buds::gbc_execute_action,buds::gbc_activate,
            quickshare::qs_start,quickshare::qs_stop,
            quickshare::qs_discover,quickshare::qs_stop_discover,
            quickshare::qs_send_files,quickshare::qs_action,
            quickshare::qs_cancel,quickshare::qs_set_visibility,
            quickshare::qs_set_download_path,
            p2p::p2p_start_discover,p2p::p2p_stop_discover,
            p2p::p2p_connect,p2p::p2p_disconnect,
            search::search_status,search::search_install,search::search_install_log,
            search::search_toggle,search::search_reindex,search::search_query,search::search_uninstall,
            get_thermal_csv_data,get_charging_info,
            set_camera_enabled,get_camera_enabled,set_mic_muted,get_mic_muted
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Clean up lock file when the app exits normally.
    let _ = std::fs::remove_file(LOCK_FILE);
}
