// hardware_control.rs — BookOS hardware control (Intel Arc 140V / Lunar Lake, xe driver)
// Reverse engineered from Samsung Settings (Windows ProcMon + EC-Probe analysis)

use std::fs;
use tokio::process::Command;
use std::time::Duration;

// ── Sysfs paths (verified on hardware) ───────────────────────────────────────
const RAPL_PL1: &str = "/sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw";
const RAPL_PL2: &str = "/sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw";
const PLATFORM_PROFILE: &str = "/sys/firmware/acpi/platform_profile";
const PLATFORM_PROFILE_MODERN: &str = "/sys/class/platform-profile/platform-profile-0/profile";
const BACKLIGHT: &str = "/sys/class/backlight/intel_backlight/brightness";
const BACKLIGHT_MAX: u32 = 400;
const BACKLIGHT_DEFAULT_RAW: u32 = 160; // 40% — user default observed in kscreen-doctor
const GPU_POWER: &str = "/sys/bus/pci/devices/0000:00:02.0/power/control";
const ICC_DIR: &str = "/usr/share/color/icc/BookOS";
const DISPLAY: &str = "eDP-1";
const COLORD_DEVICE: &str = "xrandr-eDP-1";

// ── Low-level helpers ─────────────────────────────────────────────────────────

fn write_sysfs(path: &str, value: &str) -> Result<(), String> {
    fs::write(path, value).map_err(|e| {
        let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
            if path.contains("powercap") {
                " → Instala el servicio y cierra sesión: sudo cp src-tauri/extra/bookos-hw-perms.service /etc/systemd/system/ && sudo systemctl enable --now bookos-hw-perms && sudo usermod -aG power $USER (luego cierra sesión)"
            } else if path.contains("backlight") {
                " → Cierra sesión para aplicar los grupos: sudo usermod -aG video $USER"
            } else if path.contains("power/control") {
                " → Cierra sesión para aplicar los grupos: sudo usermod -aG power $USER (el servicio bookos-hw-perms aplica permisos al arrancar)"
            } else {
                ""
            }
        } else {
            ""
        };
        format!("Error escribiendo {}: {}.{}", path, e, hint)
    })
}

/// Soft write — returns a concise one-line warning on failure, never propagates.
fn write_sysfs_soft(path: &str, value: &str) -> Option<String> {
    match fs::write(path, value) {
        Ok(_) => None,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::PermissionDenied {
                if path.contains("powercap") {
                    "RAPL sin permisos — instala bookos-hw-perms.service"
                } else if path.contains("power/control") {
                    "GPU power sin permisos — instala bookos-hw-perms.service"
                } else if path.contains("backlight") {
                    "Brillo sin permisos — añade usuario al grupo video"
                } else {
                    "sin permisos"
                }
            } else {
                "error de escritura sysfs"
            };
            Some(msg.to_string())
        }
    }
}

/// Run command with 5 s timeout. Returns Err only if the command itself fails.
/// "already" messages are treated as success.
async fn run_cmd_capture(program: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let child = Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar {}: {}", program, e))?;

    let result = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        child.wait_with_output()
    ).await;

    match result {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() { return Ok(stdout); }
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stderr = stderr.trim();
            if stderr.contains("already") || stderr.contains("Already") { return Ok(stdout); }
            let detail = if stderr.is_empty() { "sin respuesta" } else { stderr };
            Err(format!("{} falló: {}", program, detail))
        }
        Ok(Err(e)) => Err(format!("Error al esperar {}: {}", program, e)),
        Err(_) => {
            // child was consumed by wait_with_output; tokio drops & kills it on timeout
            Err(format!("{} no respondió en {}s", program, timeout_ms / 1000))
        }
    }
}
async fn run_cmd(program: &str, args: &[&str]) -> Result<(), String> {
    run_cmd_timeout(program, args, 5_000).await
}

async fn run_cmd_timeout(program: &str, args: &[&str], timeout_ms: u64) -> Result<(), String> {
    run_cmd_capture(program, args, timeout_ms).await.map(|_| ())
}


fn read_sysfs(path: &str) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

// ── 1. Thermal profile ────────────────────────────────────────────────────────
// RAPL writes are non-fatal. Platform profile prefers power-profiles-daemon
// (DBus, no root) and falls back to direct sysfs.

