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
/// Locate user picture and return (path, base64-data-url) — searches the
/// standard locations: ~/.face, ~/.face.icon, /var/lib/AccountsService/icons/<user>.
fn find_avatar(home: &str, user: &str) -> (String, String) {
    let candidates = [
        format!("{}/.face", home),
        format!("{}/.face.icon", home),
        format!("/var/lib/AccountsService/icons/{}", user),
    ];
    let path = match candidates.iter().find(|p| std::path::Path::new(p).exists()) {
        Some(p) => p.clone(),
        None => return (String::new(), String::new()),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return (path, String::new()),
    };
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        s.push(T[(b0 >> 2) as usize] as char);
        s.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        s.push(if chunk.len() > 1 { T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        s.push(if chunk.len() > 2 { T[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    let mime = if path.ends_with(".png") { "image/png" } else { "image/jpeg" };
    (path, format!("data:{};base64,{}", mime, s))
}

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
    let (avatar, avatar_data) = find_avatar(&home, &user);
    let has_av = !avatar.is_empty();
    format!(r#"{{"username":"{}","display_name":"{}","hostname":"{}","has_avatar":{},"avatar_path":"{}","avatar_data":"{}"}}"#,
        esc(&user),esc(&display),esc(&host),has_av,esc(&avatar),avatar_data)
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
/// BookOS release info — separate from package updates. Reads /etc/bookos-release.
/// Format (key=value lines):
///   NAME=BookOS 1.0
///   VERSION=1.0
///   SIZE=1 GB
///   CHANNEL=stable    # stable | beta | dev
///   CHANGELOG=https://bookos.es/changelog
///   DESCRIPTION=BookOS 1.0 includes…  (single line, \n placeholder for breaks)
///   INSTALLED=BookOS 0.2 Preview
/// Returns sensible defaults if file missing.
/// Default upstream releases URL. Override via /etc/bookos-update.conf line `UPSTREAM=...`.
const DEFAULT_UPSTREAM: &str = "https://bookos.es/api/releases.json";

/// Read update config. /etc/bookos-update.conf is the system default;
/// ~/.config/bookos-update.conf overrides per-user (no sudo to switch channel).
fn read_update_conf() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    let mut paths: Vec<String> = vec!["/etc/bookos-update.conf".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        paths.push(format!("{}/.config/bookos-update.conf", home));
    }
    for p in paths {
        if let Ok(txt) = std::fs::read_to_string(&p) {
            for l in txt.lines() {
                let l = l.trim();
                if l.is_empty() || l.starts_with('#') { continue; }
                if let Some(eq) = l.find('=') {
                    m.insert(l[..eq].trim().to_string(), l[eq+1..].trim().trim_matches('"').to_string());
                }
            }
        }
    }
    m
}

/// Fetch upstream releases.json from BookOS server. Picks the latest release
/// matching the configured CHANNEL. Returns the json text on success.
/// Refuses to block more than 5s — safe for sync UI calls.
async fn fetch_upstream_release(channel: &str) -> Option<serde_json::Value> {
    let conf = read_update_conf();
    let mut url = conf.get("UPSTREAM").cloned().unwrap_or_else(|| DEFAULT_UPSTREAM.to_string());
    if !url.contains('?') { url.push('?'); } else { url.push('&'); }
    url.push_str(&format!("channel={}", urlencode(channel)));
    // Use curl since reqwest isn't in deps. -fsSL: fail on HTTP error, silent, follow redirects.
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new("curl").args(["-fsSL", "--max-time", "5", &url]).output()
    ).await.ok()?.ok()?;
    if !out.status.success() { return None; }
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<serde_json::Value>(&body).ok()
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| match c {
        'a'..='z'|'A'..='Z'|'0'..='9'|'-'|'_'|'.'|'~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}

/// Apply BookOS release update. Fedora-only flow:
///   sudo dnf upgrade -y bookos-meta
/// The 'bookos-meta' RPM has Requires: for the BookOS package set; upgrading it
/// pulls all dependencies to the manifested version.
/// Channel-specific repos must be enabled beforehand (see /etc/yum.repos.d/bookos-*).
#[tauri::command]
async fn apply_bookos_release(password: String, state: tauri::State<'_, UpdateState>) -> Result<String, String> {
    use std::io::Write;
    {
        let mut s = state.lock().unwrap();
        if s.running { return Ok(r#"{"ok":false,"error":"Ya hay una actualización en curso"}"#.into()); }
        *s = UpdateProgress { running: true, done: false, ok: false, output: "Iniciando...".into(), child_pid: None };
    }
    let state_clone = std::sync::Arc::clone(&state);
    std::thread::spawn(move || {
        // Determine current channel to know which repo group to use.
        let channel = read_update_conf().get("CHANNEL").cloned().unwrap_or_else(|| "stable".into());
        // Ensure the right repo is enabled; disable the others.
        let enable_arg = format!("--enablerepo=bookos-{}", channel);
        let disable_args: Vec<String> = ["stable","beta","dev"].iter()
            .filter(|c| **c != channel.as_str())
            .map(|c| format!("--disablerepo=bookos-{}", c))
            .collect();

        // Build the dnf upgrade command (channel repos toggled).
        let mut dnf = format!("dnf upgrade -y --refresh {}", enable_arg);
        for d in &disable_args { dnf.push(' '); dnf.push_str(d); }
        dnf.push_str(" bookos-meta");
        // Take a btrfs snapshot first (rollback safety net) unless the user set
        // SnapshotPolicy=never. If snapper isn't present it's a no-op. Run both
        // under one sudo so the password is asked once.
        let snap = if should_snapshot(false) {
            "snapper -c root create -d 'Antes de actualizar BookOS' 2>/dev/null; "
        } else { "" };
        let shell_cmd = format!("{}{}", snap, dnf);
        let args: Vec<String> = vec!["-k".into(), "-S".into(), "sh".into(), "-c".into(), shell_cmd];

        let mut child = match StdCommand::new("sudo")
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn() {
                Ok(c) => c,
                Err(e) => {
                    if let Ok(mut s) = state_clone.lock() {
                        s.running = false; s.done = true; s.ok = false;
                        s.output = format!("spawn fail: {}", e);
                    }
                    return;
                }
            };
        if let Some(mut sin) = child.stdin.take() {
            let _ = sin.write_all(password.as_bytes());
            let _ = sin.write_all(b"\n");
        }
        if let Ok(mut s) = state_clone.lock() { s.child_pid = child.id().into(); }
        match child.wait_with_output() {
            Ok(o) => {
                let combined = String::from_utf8_lossy(&o.stdout).to_string()
                             + &String::from_utf8_lossy(&o.stderr);
                // On success, stamp INSTALLED to the version we just upgraded to
                // so the "update available" check clears (bug: it never updated).
                if o.status.success() {
                    let installed_ver = std::fs::read_to_string("/etc/bookos-release").ok()
                        .or_else(|| std::env::var("HOME").ok()
                            .and_then(|h| std::fs::read_to_string(format!("{}/.config/bookos-release-cache", h)).ok()))
                        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("VERSION=").map(|s| s.trim().to_string())))
                        .unwrap_or_default();
                    if !installed_ver.is_empty() { mark_installed(&installed_ver); }
                }
                if let Ok(mut s) = state_clone.lock() {
                    s.running = false; s.done = true;
                    s.ok = o.status.success();
                    s.output = combined;
                }
            },
            Err(e) => {
                if let Ok(mut s) = state_clone.lock() {
                    s.running = false; s.done = true; s.ok = false;
                    s.output = format!("wait: {}", e);
                }
            }
        }
    });
    Ok(r#"{"ok":true,"started":true}"#.into())
}

/// Whether to take a snapshot, per SnapshotPolicy setting.
/// "never" → no. "packages" → on both package + OS updates. "osupdate"
/// (default) → only on OS release upgrades.
fn should_snapshot(is_packages: bool) -> bool {
    let policy = load_bookos_settings().get("SnapshotPolicy")
        .and_then(|v| v.as_str()).unwrap_or("osupdate").to_string();
    match policy.as_str() {
        "never" => false,
        "packages" => true,
        _ => !is_packages,
    }
}

/// Is this system capable of snapshots? (root on btrfs + snapper present)
#[tauri::command]
async fn get_snapshot_support() -> String {
    let fs = Command::new("findmnt").args(["-n","-o","FSTYPE","/"]).output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let snapper = Command::new("sh").args(["-c","command -v snapper >/dev/null"]).output().await
        .map(|o| o.status.success()).unwrap_or(false);
    format!(r#"{{"supported":{},"fs":"{}","snapper":{}}}"#, fs=="btrfs" && snapper, esc(&fs), snapper)
}

/// List btrfs/snapper snapshots (rollback points). Returns [] if snapper
/// isn't installed or the system isn't on btrfs.
#[tauri::command]
async fn list_bookos_snapshots() -> String {
    let out = match Command::new("snapper").args(["-c","root","--machine-readable","csv","list"]).output().await {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return "[]".into(),
    };
    // CSV header first; columns include number, date, description.
    let mut items: Vec<String> = Vec::new();
    for (i, line) in out.lines().enumerate() {
        if i == 0 || line.trim().is_empty() { continue; }
        let cols: Vec<&str> = line.split(',').collect();
        // snapper csv: config,subvolume,number,default,active,date,user,cleanup,description,...
        let num  = cols.get(2).map(|s| s.trim()).unwrap_or("");
        let date = cols.get(5).map(|s| s.trim()).unwrap_or("");
        let desc = cols.get(8).map(|s| s.trim()).unwrap_or("");
        if num.is_empty() || num == "0" { continue; }
        items.push(format!(r#"{{"number":"{}","date":"{}","description":"{}"}}"#, esc(num), esc(date), esc(desc)));
    }
    format!("[{}]", items.join(","))
}

/// Roll the system back to a snapshot (needs reboot to take effect).
#[tauri::command]
async fn rollback_bookos_snapshot(password: String, number: String) -> String {
    if !number.chars().all(|c| c.is_ascii_digit()) || number.is_empty() {
        return r#"{"ok":false,"error":"invalid snapshot"}"#.into();
    }
    let cmd = format!("snapper -c root rollback {}", number);
    let out = Command::new("sudo").args(["-k","-S","sh","-c",&cmd])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match out { Ok(c) => c, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())) };
    if let Some(mut sin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = sin.write_all(format!("{}\n", password).as_bytes()).await;
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => r#"{"ok":true,"reboot_required":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(String::from_utf8_lossy(&o.stderr).trim())),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

/// Get current update channel ("stable" default).
#[tauri::command]
fn get_update_channel() -> String {
    let ch = read_update_conf().get("CHANNEL").cloned()
        .or_else(|| std::fs::read_to_string("/etc/bookos-release").ok()
            .and_then(|t| t.lines().find_map(|l| l.strip_prefix("CHANNEL=").map(|s| s.trim().to_string()))))
        .unwrap_or_else(|| "stable".to_string());
    format!(r#"{{"channel":"{}"}}"#, esc(&ch))
}

/// Switch update channel. Tries /etc first, falls back to user override file
/// (~/.config/bookos-update.conf) so it works without sudo.
#[tauri::command]
fn set_update_channel(channel: String) -> String {
    if !["stable","beta","dev"].contains(&channel.as_str()) {
        return r#"{"ok":false,"error":"invalid channel"}"#.into();
    }
    // Read/update conf, preserving other keys
    let mut conf = read_update_conf();
    conf.insert("CHANNEL".to_string(), channel.clone());
    let out: String = conf.iter().map(|(k,v)| format!("{}={}\n", k, v)).collect();

    if std::fs::write("/etc/bookos-update.conf", &out).is_err() {
        if let Ok(home) = std::env::var("HOME") {
            let _ = std::fs::create_dir_all(format!("{}/.config", home));
            let _ = std::fs::write(format!("{}/.config/bookos-update.conf", home), &out);
        }
    }
    format!(r#"{{"ok":true,"channel":"{}"}}"#, esc(&channel))
}

// ── BookOS dnf repo (custom packages: modified libfprint, BookOS apps) ──
const BOOKOS_REPO_PATH: &str = "/etc/yum.repos.d/bookos.repo";
const BOOKOS_REPO_URL: &str = "https://bookos.es/store-files/bookos.repo";

/// Is the BookOS dnf repo installed on this system?
#[tauri::command]
fn get_bookos_repo_status() -> String {
    let supported = std::path::Path::new("/etc/yum.repos.d").exists();
    let enabled = std::fs::read_to_string(BOOKOS_REPO_PATH)
        .map(|c| !c.contains("enabled=0"))
        .unwrap_or(false);
    format!(r#"{{"supported":{},"enabled":{}}}"#, supported, enabled)
}

/// Install/remove the BookOS dnf repo. Uses pkexec (graphical polkit prompt).
#[tauri::command]
async fn set_bookos_repo(enable: bool) -> String {
    let script = if enable {
        format!(
            "curl -fsSL --proto '=https' --max-time 20 {url} -o {path} && chmod 644 {path}",
            url = BOOKOS_REPO_URL, path = BOOKOS_REPO_PATH
        )
    } else {
        format!("rm -f {}", BOOKOS_REPO_PATH)
    };
    match Command::new("pkexec").args(["sh", "-c", &script]).output().await {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(String::from_utf8_lossy(&o.stderr).trim())),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

#[tauri::command]
async fn refresh_bookos_release(lang: Option<String>) -> String {
    // Online check — fetches manifest, picks latest for current channel,
    // writes /etc/bookos-release atomically. Requires sudo writability — if
    // not possible (e.g. typical user), writes to ~/.config/bookos-release-cache
    // and get_bookos_release will prefer that override when present.
    let conf = read_update_conf();
    let channel = conf.get("CHANNEL").cloned()
        .or_else(|| std::fs::read_to_string("/etc/bookos-release").ok()
            .and_then(|t| t.lines().find_map(|l| l.strip_prefix("CHANNEL=").map(|s| s.trim().to_string()))))
        .unwrap_or_else(|| "stable".to_string());

    let json = match fetch_upstream_release(&channel).await {
        Some(j) => j,
        None => return r#"{"ok":false,"error":"upstream unreachable"}"#.into(),
    };
    let latest = match select_release(&json, &channel) {
        Some(v) => v,
        None => return r#"{"ok":false,"error":"no release in manifest"}"#.into(),
    };

    let gs = |k: &str| -> String { latest.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string() };
    let installed = std::fs::read_to_string("/etc/bookos-release").ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("INSTALLED=").map(|s| s.trim().to_string())))
        .unwrap_or_default();

    let new_conf = format!(
        "NAME=BookOS {ver}\nVERSION={ver}\nSIZE={size}\nCHANNEL={ch}\nCHANGELOG={cl}\nDESCRIPTION={desc}\nDESCRIPTION_EN={desc_en}\nINSTALLED={inst}\n",
        ver = gs("version"),
        size = gs("size_human").is_empty().then(|| latest.get("size").and_then(|v| v.as_u64()).map(|b| format_bytes(b)).unwrap_or_default()).unwrap_or_else(|| gs("size_human")),
        ch = channel,
        cl = gs("changelog_url"),
        desc = gs("notes").replace('\n', "\\n"),
        desc_en = gs("notes_en").replace('\n', "\\n"),
        inst = installed,
    );

    // Try /etc first (root); fallback to user cache that get_bookos_release reads.
    if std::fs::write("/etc/bookos-release", &new_conf).is_err() {
        if let Ok(home) = std::env::var("HOME") {
            let _ = std::fs::create_dir_all(format!("{}/.config", home));
            let _ = std::fs::write(format!("{}/.config/bookos-release-cache", home), &new_conf);
        }
    }
    let _ = lang;
    r#"{"ok":true}"#.into()
}

/// Select the newest release object for `channel` from a manifest, tolerating
/// several reasonable server shapes so a schema tweak can't silently break
/// updates:
///   1. `by_channel` as an object keyed by channel: {"stable": {...}}
///   2. `by_channel` as an array of release objects (each with a "channel")
///   3. a flat `releases` array (filtered by "channel", newest wins)
///   4. a single `latest` object (used only if it matches the channel/unlabeled)
fn select_release<'a>(json: &'a serde_json::Value, channel: &str) -> Option<&'a serde_json::Value> {
    let ver = |r: &serde_json::Value| r.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // An entry matches when it has no channel label or its label equals `channel`.
    let matches_ch = |r: &serde_json::Value| r.get("channel").and_then(|v| v.as_str()).map_or(true, |c| c == channel);

    // 1) by_channel as object
    if let Some(obj) = json.get("by_channel").and_then(|v| v.as_object()) {
        if let Some(r) = obj.get(channel) {
            if r.is_object() { return Some(r); }
        }
    }
    // 2/3) by_channel or releases as array — newest matching channel
    for key in ["by_channel", "releases"] {
        if let Some(arr) = json.get(key).and_then(|v| v.as_array()) {
            if let Some(r) = arr.iter()
                .filter(|r| r.is_object() && matches_ch(r))
                .max_by(|a, b| cmp_versions(&ver(a), &ver(b))) {
                return Some(r);
            }
        }
    }
    // 4) single latest object
    if let Some(r) = json.get("latest") {
        if r.is_object() && matches_ch(r) { return Some(r); }
    }
    None
}

/// Pull a comparable version token out of a free-form string, e.g.
/// "BookOS 1.2.0" → "1.2.0", "BookOS 1.0 Preview" → "1.0", "1.1-rc.1" → "1.1-rc.1".
fn extract_version(s: &str) -> String {
    s.split_whitespace()
        .find(|t| t.chars().next().map_or(false, |c| c.is_ascii_digit()))
        .unwrap_or("")
        .to_string()
}

/// Compare two dotted versions. A plain release outranks a pre-release of the
/// same core (1.0 > 1.0-rc.1); pre-releases compare lexically among themselves.
fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let split = |v: &str| -> (Vec<u64>, String) {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, p.to_string()),
            None => (v, String::new()),
        };
        (core.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect(), pre)
    };
    let (na, pa) = split(a);
    let (nb, pb) = split(b);
    for i in 0..na.len().max(nb.len()) {
        match na.get(i).copied().unwrap_or(0).cmp(&nb.get(i).copied().unwrap_or(0)) {
            Ordering::Equal => continue,
            o => return o,
        }
    }
    match (pa.is_empty(), pb.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,   // release > pre-release
        (false, true) => Ordering::Less,
        (false, false) => pa.cmp(&pb),
    }
}

/// True when `available` is a strictly newer version than `installed`.
/// If the installed version can't be determined, we don't nag (returns false).
fn update_is_available(available: &str, installed: &str) -> bool {
    let inst = extract_version(installed);
    !available.is_empty() && !inst.is_empty()
        && cmp_versions(available, &inst) == std::cmp::Ordering::Greater
}

/// Rewrite the INSTALLED= line in the bookos-release file after a successful
/// upgrade, so the "update available" check stops firing. Tries /etc, falls
/// back to the per-user cache that get_bookos_release also reads.
fn mark_installed(version: &str) {
    let stamp = format!("BookOS {}", version);
    let patch = |txt: String| -> String {
        let mut seen = false;
        let mut out: String = txt.lines().map(|l| {
            if l.trim_start().starts_with("INSTALLED=") { seen = true; format!("INSTALLED={}\n", stamp) }
            else { format!("{}\n", l) }
        }).collect();
        if !seen { out.push_str(&format!("INSTALLED={}\n", stamp)); }
        out
    };
    if let Ok(txt) = std::fs::read_to_string("/etc/bookos-release") {
        if std::fs::write("/etc/bookos-release", patch(txt)).is_ok() { return; }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = format!("{}/.config/bookos-release-cache", home);
        let txt = std::fs::read_to_string(&p).unwrap_or_default();
        let _ = std::fs::write(&p, patch(txt));
    }
}

fn format_bytes(b: u64) -> String {
    if b >= 1_000_000_000 { format!("{:.1} GB", b as f64 / 1e9) }
    else if b >= 1_000_000 { format!("{:.0} MB", b as f64 / 1e6) }
    else if b >= 1_000     { format!("{:.0} KB", b as f64 / 1e3) }
    else                   { format!("{} B", b) }
}

#[tauri::command]
fn get_bookos_release(lang: Option<String>) -> String {
    // Prefer user cache (refresh_bookos_release writes here when /etc not writable)
    let home = std::env::var("HOME").unwrap_or_default();
    let user_cache = format!("{}/.config/bookos-release-cache", home);
    let txt = if std::path::Path::new(&user_cache).exists() {
        std::fs::read_to_string(&user_cache).unwrap_or_default()
    } else {
        std::fs::read_to_string("/etc/bookos-release").unwrap_or_default()
    };
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in txt.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') { continue; }
        if let Some(eq) = l.find('=') {
            map.insert(l[..eq].trim().to_string(), l[eq+1..].trim().trim_matches('"').to_string());
        }
    }
    let get = |k: &str, def: &str| -> String { map.get(k).cloned().unwrap_or_else(|| def.to_string()) };
    // Pick description per lang: DESCRIPTION_EN/_ES, fallback to DESCRIPTION.
    let l = lang.unwrap_or_else(|| "es".to_string());
    let desc_key = if l == "en" { "DESCRIPTION_EN" } else { "DESCRIPTION_ES" };
    let description = if let Some(s) = map.get(desc_key) { s.clone() } else { get("DESCRIPTION","") };
    // Same for changelog URL (optional override)
    let cl_key = if l == "en" { "CHANGELOG_EN" } else { "CHANGELOG_ES" };
    let changelog = if let Some(s) = map.get(cl_key) { s.clone() } else { get("CHANGELOG","") };
    format!(
        r#"{{"name":"{}","version":"{}","size":"{}","channel":"{}","changelog":"{}","description":"{}","installed":"{}","available":{}}}"#,
        esc(&get("NAME","BookOS")),
        esc(&get("VERSION","")),
        esc(&get("SIZE","")),
        esc(&get("CHANNEL","stable")),
        esc(&changelog),
        esc(&description),
        esc(&get("INSTALLED","")),
        // Available only when the manifest version is strictly newer than what's
        // installed — not merely "a VERSION line exists" (which was always true
        // after a refresh and left the banner stuck on forever).
        if update_is_available(&get("VERSION",""), &get("INSTALLED","")) { "true" } else { "false" }
    )
}

/// Map the Samsung DMI model code (e.g. "940XHA", "NP754QKG-…") to the
/// commercial Galaxy Book name. Codes condensed from modelos_book.md:
///   Book5: *XHA Pro · *QQHA Pro360 · *QHA 360 · *XHD (base)
///   Book4: *XGL Ultra · *QKG Edge(ARM) · *QGK Pro360/360 · *XGK Pro/base · *XGJ base
/// The 960/940 vs 750 numeric prefix disambiguates Pro vs base / Pro360 vs 360.
fn detect_book_model() -> Option<String> {
    let raw = format!("{} {}",
        read("/sys/class/dmi/id/product_name"),
        read("/sys/class/dmi/id/board_name"));
    let code = raw.to_uppercase();
    let c = |s: &str| code.contains(s);
    // numeric prefix present anywhere (clamshell sizes 940/960, convertibles 750/754)
    let hi = c("960") || c("964") || c("940") || c("944");   // Pro / Ultra tier
    let name = if c("QQHA") { "Galaxy Book5 Pro 360" }
        else if c("XHA")    { "Galaxy Book5 Pro" }
        else if c("QHA")    { "Galaxy Book5 360" }
        else if c("XHD")    { "Galaxy Book5" }
        else if c("XGL")    { "Galaxy Book4 Ultra" }
        else if c("QKG")    { "Galaxy Book4 Edge" }          // ARM
        else if c("QGK")    { if hi { "Galaxy Book4 Pro 360" } else { "Galaxy Book4 360" } }
        else if c("XGK")    { if hi { "Galaxy Book4 Pro" } else { "Galaxy Book4" } }
        else if c("XGJ")    { "Galaxy Book4" }
        else { return None };
    Some(name.to_string())
}

/// Default hostname derived from the laptop model: "Galaxy Book5 Pro" →
/// "book5-pro". Falls back to "bookos" when the model is unknown.
#[tauri::command] fn get_default_hostname() -> String {
    let slug = detect_book_model()
        .map(|m| m.to_lowercase()
            .replace("galaxy ", "")
            .trim().replace(' ', "-"))
        .filter(|s| s.starts_with("book"))
        .unwrap_or_else(|| "bookos".to_string());
    format!(r#"{{"hostname":"{}"}}"#, esc(&slug))
}

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
    // Commercial model name (Galaxy Book4/5 …) from DMI, else raw product_name.
    let model = detect_book_model()
        .unwrap_or_else(|| { let p = read("/sys/class/dmi/id/product_name").trim().to_string(); if p.is_empty() { "—".into() } else { p } });
    format!(r#"{{"hostname":"{}","kernel":"{}","distro":"{}","cpu":"{}","ram":"{}","gpu":"{}","plasma":"{}","model":"{}"}}"#,
        esc(&host),esc(&kern),esc(&distro),esc(&cpu),esc(&ram),esc(&gpu),esc(&plasma),esc(&model))
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

/// Calls the bookos-ai predict.py to estimate minutes remaining until 20%.
/// Returns model JSON or `{"ok":false,"reason":"..."}`.
#[tauri::command] async fn predict_battery_runtime() -> String {
    fn read_u64(p: &str) -> u64 { std::fs::read_to_string(p).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0) }
    // Prefer /var/lib (user-writable, set up at first run) over /opt (system,
    // populated by the post-install hook on packaged installs).
    let candidates = [
        ("/var/lib/bookos-ai/venv/bin/python", "/var/lib/bookos-ai/predict.py"),
        ("/opt/bookos-ai/venv/bin/python", "/opt/bookos-ai/predict.py"),
    ];
    let (py, script) = match candidates.iter().find(|(p, s)|
        std::path::Path::new(p).exists() && std::path::Path::new(s).exists()
    ) {
        Some((p, s)) => (*p, *s),
        None => return r#"{"ok":false,"reason":"venv_not_installed"}"#.into(),
    };
    // Gather current state
    let bat = if std::path::Path::new("/sys/class/power_supply/BAT1").exists() { "BAT1" } else { "BAT0" };
    let level   = read_u64(&format!("/sys/class/power_supply/{bat}/capacity"));
    let cur_ua  = read_u64(&format!("/sys/class/power_supply/{bat}/current_now"));
    let volt_uv = read_u64(&format!("/sys/class/power_supply/{bat}/voltage_now"));
    let power_w = (cur_ua.saturating_mul(volt_uv) / 1_000_000) as f64 / 1e6;

    // Local time without chrono — `date` provides it consistently
    let date_out = std::process::Command::new("date").arg("+%H %M %u").output();
    let (hora, minute, dow) = match date_out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut it = s.split_whitespace();
            let h: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let m: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let d: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(1);
            (h, m, d)
        }
        Err(_) => (0u32, 0u32, 1u32),
    };
    let t_min = hora * 60 + minute;

    let input = format!(
        r#"{{"nivel":{},"power_w":{:.3},"hora":{},"dia":{},"t_min":{}}}"#,
        level, power_w, hora, dow, t_min
    );
    let out = tokio::process::Command::new(py)
        .args([script, "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match out { Ok(c) => c, Err(e) => return format!(r#"{{"ok":false,"reason":"spawn:{}"}}"#, esc(&e.to_string())) };
    if let Some(mut sin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = sin.write_all(input.as_bytes()).await;
        drop(sin);
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Ok(o) => format!(r#"{{"ok":false,"reason":"py_exit","stderr":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"reason":"wait:{}"}}"#, esc(&e.to_string())),
    }
}

/// Background throttling: lowers cpufreq for non-foreground tasks and renices
/// existing user processes that aren't part of the active session.
/// `enable=true` => restrict, `false` => restore defaults.
#[tauri::command] async fn set_background_throttle(enable: bool) -> String {
    use std::process::Command;
    // 1. cpufreq governor
    let gov = if enable { "powersave" } else { "schedutil" };
    let mut gov_changed = 0u32;
    if let Ok(rd) = std::fs::read_dir("/sys/devices/system/cpu/cpufreq") {
        for e in rd.flatten() {
            let p = e.path().join("scaling_governor");
            if p.exists() && std::fs::write(&p, gov).is_ok() { gov_changed += 1; }
        }
    }
    // 2. Renice non-foreground user processes (background tasks).
    // Heuristic: any process owned by current UID, that has no controlling
    // tty AND isn't the active foreground window's PID, gets nice +10 / ionice idle.
    if enable {
        let _ = Command::new("sh").arg("-c").arg(
            "for pid in $(ps -u \"$(id -u)\" -o pid= --no-headers); do \
                tty=$(ps -o tty= -p $pid 2>/dev/null | tr -d ' '); \
                [ \"$tty\" = '?' ] || continue; \
                renice -n 10 -p $pid >/dev/null 2>&1; \
                ionice -c 3 -p $pid >/dev/null 2>&1; \
            done"
        ).status();
    } else {
        let _ = Command::new("sh").arg("-c").arg(
            "for pid in $(ps -u \"$(id -u)\" -o pid= --no-headers); do \
                renice -n 0 -p $pid >/dev/null 2>&1; \
                ionice -c 2 -n 4 -p $pid >/dev/null 2>&1; \
            done"
        ).status();
    }
    format!(r#"{{"ok":true,"governor":"{}","cpus_changed":{}}}"#, gov, gov_changed)
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
    // Mode: 0=auto location, 1=manual times, 2=location coords, 3=constant
    let mode = run("kreadconfig6",&["--file","kwinrc","--group","NightColor","--key","Mode"]).await;
    let begin = run("kreadconfig6",&["--file","kwinrc","--group","NightColor","--key","EveningBeginFixed"]).await;
    let morn = run("kreadconfig6",&["--file","kwinrc","--group","NightColor","--key","MorningBeginFixed"]).await;
    // KDE stores HHMMSS strings (e.g. "1800"). Normalise to HH:MM.
    let fmt = |s: &str, def: &str| -> String {
        let s = if s.is_empty() { def } else { s };
        let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        let p = format!("{:0>4}", digits);
        if p.len() >= 4 { format!("{}:{}", &p[0..2], &p[2..4]) } else { def.to_string() }
    };
    format!(r#"{{"active":{},"temperature":{},"mode":"{}","evening":"{}","morning":"{}"}}"#,
        a=="true", if t.is_empty(){"4500".into()}else{t},
        if mode.is_empty(){"0".into()}else{esc(mode.trim())},
        fmt(begin.trim(),"18:00"), fmt(morn.trim(),"06:00"))
}

// Configure a fixed-time night light schedule (Mode=1). Times are "HH:MM".
#[tauri::command] async fn set_nightlight_schedule(scheduled: bool, evening: String, morning: String, temperature: Option<u32>) -> String {
    // Mode 1 = custom times, Mode 3 = always on (constant).
    let mode = if scheduled { "1" } else { "3" };
    run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","Active","true"]).await;
    run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","Mode",mode]).await;
    if scheduled {
        let to_kde = |hhmm: &str| hhmm.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
        let ev = to_kde(&evening); let mo = to_kde(&morning);
        run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","EveningBeginFixed",&ev]).await;
        run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","MorningBeginFixed",&mo]).await;
    }
    if let Some(t) = temperature {
        run("kwriteconfig6",&["--file","kwinrc","--group","NightColor","--key","NightTemperature",&t.to_string()]).await;
    }
    run("qdbus6",&["org.kde.KWin","/KWin","reconfigure"]).await;
    r#"{"ok":true}"#.into()
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

/// Balance: -100=full left, 0=center, 100=full right.
/// Converts to pactl dual-channel volume: e.g. balance=+50 → L=75%, R=100%
/// Balance: -100=full left, 0=center, 100=full right.
/// Sets per-channel volume on the default sink, scaling current overall volume.
/// Requires pactl/pipewire-pulse. Uses `wpctl` as fallback for native PipeWire.
#[tauri::command] async fn set_balance(balance: i32) -> String {
    let b = balance.clamp(-100, 100);
    // Read current overall volume so we don't reset it.
    let cur = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"]).await;
    let base: u32 = cur.split('/').nth(1)
        .and_then(|s| s.trim().trim_end_matches('%').trim().parse().ok())
        .unwrap_or(50);
    // Compute per-channel percentages relative to base
    let (l_pct, r_pct): (u32, u32) = if b <= 0 {
        (base, ((base as i32 + (base as i32 * b / 100)).max(0)) as u32)
    } else {
        (((base as i32 - (base as i32 * b / 100)).max(0)) as u32, base)
    };
    // Pactl accepts: "set-sink-volume SINK 80% 60%" (one value per channel)
    let l_str = format!("{}%", l_pct);
    let r_str = format!("{}%", r_pct);
    let _ = run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &l_str, &r_str]).await;
    set_bookos_setting("AudioBalance".into(), b.to_string());
    eprintln!("[balance] base={}% L={} R={} balance={}", base, l_pct, r_pct, b);
    format!(r#"{{"ok":true,"l":{},"r":{},"base":{}}}"#, l_pct, r_pct, base)
}

#[tauri::command] fn get_balance() -> String {
    let b = get_bookos_setting("AudioBalance".into(), "0".into())
        .parse::<i32>().unwrap_or(0).clamp(-100, 100);
    format!(r#"{{"balance":{}}}"#, b)
}

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
    // Only parse the tail (~24h worth) — the file can hold weeks of samples
    // and parsing it all made the chart slow to load.
    let lines: Vec<&str> = content.lines().skip(1).collect();
    let tail_start = lines.len().saturating_sub(2880);
    let mut rows: Vec<String> = Vec::new();
    for line in &lines[tail_start..] {
        let p: Vec<&str> = line.split(',').collect();
        if p.len() >= 5 {
            if let (Ok(day), Ok(h), Ok(m), Ok(lvl)) = (
                p[0].trim().parse::<u32>(),
                p[1].trim().parse::<u32>(),
                p[2].trim().parse::<u32>(),
                p[3].trim().parse::<u32>(),
            ) {
                let power_uw: u64 = p.get(5).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                let ts: i64 = p.get(6).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                rows.push(format!(r#"{{"day":{},"h":{},"m":{},"level":{},"state":"{}","power_uw":{},"ts":{}}}"#,
                    day, h, m, lvl, esc(p[4].trim()), power_uw, ts));
            }
        }
    }
    format!(r#"{{"ok":true,"rows":[{}]}}"#, rows.join(","))
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

    // Scan typec ports — kernel pd revision is often hardcoded (e.g. 1.1)
    // by Samsung firmware, so we trust usb_type from ucsi-source-psy more.
    let mut kernel_pd_rev = String::new();
    let mut op_mode_raw   = String::new();
    if let Ok(rd) = std::fs::read_dir("/sys/class/typec") {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("port") || name.contains("partner") { continue; }
            let role = read_str(&format!("{}/power_role", p.display()));
            if role.contains("[sink]") {
                kernel_pd_rev = read_str(&format!("{}/usb_power_delivery_revision", p.display()));
                op_mode_raw   = read_str(&format!("{}/power_operation_mode", p.display()));
                break;
            }
        }
    }
    // ucsi-source-psy: usb_type tells real capability (PD, PD_PPS, BC1.2, ...)
    let mut usb_type_raw = String::new();
    let (mut v_max, mut c_max) = (0u64, 0u64);
    if let Ok(rd) = std::fs::read_dir("/sys/class/power_supply") {
        for e in rd.flatten() {
            let n = e.file_name().into_string().unwrap_or_default();
            if !n.starts_with("ucsi-source-psy") { continue; }
            if read_u64(&format!("/sys/class/power_supply/{n}/online")) != 1 { continue; }
            v_max = read_u64(&format!("/sys/class/power_supply/{n}/voltage_max"));
            c_max = read_u64(&format!("/sys/class/power_supply/{n}/current_max"));
            usb_type_raw = read_str(&format!("/sys/class/power_supply/{n}/usb_type"));
            break;
        }
    }
    // Pick selected usb_type (the one in [brackets]), fall back to whole string
    let selected_type = {
        let s = &usb_type_raw;
        if let (Some(a), Some(b)) = (s.find('['), s.find(']')) {
            if b > a { s[a+1..b].to_string() } else { s.clone() }
        } else { s.clone() }
    };
    // Derive a reasonable protocol label
    let protocol = if selected_type.contains("PD_PPS") || usb_type_raw.contains("PD_PPS") {
        "USB-PD 3.0 (PPS)".to_string()
    } else if selected_type.contains("PD") || usb_type_raw.contains("[PD") {
        // Trust kernel revision only when it looks plausible (>=2.0)
        let rev_ok = kernel_pd_rev.starts_with('2') || kernel_pd_rev.starts_with('3');
        if rev_ok { format!("USB-PD {}", kernel_pd_rev) } else { "USB-PD".to_string() }
    } else if selected_type.contains("C") {
        "USB-C".to_string()
    } else if !selected_type.is_empty() {
        selected_type.clone()
    } else if ac_online {
        "Conectado".to_string()
    } else {
        String::new()
    };

    // Adapter rated wattage from negotiated PDO. Many ucsi drivers leave this
    // at 0 — caller will fall back to live max measurement.
    let adapter_w = v_max.saturating_mul(c_max) / 1_000_000_000_000;

    // Persistent peak power this session: track the highest power_uw seen
    // while charging since the app started; useful when adapter_w is 0.
    use std::sync::atomic::{AtomicU64, Ordering};
    static PEAK_UW: AtomicU64 = AtomicU64::new(0);
    if charging && power_uw > PEAK_UW.load(Ordering::Relaxed) {
        PEAK_UW.store(power_uw, Ordering::Relaxed);
    }
    if !ac_online { PEAK_UW.store(0, Ordering::Relaxed); }
    let peak_uw = PEAK_UW.load(Ordering::Relaxed);

    format!(r#"{{"ok":true,"charging":{},"ac_online":{},"current_ua":{},"voltage_uv":{},"power_uw":{},"peak_uw":{},"status":"{}","pd_rev":"{}","op_mode":"{}","protocol":"{}","adapter_w":{},"usb_type":"{}"}}"#,
        charging, ac_online, current_ua, voltage_uv, power_uw, peak_uw,
        esc(&status), esc(&kernel_pd_rev), esc(&op_mode_raw), esc(&protocol), adapter_w, esc(&selected_type))
}

/// Camera privacy toggle — chmod /dev/video* devices to block access.
/// More reliable than modprobe -r (which can fail if any app holds the device).
#[tauri::command] async fn set_camera_enabled(enable: bool) -> String {
    let mode = if enable { "0660" } else { "0000" };
    // chmod every /dev/video* device. Requires pkexec (root).
    let script = format!(
        "for d in /dev/video*; do [ -e \"$d\" ] && chmod {} \"$d\"; done",
        mode
    );
    let r = Command::new("pkexec").args(&["sh", "-c", &script]).output().await;
    match r {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{e}"}}"#),
    }
}

