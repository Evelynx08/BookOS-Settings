// BookOS semantic search — Tauri commands wrapping /opt/bookos-search scripts.
use std::process::Stdio;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};

const SEARCH_DIR: &str = "/opt/bookos-search";
const STATE_FILE: &str = "/tmp/bookos-search-install.state";
const LOG_FILE:   &str = "/tmp/bookos-search-install.log";

fn venv_ok() -> bool { std::path::Path::new(&format!("{SEARCH_DIR}/venv/bin/python")).exists() }
fn script(n: &str) -> String { format!("{SEARCH_DIR}/{n}") }
fn py()   -> String { format!("{SEARCH_DIR}/venv/bin/python") }

async fn sh(cmd: &str, args: &[&str]) -> (bool, String) {
    let out = Command::new(cmd).args(args).output().await;
    match out {
        Ok(o) => (o.status.success(), String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Err(e) => (false, format!("error: {e}")),
    }
}

#[tauri::command]
pub async fn search_status() -> String {
    let installed = venv_ok();
    let (_, watcher) = sh("systemctl", &["--user", "is-active", "bookos-search-watcher.service"]).await;
    let (_, timer)   = sh("systemctl", &["--user", "is-active", "bookos-search-reindex.timer"]).await;
    let (_, reidx)   = sh("systemctl", &["--user", "is-active", "bookos-search-reindex.service"]).await;

    let count = if installed {
        let out = Command::new(py()).args(&[&script("indexador.py"), "--stats"])
            .output().await.ok();
        out.and_then(|o| String::from_utf8(o.stdout).ok())
           .and_then(|s| s.lines().find(|l| l.starts_with("fragmentos:"))
               .and_then(|l| l.split(':').nth(1).map(|v| v.trim().parse::<u64>().ok().unwrap_or(0))))
           .unwrap_or(0)
    } else { 0 };

    let install_state = std::fs::read_to_string(STATE_FILE).unwrap_or_default();
    let install_state = install_state.trim();

    format!(
        r#"{{"installed":{installed},"watcher":"{watcher}","timer":"{timer}","reindex":"{reidx}","count":{count},"install_state":"{install_state}"}}"#
    )
}

fn set_state(s: &str) { let _ = std::fs::write(STATE_FILE, s); }

#[tauri::command]
pub async fn search_install() -> String {
    if venv_ok() { return r#"{"ok":true,"note":"ya instalado"}"#.into(); }
    let state = std::fs::read_to_string(STATE_FILE).unwrap_or_default();
    if state.trim() == "installing" { return r#"{"ok":false,"error":"ya en curso"}"#.into(); }
    set_state("installing");
    let _ = std::fs::write(LOG_FILE, "");

    tokio::spawn(async {
        let child = Command::new("pkexec")
            .arg(format!("{SEARCH_DIR}/setup.sh"))
            .stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn();
        let ok = match child {
            Ok(mut ch) => {
                if let Some(out) = ch.stdout.take() {
                    tokio::spawn(async move {
                        let mut r = BufReader::new(out).lines();
                        while let Ok(Some(l)) = r.next_line().await {
                            use std::io::Write;
                            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(LOG_FILE) {
                                let _ = writeln!(f, "{l}");
                            }
                        }
                    });
                }
                if let Some(err) = ch.stderr.take() {
                    tokio::spawn(async move {
                        let mut r = BufReader::new(err).lines();
                        while let Ok(Some(l)) = r.next_line().await {
                            use std::io::Write;
                            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(LOG_FILE) {
                                let _ = writeln!(f, "{l}");
                            }
                        }
                    });
                }
                ch.wait().await.map(|s| s.success()).unwrap_or(false)
            }
            Err(_) => false,
        };
        if !ok { set_state("failed"); return; }
        set_state("indexing");
        // Reindex inicial
        let _ = Command::new(py()).args(&[&script("indexador.py"), "--full"]).status().await;
        // Activar unidades user
        let _ = sh("systemctl", &["--user","daemon-reload"]).await;
        let _ = sh("systemctl", &["--user","enable","--now","bookos-search-watcher.service"]).await;
        let _ = sh("systemctl", &["--user","enable","--now","bookos-search-reindex.timer"]).await;
        let _ = sh("systemctl", &["--user","enable","--now","bookos-krunner.service"]).await;
        set_state("ready");
    });

    r#"{"ok":true}"#.into()
}

#[tauri::command]
pub async fn search_install_log() -> String {
    let log = std::fs::read_to_string(LOG_FILE).unwrap_or_default();
    let tail: Vec<&str> = log.lines().rev().take(20).collect();
    let lines: Vec<&str> = tail.into_iter().rev().collect();
    serde_json::json!({"log": lines.join("\n")}).to_string()
}

#[tauri::command]
pub async fn search_toggle(enable: bool) -> String {
    if !venv_ok() { return r#"{"ok":false,"error":"no instalado"}"#.into(); }
    let action = if enable { "enable" } else { "disable" };
    let _ = sh("systemctl", &["--user", action, "--now", "bookos-search-watcher.service"]).await;
    let _ = sh("systemctl", &["--user", action, "--now", "bookos-search-reindex.timer"]).await;
    let _ = sh("systemctl", &["--user", action, "--now", "bookos-krunner.service"]).await;
    r#"{"ok":true}"#.into()
}

#[tauri::command]
pub async fn search_reindex() -> String {
    if !venv_ok() { return r#"{"ok":false,"error":"no instalado"}"#.into(); }
    let _ = sh("systemctl", &["--user","start","bookos-search-reindex.service"]).await;
    r#"{"ok":true}"#.into()
}

#[tauri::command]
pub async fn search_query(query: String) -> String {
    if !venv_ok() { return r#"{"error":"no instalado","results":[]}"#.into(); }
    let out = Command::new(py())
        .args(&[&script("buscar.py"), &query, "--json", "-n", "10"])
        .output().await;
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            format!(r#"{{"results":{s}}}"#)
        }
        Err(e) => format!(r#"{{"error":"{e}","results":[]}}"#),
    }
}

#[tauri::command]
pub async fn search_uninstall() -> String {
    // Parar servicios user
    let _ = sh("systemctl", &["--user","disable","--now","bookos-search-watcher.service"]).await;
    let _ = sh("systemctl", &["--user","disable","--now","bookos-search-reindex.timer"]).await;
    // Borrar venv + db (db es de usuario)
    let _ = Command::new("pkexec").args(&["rm","-rf", &format!("{SEARCH_DIR}/venv"), &format!("{SEARCH_DIR}/models")]).status().await;
    let home = std::env::var("HOME").unwrap_or_default();
    let _ = std::fs::remove_dir_all(format!("{home}/.local/share/bookos-search"));
    set_state("");
    r#"{"ok":true}"#.into()
}