async fn set_ppd_profile(profile: &str) -> Result<(), String> {
    let conn = zbus::Connection::system().await.map_err(|e| e.to_string())?;
    let props = zbus::Proxy::new(
        &conn,
        "net.hadess.PowerProfiles",
        "/net/hadess/PowerProfiles",
        "org.freedesktop.DBus.Properties",
    ).await.map_err(|e| e.to_string())?;
    props.call::<_, _, ()>(
        "Set",
        &("net.hadess.PowerProfiles", "ActiveProfile", zbus::zvariant::Value::from(profile)),
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn aplicar_perfil_termico(modo: String) -> Result<String, String> {
    // (pl1_uw, pl2_uw, platform_profile value, PPD value ("" = skip PPD))
    let (pl1, pl2, profile, ppd) = match modo.as_str() {
        "ahorro"      => (4_000_000u64,   5_000_000u64,  "low-power",   ""),  // PL2 bajo = no boost = menos calor = fan no arranca
        "silencioso"  => (8_000_000u64,  12_000_000u64,  "quiet",       "power-saver"),
        "optimizado"  => (15_000_000u64, 25_000_000u64,  "balanced",    "balanced"),
        "rendimiento" => (28_000_000u64, 45_000_000u64,  "performance", "performance"),
        other => return Err(format!("Modo desconocido: '{}'. Usa: ahorro, silencioso, optimizado, rendimiento", other)),
    };

    let mut warns: Vec<String> = Vec::new();

    if let Some(e) = write_sysfs_soft(RAPL_PL1, &pl1.to_string()) { warns.push(e); }
    if let Some(e) = write_sysfs_soft(RAPL_PL2, &pl2.to_string()) { warns.push(e); }

    // Platform profile write path:
    // 1. PPD via DBus (preferred, no root, but only covers 3 stdprofiles)
    // 2. Modern per-device API (/sys/class/platform-profile/*/profile)
    // 3. Legacy firmware path (/sys/firmware/acpi/platform_profile)
    let mut profile_ok = false;
    if !ppd.is_empty() {
        profile_ok = set_ppd_profile(ppd).await.is_ok();
    }
    if !profile_ok {
        profile_ok = write_sysfs_soft(PLATFORM_PROFILE_MODERN, profile).is_none();
    }
    if !profile_ok {
        profile_ok = write_sysfs_soft(PLATFORM_PROFILE, profile).is_none();
    }
    if !profile_ok {
        warns.push("perfil de plataforma sin permisos".to_string());
    }

    let note = if warns.is_empty() {
        String::new()
    } else {
        format!(" ({})", warns.join("; "))
    };

    Ok(format!("Perfil '{}' aplicado{}", modo, note))
}

// ── ICC background helper ─────────────────────────────────────────────────────
// Spawns ICC application in a detached thread so toggles return immediately.
fn spawn_icc(profile: &'static str) {
    tokio::spawn(async move {
        let _ = aplicar_perfil_color_interno(profile).await;
    });
}

// ── 2. Vision Booster ─────────────────────────────────────────────────────────
// WCG and ICC are fire-and-forget (spawned threads) so the toggle returns
// as soon as the core backlight write succeeds. No more multi-second freeze.

#[tauri::command]
pub async fn activar_vision_booster() -> Result<String, String> {
    // Set brightness to 100% via KDE D-Bus (keeps KDE in sync)
    let max: u64 = run_cmd_capture("qdbus6", &[
        "org.kde.Solid.PowerManagement",
        "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
        "brightnessMax",
    ], 2_000).await.unwrap_or_default().trim().parse().unwrap_or(400);
    run_cmd_timeout("qdbus6", &[
        "org.kde.Solid.PowerManagement",
        "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
        "setBrightness",
        &max.to_string(),
    ], 2_000).await?;

    let display = DISPLAY.to_string();
    tokio::spawn(async move {
        let _ = run_cmd_timeout("kscreen-doctor", &[&format!("output.{}.wcg.enable", display)], 5_000).await;
    });
    spawn_icc("SDC4189P.icm");

    Ok("Vision Booster activado: brillo máximo".to_string())
}

#[tauri::command]
pub async fn desactivar_vision_booster() -> Result<String, String> {
    // Restore to 40% via KDE D-Bus
    let max: u64 = run_cmd_capture("qdbus6", &[
        "org.kde.Solid.PowerManagement",
        "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
        "brightnessMax",
    ], 2_000).await.unwrap_or_default().trim().parse().unwrap_or(400);
    let raw_40 = max * 40 / 100;
    run_cmd_timeout("qdbus6", &[
        "org.kde.Solid.PowerManagement",
        "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
        "setBrightness",
        &raw_40.to_string(),
    ], 2_000).await?;

    let display = DISPLAY.to_string();
    tokio::spawn(async move {
        let _ = run_cmd_timeout("kscreen-doctor", &[&format!("output.{}.wcg.disable", display)], 5_000).await;
    });
    spawn_icc("SDC4189.icm");

    Ok("Vision Booster desactivado: brillo restaurado".to_string())
}

// ── 3. HDR ────────────────────────────────────────────────────────────────────
// HDR enable/disable via kscreen-doctor are the primary operations (fatal if
// kscreen-doctor not found). WCG and ICC are non-fatal.

#[tauri::command]
pub async fn activar_hdr() -> Result<String, String> {
    // Primary: HDR signal (fatal — this is the whole point of the toggle)
    run_cmd("kscreen-doctor", &[&format!("output.{}.hdr.enable", DISPLAY)]).await?;

    let display = DISPLAY.to_string();
    tokio::spawn(async move {
        let _ = run_cmd_timeout("kscreen-doctor", &[&format!("output.{}.wcg.enable", display)], 5_000).await;
        if let Ok(m) = run_cmd_capture("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","brightnessMax"],2_000).await{
            if let Ok(max)=m.trim().parse::<u64>(){
                let _=run_cmd_timeout("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","setBrightness",&max.to_string()],2_000).await;
            }
        }
    });

    Ok("HDR activado".to_string())
}