#[tauri::command] fn get_camera_enabled() -> String {
    // Camera "enabled" if at least one /dev/video* has read perm for group
    let enabled = std::fs::read_dir("/dev").map(|d| {
        d.flatten().any(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("video") { return false; }
            std::fs::metadata(e.path()).map(|m| {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o060 != 0
            }).unwrap_or(false)
        })
    }).unwrap_or(true);
    format!(r#"{{"enabled":{}}}"#, enabled)
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
/// Toggle the adaptive-charging system timer.
///
/// We never call plain `systemctl` first because that triggers Polkit's
/// own auth popup. Instead, the first call always returns `needs_auth:true`
/// so the frontend can show its own promptAuth dialog and re-invoke with
/// the password — which we then forward to `sudo -S`.
#[tauri::command] async fn set_adaptive_charging(enabled: bool, password: Option<String>) -> String {
    use tokio::io::AsyncWriteExt;
    let timer = "bookos-battery-adaptive.timer";
    let action = if enabled { "enable" } else { "disable" };

    // No password yet → tell the frontend to prompt. Skip Polkit entirely.
    let pw = match password {
        Some(p) if !p.is_empty() => p,
        _ => return format!(r#"{{"ok":false,"needs_auth":true,"enabled":{}}}"#, enabled),
    };

    // Use sudo -S so PAM authenticates from our supplied password and
    // Polkit's session agent stays out of the picture.
    let mut child = match tokio::process::Command::new("sudo")
        .args(["-S", "-p", "", "systemctl", action, "--now", timer])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", pw).as_bytes()).await;
        drop(sin);
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => format!(r#"{{"ok":true,"enabled":{}}}"#, enabled),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

// ── Display / Resolution ─────────────────────────────────────────────────
#[tauri::command] async fn get_display_info() -> String {
    let raw = run("kscreen-doctor",&["-o"]).await;
    // kscreen-doctor emits ANSI colour codes even when piped — strip them or
    // line prefixes like "Output:" never match.
    let mut out = String::with_capacity(raw.len());
    {
        let mut chars = raw.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\x1b' { while let Some(nc) = chars.next() { if nc.is_ascii_alphabetic() { break; } } }
            else { out.push(c); }
        }
    }
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

/// Logout current session. Faster than reboot, applies theme to all apps cleanly.
#[tauri::command]
async fn logout_session() -> String {
    // Plasma session manager — clean logout, no confirm dialog.
    let _ = run("qdbus6", &["org.kde.LogoutPrompt","/LogoutPrompt","logout"]).await;
    let _ = run("qdbus6", &["org.kde.Shutdown","/Shutdown","logout"]).await;
    let _ = run("loginctl", &["terminate-session", "self"]).await;
    r#"{"ok":true}"#.into()
}

/// Sync the `variant=` line of the BookOS SDDM theme.conf so the lockscreen QML
/// (which reads that file) picks up the user's chosen light/dark mode.
/// Requires sudo cached or polkit rule; silent no-op if not writable.
async fn sync_sddm_variant(is_dark: bool) {
    // Per-user override mirrors /usr/share/.../theme.conf but is writable without sudo.
    // Lockscreen QML reads /usr/share/sddm/themes/bookos/theme.conf; we use a separate
    // user-writable file and let the lockscreen check both. To avoid root for routine
    // theme switches, we ALSO write to ~/.config/bookos-sddm-variant which the
    // lockscreen reads as override.
    let home = match std::env::var("HOME") { Ok(h) => h, Err(_) => return };
    let user_override = format!("{}/.config/bookos-sddm-variant", home);
    let new_variant = if is_dark { "dark" } else { "light" };
    let _ = std::fs::write(&user_override, format!("variant={}\n", new_variant));

    // Also try silent direct write to /usr/share if user already has perm (no prompt).
    let conf_path = "/usr/share/sddm/themes/bookos/theme.conf";
    if let Ok(cur) = std::fs::read_to_string(conf_path) {
        let mut found = false;
        let mut out: Vec<String> = cur.lines().filter_map(|l| {
            let trimmed = l.trim();
            // Self-heal: drop garbage lines (no '=', not a section header/comment),
            // e.g. a stray "1408" that would corrupt the theme.conf.
            if !trimmed.is_empty()
                && !trimmed.starts_with('[')
                && !trimmed.starts_with('#')
                && !trimmed.contains('=') {
                return None;
            }
            if l.starts_with("variant=") {
                found = true;
                Some(format!("variant={}", new_variant))
            } else { Some(l.to_string()) }
        }).collect();
        if !found { out.push(format!("variant={}", new_variant)); }
        let new_content = out.join("\n") + "\n";
        if new_content != cur {
            // Only direct fs::write — no pkexec. If it fails, the per-user
            // override above is enough for the lockscreen.
            let _ = std::fs::write(conf_path, &new_content);
        }
    }
}

/// Tell running apps a theme change happened so they re-style without restart.
/// Strictly non-invasive: only fires D-Bus signals + gsettings. Does NOT restart
/// plasmashell, kwin, or any service.
async fn notify_theme_change(is_dark: bool) {
    // Tell KDE platform theme module to reload palette (Qt apps with KDE integration).
    // Soft refresh — module re-reads config files, no process restart.
    run("qdbus6", &["org.kde.kded6", "/modules/kdeplatformtheme", "refresh"]).await;
    // Broadcast KGlobalSettings palette-changed signal so all Qt apps repaint.
    run("dbus-send", &["--session","--type=signal","/KGlobalSettings",
        "org.kde.KGlobalSettings.notifyChange","int32:0","int32:0"]).await;
    // GTK3/4 apps watch this gsetting and re-style automatically.
    let gtk_color = if is_dark { "prefer-dark" } else { "prefer-light" };
    run("gsettings", &["set","org.gnome.desktop.interface","color-scheme",gtk_color]).await;
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
    let theme = if is_dark { "BookOS-Dark" } else { "BookOS-Light" };
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
    let is_dark = theme_is_dark(&name);
    // Persist intent first so any failures still leave config consistent.
    let mut cfg = load_bookos_settings();
    cfg["ThemeIsDark"] = serde_json::Value::Bool(is_dark);
    cfg["ThemeScheme"] = serde_json::Value::String(name.clone());
    save_bookos_settings(&cfg);

    let (kv, pt) = get_kv_pt(&cfg, is_dark);
    let gtk_color = if is_dark {"prefer-dark"} else {"prefer-light"};
    let name_ref = name.as_str();
    let kv_ref = kv.as_str();
    let pt_ref = pt.as_str();

    let base_args_look: [&str; 2] = ["--apply", name_ref];
    let base_args_color: [&str; 1] = [name_ref];
    let kv_args: [&str; 2] = ["--set", kv_ref];
    let pt_args: [&str; 1] = [pt_ref];
    let gtk_args: [&str; 4] = ["set","org.gnome.desktop.interface","color-scheme",gtk_color];

    let base_fut = async {
        if is_global { run("plasma-apply-lookandfeel", &base_args_look).await }
        else         { run("plasma-apply-colorscheme",  &base_args_color).await }
    };
    let (_a,_b,_c,_d) = tokio::join!(
        base_fut,
        run("kvantummanager", &kv_args),
        run("plasma-apply-desktoptheme", &pt_args),
        run("gsettings", &gtk_args),
    );
    let _ = tokio::join!(
        apply_gtk_theme(&cfg, is_dark),
        apply_lockscreen_theme(is_dark),
    );
    sync_sddm_variant(is_dark).await;
    notify_theme_change(is_dark).await;
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
    let sl = scheme.to_lowercase();
    let is_dark = sl.contains("dark") || sl.contains("mocha") || sl.contains("frappe") || sl.contains("macchiato") || sl.contains("noir") || sl.contains("night") || sl.contains("midnight") || sl.contains("dracula") || sl.contains("gruvbox") || sl.contains("nord") || sl.contains("tokyo") || sl.contains("onedark") || sl.contains("heimdal") || sl.contains("emerald-smooth") || sl.contains("cachyos-dark");
    let mut cfg = load_bookos_settings();
    cfg["ThemeIsDark"] = serde_json::Value::Bool(is_dark);
    cfg["ThemeScheme"] = serde_json::Value::String(scheme.clone());
    save_bookos_settings(&cfg);

    let (kv, pt) = get_kv_pt(&cfg, is_dark);
    let gtk_color = if is_dark {"prefer-dark"} else {"prefer-light"};
    let scheme_ref = scheme.as_str();
    let kv_ref = kv.as_str();
    let pt_ref = pt.as_str();
    let cs_args:  [&str; 1] = [scheme_ref];
    let kv_args:  [&str; 2] = ["--set", kv_ref];
    let pt_args:  [&str; 1] = [pt_ref];
    let gtk_args: [&str; 4] = ["set","org.gnome.desktop.interface","color-scheme",gtk_color];
    let _ = tokio::join!(
        run("plasma-apply-colorscheme", &cs_args),
        run("kvantummanager", &kv_args),
        run("plasma-apply-desktoptheme", &pt_args),
        run("gsettings", &gtk_args),
    );
    let _ = tokio::join!(
        apply_gtk_theme(&cfg, is_dark),
        apply_lockscreen_theme(is_dark),
    );
    sync_sddm_variant(is_dark).await;
    notify_theme_change(is_dark).await;
    r#"{"ok":true}"#.into()
}

// ── BookOS icon style (Light / Dark / Tinted) ───────────────────────────
// Each app icon is a rounded square (neutral dark/light background) with the
// app logo on top. "Tinted" keeps the neutral square and recolours just the
// LOGO to a monochrome tint of the chosen hue — iOS style.

// Candidate source locations for the shipped packs.
// variant: "light" | "dark" | "tinted-light" | "tinted-dark"
fn icon_pack_src(variant: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let name = match variant {
        "light"        => "BookOS-Icon-Pack-Light",
        "tinted-dark"  => "BookOS-Icon-Pack-Tinted-Dark",
        "tinted-light" => "BookOS-Icon-Pack-Tinted-Light",
        _              => "BookOS-Icon-Pack-Dark",
    };
    let roots = [
        format!("{}/Descargas/BookOS/Icons", home),
        "/usr/share/bookos/icons".to_string(),
        format!("{}/.local/share/bookos/icons", home),
    ];
    for r in &roots {
        let p = std::path::PathBuf::from(format!("{}/{}", r, name));
        if p.join("index.theme").exists() { return Some(p); }
    }
    None
}

fn icons_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(format!("{}/.local/share/icons", home))
}

// Copy a directory tree recursively (std-only).
fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() { copy_tree(&path, &target)?; }
        else { std::fs::copy(&path, &target)?; }
    }
    Ok(())
}

// hue 0-360, strength 0-100 → (r,g,b) floats 0-1.
// strength low = strong/saturated, high = washed toward white (matches the UI slider).
fn tint_rgb(hue: f64, strength: f64) -> (f64, f64, f64) {
    let sat = (0.90 - (strength / 100.0) * 0.55).clamp(0.0, 1.0);
    let light = (0.42 + (strength / 100.0) * 0.38).clamp(0.0, 1.0);
    let c = (1.0 - (2.0 * light - 1.0).abs()) * sat;
    let h = hue / 60.0;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match h as i32 {
        0 => (c, x, 0.0), 1 => (x, c, 0.0), 2 => (0.0, c, x),
        3 => (0.0, x, c), 4 => (x, 0.0, c), _ => (c, 0.0, x),
    };
    let m = light - c / 2.0;
    ((r1 + m).clamp(0.0, 1.0), (g1 + m).clamp(0.0, 1.0), (b1 + m).clamp(0.0, 1.0))
}

// QSvgRenderer (what KDE uses to rasterise icons) implements SVG Tiny and
// IGNORES <filter> elements entirely, so the tint cannot be a filter — it has
// to be baked into the fills. We rewrite every hex colour in the logo to the
// tint colour scaled by the original's luminance (same mapping the old
// feComponentTransfer filter described: out = tint * (0.45 + 0.55 * lum)).
fn tint_hex_color(hex: &str, r: f64, g: f64, b: f64) -> Option<String> {
    let v: Vec<u32> = hex.chars().map(|c| c.to_digit(16)).collect::<Option<_>>()?;
    let (or, og, ob) = match v.len() {
        6 => ((v[0] * 16 + v[1]) as f64, (v[2] * 16 + v[3]) as f64, (v[4] * 16 + v[5]) as f64),
        3 => ((v[0] * 17) as f64, (v[1] * 17) as f64, (v[2] * 17) as f64),
        _ => return None,
    };
    let lum = (0.2126 * or + 0.7152 * og + 0.0722 * ob) / 255.0;
    let f = 0.45 + 0.55 * lum;
    Some(format!("{:02X}{:02X}{:02X}",
        (r * f * 255.0).round() as u8,
        (g * f * 255.0).round() as u8,
        (b * f * 255.0).round() as u8))
}

// Replace every #RRGGBB / #RGB in `s` with its tinted equivalent.
fn tint_svg_colors(s: &str, r: f64, g: f64, b: f64) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let hexlen = bytes[i + 1..].iter().take(7).take_while(|c| c.is_ascii_hexdigit()).count();
            // 6 or 3 digits, not followed by another hex digit (avoids ids like #a1b2c3d4)
            let take = if hexlen >= 6 { 6 } else if hexlen >= 3 { 3 } else { 0 };
            if (take == 6 && hexlen == 6) || (take == 3 && hexlen == 3) {
                let hex = &s[i + 1..i + 1 + take];
                if let Some(t) = tint_hex_color(hex, r, g, b) {
                    out.push('#');
                    out.push_str(&t);
                    i += 1 + take;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

// Install a pack into ~/.local/share/icons/<theme_name>.
// When `tint` (r,g,b 0-1) is given, every app icon's logo is recoloured to a
// monochrome tint of that colour (iOS style); the rounded background is left
// untouched (neutral per light/dark mode).
fn install_icon_pack(variant: &str, theme_name: &str, base_tint: Option<(f64, f64, f64)>, logo_tint: Option<(f64, f64, f64)>) -> Result<String, String> {
    let src = icon_pack_src(variant).ok_or_else(|| format!("pack '{}' no encontrado", variant))?;
    let dst = icons_dir().join(theme_name);
    let _ = std::fs::remove_dir_all(&dst);
    if base_tint.is_none() && logo_tint.is_none() {
        copy_tree(&src, &dst).map_err(|e| e.to_string())?;
    } else {
        // Single pass: copy everything except apps/ verbatim; the app icons
        // are tinted while copying (instead of copy + rewrite = double IO).
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == "apps" { continue; }
            let p = entry.path();
            let t = dst.join(entry.file_name());
            if p.is_dir() { copy_tree(&p, &t).map_err(|e| e.to_string())?; }
            else { std::fs::copy(&p, &t).map_err(|e| e.to_string())?; }
        }
    }

    // Set the theme Name= inside index.theme so KDE shows it distinctly.
    let idx = dst.join("index.theme");
    if let Ok(content) = std::fs::read_to_string(&idx) {
        let new: String = content.lines().map(|l| {
            if l.trim_start().starts_with("Name=") { format!("Name={}", theme_name) } else { l.to_string() }
        }).collect::<Vec<_>>().join("\n");
        let _ = std::fs::write(&idx, new + "\n");
    }

    // Apply the tint. Colours are rewritten in place (no SVG filter —
    // QSvgRenderer ignores filters, so a filter-based tint renders as no tint
    // at all). The rounded BASE rect always takes the tint colour; the logo
    // is only recoloured (luminance-mapped) when `tint_logo` is set.
    if base_tint.is_some() || logo_tint.is_some() {
        let base_hex = base_tint.map(|(r, g, b)| format!("{:02X}{:02X}{:02X}",
            (r * 255.0).round() as u8, (g * 255.0).round() as u8, (b * 255.0).round() as u8));
        let src_apps = src.join("apps").join("scalable");
        let dst_apps = dst.join("apps").join("scalable");
        std::fs::create_dir_all(&dst_apps).map_err(|e| e.to_string())?;
        let files: Vec<_> = std::fs::read_dir(&src_apps)
            .map_err(|e| e.to_string())?
            .flatten().map(|e| e.path()).collect();
        // ~8k files: split across threads — the per-file work is tiny, the
        // wall time is IO + string churn, parallelism cuts it ~4x.
        let nthreads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        let chunk = files.len().div_ceil(nthreads);
        std::thread::scope(|s| {
            for part in files.chunks(chunk.max(1)) {
                let dst_apps = &dst_apps;
                let base_hex = &base_hex;
                s.spawn(move || {
                    for p in part {
                        let target = dst_apps.join(p.file_name().unwrap_or_default());
                        if p.extension().and_then(|x| x.to_str()) != Some("svg") {
                            let _ = std::fs::copy(p, &target);
                            continue;
                        }
                        let Ok(svg) = std::fs::read_to_string(p) else { continue };
                        if let Some(pos) = svg.find("<g transform=") {
                            let (head, logo) = svg.split_at(pos);
                            // The generator writes the base colour as an isolated
                            // `fill="#XXXXXX"` on the <rect> before the logo group.
                            let mut new_head = head.to_string();
                            if let Some(hex) = base_hex.as_deref() {
                                if let Some(fp) = head.find("fill=\"#") {
                                    let start = fp + 7;
                                    if head.len() >= start + 6 {
                                        new_head.replace_range(start..start + 6, hex);
                                    }
                                }
                            }
                            let new_logo = match logo_tint {
                                Some((r, g, b)) => tint_svg_colors(logo, r, g, b),
                                None => logo.to_string(),
                            };
                            let _ = std::fs::write(&target, format!("{}{}", new_head, new_logo));
                        } else {
                            let _ = std::fs::copy(p, &target);
                        }
                    }
                });
            }
        });
    }
    Ok(theme_name.to_string())
}

// Apply the chosen icon theme to KDE live.
async fn apply_icon_theme(theme: &str) {
    // plasma-changeicons no-ops when kdeglobals already names the target theme,
    // so it must run BEFORE kwriteconfig (it lives outside PATH on Arch — try both).
    let r = run("/usr/lib/plasma-changeicons", &[theme]).await;
    if r.contains("No such file") { run("plasma-changeicons", &[theme]).await; }
    run("kwriteconfig6", &["--file","kdeglobals","--group","Icons","--key","Theme", theme]).await;
    // plasma-changeicons already notifies KIconLoader/Plasma; kbuildsycoca6 and
    // extra dbus signals here only added seconds without visible effect.
    run("dbus-send", &["--session","--type=signal","/KIconLoader","org.kde.KIconLoader.iconChanged","int32:0"]).await;
}

/// Set the BookOS app-icon style.
/// mode: "light" | "dark" | "tinted".
/// For tinted: hue 0-360 + strength 0-100, and `dark` picks the base (the
/// tinted icon keeps a dark or light square depending on the system mode).
#[tauri::command]
async fn set_icon_style(mode: String, hue: Option<f64>, strength: Option<f64>, dark: Option<bool>, tint_base: Option<bool>, tint_logo: Option<bool>, logo_hue: Option<f64>) -> String {
    let theme = match mode.as_str() {
        "light" => match install_icon_pack("light", "BookOS-Light", None, None) {
            Ok(t) => t,
            // Light pack missing → fall back to the dark pack art.
            Err(_) => match install_icon_pack("dark", "BookOS-Light", None, None) {
                Ok(t) => t, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e)),
            },
        },
        "dark" => match install_icon_pack("dark", "BookOS-Dark", None, None) {
            Ok(t) => t, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e)),
        },
        "tinted" => {
            // Base and logo are tinted independently; the logo has its own hue.
            let st = strength.unwrap_or(45.0);
            let base = if tint_base.unwrap_or(true) { Some(tint_rgb(hue.unwrap_or(210.0), st)) } else { None };
            let logo = if tint_logo.unwrap_or(false) { Some(tint_rgb(logo_hue.or(hue).unwrap_or(210.0), st)) } else { None };
            let is_dark = dark.unwrap_or(true);
            // Re-applying the SAME theme name is a no-op for Plasma (icon cache
            // is keyed by name), so alternate between two names — each apply is
            // then a real theme switch: one repaint, no cache nuking.
            let cur = run("kreadconfig6", &["--file","kdeglobals","--group","Icons","--key","Theme"]).await;
            let name = if cur.trim() == "BookOS-Tinted" { "BookOS-Tinted-B" } else { "BookOS-Tinted" };
            // The pack rewrite touches ~8k SVGs — run it off the async runtime
            // so the UI stays responsive.
            let nm = name.to_string();
            let res = tauri::async_runtime::spawn_blocking(move || {
                let src_variant = if is_dark { "tinted-dark" } else { "tinted-light" };
                install_icon_pack(src_variant, &nm, base, logo)
                    .or_else(|_| install_icon_pack(if is_dark {"dark"} else {"light"}, &nm, base, logo))
            }).await.unwrap_or_else(|e| Err(e.to_string()));
            match res { Ok(t) => t, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e)) }
        },
        _ => return r#"{"ok":false,"error":"modo inválido"}"#.into(),
    };
    apply_icon_theme(&theme).await;
    format!(r#"{{"ok":true,"theme":"{}"}}"#, esc(&theme))
}