#[tauri::command]
pub async fn desactivar_hdr() -> Result<String, String> {
    run_cmd("kscreen-doctor", &[&format!("output.{}.hdr.disable", DISPLAY)]).await?;

    let display = DISPLAY.to_string();
    tokio::spawn(async move {
        let _ = run_cmd_timeout("kscreen-doctor", &[&format!("output.{}.wcg.disable", display)], 5_000).await;
        if let Ok(m) = run_cmd_capture("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","brightnessMax"],2_000).await{
            if let Ok(max)=m.trim().parse::<u64>(){
                let raw_40=max*40/100;
                let _=run_cmd_timeout("qdbus6",&["org.kde.Solid.PowerManagement","/org/kde/Solid/PowerManagement/Actions/BrightnessControl","setBrightness",&raw_40.to_string()],2_000).await;
            }
        }
    });
    spawn_icc("SDC4189.icm");

    Ok("HDR desactivado: brillo restaurado".to_string())
}

// ── 4. Ahorro de pantalla ─────────────────────────────────────────────────────
// Hz change and GPU power management. GPU power write is non-fatal.

#[tauri::command]
pub async fn activar_ahorro_pantalla() -> Result<String, String> {
    let mut warns: Vec<String> = Vec::new();

    let _ = run_cmd("kscreen-doctor", &[&format!("output.{}.mode.2880x1800@90", DISPLAY)]).await;
    let _ = run_cmd("kscreen-doctor", &[&format!("output.{}.vrrpolicy.1", DISPLAY)]).await;

    // Core: backlight (fatal — needs video group)
    write_sysfs(BACKLIGHT, &BACKLIGHT_DEFAULT_RAW.to_string())?;

    // Non-fatal: GPU runtime PM (needs power group / bookos-hw-perms.service)
    if let Some(e) = write_sysfs_soft(GPU_POWER, "auto") { warns.push(e); }

    let note = if warns.is_empty() { String::new() } else { format!(" (no crítico: {})", warns.join("; ")) };
    Ok(format!("Ahorro de pantalla activado: 90Hz, brillo al 40%{}", note))
}

#[tauri::command]
pub async fn desactivar_ahorro_pantalla() -> Result<String, String> {
    let mut warns: Vec<String> = Vec::new();

    let _ = run_cmd("kscreen-doctor", &[&format!("output.{}.mode.2880x1800@120", DISPLAY)]).await;
    // Restore VRR to "automatic" (only when app requests it) at 120Hz
    let _ = run_cmd("kscreen-doctor", &[&format!("output.{}.vrrpolicy.2", DISPLAY)]).await;

    if let Some(e) = write_sysfs_soft(GPU_POWER, "auto") { warns.push(e); }

    let note = if warns.is_empty() { String::new() } else { format!(" (no crítico: {})", warns.join("; ")) };
    Ok(format!("Ahorro de pantalla desactivado: 120Hz restaurado{}", note))
}