// ── Notifications ────────────────────────────────────────────────────────
#[tauri::command] async fn get_dnd_status() -> String {
    let d = run("kreadconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until"]).await;
    format!(r#"{{"dnd_active":{}}}"#,!d.is_empty())
}
#[tauri::command] async fn toggle_dnd(enable: bool) -> String {
    // Plasma stores Until as a KConfig QDateTime list ("y,M,d,h,m,s"), NOT ISO.
    // An ISO string fails to parse and DnD silently never engages.
    if enable { run("kwriteconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until","2099,12,31,23,59,59"]).await; }
    else { run("kwriteconfig6",&["--file","plasmanotifyrc","--group","DoNotDisturb","--key","Until","--delete"]).await; }
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
const AUTOSTART_DESKTOP: &str = "[Desktop Entry]\nName=BookOS Settings\nExec=bookos-settings --hidden\nIcon=preferences-system\nType=Application\nNoDisplay=true\nX-KDE-autostart-phase=1\n";
fn autostart_optout_path() -> String { format!("{}/.config/bookos-settings-autostart.disabled", std::env::var("HOME").unwrap_or_default()) }
#[tauri::command] async fn toggle_autostart_bookos(enable: bool) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = format!("{}/.config/autostart/bookos-settings.desktop", home);
    if enable {
        let _ = std::fs::create_dir_all(format!("{}/.config/autostart", home));
        let _ = std::fs::write(&p, AUTOSTART_DESKTOP);
        let _ = std::fs::remove_file(autostart_optout_path());
    } else {
        let _ = std::fs::remove_file(&p);
        // Opt-out marker so setup() doesn't re-create it on next launch
        let _ = std::fs::write(autostart_optout_path(), "");
    }
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_lock_timeout(minutes: u32) -> String {
    run("kwriteconfig6",&["--file","kscreenlockerrc","--group","Daemon","--key","Timeout",&minutes.to_string()]).await;
    // Reload kscreenlocker so change applies without logout
    run("qdbus6",&["org.kde.screensaver","/ScreenSaver","org.kde.screensaver.configure"]).await;
    r#"{"ok":true}"#.into()
}
/// Grace period (seconds without prompting password after wake).
/// Pass 0 for "immediately".
#[tauri::command] async fn set_lock_grace(seconds: u32) -> String {
    run("kwriteconfig6",&["--file","kscreenlockerrc","--group","Daemon","--key","LockGrace",&seconds.to_string()]).await;
    run("qdbus6",&["org.kde.screensaver","/ScreenSaver","org.kde.screensaver.configure"]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn get_lock_grace() -> String {
    let out = Command::new("kreadconfig6")
        .args(&["--file","kscreenlockerrc","--group","Daemon","--key","LockGrace","--default","0"])
        .output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "0".into());
    let s: u32 = out.parse().unwrap_or(0);
    format!(r#"{{"seconds":{}}}"#, s)
}
/// Validate the user's password without running anything privileged.
/// Returns `{"ok":true}` if accepted, `{"ok":false}` otherwise.
/// Uses `sudo -k` then `sudo -S -v` so PAM is the source of truth.
#[tauri::command] async fn verify_password(password: String) -> String {
    use tokio::io::AsyncWriteExt;
    // Drop the cached sudo timestamp so the test reflects the password actually entered.
    let _ = tokio::process::Command::new("sudo").arg("-k").status().await;

    let mut child = match tokio::process::Command::new("sudo")
        .args(["-S", "-p", "", "-v"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", password).as_bytes()).await;
        drop(sin);
    }
    let ok = matches!(child.wait().await, Ok(s) if s.success());
    format!(r#"{{"ok":{}}}"#, ok)
}

/// Listen for a fingerprint match. Resolves with `{"ok":true}` on a match,
/// `{"ok":false,"error":"..."}` on failure or timeout. Pairs with the auth dialog.
#[tauri::command] async fn verify_fingerprint() -> String {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let user = run("whoami", &[]).await;
    let mut child = match tokio::process::Command::new("fprintd-verify")
        .arg(&user)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };

    let stdout = match child.stdout.take() { Some(s) => s, None => return r#"{"ok":false,"error":"no stdout"}"#.into() };
    let mut reader = BufReader::new(stdout).lines();
    let mut matched = false;
    let mut output = String::new();
    while let Ok(Some(line)) = reader.next_line().await {
        output.push_str(&line);
        output.push('\n');
        if line.contains("verify-match") || line.contains("Verify result: verify-match") {
            matched = true;
        }
        if line.contains("verify-no-match") || line.contains("verify-disconnected")
            || line.contains("verify-unknown-error") || line.contains("verify-retry-scan") {
            // Don't break on retry — let fprintd handle multi-attempt cycle
            if !line.contains("verify-retry-scan") {
                break;
            }
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    if matched { r#"{"ok":true}"#.into() } else {
        format!(r#"{{"ok":false,"output":"{}"}}"#, esc(output.trim()))
    }
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
// 5-minute in-process cache for update checks. Re-running checkupdates / paru -Qua /
// flatpak remote-ls every page open is slow (network + DB sync). Force=true bypasses.
use std::sync::Mutex as StdMutex;
struct UpdCache { sys: Option<(std::time::Instant, String)>, aur: Option<(std::time::Instant, String)>, flat: Option<(std::time::Instant, String)> }
static UPD_CACHE: StdMutex<UpdCache> = StdMutex::new(UpdCache { sys: None, aur: None, flat: None });
const UPD_CACHE_TTL: u64 = 300; // 5 min

fn cache_get(which: &str) -> Option<String> {
    let g = UPD_CACHE.lock().ok()?;
    let entry = match which { "sys" => &g.sys, "aur" => &g.aur, "flat" => &g.flat, _ => return None };
    let (t, v) = entry.as_ref()?;
    if t.elapsed().as_secs() < UPD_CACHE_TTL { Some(v.clone()) } else { None }
}
fn cache_set(which: &str, v: String) {
    if let Ok(mut g) = UPD_CACHE.lock() {
        let now = std::time::Instant::now();
        match which { "sys" => g.sys = Some((now, v)), "aur" => g.aur = Some((now, v)), "flat" => g.flat = Some((now, v)), _ => {} }
    }
}

/// Detect the host distro's package manager. Result cached at first call.
/// Returns one of: "pacman" (Arch), "dnf5"/"dnf" (Fedora), "apt" (Debian/Ubuntu),
/// "zypper" (openSUSE), "unknown".
fn detect_pkg_mgr() -> &'static str {
    use std::sync::OnceLock;
    static MGR: OnceLock<&'static str> = OnceLock::new();
    MGR.get_or_init(|| {
        let p = std::path::Path::new;
        if p("/usr/bin/checkupdates").exists() || p("/usr/bin/pacman").exists() { "pacman" }
        else if p("/usr/bin/dnf5").exists()   { "dnf5" }
        else if p("/usr/bin/dnf").exists()    { "dnf" }
        else if p("/usr/bin/apt").exists()    { "apt" }
        else if p("/usr/bin/zypper").exists() { "zypper" }
        else { "unknown" }
    })
}

#[tauri::command] fn get_pkg_mgr() -> String {
    format!(r#"{{"manager":"{}"}}"#, detect_pkg_mgr())
}

#[tauri::command] async fn check_system_updates(force: Option<bool>) -> Result<String, String> {
    if !force.unwrap_or(false) { if let Some(c) = cache_get("sys") { return Ok(c); } }
    let mgr = detect_pkg_mgr();
    // Output normalised to {name, old, new}
    let pkgs: Vec<String> = match mgr {
        "pacman" => {
            let u = run("checkupdates", &[]).await;
            u.lines().filter(|l| !l.is_empty()).take(100).map(|l| {
                let p: Vec<&str> = l.split_whitespace().collect();
                format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#,
                    esc(p.first().unwrap_or(&"")), esc(p.get(1).unwrap_or(&"")), esc(p.last().unwrap_or(&"")))
            }).collect()
        }
        "dnf5" | "dnf" => {
            // dnf check-update prints "pkg.arch  newver  repo"
            // dnf may refresh repo metadata first, which on a slow mirror easily
            // exceeds the default 12s run() timeout — and a timeout returns "" =
            // false "0 updates / up to date". Give it room.
            let u = run_timeout(mgr, &["check-update", "--quiet"], 60_000).await;
            // The upgrade list ends at a blank line or the "Obsoleting Packages"
            // section; take_while stops there so obsoleted pkgs aren't counted as
            // updates. Skip indented continuation lines and any "Last metadata…".
            u.lines()
                .take_while(|l| { let t = l.trim(); !t.is_empty() && !t.starts_with("Obsoleting") })
                .filter(|l| l.starts_with(|c: char| c.is_ascii_alphanumeric()) && !l.starts_with("Last"))
                .take(100).map(|l| {
                    let p: Vec<&str> = l.split_whitespace().collect();
                    // Token is "name.arch" — strip only the trailing arch segment
                    // (rsplit) so versioned names like python3.11 survive.
                    let tok = *p.first().unwrap_or(&"");
                    let name = tok.rsplit_once('.').map(|(n, _)| n).unwrap_or(tok);
                    format!(r#"{{"name":"{}","old":"","new":"{}"}}"#,
                        esc(name), esc(p.get(1).unwrap_or(&"")))
                }).collect()
        }
        "apt" => {
            // apt list --upgradable: "pkg/repo new [from: old]"
            let u = run("apt", &["list", "--upgradable"]).await;
            u.lines().filter(|l| l.contains('/')).take(100).map(|l| {
                let name = l.split('/').next().unwrap_or("");
                let parts: Vec<&str> = l.split_whitespace().collect();
                let new = parts.get(1).unwrap_or(&"");
                let old = if let Some(idx) = l.find("from: ") {
                    l[idx+6..].trim_end_matches(']').to_string()
                } else { String::new() };
                format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#, esc(name), esc(&old), esc(new))
            }).collect()
        }
        "zypper" => {
            let u = run("zypper", &["--non-interactive", "list-updates"]).await;
            u.lines().filter(|l| l.starts_with("v ") || l.starts_with("| ")).take(100).filter_map(|l| {
                let parts: Vec<&str> = l.split('|').map(|s| s.trim()).collect();
                if parts.len() < 5 { return None; }
                Some(format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#,
                    esc(parts[2]), esc(parts[3]), esc(parts[4])))
            }).collect()
        }
        _ => Vec::new(),
    };
    let result = format!(r#"{{"count":{},"packages":[{}],"manager":"{}"}}"#, pkgs.len(), pkgs.join(","), mgr);
    cache_set("sys", result.clone());
    Ok(result)
}
#[tauri::command] async fn check_aur_updates(force: Option<bool>) -> Result<String, String> {
    // AUR is Arch-only. Empty result on other distros.
    if detect_pkg_mgr() != "pacman" {
        return Ok(r#"{"count":0,"packages":[]}"#.into());
    }
    if !force.unwrap_or(false) { if let Some(c) = cache_get("aur") { return Ok(c); } }
    let u = run("paru",&["-Qua"]).await;
    let pkgs: Vec<String> = u.lines().filter(|l| !l.is_empty()).take(100).map(|l| {
        let p: Vec<&str> = l.split_whitespace().collect();
        format!(r#"{{"name":"{}","old":"{}","new":"{}"}}"#,esc(p.first().unwrap_or(&"")),esc(p.get(1).unwrap_or(&"")),esc(p.last().unwrap_or(&"")))
    }).collect();
    let result = format!(r#"{{"count":{},"packages":[{}]}}"#,pkgs.len(),pkgs.join(","));
    cache_set("aur", result.clone());
    Ok(result)
}
/// True only if flatpak binary exists. Used by frontend to hide Flatpak tab.
#[tauri::command] fn has_flatpak() -> String {
    let ok = std::path::Path::new("/usr/bin/flatpak").exists()
          || std::path::Path::new("/var/lib/flatpak").exists();
    format!(r#"{{"available":{}}}"#, ok)
}

#[tauri::command] async fn check_flatpak_updates(force: Option<bool>) -> Result<String, String> {
    if !std::path::Path::new("/usr/bin/flatpak").exists() {
        return Ok(r#"{"count":0,"packages":[]}"#.into());
    }
    if !force.unwrap_or(false) { if let Some(c) = cache_get("flat") { return Ok(c); } }
    // remote-ls hits the network; the default 12s timeout can return "" (= false
    // "0 updates") on a slow connection. Allow more time.
    let u = run_timeout("flatpak",&["remote-ls","--updates","--columns=application,version"], 60_000).await;
    let pkgs: Vec<String> = u.lines().filter(|l| !l.is_empty()).map(|l| {
        let p: Vec<&str> = l.split('\t').collect();
        format!(r#"{{"name":"{}","version":"{}"}}"#,esc(p.first().unwrap_or(&"")),esc(p.get(1).unwrap_or(&"")))
    }).collect();
    let result = format!(r#"{{"count":{},"packages":[{}]}}"#,pkgs.len(),pkgs.join(","));
    cache_set("flat", result.clone());
    Ok(result)
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
        let mgr = detect_pkg_mgr();
        let use_paru = mgr == "pacman" && StdCommand::new("which").arg("paru").output()
            .map(|o| o.status.success()).unwrap_or(false);

        let child = if use_paru {
            StdCommand::new("paru")
                .args(["-Syu", "--noconfirm", "--sudoflags", "-S"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        } else if mgr == "dnf5" || mgr == "dnf" {
            // Snapshot before package upgrade when SnapshotPolicy=packages.
            let snap = if should_snapshot(true) { "snapper -c root create -d 'Antes de actualizar paquetes' 2>/dev/null; " } else { "" };
            let cmd = format!("{}{} upgrade -y", snap, mgr);
            StdCommand::new("sudo")
                .args(["-k", "-S", "sh", "-c", &cmd])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        } else if mgr == "apt" {
            StdCommand::new("sudo")
                .args(["-k", "-S", "sh", "-c", "apt update && apt upgrade -y"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        } else if mgr == "zypper" {
            StdCommand::new("sudo")
                .args(["-k", "-S", "zypper", "--non-interactive", "update"])
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
        "/usr/share/icons/hicolor/64x64/apps",
        "/usr/share/icons/hicolor/128x128/apps",
        "/usr/share/icons/hicolor/scalable/apps",
        "/usr/share/icons/hicolor/32x32/apps",
        "/usr/share/icons/breeze/apps/48",
        "/usr/share/icons/breeze/apps/64",
        "/usr/share/icons/breeze/apps/22",
        "/usr/share/icons/breeze-dark/apps/48",
        "/usr/share/icons/Papirus/64x64/apps",
        "/usr/share/icons/Papirus/48x48/apps",
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

            // Process names truncated by the kernel often differ from the
            // .desktop "Icon=" field. Map well-known cases first.
            let aliases: &[(&str, &[&str])] = &[
                ("firefox",        &["firefox", "firefox-default"]),
                ("firefox-bin",    &["firefox"]),
                ("code",           &["visual-studio-code", "code", "code-oss", "vscode"]),
                ("code-oss",       &["code-oss", "code"]),
                ("electron",       &["electron"]),
                ("konsole",        &["utilities-terminal", "konsole", "org.kde.konsole"]),
                ("kitty",          &["kitty"]),
                ("alacritty",      &["alacritty"]),
                ("dolphin",        &["system-file-manager", "dolphin", "org.kde.dolphin"]),
                ("kate",           &["kate", "org.kde.kate"]),
                ("gwenview",       &["gwenview", "org.kde.gwenview"]),
                ("spectacle",      &["spectacle", "org.kde.spectacle"]),
                ("plasmashell",    &["plasma", "plasmashell"]),
                ("kwin_wayland",   &["kwin"]),
                ("krunner",        &["krunner"]),
                ("vlc",            &["vlc"]),
                ("mpv",            &["mpv"]),
                ("steam",          &["steam"]),
                ("discord",        &["discord"]),
                ("telegram-deskto",&["telegram", "telegram-desktop"]),
                ("thunderbird",    &["thunderbird"]),
                ("chrome",         &["google-chrome"]),
                ("chromium",       &["chromium"]),
                ("brave",          &["brave-browser", "brave"]),
                ("obsidian",       &["obsidian"]),
                ("blender",        &["blender"]),
                ("gimp",           &["gimp"]),
                ("inkscape",       &["inkscape"]),
                ("claude",         &["claude"]),
                ("python",         &["python", "applications-development"]),
                ("python3",        &["python", "applications-development"]),
                ("node",           &["nodejs", "applications-development"]),
                ("cargo",          &["applications-development"]),
                ("rustc",          &["applications-development"]),
            ];

            let mut candidates: Vec<String> = vec![name.clone(), nl.clone()];
            for (key, aliases) in aliases {
                if nl == *key || nl.starts_with(key) {
                    candidates.extend(aliases.iter().map(|s| s.to_string()));
                    break;
                }
            }

            let mut icon = String::new();
            'outer: for cand in &candidates {
                for dir in &icon_dirs {
                    for ext in &icon_exts {
                        let path = format!("{}/{}.{}", dir, cand, ext);
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

// Get BookOS SDDM theme config
#[tauri::command] fn get_sddm_config() -> String {
    let conf = fs::read_to_string("/usr/share/sddm/themes/bookos/theme.conf").unwrap_or_default();
    let mut variant = "dark".to_string();
    let mut background = "solid".to_string();
    let mut bg_image = String::new();
    let mut accent_color = "#007AFF".to_string();
    let mut clock_format = "24h".to_string();
    let mut clock_font   = "serif".to_string();
    let mut blur_radius = "24".to_string();
    let mut show_date = "true".to_string();
    let mut show_battery = "true".to_string();
    let mut show_bookbar = "true".to_string();
    for line in conf.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("variant=")      { variant      = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("background=")   { background   = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("bgImage=")      { bg_image     = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("accentColor=")  { accent_color = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("clockFormat=")  { clock_format = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("clockFont=")    { clock_font   = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("blurRadius=")   { blur_radius  = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("showDate=")     { show_date    = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("showBattery=")  { show_battery = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("showBookBar=")  { show_bookbar = v.trim().to_string(); }
    }
    format!(r#"{{"variant":"{}","background":"{}","bgImage":"{}","accentColor":"{}","clockFormat":"{}","clockFont":"{}","blurRadius":"{}","showDate":"{}","showBattery":"{}","showBookBar":"{}"}}"#,
        esc(&variant), esc(&background), esc(&bg_image),
        esc(&accent_color), esc(&clock_format), esc(&clock_font), esc(&blur_radius),
        esc(&show_date), esc(&show_battery), esc(&show_bookbar))
}

// Set BookOS SDDM theme config (requires sudo)
#[tauri::command] async fn set_sddm_config(
    variant: String, background: String, bg_image: String,
    accent_color: String, clock_format: String, clock_font: String, blur_radius: String,
    show_date: String, show_battery: String, show_bookbar: String,
    password: String
) -> String {
    use std::io::Write;
    let conf = format!(
        "[General]\nvariant={}\nbackground={}\nbgImage={}\naccentColor={}\nclockFormat={}\nclockFont={}\nblurRadius={}\nshowDate={}\nshowBattery={}\nshowBookBar={}\n",
        variant, background, bg_image, accent_color, clock_format, clock_font, blur_radius, show_date, show_battery, show_bookbar
    );
    // Write to user tmp, then move into place with elevation.
    let tmp = format!("/tmp/.bookos-sddm-conf-{}", std::process::id());
    if let Err(e) = std::fs::write(&tmp, &conf) {
        return format!(r#"{{"ok":false,"error":"tmp write: {}"}}"#, esc(&e.to_string()));
    }
    let script = format!(
        "set -e; mkdir -p /usr/share/sddm/themes/bookos; cp '{tmp}' /usr/share/sddm/themes/bookos/theme.conf; chmod 644 /usr/share/sddm/themes/bookos/theme.conf; rm -f '{tmp}'",
        tmp = tmp
    );
    eprintln!("[set_sddm_config] script:\n{}", script);

    // Primary path: sudo -S with the provided password. Some Fedora/PAM setups
    // reject password-over-stdin, so we fall back to pkexec (graphical polkit
    // prompt) when sudo fails for any reason other than success.
    let try_sudo = |pw: &str| -> Result<bool, String> {
        let mut child = StdCommand::new("sudo")
            .args(["-S", "-p", "", "--", "sh", "-c", &script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().map_err(|e| e.to_string())?;
        if let Some(mut sin) = child.stdin.take() {
            let _ = sin.write_all(pw.as_bytes());
            let _ = sin.write_all(b"\n");
            drop(sin);
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(out.status.success())
    };

    let mut ok = false;
    let mut last_err = String::new();
    if !password.is_empty() {
        match try_sudo(&password) {
            Ok(true) => ok = true,
            Ok(false) => last_err = "sudo: autenticación fallida".into(),
            Err(e) => last_err = e,
        }
    }
    // Fallback: pkexec shows its own polkit dialog (no password handling here).
    if !ok && std::path::Path::new(&tmp).exists() {
        match StdCommand::new("pkexec").args(["sh", "-c", &script]).status() {
            Ok(s) if s.success() => ok = true,
            Ok(s) => last_err = format!("pkexec exit {}", s.code().unwrap_or(-1)),
            Err(e) => last_err = format!("pkexec: {}", e),
        }
    }
    let _ = std::fs::remove_file(&tmp);
    if ok { r#"{"ok":true}"#.into() }
    else {
        eprintln!("[set_sddm_config] FAIL: {}", last_err);
        format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&last_err))
    }
}

// ── BookOS lockscreen theme install/uninstall ───────────────────────────
// The lockscreen QML lives in `/usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen/`
// Plasma 6 doesn't honor look-and-feel for lockscreen, so we patch the shell directly.
// Source files come from /usr/share/bookos-settings/lockscreen/ (installed by package)
// or fall back to ~/.local/share/plasma/look-and-feel/BookOS-Light/contents/lockscreen/.
const LOCKSCREEN_FILES: &[&str] = &[
    "MainBlock.qml",
    "LockScreenUi.qml",
    "BookBar.qml",
    "MediaControls.qml",
];
const LOCKSCREEN_DEST: &str = "/usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen";
const LOCKSCREEN_BACKUP: &str = "/usr/share/plasma/shells/org.kde.plasma.desktop/contents/lockscreen/.backup";

fn lockscreen_source() -> Option<String> {
    let pkg = "/usr/share/bookos-settings/lockscreen";
    if std::path::Path::new(pkg).is_dir() { return Some(pkg.into()); }
    let home = std::env::var("HOME").ok()?;
    let local = format!("{}/.local/share/plasma/look-and-feel/BookOS-Light/contents/lockscreen", home);
    if std::path::Path::new(&local).is_dir() { return Some(local); }
    None
}

#[tauri::command] fn is_lockscreen_theme_installed() -> String {
    // Marker file written when our theme is active.
    let marker = format!("{}/.bookos-installed", LOCKSCREEN_DEST);
    let installed = std::path::Path::new(&marker).exists();
    format!(r#"{{"installed":{}}}"#, installed)
}

#[tauri::command] async fn install_lockscreen_theme(password: String) -> String {
    use std::io::Write;
    let src = match lockscreen_source() {
        Some(s) => s,
        None => return r#"{"ok":false,"error":"lockscreen QML stage not found at /usr/share/bookos-settings/lockscreen/ — reinstall bookos-settings"}"#.into(),
    };
    // Verify Plasma shell dir exists
    if !std::path::Path::new(LOCKSCREEN_DEST).is_dir() {
        return format!(r#"{{"ok":false,"error":"Plasma shell lockscreen not found at {}"}}"#, LOCKSCREEN_DEST).into();
    }
    // Verify source files actually exist
    for f in LOCKSCREEN_FILES {
        let p = format!("{}/{}", src, f);
        if !std::path::Path::new(&p).is_file() {
            return format!(r#"{{"ok":false,"error":"missing source file: {}"}}"#, esc(&p)).into();
        }
    }

    // set -e = abort on first error so we get a real error code
    let mut script = String::from("set -e; ");
    script.push_str(&format!("mkdir -p '{}'; ", LOCKSCREEN_BACKUP));
    for f in LOCKSCREEN_FILES {
        // Backup original if not yet backed up
        script.push_str(&format!(
            "if [ -f '{dest}/{file}' ] && [ ! -f '{bk}/{file}' ]; then cp '{dest}/{file}' '{bk}/{file}'; fi; ",
            dest=LOCKSCREEN_DEST, bk=LOCKSCREEN_BACKUP, file=f
        ));
        // Copy ours over — required, error if missing
        script.push_str(&format!(
            "cp '{src}/{file}' '{dest}/{file}'; ",
            src=src, dest=LOCKSCREEN_DEST, file=f
        ));
    }
    script.push_str(&format!("touch '{}/.bookos-installed'", LOCKSCREEN_DEST));

    eprintln!("[install_lockscreen] script:\n{}", script);

    let mut child = match StdCommand::new("sudo")
        .args(["-k", "-S", "-p", "", "--", "sh", "-c", &script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn() { Ok(c) => c, Err(e) => return format!(r#"{{"ok":false,"error":"spawn: {}"}}"#, esc(&e.to_string())) };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(password.as_bytes());
        let _ = sin.write_all(b"\n");
        drop(sin);
    }
    match child.wait_with_output() {
        Ok(o) if o.status.success() => {
            eprintln!("[install_lockscreen] OK");
            r#"{"ok":true}"#.into()
        },
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            eprintln!("[install_lockscreen] FAIL status={:?} stderr={}", o.status, err);
            format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&err))
        },
        Err(e) => format!(r#"{{"ok":false,"error":"wait: {}"}}"#, esc(&e.to_string())),
    }
}

#[tauri::command] async fn uninstall_lockscreen_theme(password: String) -> String {
    use std::io::Write;
    let mut script = String::new();
    for f in LOCKSCREEN_FILES {
        script.push_str(&format!(
            "[ -f \"{bk}/{file}\" ] && cp \"{bk}/{file}\" \"{dest}/{file}\"; ",
            bk=LOCKSCREEN_BACKUP, dest=LOCKSCREEN_DEST, file=f
        ));
    }
    script.push_str(&format!("rm -f \"{}/.bookos-installed\"", LOCKSCREEN_DEST));

    let mut child = match StdCommand::new("sudo")
        .args(["-k", "-S", "--", "sh", "-c", &script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn() { Ok(c) => c, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())) };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", password).as_bytes());
    }
    match child.wait_with_output() {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

// ── BookOS SDDM theme toggle ────────────────────────────────────────────
#[tauri::command] fn is_sddm_theme_installed() -> String {
    // The active SDDM theme can be selected from /etc/sddm.conf or *any* file in
    // /etc/sddm.conf.d/ (Arch's KDE setup uses kde_settings.conf, not our own
    // bookos-theme.conf), so scan all of them for Current=bookos.
    let mut installed = std::fs::read_to_string("/etc/sddm.conf")
        .map(|c| c.contains("Current=bookos")).unwrap_or(false);
    if !installed {
        if let Ok(entries) = std::fs::read_dir("/etc/sddm.conf.d") {
            for e in entries.flatten() {
                if let Ok(c) = std::fs::read_to_string(e.path()) {
                    if c.contains("Current=bookos") { installed = true; break; }
                }
            }
        }
    }
    format!(r#"{{"installed":{}}}"#, installed)
}

#[tauri::command] async fn install_sddm_theme(password: String) -> String {
    use std::io::Write;
    let dest = "/usr/share/sddm/themes/bookos";
    let staged = "/usr/share/bookos-settings/sddm-theme";

    if !std::path::Path::new(staged).is_dir() && !std::path::Path::new(dest).is_dir() {
        return r#"{"ok":false,"error":"SDDM theme stage not found at /usr/share/bookos-settings/sddm-theme — reinstall bookos-settings"}"#.into();
    }

    // Write SDDM conf to a tmpfile owned by the user, then sudo-mv it.
    // This avoids the cat-pipe-with-password hack.
    let tmp_conf = format!("/tmp/.bookos-sddm-conf-{}", std::process::id());
    let cfg = "[Theme]\nCurrent=bookos\nCursorTheme=Apple-cursors\n";
    if let Err(e) = std::fs::write(&tmp_conf, cfg) {
        return format!(r#"{{"ok":false,"error":"tmp write: {}"}}"#, esc(&e.to_string()));
    }

    let mut script = String::from("set -e; ");
    // Always refresh the theme files from the staged copy so updates to Main.qml
    // etc. actually land (the old `if !dest exists` guard meant reinstalling never
    // updated an existing theme). Preserve the user's theme.conf across the refresh.
    if std::path::Path::new(staged).is_dir() {
        script.push_str(&format!(
            "mkdir -p '{dest}'; \
             if [ -f '{dest}/theme.conf' ]; then cp '{dest}/theme.conf' /tmp/.bookos-themeconf-keep; fi; \
             cp -rf '{staged}/.' '{dest}/'; \
             if [ -f /tmp/.bookos-themeconf-keep ]; then mv -f /tmp/.bookos-themeconf-keep '{dest}/theme.conf'; fi; ",
            staged = staged, dest = dest
        ));
    }
    script.push_str(&format!("mkdir -p /etc/sddm.conf.d; mv '{}' /etc/sddm.conf.d/bookos-theme.conf; chmod 644 /etc/sddm.conf.d/bookos-theme.conf", tmp_conf));

    eprintln!("[install_sddm] script:\n{}", script);

    let mut child = match StdCommand::new("sudo")
        .args(["-k", "-S", "-p", "", "--", "sh", "-c", &script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn() { Ok(c) => c, Err(e) => { let _ = std::fs::remove_file(&tmp_conf); return format!(r#"{{"ok":false,"error":"spawn: {}"}}"#, esc(&e.to_string())); } };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(password.as_bytes());
        let _ = sin.write_all(b"\n");
        drop(sin);
    }
    let result = match child.wait_with_output() {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            eprintln!("[install_sddm] FAIL stderr={}", err);
            format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&err))
        },
        Err(e) => format!(r#"{{"ok":false,"error":"wait: {}"}}"#, esc(&e.to_string())),
    };
    // Cleanup tmpfile if still there
    let _ = std::fs::remove_file(&tmp_conf);
    result
}

#[tauri::command] async fn uninstall_sddm_theme(password: String) -> String {
    use std::io::Write;
    let mut child = match StdCommand::new("sudo")
        .args(["-k", "-S", "--", "rm", "-f", "/etc/sddm.conf.d/bookos-theme.conf"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn() { Ok(c) => c, Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())) };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", password).as_bytes());
    }
    match child.wait_with_output() {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

// Launch sddm-greeter in test mode (preview)
#[tauri::command] fn preview_sddm() -> String {
    use std::process::Stdio;
    let theme = "/usr/share/sddm/themes/bookos";
    let res = Command::new("setsid")
        .args(["sddm-greeter", "--test-mode", "--theme", theme])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match res {
        Ok(_) => r#"{"ok":true}"#.into(),
        Err(e) => {
            // Fallback without setsid
            let res2 = Command::new("sddm-greeter")
                .args(["--test-mode", "--theme", theme])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match res2 {
                Ok(_) => r#"{"ok":true}"#.into(),
                Err(e2) => format!(r#"{{"ok":false,"error":"{} / {}"}}"#, esc(&e.to_string()), esc(&e2.to_string())),
            }
        }
    }
}

// Get digital wellbeing / app usage (reads from bookos usage log if available)
#[tauri::command] fn get_app_usage() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let log = format!("{}/.local/share/bookos/app_usage.json", home);
    fs::read_to_string(&log).unwrap_or_else(|_| "[]".into())
}

#[tauri::command] async fn run_flatpak_update() -> Result<String, String> {
    // A real update downloads runtimes/apps and takes minutes — the default 12s
    // run() would return early and make the UI report success prematurely.
    let output = run_timeout("flatpak", &["update", "-y"], 600_000).await;
    Ok(format!(r#"{{"ok":true,"output":"{}"}}"#, esc(&output)))
}

/// AUR update via yay or paru (whichever exists).
#[tauri::command] async fn run_aur_update() -> Result<String, String> {
    let helper = if Command::new("which").arg("yay").output().await.map(|o| o.status.success()).unwrap_or(false) {
        "yay"
    } else if Command::new("which").arg("paru").output().await.map(|o| o.status.success()).unwrap_or(false) {
        "paru"
    } else {
        return Ok(r#"{"ok":false,"error":"no AUR helper (yay/paru) found"}"#.into());
    };
    // Building AUR packages takes minutes — don't let the default 12s run() cut
    // it short and report success while the build is still going.
    let output = run_timeout(helper, &["-Sua", "--noconfirm"], 600_000).await;
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

// ── Date & time (timedatectl) ─────────────────────────────────────────────
#[tauri::command] async fn get_datetime_info() -> String {
    let s = run("timedatectl",&["show"]).await;
    let mut tz = String::new(); let mut ntp = false; let mut synced = false;
    for line in s.lines() {
        if let Some(v) = line.strip_prefix("Timezone=") { tz = v.trim().to_string(); }
        else if let Some(v) = line.strip_prefix("NTP=") { ntp = v.trim() == "yes"; }
        else if let Some(v) = line.strip_prefix("NTPSynchronized=") { synced = v.trim() == "yes"; }
    }
    format!(r#"{{"timezone":"{}","ntp":{},"synced":{}}}"#, esc(&tz), ntp, synced)
}
#[tauri::command] async fn list_timezones() -> String {
    let l = run("timedatectl",&["list-timezones"]).await;
    let zones: Vec<String> = l.lines().map(|l| format!(r#""{}""#, esc(l.trim()))).collect();
    format!("[{}]", zones.join(","))
}
#[tauri::command] async fn set_timezone(timezone: String) -> String {
    // timedatectl needs root → use pkexec (graphical polkit prompt).
    let out = StdCommand::new("pkexec").args(["timedatectl","set-timezone",&timezone]).status();
    match out { Ok(s) if s.success() => r#"{"ok":true}"#.into(), _ => r#"{"ok":false}"#.into() }
}
#[tauri::command] async fn set_ntp(enable: bool) -> String {
    let v = if enable { "true" } else { "false" };
    let out = StdCommand::new("pkexec").args(["timedatectl","set-ntp",v]).status();
    match out { Ok(s) if s.success() => r#"{"ok":true}"#.into(), _ => r#"{"ok":false}"#.into() }
}

// ── Scheduled Theme ──────────────────────────────────────────────────────
#[tauri::command] fn get_theme_schedule() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = format!("{}/.config/bookos/settings.json", home);
    let cfg: serde_json::Value = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
    let enabled = cfg.get("theme_schedule_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let light_time = cfg.get("theme_light_time").and_then(|v| v.as_str()).unwrap_or("07:00").to_string();
    let dark_time = cfg.get("theme_dark_time").and_then(|v| v.as_str()).unwrap_or("20:00").to_string();
    let light_theme = cfg.get("theme_light").and_then(|v| v.as_str()).unwrap_or("BookOS-Light").to_string();
    let dark_theme = cfg.get("theme_dark").and_then(|v| v.as_str()).unwrap_or("BookOS-Dark").to_string();
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
        "packages" => {
            // Clean the package-manager cache, per distro. pkexec for root ops.
            match detect_pkg_mgr() {
                "pacman" => {
                    // paru cleans AUR build cache as the user; pacman cache needs root.
                    let aur = run("paru", &["-Sc", "--noconfirm"]).await;
                    let sys = run("pkexec", &["paccache", "-r", "-k1"]).await;
                    format!("{}\n{}", aur.trim(), sys.trim())
                }
                "dnf5" => run("pkexec", &["dnf5", "clean", "all"]).await,
                "dnf"  => run("pkexec", &["dnf", "clean", "all"]).await,
                "apt"  => run("pkexec", &["sh", "-c", "apt-get clean && apt-get autoclean"]).await,
                "zypper" => run("pkexec", &["zypper", "clean", "--all"]).await,
                _ => "Gestor de paquetes no soportado".to_string(),
            }
        }
        "cache" => {
            let home = std::env::var("HOME").unwrap_or_default();
            run("sh", &["-c", &format!("rm -rf '{}/.cache/thumbnails/'* 2>/dev/null; true", home)]).await
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
    // Plasma 6 ships qdbus6; older systems have qdbus. Try the former, fall back.
    let r = run("qdbus6", &["org.kde.KWin", "/KWin", "reconfigure"]).await;
    if r.contains("not found") || r.contains("No such") || r.is_empty() {
        run("qdbus", &["org.kde.KWin", "/KWin", "reconfigure"]).await;
    }
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
/// Copy user-picked image files into ~/.local/share/wallpapers so they persist
/// and show up in get_wallpapers(). Returns the number of files added.
#[tauri::command] fn add_wallpapers(paths: Vec<String>) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let dest_dir = format!("{}/.local/share/wallpapers", home);
    if let Err(e) = fs::create_dir_all(&dest_dir) {
        return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string()));
    }
    let mut added = 0;
    for p in &paths {
        let src = std::path::Path::new(p);
        let ext = src.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if !["jpg","jpeg","png","webp"].contains(&ext.as_str()) { continue; }
        let fname = match src.file_name() { Some(f) => f.to_string_lossy().to_string(), None => continue };
        // Avoid clobbering an existing file with a different image: suffix on collision.
        let mut dest = std::path::Path::new(&dest_dir).join(&fname);
        if dest.exists() && fs::read(&dest).ok() != fs::read(src).ok() {
            let stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let mut n = 1;
            loop {
                let cand = std::path::Path::new(&dest_dir).join(format!("{}-{}.{}", stem, n, ext));
                if !cand.exists() { dest = cand; break; }
                n += 1;
            }
        }
        if fs::copy(src, &dest).is_ok() { added += 1; }
    }
    format!(r#"{{"ok":true,"added":{}}}"#, added)
}
#[tauri::command] async fn get_current_wallpaper() -> String {
    // Plasma stores the wallpaper inside a Containment whose number varies.
    // Parse the appletsrc directly to find the first Wallpaper Image key.
    let cfg = std::env::var("HOME").map(|h| format!("{}/.config/plasma-org.kde.plasma.desktop-appletsrc", h)).unwrap_or_default();
    let contents = std::fs::read_to_string(&cfg).unwrap_or_default();
    let mut in_image_general = false;
    for line in contents.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_image_general = l.contains("Wallpaper") && l.contains("org.kde.image") && l.ends_with("][General]");
            continue;
        }
        if in_image_general {
            if let Some(val) = l.strip_prefix("Image=") {
                let path = val.trim().replace("file://", "");
                return format!(r#"{{"path":"{}"}}"#, esc(&path));
            }
        }
    }
    r#"{"path":""}"#.into()
}
#[tauri::command] async fn set_wallpaper(path: String) -> String {
    run("plasma-apply-wallpaperimage", &[&path]).await;
    r#"{"ok":true}"#.into()
}

// ── Default Apps ──────────────────────────────────────────────────────
// Search the standard XDG dirs for a .desktop file and pull out a field.
fn desktop_file_path(id: &str) -> Option<std::path::PathBuf> {
    if id.is_empty() { return None; }
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        format!("{}/.local/share/applications", home),
        "/usr/share/applications".into(),
        "/usr/local/share/applications".into(),
        "/var/lib/flatpak/exports/share/applications".into(),
        format!("{}/.local/share/flatpak/exports/share/applications", home),
    ];
    for d in &dirs {
        let p = std::path::Path::new(d).join(id);
        if p.is_file() { return Some(p); }
    }
    None
}
fn desktop_field(path: &std::path::Path, key: &str) -> String {
    let content = fs::read_to_string(path).unwrap_or_default();
    // Only read the [Desktop Entry] group, stop at the next group.
    let mut in_entry = false;
    for line in content.lines() {
        let l = line.trim();
        if l.starts_with('[') { in_entry = l == "[Desktop Entry]"; continue; }
        if in_entry {
            if let Some(v) = l.strip_prefix(&format!("{}=", key)) { return v.trim().to_string(); }
        }
    }
    String::new()
}
// Friendly Name + Icon for a .desktop id (e.g. "firefox.desktop").
// Resolve a freedesktop icon *name* (e.g. "firefox", "org.kde.dolphin") to an
// absolute file path by scanning the common theme dirs. If `name` is already an
// absolute path, it's returned as-is. Returns "" if nothing is found.
fn resolve_icon_file(name: &str) -> String {
    if name.is_empty() { return String::new(); }
    if name.starts_with('/') && std::path::Path::new(name).exists() { return name.to_string(); }
    let home = std::env::var("HOME").unwrap_or_default();
    let user_dirs = [
        format!("{}/.local/share/icons/hicolor/256x256/apps", home),
        format!("{}/.local/share/icons/hicolor/128x128/apps", home),
        format!("{}/.local/share/icons/hicolor/64x64/apps", home),
        format!("{}/.local/share/icons/hicolor/scalable/apps", home),
    ];
    let sys_dirs = [
        "/usr/share/icons/hicolor/scalable/apps",
        "/usr/share/icons/hicolor/256x256/apps",
        "/usr/share/icons/hicolor/128x128/apps",
        "/usr/share/icons/hicolor/64x64/apps",
        "/usr/share/icons/hicolor/48x48/apps",
        "/usr/share/icons/breeze/apps/64",
        "/usr/share/icons/breeze/apps/48",
        "/usr/share/icons/breeze-dark/apps/48",
        "/usr/share/icons/Papirus/64x64/apps",
        "/usr/share/icons/Papirus/48x48/apps",
        "/usr/share/pixmaps",
    ];
    let exts = ["svg", "png", "xpm"];
    for dir in user_dirs.iter().map(|s| s.as_str()).chain(sys_dirs.iter().copied()) {
        for ext in &exts {
            let p = format!("{}/{}.{}", dir, name, ext);
            if std::path::Path::new(&p).exists() { return p; }
        }
    }
    String::new()
}

fn app_label_icon(id: &str) -> (String, String) {
    match desktop_file_path(id) {
        Some(p) => {
            let mut name = desktop_field(&p, "Name");
            if name.is_empty() { name = id.trim_end_matches(".desktop").to_string(); }
            let icon_name = desktop_field(&p, "Icon");
            // Resolve the Icon= name to an absolute file the webview can load.
            let icon = resolve_icon_file(&icon_name);
            (name, icon)
        }
        None => (id.trim_end_matches(".desktop").to_string(), String::new()),
    }
}

#[tauri::command] async fn get_default_apps() -> String {
    let roles = default_app_roles();
    let mut parts: Vec<String> = Vec::new();
    for (role, query_mime, _all_mimes, _cat) in &roles {
        let id = if *role == "browser" {
            run("xdg-settings", &["get", "default-web-browser"]).await
        } else {
            run("xdg-mime", &["query", "default", query_mime]).await
        };
        let id = id.trim();
        let (name, icon) = app_label_icon(id);
        parts.push(format!(r#""{}":{{"id":"{}","name":"{}","icon":"{}"}}"#,
            role, esc(id), esc(&name), esc(&icon)));
    }
    format!("{{{}}}", parts.join(","))
}

// Central table of default-app roles. Each entry:
//   (role key, primary MIME for query/match, all MIMEs to bind on set, category fallback)
fn default_app_roles() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    vec![
        ("browser",     "x-scheme-handler/http", "x-scheme-handler/http;x-scheme-handler/https;text/html", "WebBrowser"),
        ("email",       "x-scheme-handler/mailto", "x-scheme-handler/mailto", "Email"),
        ("filemanager", "inode/directory", "inode/directory", "FileManager"),
        ("image",       "image/png", "image/png;image/jpeg;image/gif;image/webp;image/bmp;image/tiff;image/svg+xml", "ImageViewer"),
        ("video",       "video/mp4", "video/mp4;video/x-matroska;video/webm;video/quicktime;video/x-msvideo;video/mpeg", "Player"),
        ("audio",       "audio/mpeg", "audio/mpeg;audio/flac;audio/x-wav;audio/ogg;audio/aac;audio/x-m4a", "AudioVideo"),
        ("pdf",         "application/pdf", "application/pdf", "Viewer"),
        ("text",        "text/plain", "text/plain", "TextEditor"),
        ("archive",     "application/zip", "application/zip;application/x-7z-compressed;application/x-tar;application/x-rar;application/gzip;application/x-xz", "Archiving"),
    ]
}

// List installed apps that declare support for a given role.
#[tauri::command] fn list_apps_for_role(role: String) -> String {
    let roles = default_app_roles();
    let entry = match roles.iter().find(|r| r.0 == role) {
        Some(e) => e,
        None => return "[]".into(),
    };
    // Build the set of MIME types this role considers a match.
    let role_mimes: Vec<&str> = entry.2.split(';').filter(|s| !s.is_empty()).collect();
    let cat = entry.3;
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        format!("{}/.local/share/applications", home),
        "/usr/share/applications".to_string(),
        "/usr/local/share/applications".to_string(),
        "/var/lib/flatpak/exports/share/applications".to_string(),
        format!("{}/.local/share/flatpak/exports/share/applications", home),
    ];
    let mut seen = std::collections::HashSet::new();
    let mut apps: Vec<serde_json::Value> = Vec::new();
    for d in &dirs {
        let entries = match fs::read_dir(d) { Ok(e) => e, Err(_) => continue };
        for de in entries.flatten() {
            let path = de.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") { continue; }
            let id = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if id.is_empty() || !seen.insert(id.clone()) { continue; }
            let content = fs::read_to_string(&path).unwrap_or_default();
            if content.contains("NoDisplay=true") || content.contains("Hidden=true") { continue; }
            let mimes = desktop_field(&path, "MimeType");
            let cats = desktop_field(&path, "Categories");
            let declared: Vec<&str> = mimes.split(';').filter(|s| !s.is_empty()).collect();
            // Match if the app declares any of the role's MIME types, or its
            // category matches as a fallback.
            let mime_match = declared.iter().any(|m| role_mimes.contains(m));
            let cat_match = !cat.is_empty() && cats.contains(cat);
            if !mime_match && !cat_match { continue; }
            let name = desktop_field(&path, "Name");
            if name.is_empty() { continue; }
            let icon = resolve_icon_file(&desktop_field(&path, "Icon"));
            apps.push(serde_json::json!({"id":id,"name":name,"icon":icon}));
        }
    }
    apps.sort_by(|a,b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    serde_json::to_string(&apps).unwrap_or_else(|_| "[]".into())
}

// Set the default app (.desktop id) for a role.
#[tauri::command] async fn set_default_app(role: String, desktop_id: String) -> String {
    let roles = default_app_roles();
    let entry = match roles.iter().find(|r| r.0 == role) {
        Some(e) => e,
        None => return r#"{"ok":false,"error":"rol desconocido"}"#.into(),
    };
    if role == "browser" {
        run("xdg-settings", &["set", "default-web-browser", &desktop_id]).await;
    }
    // Bind every MIME type for this role to the chosen app via xdg-mime…
    let mut args: Vec<&str> = vec!["default", &desktop_id];
    let mimes: Vec<&str> = entry.2.split(';').filter(|s| !s.is_empty()).collect();
    args.extend(mimes.iter());
    run("xdg-mime", &args).await;

    // …but xdg-mime is unreliable on KDE (Wayland/portals), so also write the
    // associations directly into ~/.config/mimeapps.list under [Default Applications].
    // This is what KIO/Plasma actually reads.
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{}/.config/mimeapps.list", home);
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut lines: Vec<String> = existing.lines().map(|l| l.to_string()).collect();
        // Ensure [Default Applications] section exists.
        let hdr = "[Default Applications]";
        if !lines.iter().any(|l| l.trim() == hdr) {
            if !lines.is_empty() && !lines.last().map(|l| l.is_empty()).unwrap_or(true) { lines.push(String::new()); }
            lines.push(hdr.to_string());
        }
        // Find the section bounds.
        let start = lines.iter().position(|l| l.trim() == hdr).unwrap();
        let end = lines[start+1..].iter().position(|l| l.trim_start().starts_with('['))
            .map(|p| start + 1 + p).unwrap_or(lines.len());
        for mime in &mimes {
            let key = format!("{}=", mime);
            let line = format!("{}={}", mime, desktop_id);
            if let Some(idx) = lines[start..end].iter().position(|l| l.trim_start().starts_with(&key)) {
                lines[start + idx] = line;
            } else {
                lines.insert(end, line);
            }
        }
        let _ = std::fs::write(&path, lines.join("\n") + "\n");
    }

    // Verify the change actually took effect for the primary MIME.
    let got = if role == "browser" {
        run("xdg-settings", &["get", "default-web-browser"]).await
    } else {
        run("xdg-mime", &["query", "default", entry.1]).await
    };
    let ok = got.trim() == desktop_id;
    format!(r#"{{"ok":{},"applied":"{}"}}"#, ok, esc(got.trim()))
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
    // Trigger the effect via D-Bus (the plugin exposes Invert.toggleScreenInvert)
    run("qdbus6",&["org.kde.KWin","/org/kde/KWin/Effect/Invert1","org.kde.kwin.Effect.toggleScreenInvert"]).await;
    r#"{"ok":true}"#.into()
}
#[tauri::command] async fn set_cursor_size(size: i32) -> String {
    let s = size.to_string();
    run("kwriteconfig6",&["--file","kcminputrc","--group","Mouse","--key","cursorSize",&s]).await;
    // Also write to kdeglobals (used by some apps) and notify cursor change via KGlobalSettings
    run("kwriteconfig6",&["--file","kdeglobals","--group","KDE","--key","CursorSize",&s]).await;
    // Apply live: re-run the cursor-theme kcm init (reloads cursor at the new size
    // without a relogin) and reconfigure KWin. kcminit is the piece that actually
    // pushes the new size to the running Wayland/X cursor.
    run("kcminit",&["kcm_cursortheme"]).await;
    let r = run("qdbus6",&["org.kde.KWin","/KWin","reconfigure"]).await;
    if r.contains("not found") || r.is_empty() {
        run("dbus-send",&["--session","--dest=org.kde.KWin","--type=method_call","/KWin","org.kde.KWin.reconfigure"]).await;
    }
    // Nudge GTK/XSettings consumers too.
    run("dbus-send",&["--session","--type=signal","/KGlobalSettings","org.kde.KGlobalSettings.notifyChange","int32:5","int32:0"]).await;
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

/// Create a new local user account. Optional avatar_path is copied into the
/// new user's home and into AccountsService.
#[tauri::command] async fn create_user(
    username: String, full_name: String, password: String,
    is_admin: bool, avatar_path: Option<String>,
    sudo_password: String,
) -> String {
    use tokio::io::AsyncWriteExt;
    if username.is_empty() || password.is_empty() || sudo_password.is_empty() {
        return r#"{"ok":false,"error":"missing_fields"}"#.into();
    }
    // Validate username (POSIX): lowercase letters, digits, underscores, hyphens
    if !username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return r#"{"ok":false,"error":"invalid_username"}"#.into();
    }

    // Step 1: useradd -m -s /bin/bash -c "<full name>" <user>
    let comment = full_name.replace(',', " ").replace(':', " ");
    let mut child = match tokio::process::Command::new("sudo")
        .args(["-S", "-p", "", "useradd", "-m", "-s", "/bin/bash", "-c", &comment, &username])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", sudo_password).as_bytes()).await;
        drop(sin);
    }
    let out = child.wait_with_output().await.ok();
    if !matches!(&out, Some(o) if o.status.success()) {
        let err = out.map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();
        return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&err));
    }

    // Step 2: set password via chpasswd
    let mut child = match tokio::process::Command::new("sudo")
        .args(["-S", "-p", "", "chpasswd"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n{}:{}\n", sudo_password, username, password).as_bytes()).await;
        drop(sin);
    }
    let _ = child.wait_with_output().await;

    // Step 3: add to wheel group if admin
    if is_admin {
        let mut child = tokio::process::Command::new("sudo")
            .args(["-S", "-p", "", "usermod", "-aG", "wheel", &username])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn().ok();
        if let Some(c) = child.as_mut() {
            if let Some(mut sin) = c.stdin.take() {
                let _ = sin.write_all(format!("{}\n", sudo_password).as_bytes()).await;
                drop(sin);
            }
            let _ = c.wait().await;
        }
    }

    // Step 4: avatar copy (best-effort)
    if let Some(src) = avatar_path {
        if !src.is_empty() && std::path::Path::new(&src).exists() {
            let mut child = tokio::process::Command::new("sudo")
                .args(["-S", "-p", "", "cp", "--no-preserve=ownership", &src,
                       &format!("/var/lib/AccountsService/icons/{}", username)])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn().ok();
            if let Some(c) = child.as_mut() {
                if let Some(mut sin) = c.stdin.take() {
                    let _ = sin.write_all(format!("{}\n", sudo_password).as_bytes()).await;
                    drop(sin);
                }
                let _ = c.wait().await;
            }
        }
    }
    format!(r#"{{"ok":true,"username":"{}"}}"#, esc(&username))
}

/// Delete a local user account. By default removes their home (`-r`).
#[tauri::command] async fn delete_user(username: String, sudo_password: String, remove_home: bool) -> String {
    use tokio::io::AsyncWriteExt;
    let current = run("whoami", &[]).await;
    if username == current {
        return r#"{"ok":false,"error":"cannot_delete_self"}"#.into();
    }
    let args: &[&str] = if remove_home {
        &["-S", "-p", "", "userdel", "-r", "--", &username]
    } else {
        &["-S", "-p", "", "userdel", "--", &username]
    };
    let mut child = match tokio::process::Command::new("sudo")
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n", sudo_password).as_bytes()).await;
        drop(sin);
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => r#"{"ok":true}"#.into(),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    }
}

/// Read SDDM autologin status. Returns the configured user (or empty) + session.
#[tauri::command] fn get_autologin_status() -> String {
    let paths = [
        "/etc/sddm.conf.d/autologin.conf",
        "/etc/sddm.conf.d/kde_settings.conf",
        "/etc/sddm.conf",
    ];
    let mut user = String::new();
    let mut session = String::new();
    let mut in_section = false;
    for p in &paths {
        let content = match fs::read_to_string(p) { Ok(c) => c, Err(_) => continue };
        for line in content.lines() {
            let l = line.trim();
            if l.starts_with('[') && l.ends_with(']') {
                in_section = l.eq_ignore_ascii_case("[Autologin]");
                continue;
            }
            if !in_section { continue; }
            if let Some(rest) = l.strip_prefix("User=") { if !rest.trim().is_empty() { user = rest.trim().to_string(); } }
            if let Some(rest) = l.strip_prefix("Session=") { if !rest.trim().is_empty() { session = rest.trim().to_string(); } }
        }
        if !user.is_empty() { break; }
    }
    let enabled = !user.is_empty();
    format!(r#"{{"enabled":{},"user":"{}","session":"{}"}}"#, enabled, esc(&user), esc(&session))
}

/// Enable / disable SDDM autologin. Writes /etc/sddm.conf.d/bookos-autologin.conf.
#[tauri::command] async fn set_autologin(enabled: bool, username: String, sudo_password: String) -> String {
    use tokio::io::AsyncWriteExt;
    let body = if enabled {
        format!("[Autologin]\nUser={}\nSession=plasma\nRelogin=false\n", username)
    } else {
        // Empty file disables it (overrides previous configs since drop-ins are sorted)
        "[Autologin]\nUser=\nSession=\n".to_string()
    };
    let target = "/etc/sddm.conf.d/bookos-autologin.conf";
    // Use sudo tee
    let mut child = match tokio::process::Command::new("sudo")
        .args(["-S", "-p", "", "tee", target])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
    };
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{}\n{}", sudo_password, body).as_bytes()).await;
        drop(sin);
    }
    match child.wait_with_output().await {
        Ok(o) if o.status.success() => format!(r#"{{"ok":true,"enabled":{}}}"#, enabled),
        Ok(o) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&String::from_utf8_lossy(&o.stderr))),
        Err(e) => format!(r#"{{"ok":false,"error":"{}"}}"#, esc(&e.to_string())),
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

// ── Connection details (IP, gateway, DNS, MAC, speed…) ───────────────────
// Shared by WiFi and Ethernet. `kind` = "wifi" | "ethernet".
// nmcli -t escapes ':' inside values as '\:' and returns DNS/ADDRESS with
// indexed keys (IP4.DNS[1], IP4.ADDRESS[1]) regardless of the -f filter, so we
// must match by prefix, not exact key, and unescape.
fn nm_unescape(s: &str) -> String { s.replace("\\:", ":").replace("\\\\", "\\") }

async fn connection_details_for_iface(iface: &str) -> (String,String,String,String,String,String,String,String) {
    // ip(v4), ip6, gateway, dns (joined), mac, mtu, prefix, state
    let info = run("nmcli",&["-t","-e","yes","-f",
        "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,IP6.ADDRESS,GENERAL.HWADDR,GENERAL.MTU,GENERAL.STATE",
        "device","show",iface]).await;
    let mut ip = String::new(); let mut ip6 = String::new(); let mut gateway = String::new();
    let mut dns_list: Vec<String> = Vec::new(); let mut mac = String::new();
    let mut mtu = String::new(); let mut prefix = String::new(); let mut state = String::new();
    for line in info.lines() {
        let (key, val) = match line.split_once(':') { Some(kv) => kv, None => continue };
        let val = nm_unescape(val.trim());
        if key.starts_with("IP4.ADDRESS") {
            let mut parts = val.splitn(2,'/');
            ip = parts.next().unwrap_or("").to_string();
            prefix = parts.next().unwrap_or("").to_string();
        } else if key == "IP4.GATEWAY" { gateway = val; }
        else if key.starts_with("IP4.DNS") { if !val.is_empty() { dns_list.push(val); } }
        else if key.starts_with("IP6.ADDRESS") && ip6.is_empty() { ip6 = val.split('/').next().unwrap_or("").to_string(); }
        else if key == "GENERAL.HWADDR" { mac = val; }
        else if key == "GENERAL.MTU" { mtu = val; }
        else if key == "GENERAL.STATE" { state = val; }
    }
    (ip, ip6, gateway, dns_list.join(", "), mac, mtu, prefix, state)
}

// Find the active interface of a given type ("wifi" | "ethernet").
async fn active_iface_of(kind: &str) -> String {
    let dev_out = run("nmcli",&["-t","-f","DEVICE,TYPE,STATE","device"]).await;
    let needle = format!(":{}:", kind);
    dev_out.lines()
        .find(|l| l.contains(&needle) && l.contains("connected"))
        .and_then(|l| l.split(':').next().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[tauri::command] async fn get_wifi_details(_ssid: String) -> String {
    let iface = {
        let i = active_iface_of("wifi").await;
        if i.is_empty() { "wlan0".to_string() } else { i }
    };
    let (ip, ip6, gateway, dns, mac, mtu, prefix, state) = connection_details_for_iface(&iface).await;
    // Link speed / rate (bitrate) for WiFi
    let rate = run("nmcli",&["-t","-f","GENERAL.CONNECTION","device","show",&iface]).await;
    let _ = rate; // connection name not needed here
    format!(r#"{{"ip":"{}","ip6":"{}","gateway":"{}","dns":"{}","mac":"{}","mtu":"{}","prefix":"{}","state":"{}","iface":"{}"}}"#,
        esc(&ip),esc(&ip6),esc(&gateway),esc(&dns),esc(&mac),esc(&mtu),esc(&prefix),esc(&state),esc(&iface))
}

// ── Ethernet (wired) ─────────────────────────────────────────────────────
#[tauri::command] async fn get_ethernet_status() -> String {
    let dev_out = run("nmcli",&["-t","-f","DEVICE,TYPE,STATE,CONNECTION","device"]).await;
    for line in dev_out.lines() {
        let p: Vec<&str> = line.splitn(4,':').collect();
        if p.len() >= 3 && p.get(1) == Some(&"ethernet") {
            let connected = p.get(2).map(|s| s.contains("connected") && !s.contains("disconnected")).unwrap_or(false);
            let name = p.get(3).map(|s| nm_unescape(s)).unwrap_or_default();
            return format!(r#"{{"present":true,"connected":{},"iface":"{}","connection":"{}"}}"#,
                connected, esc(p.first().unwrap_or(&"")), esc(&name));
        }
    }
    r#"{"present":false,"connected":false,"iface":"","connection":""}"#.into()
}

#[tauri::command] async fn get_ethernet_details() -> String {
    let iface = active_iface_of("ethernet").await;
    if iface.is_empty() {
        // Fall back to first ethernet device even if not "connected"
        let dev_out = run("nmcli",&["-t","-f","DEVICE,TYPE","device"]).await;
        let fb = dev_out.lines().find(|l| l.contains(":ethernet"))
            .and_then(|l| l.split(':').next().map(|s| s.to_string())).unwrap_or_default();
        if fb.is_empty() { return r#"{"present":false}"#.into(); }
        let (ip,ip6,gw,dns,mac,mtu,prefix,state)=connection_details_for_iface(&fb).await;
        return format!(r#"{{"present":true,"ip":"{}","ip6":"{}","gateway":"{}","dns":"{}","mac":"{}","mtu":"{}","prefix":"{}","state":"{}","iface":"{}"}}"#,
            esc(&ip),esc(&ip6),esc(&gw),esc(&dns),esc(&mac),esc(&mtu),esc(&prefix),esc(&state),esc(&fb));
    }
    let (ip,ip6,gw,dns,mac,mtu,prefix,state)=connection_details_for_iface(&iface).await;
    format!(r#"{{"present":true,"ip":"{}","ip6":"{}","gateway":"{}","dns":"{}","mac":"{}","mtu":"{}","prefix":"{}","state":"{}","iface":"{}"}}"#,
        esc(&ip),esc(&ip6),esc(&gw),esc(&dns),esc(&mac),esc(&mtu),esc(&prefix),esc(&state),esc(&iface))
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
// Detect active window's app name and log 1 minute of usage.
// Uses `qdbus6 org.kde.KWin /KWin getWindowInfo` with a fallback to xprop.
#[tauri::command] async fn track_active_app() -> String {
    // Try to read the active window's resource class via xprop (works under XWayland)
    let xprop_root = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        run("xprop", &["-root", "_NET_ACTIVE_WINDOW"])
    ).await.unwrap_or_default();
    let win_id = xprop_root.split_whitespace().last().unwrap_or("").trim().to_string();
    let app_name = if win_id.starts_with("0x") && win_id.len() > 2 {
        let info = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            run("xprop", &["-id", &win_id, "WM_CLASS"])
        ).await.unwrap_or_default();
        // WM_CLASS(STRING) = "instance", "class"
        info.split('=').nth(1)
            .and_then(|s| s.split(',').nth(1))
            .map(|s| s.trim().trim_matches('"').to_string())
            .unwrap_or_default()
    } else { String::new() };
    if app_name.is_empty() || app_name == "plasmashell" || app_name == "BookOS Settings" {
        return r#"{"ok":false,"reason":"no_active_app"}"#.into();
    }
    log_app_usage(app_name, 1.0)
}

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
// Map an ugly PipeWire/ALSA description + active port into a friendly,
// human label. Falls back to the raw description if nothing matches.
fn friendly_audio_name(desc: &str, port: &str, lang_es: bool) -> String {
    let p = port.to_lowercase();
    let d = desc.to_lowercase();
    let pick = |es: &str, en: &str| if lang_es { es.to_string() } else { en.to_string() };
    // Bluetooth devices already have a clean name (the device name) — keep desc.
    if d.contains("bluez") || p.contains("bluetooth") { return desc.to_string(); }
    if p.contains("headphone") || d.contains("headphone") { return pick("Auriculares", "Headphones"); }
    if p.contains("headset")   || d.contains("headset")   { return pick("Auriculares con micrófono", "Headset"); }
    if p.contains("speaker")   || p.contains("internal")  { return pick("Altavoces internos", "Internal speakers"); }
    if p.contains("hdmi")      || p.contains("displayport") || d.contains("hdmi") { return pick("Salida HDMI / DisplayPort", "HDMI / DisplayPort"); }
    if p.contains("usb")       || d.contains("usb")       { return pick("Dispositivo USB", "USB device"); }
    if p.contains("mic")       || d.contains("microphone") { return pick("Micrófono interno", "Internal microphone"); }
    // Generic onboard codec names → "Audio interno"
    if d.contains("hd audio") || d.contains("hda ") || d.contains("alc") || d.contains("sof") || d.contains("controller") {
        return pick("Audio interno", "Built-in audio");
    }
    desc.to_string()
}

#[tauri::command] async fn get_sink_descriptions() -> String {
    let out = run("pactl",&["list","sinks"]).await;
    let lang_es = std::env::var("LANG").unwrap_or_default().starts_with("es");
    let mut map: Vec<serde_json::Value> = Vec::new();
    let mut cur_name = String::new();
    let mut cur_desc = String::new();
    let mut cur_port = String::new();
    let flush = |map: &mut Vec<serde_json::Value>, name: &str, desc: &str, port: &str| {
        if !name.is_empty() && !desc.is_empty() {
            let friendly = friendly_audio_name(desc, port, lang_es);
            map.push(serde_json::json!({"name":name,"desc":desc,"friendly":friendly}));
        }
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(n) = t.strip_prefix("Name:") {
            // New sink block starts — flush the previous one.
            flush(&mut map, &cur_name, &cur_desc, &cur_port);
            cur_name = n.trim().to_string();
            cur_desc = String::new();
            cur_port = String::new();
        } else if let Some(d) = t.strip_prefix("Description:") {
            cur_desc = d.trim().to_string();
        } else if let Some(ap) = t.strip_prefix("Active Port:") {
            cur_port = ap.trim().to_string();
        }
    }
    flush(&mut map, &cur_name, &cur_desc, &cur_port);
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

/// Opens the Software Updates page: drops the page hint where both a running
/// instance (polled via check_navigation_request) and a fresh launch
/// (get_startup_page) will pick it up, then launches/focuses the app.
fn open_updates_page() {
    let _ = std::fs::write("/tmp/bookos-start-page", "actualizacion");
    // Try to launch the desktop entry (focuses existing window via single-instance,
    // or starts a new one). Fall back to the binary with --page.
    let launched = StdCommand::new("gtk-launch")
        .arg("bookos-settings.desktop")
        .spawn().is_ok();
    if !launched {
        let _ = StdCommand::new("bookos-settings")
            .args(["--page", "actualizacion"])
            .spawn();
    }
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
        let mgr = detect_pkg_mgr();
        let sys_cmd = match mgr {
            "pacman"      => "checkupdates 2>/dev/null | wc -l",
            // sed '/^$/q' stops at the first blank line, dropping the trailing
            // "Obsoleting Packages" section so it isn't counted as an update.
            "dnf5"|"dnf"  => "dnf check-update -q 2>/dev/null | sed '/^$/q' | grep -cE '^[a-zA-Z0-9]'",
            "apt"         => "apt list --upgradable 2>/dev/null | grep -c '/'",
            "zypper"      => "zypper -q list-updates 2>/dev/null | grep -c '^v '",
            _             => "echo 0",
        };
        let flat_cmd = "command -v flatpak >/dev/null && flatpak remote-ls --updates --columns=application 2>/dev/null | wc -l || echo 0";
        // Two-tier notification:
        //   1. If /etc/bookos-release has a new VERSION (≠ INSTALLED) → notify BookOS release
        //   2. Always: if package updates pending → notify package count
        // Multi-lang: ES if LANG starts with es, else EN.
        // Icon: prefer hicolor bookos-settings, fall back to system theme.
        let exec = format!(
"/bin/sh -c '\
CFG=\"$HOME/.config/bookos/settings.json\"; \
if [ -f \"$CFG\" ] && grep -q \"\\\"UpdateNotifications\\\"[[:space:]]*:[[:space:]]*\\\"false\\\"\" \"$CFG\"; then exit 0; fi; \
LANG_PREFIX=$(echo \"${{LANG:-en}}\" | cut -c1-2); \
ICON=software-update-available; \
[ -f /usr/share/icons/hicolor/scalable/apps/bookos-settings.svg ] && ICON=bookos-settings; \
[ \"$LANG_PREFIX\" = \"es\" ] && OPENLBL=Abrir || OPENLBL=Open; \
nclick() {{ \
  ACT=$(notify-send -u normal --icon=$ICON -a \"BookOS\" -c \"system.software-update\" -h string:desktop-entry:bookos-settings --wait -A \"default=$OPENLBL\" -A \"open=$OPENLBL\" \"$1\" \"$2\"); \
  if [ \"$ACT\" = default ] || [ \"$ACT\" = open ]; then \
    echo actualizacion > /tmp/bookos-start-page; \
    gtk-launch bookos-settings.desktop >/dev/null 2>&1 || bookos-settings --page actualizacion >/dev/null 2>&1 & \
  fi; \
}}; \
# ── BookOS release check ─────────────────────────────────
if [ -f /etc/bookos-release ]; then \
  REL_VER=$(grep -m1 ^VERSION= /etc/bookos-release | cut -d= -f2-); \
  REL_INST=$(grep -m1 ^INSTALLED= /etc/bookos-release | cut -d= -f2- | sed \"s/.*[Bb]ook[Oo][Ss][[:space:]]*//\"); \
  REL_NAME=$(grep -m1 ^NAME= /etc/bookos-release | cut -d= -f2-); \
  if [ -n \"$REL_VER\" ] && [ \"$REL_VER\" != \"$REL_INST\" ]; then \
    if [ \"$LANG_PREFIX\" = \"es\" ]; then \
      T_TITLE=\"Nueva versión de BookOS\"; \
      T_BODY=\"$REL_NAME está disponible. Abre Ajustes para instalar.\"; \
    else \
      T_TITLE=\"New BookOS version\"; \
      T_BODY=\"$REL_NAME is available. Open Settings to install.\"; \
    fi; \
    nclick \"$T_TITLE\" \"$T_BODY\"; \
  fi; \
fi; \
# ── Package updates ───────────────────────────────────────
SYS=$({sys_cmd}); FL=$({flat_cmd}); TOTAL=$((SYS+FL)); \
if [ \"$TOTAL\" -gt 0 ]; then \
  if [ \"$LANG_PREFIX\" = \"es\" ]; then \
    [ \"$TOTAL\" = \"1\" ] && U_TITLE=\"1 actualización disponible\" || U_TITLE=\"$TOTAL actualizaciones disponibles\"; \
    U_BODY=\"Abre BookOS Settings para revisar e instalar.\"; \
  else \
    [ \"$TOTAL\" = \"1\" ] && U_TITLE=\"1 update available\" || U_TITLE=\"$TOTAL updates available\"; \
    U_BODY=\"Open BookOS Settings to review and install.\"; \
  fi; \
  nclick \"$U_TITLE\" \"$U_BODY\"; \
fi'",
            sys_cmd = sys_cmd, flat_cmd = flat_cmd
        );
        let service = format!(
            "[Unit]\nDescription=BookOS Auto Update Check\n\n[Service]\nType=oneshot\nExecStart={}\n",
            exec
        );
        let timer = "[Unit]\nDescription=BookOS Auto Update Check Timer\n\n[Timer]\nOnCalendar=daily\nPersistent=true\nRandomizedDelaySec=15min\n\n[Install]\nWantedBy=timers.target\n";
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

// ── Earbud detection daemon ─────────────────────────────────────────────
// Polls connected Bluetooth audio devices; when a new pair of earbuds/headset
// connects, fires a desktop notification with the battery levels (Galaxy Buds
// Client style). Runs in the background for the lifetime of the app.

// Is this bluez "Icon" value an audio/earbud device?
fn bt_icon_is_audio(icon: &str) -> bool {
    let i = icon.to_lowercase();
    i.contains("headphone") || i.contains("headset") || i.contains("earbud")
        || i.contains("audio-card") || i == "audio-headphones" || i == "audio-headset"
}

// List currently-connected audio devices: Vec<(mac, name)>.
async fn connected_audio_devices() -> Vec<(String, String)> {
    let connected = run_timeout("bluetoothctl", &["devices", "Connected"], 3_000).await;
    let mut out = Vec::new();
    for line in connected.lines() {
        let l = line.trim().trim_start_matches(|c: char| c=='[' || c==']' || c=='#' || c.is_whitespace());
        let idx = match l.find("Device ") { Some(i) => i, None => continue };
        let rest = &l[idx + "Device ".len()..];
        let (mac, name) = match rest.split_once(' ') { Some(p) => p, None => continue };
        if mac.len()!=17 || mac.matches(':').count()!=5 { continue; }
        let info = run_timeout("bluetoothctl", &["info", mac], 2_000).await;
        let icon = info.lines().find(|l| l.trim_start().starts_with("Icon:"))
            .and_then(|l| l.split(':').nth(1)).map(|s| s.trim().to_string()).unwrap_or_default();
        if bt_icon_is_audio(&icon) {
            out.push((mac.to_string(), name.trim().to_string()));
        }
    }
    out
}

// Is this device a Samsung Galaxy Buds (by BT name)?
fn name_is_galaxy_buds(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("buds") || n.contains("galaxy buds")
}

// Read native L/R/case battery from an already-open BudsConn in BudsState.
// Returns (left, right, case) if connected to this mac.
fn native_buds_battery(state: &buds::BudsState) -> Option<(u8, u8, u8, String)> {
    let guard = state.0.lock().ok()?;
    let conn = guard.as_ref()?;
    // Ask for a fresh extended-status; the reader thread updates conn.status.
    let s = conn.status.lock().ok()?.clone();
    if !s.connected { return None; }
    Some((s.battery_l, s.battery_r, s.battery_case, s.model.clone()))
}

// Background loop: detect newly-connected Galaxy Buds, connect natively over the
// Samsung SPP protocol (no GalaxyBudsClient needed), read L/R/case battery and
// fire a desktop notification — Quick-Share style native integration.
async fn earbud_watch_loop(app: tauri::AppHandle) {
    use std::collections::HashSet;
    let mut known: HashSet<String> = HashSet::new();
    let mut first_pass = true;
    loop {
        // Cheap gate: when the adapter is powered off there's nothing to watch —
        // skip device enumeration entirely and back off (saves constant spawns).
        let show = run_timeout("bluetoothctl", &["show"], 2_000).await;
        if show.contains("Powered: no") || show.is_empty() {
            known.clear();   // forget state so a reconnect after power-on notifies again
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            continue;
        }
        let devs = connected_audio_devices().await;
        let current: HashSet<String> = devs.iter().map(|(m, _)| m.clone()).collect();
        known.retain(|m| current.contains(m));
        for (mac, name) in &devs {
            if known.insert(mac.clone()) && !first_pass && name_is_galaxy_buds(name) {
                handle_buds_appeared(&app, mac, name).await;
            }
        }
        first_pass = false;
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    }
}

// Themed icon installed by the package (line-art earbuds) used in buds notifications.
// Minimal percent-encoder for query values (name/mac → popup URL).
fn pct_encode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{:02X}", b),
    }).collect()
}

// Create (or replace) the frameless Buds popup window, top-right of the primary
// monitor. `state` is "connect" (Conectar/Descartar prompt) or "connected"
// (battery rings). Must run on the main thread — see spawn via run_on_main_thread.
fn create_buds_popup(app: &tauri::AppHandle, state: &str, name: &str, mac: &str, l: u8, r: u8, c: u8) {
    use tauri::{Manager, WebviewWindowBuilder, WebviewUrl, PhysicalPosition, PhysicalSize};
    // Replace any existing popup so data is always fresh.
    if let Some(w) = app.get_webview_window("buds-popup") { let _ = w.close(); }

    let url = format!(
        "buds-popup.html?state={}&name={}&mac={}&l={}&r={}&c={}",
        state, pct_encode(name), pct_encode(mac), l, r, c
    );
    let built = WebviewWindowBuilder::new(app, "buds-popup", WebviewUrl::App(url.into()))
        .title("BookOS Buds")
        .inner_size(400.0, 330.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .visible(false)
        .build();

    let win = match built { Ok(w) => w, Err(e) => { eprintln!("[buds/popup] build failed: {e}"); return; } };
    // Anchor top-right with a small margin.
    if let Ok(Some(mon)) = win.primary_monitor() {
        let sz = mon.size();
        let outer = win.outer_size().unwrap_or(PhysicalSize::new(400, 330));
        let margin = 24i32;
        let x = (sz.width as i32 - outer.width as i32 - margin).max(0);
        let y = 52i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();

    // Buds already linked → bring the full app up too (not just the popup).
    if state == "connected" { show_main_window(app); }
}

// Bring the main window to the foreground (used on buds connect + from the popup).
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(mw) = app.get_webview_window("main") {
        let _ = mw.unminimize();
        let _ = mw.set_skip_taskbar(false);
        let _ = mw.show();
        let _ = mw.set_focus();
    }
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    show_main_window(&app);
}

// React to a freshly-detected pair of Galaxy Buds:
//   • already linked (quick reconnect)  → battery-rings popup straight away
//   • not linked yet                    → Conectar / Descartar popup; the popup's
//                                          Connect button opens the native SPP link
//                                          (buds_connect) and swaps to battery rings.
// Window creation is dispatched to the main thread.
async fn handle_buds_appeared(app: &tauri::AppHandle, mac: &str, name: &str) {
    use tauri::Manager;
    let (state, l, r, c) = match native_buds_battery(&app.state::<buds::BudsState>()) {
        Some((l, r, c, _)) => ("connected", l, r, c),
        None => ("connect", 0u8, 0u8, 0u8),
    };
    let app2 = app.clone();
    let name2 = name.to_string();
    let mac2 = mac.to_string();
    let state2 = state.to_string();
    let _ = app.run_on_main_thread(move || {
        create_buds_popup(&app2, &state2, &name2, &mac2, l, r, c);
    });
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
                let (avatar, avatar_data) = find_avatar(home, un);
                let has_av = !avatar.is_empty();
                users.push(format!(r#"{{"username":"{}","display_name":"{}","has_avatar":{},"avatar_path":"{}","avatar_data":"{}"}}"#,
                    esc(un), esc(display), has_av, esc(&avatar), avatar_data));
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

// Lock + IPC files in user runtime dir ($XDG_RUNTIME_DIR), not /tmp,
// to avoid root-owned files when launched from acpid.
fn lock_path() -> String {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    format!("{}/bookos-settings.lock", dir)
}
fn toggle_path() -> String {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    format!("{}/bookos-toggle", dir)
}

/// Returns true if a process with the given PID is currently running.
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{}", pid)).exists()
}

/// Single-instance guard.
/// If another instance is already running, signal it (write the desired page to
/// /tmp/bookos-start-page) and return false → caller should exit immediately.
/// Otherwise write our PID to the lock file and return true → caller continues.
fn acquire_instance_lock() -> bool {
    let lock = lock_path();
    if let Ok(contents) = std::fs::read_to_string(&lock) {
        if let Ok(pid) = contents.trim().parse::<u32>() {
            if pid_alive(pid) {
                return false;
            }
        }
        let _ = std::fs::remove_file(&lock);
    }
    let _ = std::fs::write(&lock, std::process::id().to_string());
    true
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().collect();

    // ── Single-instance guard ─────────────────────────────────────────────
    if !acquire_instance_lock() {
        // A live instance is already running. Forward intent via /tmp/bookos-toggle:
        //   "1" → toggle (show if hidden, hide if visible)
        //   "show" → always show + focus (used when launched without --toggle)
        let tp = toggle_path();
        if args.iter().any(|a| a == "--toggle") {
            let _ = std::fs::write(&tp, "1");
        } else {
            let _ = std::fs::write(&tp, "show");
        }
        std::process::exit(0);
    }

    let is_hidden = args.iter().any(|a| a == "--hidden");
    let toggle_only = args.iter().any(|a| a == "--toggle");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(UpdateState::default())
        .manage(buds::BudsState::default())
        .manage(quickshare::QsState::default())
        .manage(p2p::P2PState::default())
        // Close-to-background: hiding the main window (instead of quitting) keeps the
        // earbud-detection daemon + routines alive so the popup works "with the app
        // closed". The popup window closes normally.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.set_skip_taskbar(true);
                }
            }
        })
        .setup(move |app| {
            use tauri::Manager;
            // Routines/automation only work while this process is alive, so
            // ensure the hidden autostart entry exists — unless the user
            // explicitly disabled it (opt-out marker from the settings toggle).
            {
                let home = std::env::var("HOME").unwrap_or_default();
                let desktop_path = format!("{}/.config/autostart/bookos-settings.desktop", home);
                if !std::path::Path::new(&autostart_optout_path()).exists()
                    && !std::path::Path::new(&desktop_path).exists() {
                    let _ = std::fs::create_dir_all(format!("{}/.config/autostart", home));
                    let _ = std::fs::write(&desktop_path, AUTOSTART_DESKTOP);
                }
            }
            // Background earbud-detection daemon: notifies on new buds/headset connect.
            // Use Tauri's async runtime (a tokio runtime isn't active inside setup()).
            let buds_app = app.handle().clone();
            tauri::async_runtime::spawn(async move { earbud_watch_loop(buds_app).await; });
            if let Some(window) = app.get_webview_window("main") {
                if is_hidden || toggle_only {
                    let _ = window.set_skip_taskbar(true);
                    // Stay hidden — launched as background service
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Watch for /tmp/bookos-toggle requests (from `bookos-settings --toggle`)
                let win = window.clone();
                std::thread::spawn(move || {
                    let path = toggle_path();
                    let path = path.as_str();
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        if std::fs::metadata(path).is_ok() {
                            let mode = std::fs::read_to_string(path).unwrap_or_default().trim().to_string();
                            let _ = std::fs::remove_file(path);
                            let visible = win.is_visible().unwrap_or(false);
                            let minimized = win.is_minimized().unwrap_or(false);
                            // Force raise + focus on Wayland/KDE (request_user_attention triggers KWin)
                            let raise = || {
                                let _ = win.unminimize();
                                let _ = win.show();
                                let _ = win.set_always_on_top(true);
                                let _ = win.set_focus();
                                let _ = win.set_always_on_top(false);
                                let _ = win.request_user_attention(Some(tauri::UserAttentionType::Critical));
                            };
                            if mode == "show" {
                                raise();
                            } else if visible && !minimized {
                                let _ = win.hide();
                            } else {
                                raise();
                            }
                        }
                    }
                });
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
            // Tray badge: hidden by default, shown by the update daemon when
            // updates are pending. Click opens the updates page.
            {
                use tauri::tray::TrayIconBuilder;
                let mut builder = TrayIconBuilder::with_id("updates")
                    .tooltip("BookOS Settings")
                    .on_tray_icon_event(|_tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { .. } = event {
                            open_updates_page();
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    builder = builder.icon(icon.clone());
                }
                if let Ok(tray) = builder.build(app.handle()) {
                    let _ = tray.set_visible(false);
                }
            }

            let upd_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Wait 5 minutes after start to not saturate CPU
                std::thread::sleep(std::time::Duration::from_secs(300));
                loop {
                    let cfg = load_bookos_settings();
                    let auto_upd = cfg.get("AutoUpdate").and_then(|v| v.as_str()).unwrap_or("false") == "true";
                    
                    if auto_upd {
                        // Count pending updates, cross-distro.
                        let total = match detect_pkg_mgr() {
                            "pacman" => {
                                // `pacman -Sy` needs root and silently failed here,
                                // leaving stale DBs. checkupdates (pacman-contrib)
                                // refreshes a private temp DB without root.
                                let pac = StdCommand::new("checkupdates").output()
                                    .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
                                    .unwrap_or_else(|_| StdCommand::new("pacman").arg("-Qu").output()
                                        .map(|o| String::from_utf8_lossy(&o.stdout).lines().count()).unwrap_or(0));
                                let aur = StdCommand::new("paru").arg("-Qua").output().map(|o| String::from_utf8_lossy(&o.stdout).lines().count()).unwrap_or(0);
                                pac + aur
                            }
                            "dnf5" | "dnf" => {
                                let mgr = detect_pkg_mgr();
                                StdCommand::new(mgr).args(["check-update","--quiet"]).output()
                                    .map(|o| String::from_utf8_lossy(&o.stdout).lines()
                                        .filter(|l| !l.is_empty() && !l.starts_with("Last") && !l.starts_with("Obsoleting")).count())
                                    .unwrap_or(0)
                            }
                            "apt" => {
                                let _ = StdCommand::new("apt").args(["update","-qq"]).output();
                                StdCommand::new("apt").args(["list","--upgradable"]).output()
                                    .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.contains('/')).count())
                                    .unwrap_or(0)
                            }
                            "zypper" => {
                                StdCommand::new("zypper").args(["--non-interactive","list-updates"]).output()
                                    .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.starts_with("v ")||l.starts_with("| ")).count())
                                    .unwrap_or(0)
                            }
                            _ => 0,
                        };

                        // Tray badge: persistent reminder, unlike the notification
                        if let Some(tray) = upd_handle.tray_by_id("updates") {
                            if total > 0 {
                                let lang_t = std::env::var("LANG").unwrap_or_default();
                                let tip = if lang_t.starts_with("es") {
                                    if total == 1 { "1 actualización disponible".to_string() }
                                    else { format!("{} actualizaciones disponibles", total) }
                                } else {
                                    if total == 1 { "1 update available".to_string() }
                                    else { format!("{} updates available", total) }
                                };
                                let _ = tray.set_tooltip(Some(&tip));
                                let _ = tray.set_title(Some(&total.to_string()));
                                let _ = tray.set_visible(true);
                            } else {
                                let _ = tray.set_visible(false);
                            }
                        }
                        // UpdateNotifications=false silences the popup (tray badge stays).
                        let notify_on = load_bookos_settings().get("UpdateNotifications")
                            .and_then(|v| v.as_str()).unwrap_or("true") != "false";
                        if total > 0 && notify_on {
                            // Pretty, branded notification — matches the timer notification.
                            let icon = if std::path::Path::new("/usr/share/icons/hicolor/scalable/apps/bookos-settings.svg").exists()
                                { "bookos-settings" } else { "software-update-available" };
                            let lang = std::env::var("LANG").unwrap_or_default();
                            let is_es = lang.starts_with("es");
                            let (title, body) = if is_es {
                                let t = if total == 1 { "1 actualización disponible".to_string() }
                                        else { format!("{} actualizaciones disponibles", total) };
                                (t, "Abre BookOS Settings para revisar e instalar.".to_string())
                            } else {
                                let t = if total == 1 { "1 update available".to_string() }
                                        else { format!("{} updates available", total) };
                                (t, "Open BookOS Settings to review and install.".to_string())
                            };
                            let action_label = if is_es { "Abrir" } else { "Open" };
                            // Clickable notification: notify-send --wait blocks until the
                            // user clicks the action (or the body). When it returns the
                            // action key, open the Updates page. Run in its own thread so
                            // the 6h check loop isn't blocked waiting for interaction.
                            let icon_s = icon.to_string();
                            let (t_s, b_s, act_s) = (title.clone(), body.clone(), action_label.to_string());
                            std::thread::spawn(move || {
                                let out = StdCommand::new("notify-send")
                                    .args([
                                        "-u", "normal",
                                        "-a", "BookOS",
                                        "-i", &icon_s,
                                        "-c", "system.software-update",
                                        "-h", "string:desktop-entry:bookos-settings",
                                        "--wait",
                                        "-A", &format!("default={}", act_s),
                                        "-A", &format!("open={}", act_s),
                                        &t_s, &b_s,
                                    ])
                                    .output();
                                // If the user activated the notification, notify-send prints
                                // the action key ("default" / "open") on stdout.
                                let activated = out.as_ref().map(|o| {
                                    let s = String::from_utf8_lossy(&o.stdout);
                                    let s = s.trim();
                                    s == "default" || s == "open"
                                }).unwrap_or(false);
                                if activated {
                                    open_updates_page();
                                }
                            });
                        }
                    }
                    // Wait 6 hours for next check
                    std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_main_window,
            get_user_info,set_display_name,set_hostname,get_system_info,get_default_hostname,get_bookos_release,refresh_bookos_release,get_update_channel,set_update_channel,apply_bookos_release,list_bookos_snapshots,rollback_bookos_snapshot,get_snapshot_support,get_bookos_repo_status,set_bookos_repo,
            check_hw_features,set_performance_mode,set_charge_limit,set_background_throttle,predict_battery_runtime,
            get_wifi_status,toggle_wifi,get_wifi_list,connect_wifi,wifi_rescan,
            get_bluetooth_status,toggle_bluetooth,get_bluetooth_devices,connect_bluetooth,disconnect_bluetooth,bluetooth_scan,
            get_airplane_mode,toggle_airplane_mode,
            get_brightness,set_brightness,get_kbd_brightness,set_kbd_brightness,
            get_nightlight,set_nightlight,set_nightlight_schedule,
            get_volume,set_volume,toggle_mute,set_balance,get_balance,
            get_battery_status,get_battery_sysfs,get_battery_history,get_battery_csv_data,get_adaptive_predictions,set_adaptive_charging,
            get_display_info,set_resolution,set_vrr_policy,
            get_current_theme,get_available_themes,set_color_scheme,get_theme_schedule,set_theme_schedule,set_icon_style,
            get_kde_light_dark_themes,apply_kde_theme,
            get_dnd_status,toggle_dnd,
            get_lock_timeout,set_lock_timeout,set_lock_grace,get_lock_grace,check_fingerprint,enroll_fingerprint,verify_password,verify_fingerprint,
            get_locale_info,get_available_locales,set_locale,get_available_keymaps,set_keymap,
            get_datetime_info,list_timezones,set_timezone,set_ntp,
            check_system_updates,check_aur_updates,check_flatpak_updates,run_system_update,run_pacman_update_silent,get_update_progress,cancel_update,run_flatpak_update,run_aur_update,get_pkg_mgr,has_flatpak,logout_session,
            get_app_power_usage,get_sddm_themes,set_sddm_theme,get_sddm_config,set_sddm_config,preview_sddm,
            is_lockscreen_theme_installed,install_lockscreen_theme,uninstall_lockscreen_theme,
            is_sddm_theme_installed,install_sddm_theme,uninstall_sddm_theme,
            get_app_usage,
            run_maintenance,get_kwin_effects,toggle_kwin_effect,fix_cursor_hz,get_cursor_fix_status,get_input_devices,set_input_setting,
            get_firewall_status,run_sudo_command,get_system_users,
            get_autostart_bookos,toggle_autostart_bookos,get_autostart_apps,toggle_autostart_app,setup_polkit_rules,export_settings,import_settings,
            get_accessibility_settings,set_font_scale,set_display_scale,toggle_invert_colors,set_cursor_size,
            change_password,set_avatar,create_user,delete_user,get_autologin_status,set_autologin,get_labs_settings,set_lab_setting,
            forget_wifi,get_wifi_details,get_ethernet_status,get_ethernet_details,get_wifi_password,log_app_usage,track_active_app,
            get_wallpapers,add_wallpapers,get_current_wallpaper,set_wallpaper,
            get_default_apps,list_apps_for_role,set_default_app,open_mime_settings,
            get_bookos_setting,set_bookos_setting,get_settings_batch,configure_auto_update,restore_startup_settings,get_startup_page,check_navigation_request,write_ipc_state,read_ipc_state,
            get_available_kvantum_themes,get_available_plasma_themes,get_style_themes,set_style_themes,
            get_bt_device_battery,get_kdeconnect_devices,
            get_audio_devices,set_default_sink,set_default_source,get_app_audio,set_app_volume,get_sink_descriptions,
            get_location_status,set_location_enabled,run_command,launch_app,which_app,
            hardware_control::aplicar_perfil_termico,
            hardware_control::set_fan_mode,
            hardware_control::check_book_hw,
            hardware_control::activar_vision_booster,hardware_control::desactivar_vision_booster,
            hardware_control::activar_hdr,hardware_control::desactivar_hdr,
            hardware_control::activar_ahorro_pantalla,hardware_control::desactivar_ahorro_pantalla,
            hardware_control::aplicar_perfil_color,
            hardware_control::set_brillo,
            hardware_control::obtener_estado_pantalla,
            buds::buds_connect,buds::buds_disconnect,buds::buds_get_status,
            buds::buds_set_auto_reconnect,buds::buds_get_prefs,buds::buds_try_auto_reconnect,buds::buds_audio_switch_check,
            buds::buds_fit_test_start,buds::buds_fit_test_stop,buds::buds_set_easy_pairing,buds::buds_request_info,buds::buds_notify_battery,
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
    let _ = std::fs::remove_file(lock_path());
}