// ── 5. Color profile (internal + command) ────────────────────────────────────

#[allow(dead_code)]
fn extract_object_path(output: &str) -> Option<String> {
    output.lines().find_map(|l| {
        let l = l.trim();
        if l.starts_with("Object path:") {
            Some(l["Object path:".len()..].trim().to_string())
        } else {
            None
        }
    })
}

// ── ICC via KWin (Plasma 6 Wayland gestiona ICC directamente, no colord) ─────
// KWin lee el perfil desde ~/.local/share/icc/ y se aplica con kscreen-doctor.
async fn aplicar_perfil_color_interno(nombre_archivo: &str) -> Result<(), String> {
    let valid = ["SDC4189.icm", "SDC4189S.icm", "SDC4189A.icm", "SDC4189P.icm"];
    if !valid.contains(&nombre_archivo) {
        return Err(format!("Perfil no válido: '{}'", nombre_archivo));
    }
    let src = format!("{}/{}", ICC_DIR, nombre_archivo);
    if !std::path::Path::new(&src).exists() {
        return Err(format!("Perfil no encontrado en {}", ICC_DIR));
    }

    // Copiar al directorio de usuario que KWin monitoriza
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    let icc_user_dir = format!("{}/.local/share/icc", home);
    std::fs::create_dir_all(&icc_user_dir).ok();
    let dest = format!("{}/{}", icc_user_dir, nombre_archivo);
    std::fs::copy(&src, &dest).map_err(|e| format!("No se pudo copiar el perfil: {}", e))?;

    // Aplicar vía kscreen-doctor (Plasma 6 Wayland)
    run_cmd_timeout("kscreen-doctor", &[
        &format!("output.{}.icc.profile.{}", DISPLAY, dest),
    ], 5_000).await?;

    Ok(())
}

#[tauri::command]
pub async fn aplicar_perfil_color(nombre_archivo: String) -> Result<String, String> {
    aplicar_perfil_color_interno(&nombre_archivo).await?;
    Ok(format!("Perfil ICC '{}' aplicado en {}", nombre_archivo, COLORD_DEVICE))
}

// ── 6. Brillo ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_brillo(porcentaje: u32) -> Result<String, String> {
    let pct = porcentaje.clamp(5, 100);
    let raw = BACKLIGHT_MAX * pct / 100;
    write_sysfs(BACKLIGHT, &raw.to_string())?;
    Ok(format!("Brillo establecido al {}% (raw: {})", pct, raw))
}

// ── 7. Estado de pantalla ─────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct EstadoPantalla {
    pub brillo_porcentaje: u32,
    pub modo_termico: String,
    pub platform_profile: String,
    pub pl1_watts: u64,
    pub hdr_activo: bool,
}

#[tauri::command]
pub async fn obtener_estado_pantalla() -> Result<EstadoPantalla, String> {
    // Brillo
    let brillo_porcentaje = read_sysfs(BACKLIGHT)
        .and_then(|s| s.parse::<u32>().ok())
        .map(|raw| (raw * 100 / BACKLIGHT_MAX).clamp(0, 100))
        .unwrap_or(40);

    // PL1 → watts → modo
    let pl1_uw: u64 = read_sysfs(RAPL_PL1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(15_000_000);
    let pl1_watts = pl1_uw / 1_000_000;
    let modo_termico = match pl1_watts {
        0..=10  => "silencioso",
        11..=20 => "optimizado",
        _       => "rendimiento",
    }.to_string();

    // Platform profile — modern per-device path first, legacy fallback
    let platform_profile = read_sysfs(PLATFORM_PROFILE_MODERN)
        .or_else(|| read_sysfs(PLATFORM_PROFILE))
        .unwrap_or_else(|| "desconocido".to_string());

    // HDR — parseamos la salida de kscreen-doctor (vía Tokio)
    let hdr_activo = {
        let result = tokio::time::timeout(
            Duration::from_millis(1_500),
            Command::new("kscreen-doctor").arg("-o").output()
        ).await;

        match result {
            Ok(Ok(o)) => {
                let out = String::from_utf8_lossy(&o.stdout).to_lowercase();
                out.contains("hdr: enabled") || out.contains("hdr:enabled") || out.contains("hdr: 1")
            }
            _ => false,
        }
    };

    Ok(EstadoPantalla { brillo_porcentaje, modo_termico, platform_profile, pl1_watts, hdr_activo })
}
