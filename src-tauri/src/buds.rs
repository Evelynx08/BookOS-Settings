//! Galaxy Buds SPP protocol implementation for BookOS Settings.
//!
//! Derived from: https://github.com/timschneeb/GalaxyBudsClient
//! Protocol reverse-engineering credit: timschneeb and contributors.
//!
//! Supports: Galaxy Buds (legacy), Buds+, BudsLive, BudsPro, Buds2, Buds2 Pro, BudsFE, Buds3, Buds3 Pro, Buds4, Buds4 Pro
//! Tested on Linux with BlueZ via raw RFCOMM sockets.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use serde::{Deserialize, Serialize};

// ── CRC16-CCITT table (from GalaxyBudsClient/Utils/Crc16.cs) ─────────────────

static CRC16_TABLE: [u32; 256] = [
    0, 4129, 8258, 12387, 16516, 20645, 24774, 28903, 33032, 37161, 41290,
    45419, 49548, 53677, 57806, 61935, 4657, 528, 12915, 8786, 21173, 17044,
    29431, 25302, 37689, 33560, 45947, 41818, 54205, 50076, 62463, 58334, 9314,
    13379, 1056, 5121, 25830, 29895, 17572, 21637, 42346, 46411, 34088, 38153,
    58862, 62927, 50604, 54669, 13907, 9842, 5649, 1584, 30423, 26358, 22165,
    18100, 46939, 42874, 38681, 34616, 63455, 59390, 55197, 51132, 18628, 22757,
    26758, 30887, 2112, 6241, 10242, 14371, 51660, 55789, 59790, 63919, 35144,
    39273, 43274, 47403, 23285, 19156, 31415, 27286, 6769, 2640, 14899, 10770,
    56317, 52188, 64447, 60318, 39801, 35672, 47931, 43802, 27814, 31879, 19684,
    23749, 11298, 15363, 3168, 7233, 60846, 64911, 52716, 56781, 44330, 48395,
    36200, 40265, 32407, 28342, 24277, 20212, 15891, 11826, 7761, 3696, 65439,
    61374, 57309, 53244, 48923, 44858, 40793, 36728, 37256, 33193, 45514, 41451,
    53516, 49453, 61774, 57711, 4224, 161, 12482, 8419, 20484, 16421, 28742,
    24679, 33721, 37784, 41979, 46042, 49981, 54044, 58239, 62302, 689, 4752,
    8947, 13010, 16949, 21012, 25207, 29270, 46570, 42443, 38312, 34185, 62830,
    58703, 54572, 50445, 13538, 9411, 5280, 1153, 29798, 25671, 21540, 17413,
    42971, 47098, 34713, 38840, 59231, 63358, 50973, 55100, 9939, 14066, 1681,
    5808, 26199, 30326, 17941, 22068, 55628, 51565, 63758, 59695, 39368, 35305,
    47498, 43435, 22596, 18533, 30726, 26663, 6336, 2273, 14466, 10403, 52093,
    56156, 60223, 64286, 35833, 39896, 43963, 48026, 19061, 23124, 27191, 31254,
    2801, 6864, 10931, 14994, 64814, 60687, 56684, 52557, 48554, 44427, 40424,
    36297, 31782, 27655, 23652, 19525, 15522, 11395, 7392, 3265, 61215, 65342,
    53085, 57212, 44955, 49082, 36825, 40952, 28183, 32310, 20053, 24180, 11923,
    16050, 3793, 7920,
];

fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut crc: u32 = 0;
    for &b in data {
        crc = CRC16_TABLE[((crc >> 8) ^ b as u32) as usize & 0xFF] ^ (crc << 8);
    }
    (crc & 0xFFFF) as u16
}

// ── Message IDs (subset used by BookOS) ──────────────────────────────────────

const MSG_MANAGER_INFO: u8 = 136;        // MANAGER_INFO — must send on connect
const MSG_STATUS_UPDATED: u8 = 96;       // STATUS_UPDATED — basic status response
const MSG_EXTENDED_STATUS: u8 = 97;      // EXTENDED_STATUS_UPDATED — full status
const MSG_NOISE_CONTROLS: u8 = 120;      // NOISE_CONTROLS — set ANC mode
const MSG_EQUALIZER: u8 = 134;           // EQUALIZER — set EQ
const MSG_LOCK_TOUCHPAD: u8 = 144;       // LOCK_TOUCHPAD — lock/unlock touch
const MSG_NOISE_REDUCTION_LEVEL: u8 = 131; // NOISE_REDUCTION_LEVEL — ANC Normal/High

// ── Packet framing constants ──────────────────────────────────────────────────

const SOM_STD: u8 = 0xFD;   // Start-of-message (standard: Buds+/Live/Pro/2+)
const EOM_STD: u8 = 0xDD;   // End-of-message (standard)
const SOM_LEG: u8 = 0xFE;   // Start-of-message (legacy: original Buds only)
const EOM_LEG: u8 = 0xEE;   // End-of-message (legacy)

// ── Packet encoding ───────────────────────────────────────────────────────────

/// Encode a standard (Buds+/Live/Pro/2+) request packet.
/// Wire format: [SOM][size_lo][size_hi|flags][msg_id][payload…][crc_lo][crc_hi][EOM]
/// size = 1(msgId) + payload.len() + 2(CRC)
fn encode_std(msg_id: u8, payload: &[u8]) -> Vec<u8> {
    let size = payload.len() + 3;
    let mut crc_data = Vec::with_capacity(1 + payload.len());
    crc_data.push(msg_id);
    crc_data.extend_from_slice(payload);
    let crc = crc16_ccitt(&crc_data);

    let mut pkt = Vec::with_capacity(1 + 2 + 1 + payload.len() + 2 + 1);
    pkt.push(SOM_STD);
    pkt.push((size & 0xFF) as u8);
    pkt.push(((size >> 8) & 0xFF) as u8);
    pkt.push(msg_id);
    pkt.extend_from_slice(payload);
    pkt.push((crc & 0xFF) as u8);       // CRC low
    pkt.push(((crc >> 8) & 0xFF) as u8); // CRC high
    pkt.push(EOM_STD);
    pkt
}

/// Encode a legacy (original Buds) request packet.
/// Wire format: [SOM][type=0][size][msg_id][payload…][crc_lo][crc_hi][EOM]
fn encode_leg(msg_id: u8, payload: &[u8]) -> Vec<u8> {
    let size = payload.len() + 3;
    let mut crc_data = Vec::with_capacity(1 + payload.len());
    crc_data.push(msg_id);
    crc_data.extend_from_slice(payload);
    let crc = crc16_ccitt(&crc_data);

    let mut pkt = Vec::with_capacity(1 + 1 + 1 + 1 + payload.len() + 2 + 1);
    pkt.push(SOM_LEG);
    pkt.push(0u8);          // Type = Request = 0
    pkt.push(size as u8);
    pkt.push(msg_id);
    pkt.extend_from_slice(payload);
    pkt.push((crc & 0xFF) as u8);
    pkt.push(((crc >> 8) & 0xFF) as u8);
    pkt.push(EOM_LEG);
    pkt
}

fn encode(msg_id: u8, payload: &[u8], legacy: bool) -> Vec<u8> {
    if legacy { encode_leg(msg_id, payload) } else { encode_std(msg_id, payload) }
}

// ── Packet decoding ───────────────────────────────────────────────────────────

#[derive(Debug)]
struct SppPacket {
    msg_id: u8,
    payload: Vec<u8>,
}

/// Read one SPP packet from `buf`, consuming the bytes.
/// Returns None if not enough data yet.
fn parse_one_packet(buf: &[u8]) -> Option<(SppPacket, usize)> {
    if buf.is_empty() { return None; }

    let legacy = buf[0] == SOM_LEG;
    let standard = buf[0] == SOM_STD;
    if !legacy && !standard { return None; }

    if legacy {
        // [SOM][type][size][id][payload…][crc×2][EOM]
        if buf.len() < 4 { return None; }
        let size = buf[2] as usize;
        let total = 1 + 1 + 1 + size + 1; // SOM+type+size + (id+payload+crc2) + EOM
        if buf.len() < total { return None; }
        let msg_id = buf[3];
        let payload_len = if size >= 3 { size - 3 } else { 0 };
        let payload = buf[4..4 + payload_len].to_vec();
        Some((SppPacket { msg_id, payload }, total))
    } else {
        // [SOM][size_lo][size_hi|flags][id][payload…][crc×2][EOM]
        if buf.len() < 4 { return None; }
        let size = ((buf[1] as usize) | ((buf[2] as usize & 0x3) << 8)) & 0x3FF;
        let total = 1 + 2 + size + 1; // SOM + header_hi_lo + (id+payload+crc2) + EOM
        if buf.len() < total { return None; }
        let msg_id = buf[3];
        let payload_len = if size >= 3 { size - 3 } else { 0 };
        let payload = buf[4..4 + payload_len].to_vec();
        Some((SppPacket { msg_id, payload }, total))
    }
}

/// Read all parseable packets from the accumulated buffer.
fn parse_packets(buf: &mut Vec<u8>) -> Vec<SppPacket> {
    let mut out = Vec::new();
    loop {
        // Find the next SOM
        let start = buf.iter().position(|&b| b == SOM_STD || b == SOM_LEG);
        match start {
            None => { buf.clear(); break; }
            Some(0) => {}
            Some(n) => { buf.drain(..n); }
        }
        match parse_one_packet(buf) {
            Some((pkt, consumed)) => {
                out.push(pkt);
                buf.drain(..consumed);
            }
            None => break,
        }
    }
    out
}

// ── Status types (serializable to JSON for JS frontend) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BudsStatus {
    pub connected: bool,
    pub battery_l: u8,
    pub battery_r: u8,
    pub battery_case: u8,
    /// 0=Off, 1=ANC, 2=Ambient, 3=Adaptive
    pub anc_mode: u8,
    /// 0=BassBoost, 1=Soft, 2=Dynamic, 3=Clear, 4=TrebleBoost
    pub eq_preset: u8,
    pub eq_enabled: bool,
    pub wearing_l: bool,
    pub wearing_r: bool,
    pub touchpad_locked: bool,
    pub model: String,
    pub error: Option<String>,
}

// ── Status decoding from EXTENDED_STATUS_UPDATED payload ─────────────────────

fn decode_extended_status(payload: &[u8], model_hint: &str) -> BudsStatus {
    if payload.len() < 4 {
        return BudsStatus { connected: true, model: model_hint.to_string(), ..Default::default() };
    }

    // payload[0] = revision, [1] = earType, [2] = battL, [3] = battR
    let battery_l = payload[2];
    let battery_r = payload[3];

    // Detect legacy (original Buds) by revision byte pattern
    let is_legacy = payload.get(4).copied().unwrap_or(0) < 2 && payload.len() < 15;

    let mut status = BudsStatus {
        connected: true,
        battery_l,
        battery_r,
        model: model_hint.to_string(),
        ..Default::default()
    };

    if is_legacy {
        // Original Buds layout: [rev, earType, battL, battR, coupled, mainConn, wearState,
        //                         ambientEnabled, ambientMode, ambientVol, eqEnabled, eqMode, ...]
        status.wearing_l = payload.get(6).copied().unwrap_or(0) == 1 || payload.get(6).copied().unwrap_or(0) == 3;
        status.wearing_r = payload.get(6).copied().unwrap_or(0) == 2 || payload.get(6).copied().unwrap_or(0) == 3;
        status.eq_enabled = payload.get(10).copied().unwrap_or(0) != 0;
        status.eq_preset = payload.get(11).copied().unwrap_or(0);
    } else {
        // Buds+ and newer layout: [rev, earType, battL, battR, coupled, mainConn, placement, battCase, ...]
        let placement = payload.get(6).copied().unwrap_or(0);
        status.wearing_l = (placement >> 4) == 0; // 0=Wearing
        status.wearing_r = (placement & 0xF) == 0;
        status.battery_case = payload.get(7).copied().unwrap_or(0);

        // ANC mode starts at different offsets per model generation
        // BudsPlus: [8]=ambient_enabled, [9]=ambient_vol, [10]=adj_sync, [11]=eq_mode
        // BudsLive/Pro and newer: [8]=adj_sync, [9]=eq_mode, [10]=touchlock, [11]=touchpad, [12]=noise_mode
        // We detect based on payload length as a heuristic
        if payload.len() >= 22 {
            // Buds Live / Pro / Buds2 and newer — noise_mode at index 12
            let eq_raw = payload.get(9).copied().unwrap_or(0);
            status.eq_enabled = eq_raw != 0;
            status.eq_preset = if eq_raw == 0 { 2 } else { eq_raw.saturating_sub(1) };
            status.touchpad_locked = payload.get(10).copied().unwrap_or(0) != 0;
            let anc_raw = payload.get(12).copied().unwrap_or(0);
            // NoiseControlModes: Off=0, ANC=1, Ambient=2, Adaptive=3
            status.anc_mode = anc_raw;
        } else if payload.len() >= 14 {
            // Buds+: eq_mode at index 11
            let eq_raw = payload.get(11).copied().unwrap_or(0);
            status.eq_enabled = eq_raw != 0;
            status.eq_preset = if eq_raw == 0 { 2 } else { eq_raw.saturating_sub(1) };
        }
    }
    status
}

// ── RFCOMM raw socket (Linux) ─────────────────────────────────────────────────

#[repr(C)]
struct SockaddrRc {
    rc_family:  u16,
    rc_bdaddr:  [u8; 6], // little-endian (reversed MAC)
    rc_channel: u8,
}

/// Parse "AA:BB:CC:DD:EE:FF" into bdaddr bytes (little-endian).
fn mac_to_bdaddr(mac: &str) -> Result<[u8; 6], String> {
    let parts: Result<Vec<u8>, _> = mac.split(':')
        .map(|x| u8::from_str_radix(x.trim(), 16))
        .collect();
    let parts = parts.map_err(|e| e.to_string())?;
    if parts.len() != 6 { return Err("Invalid MAC address".to_string()); }
    let mut bd = [0u8; 6];
    for i in 0..6 { bd[i] = parts[5 - i]; } // reverse for little-endian bdaddr
    Ok(bd)
}

#[allow(dead_code)]
fn set_socket_timeout(fd: libc::c_int, secs: u64) {
    let tv = libc::timeval {
        tv_sec:  secs as libc::time_t,
        tv_usec: 0,
    };
    unsafe {
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_RCVTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of_val(&tv) as libc::socklen_t);
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_SNDTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of_val(&tv) as libc::socklen_t);
    }
}

/// Try to open an RFCOMM socket to `mac` on `channel`.
/// Returns the raw fd on success, or -1 on failure.
fn rfcomm_connect(bdaddr: &[u8; 6], channel: u8) -> libc::c_int {
    unsafe {
        let fd = libc::socket(libc::AF_BLUETOOTH, libc::SOCK_STREAM, 3 /*BTPROTO_RFCOMM*/);
        if fd < 0 { return -1; }

        let addr = SockaddrRc {
            rc_family:  libc::AF_BLUETOOTH as u16,
            rc_bdaddr:  *bdaddr,
            rc_channel: channel,
        };

        let r = libc::connect(
            fd,
            &addr as *const SockaddrRc as *const libc::sockaddr,
            std::mem::size_of::<SockaddrRc>() as libc::socklen_t,
        );

        if r < 0 {
            libc::close(fd);
            -1
        } else {
            fd
        }
    }
}

// ── Active connection state ───────────────────────────────────────────────────

pub struct BudsConn {
    pub fd:     libc::c_int,
    pub legacy: bool,
    pub status: Arc<Mutex<BudsStatus>>,
    #[allow(dead_code)]  // Kept for diagnostics — surfaces in UI/debugging.
    pub mac:    String,
    stop:       Arc<AtomicBool>,
    reader:     Option<std::thread::JoinHandle<()>>,
}

unsafe impl Send for BudsConn {}

impl Drop for BudsConn {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        unsafe { libc::shutdown(self.fd, libc::SHUT_RDWR); }
        if let Some(h) = self.reader.take() { let _ = h.join(); }
        unsafe { libc::close(self.fd); }
    }
}

fn reader_loop(
    fd: libc::c_int,
    model: String,
    status: Arc<Mutex<BudsStatus>>,
    stop: Arc<AtomicBool>,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    while !stop.load(Ordering::SeqCst) {
        let n = unsafe { libc::recv(fd, tmp.as_mut_ptr() as *mut _, tmp.len(), 0) };
        if n <= 0 {
            let errno = unsafe { *libc::__errno_location() };
            eprintln!("[buds/rx] recv returned {} errno={}", n, errno);
            break;
        }
        buf.extend_from_slice(&tmp[..n as usize]);
        let pkts = parse_packets(&mut buf);
        for p in pkts {
            eprintln!("[buds/rx] msg_id={} payload_len={}", p.msg_id, p.payload.len());
            if p.msg_id == MSG_EXTENDED_STATUS || p.msg_id == MSG_STATUS_UPDATED {
                let decoded = decode_extended_status(&p.payload, &model);
                if let Ok(mut g) = status.lock() {
                    let eq_enabled = g.eq_enabled;
                    let eq_preset  = g.eq_preset;
                    let touch      = g.touchpad_locked;
                    let anc        = g.anc_mode;
                    *g = decoded;
                    g.connected = true;
                    // Preserve user-set values if the device didn't report them in this message
                    if p.msg_id == MSG_STATUS_UPDATED {
                        g.eq_enabled = eq_enabled;
                        g.eq_preset  = eq_preset;
                        g.touchpad_locked = touch;
                        g.anc_mode   = anc;
                    }
                }
            }
        }
    }
    eprintln!("[buds/rx] reader exit");
}

#[derive(Default)]
pub struct BudsState(pub Mutex<Option<BudsConn>>);

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Detect whether the device uses legacy header format by reading bluetoothctl info.
fn detect_legacy(mac: &str) -> bool {
    // Original Buds have UUID 00001102-0000-1000-8000-00805f9b34fd
    // All others use 00001101 or the proprietary 2e73a4ad UUID
    let out = std::process::Command::new("bluetoothctl")
        .args(["info", mac])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    out.contains("00001102-0000-1000-8000-00805f9b34fd")
}

/// Extract model name from bluetoothctl info output.
fn detect_model_name(mac: &str) -> String {
    let out = std::process::Command::new("bluetoothctl")
        .args(["info", mac])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    out.lines()
        .find(|l| l.trim_start().starts_with("Name:"))
        .map(|l| l.split(':').skip(1).collect::<Vec<_>>().join(":").trim().to_string())
        .unwrap_or_else(|| "Galaxy Buds".to_string())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Connect to Galaxy Buds at `mac`, perform MANAGER_INFO handshake,
/// and return the initial status.
#[tauri::command]
pub async fn buds_connect(
    mac: String,
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let mac_clone = mac.clone();

    let legacy_sync = detect_legacy(&mac_clone);
    let model_sync  = detect_model_name(&mac_clone);

    // Preferred native path: BlueZ Profile1 registration + ConnectProfile.
    // Works for the Samsung proprietary UUID without relying on GalaxyBudsClient.
    let native_fd = match crate::bluez_profile::connect_buds_native(&mac_clone).await {
        Ok(fd) => { eprintln!("[buds] native fd={fd}"); Some(fd) }
        Err(e) => { eprintln!("[buds] native connect failed: {e}"); None }
    };

    let result: (i32, bool, String, String) = tokio::task::spawn_blocking(move || -> Result<(i32, bool, String, String), String> {
        let legacy = legacy_sync;
        let model  = model_sync;
        let bdaddr = mac_to_bdaddr(&mac_clone)?;

        // Native (preferred) → raw RFCOMM channels 1-30 fallback
        let mut fd = native_fd.unwrap_or(-1);
        if fd < 0 {
            for ch in 1u8..=30 {
                let f = rfcomm_connect(&bdaddr, ch);
                if f >= 0 { fd = f; break; }
            }
        }
        if fd < 0 {
            return Err("No se pudo conectar al dispositivo. Asegúrate de que los Buds estén encendidos y conectados por Bluetooth.".to_string());
        }

        // MANAGER_INFO handshake — required by the firmware
        // payload: [1, 2 (ClientDeviceTypes::Other), 34 (Android SDK)]
        let mgr_pkt = encode(MSG_MANAGER_INFO, &[1, 2, 34], legacy);
        unsafe { libc::send(fd, mgr_pkt.as_ptr() as *const _, mgr_pkt.len(), 0); }

        // Request extended status (reply arrives async via reader thread)
        let status_pkt = encode(MSG_EXTENDED_STATUS, &[], legacy);
        unsafe { libc::send(fd, status_pkt.as_ptr() as *const _, status_pkt.len(), 0); }

        Ok((fd, legacy, model, mac_clone))
    }).await.map_err(|e| e.to_string())??;

    let (fd, legacy, model, mac_str) = result;

    let status_arc = Arc::new(Mutex::new(BudsStatus {
        connected: true,
        model: model.clone(),
        ..Default::default()
    }));
    let stop = Arc::new(AtomicBool::new(false));

    let reader_status = Arc::clone(&status_arc);
    let reader_stop   = Arc::clone(&stop);
    let reader_model  = model.clone();
    let reader = std::thread::spawn(move || {
        reader_loop(fd, reader_model, reader_status, reader_stop);
    });

    let initial = status_arc.lock().map(|g| g.clone()).unwrap_or_default();

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(old) = guard.take() { drop(old); }
    *guard = Some(BudsConn {
        fd,
        legacy,
        status: status_arc,
        mac: mac_str,
        stop,
        reader: Some(reader),
    });

    Ok(serde_json::to_string(&initial).unwrap_or_default())
}

#[tauri::command]
pub async fn buds_disconnect(
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.take(); // Drops BudsConn, closing the fd
    Ok(r#"{"ok":true}"#.into())
}

#[tauri::command]
pub async fn buds_get_status(
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        None => Ok(serde_json::to_string(&BudsStatus::default()).unwrap_or_default()),
        Some(conn) => {
            let fd = conn.fd;
            let legacy = conn.legacy;
            // Opportunistic refresh: ask for extended status; reader picks up reply
            let pkt = encode(MSG_EXTENDED_STATUS, &[], legacy);
            unsafe { libc::send(fd, pkt.as_ptr() as *const _, pkt.len(), 0); }
            let s = conn.status.lock().map(|g| g.clone()).unwrap_or_default();
            Ok(serde_json::to_string(&s).unwrap_or_default())
        }
    }
}

/// Set ANC/noise-control mode.
/// mode: 0=Off, 1=ANC (NoiseReduction), 2=Ambient, 3=Adaptive
#[tauri::command]
pub async fn buds_set_anc(
    mode: u8,
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("No hay conexión activa con los Buds")?;

    let pkt = encode(MSG_NOISE_CONTROLS, &[mode], conn.legacy);
    eprintln!("[buds/tx] NOISE_CONTROLS mode={} pkt={:02x?}", mode, pkt);
    let sent = unsafe { libc::send(conn.fd, pkt.as_ptr() as *const _, pkt.len(), 0) };
    eprintln!("[buds/tx] send returned {}", sent);

    // Buds3 Pro: when entering NR (1) or Adaptive (3), also force NR level high
    // so the effect is audible. Mode 0/2 → level low.
    if mode == 1 || mode == 3 {
        let lvl = encode(MSG_NOISE_REDUCTION_LEVEL, &[1], conn.legacy);
        eprintln!("[buds/tx] NR_LEVEL high pkt={:02x?}", lvl);
        unsafe { libc::send(conn.fd, lvl.as_ptr() as *const _, lvl.len(), 0); }
    }
    if let Ok(mut g) = conn.status.lock() { g.anc_mode = mode; }

    Ok(r#"{"ok":true}"#.into())
}

/// Set EQ preset. preset: 0=BassBoost, 1=Soft, 2=Dynamic, 3=Clear, 4=TrebleBoost
/// enabled: false = disable EQ (flat)
#[tauri::command]
pub async fn buds_set_eq(
    preset: u8,
    enabled: bool,
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("No hay conexión activa con los Buds")?;

    // Payload differs by model:
    // legacy (original Buds): [enabled_byte, preset + 5]
    // all others: [0 if disabled, else preset + 1]
    let payload = if conn.legacy {
        vec![enabled as u8, preset.saturating_add(5)]
    } else {
        vec![if enabled { preset.saturating_add(1) } else { 0 }]
    };

    let pkt = encode(MSG_EQUALIZER, &payload, conn.legacy);
    eprintln!("[buds/tx] EQUALIZER payload={:?} pkt={:02x?}", payload, pkt);
    let sent = unsafe { libc::send(conn.fd, pkt.as_ptr() as *const _, pkt.len(), 0) };
    eprintln!("[buds/tx] send returned {}", sent);
    if let Ok(mut g) = conn.status.lock() {
        g.eq_preset = preset;
        g.eq_enabled = enabled;
    }

    Ok(r#"{"ok":true}"#.into())
}

/// Lock or unlock the touchpad.
#[tauri::command]
pub async fn buds_set_touch_lock(
    locked: bool,
    state: tauri::State<'_, BudsState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("No hay conexión activa con los Buds")?;

    let pkt = encode(MSG_LOCK_TOUCHPAD, &[locked as u8], conn.legacy);
    unsafe { libc::send(conn.fd, pkt.as_ptr() as *const _, pkt.len(), 0); }
    if let Ok(mut g) = conn.status.lock() { g.touchpad_locked = locked; }

    Ok(r#"{"ok":true}"#.into())
}

// ── GalaxyBudsClient DBus proxy (fallback when SPP fails) ────────────────────

fn gdbus_call(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("gdbus")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
pub async fn gbc_is_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        let r = std::process::Command::new("gdbus")
            .args([
                "call", "--session",
                "--dest", "org.freedesktop.DBus",
                "--object-path", "/org/freedesktop/DBus",
                "--method", "org.freedesktop.DBus.NameHasOwner",
                "me.timschneeberger.GalaxyBudsClient",
            ])
            .output();
        match r {
            Ok(o) => Ok(String::from_utf8_lossy(&o.stdout).contains("true")),
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns JSON with device properties from GBC DBus, or error.
#[tauri::command]
pub async fn gbc_get_device() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let raw = gdbus_call(&[
            "call", "--session",
            "--dest", "me.timschneeberger.GalaxyBudsClient",
            "--object-path", "/me/timschneeberger/galaxybudsclient/device",
            "--method", "org.freedesktop.DBus.Properties.GetAll",
            "me.timschneeberger.GalaxyBudsClient.Device",
        ])?;
        Ok(parse_gdbus_props(&raw))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gbc_execute_action(action: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let arg = format!("'{}'", action.replace('\'', "'\\''"));
        gdbus_call(&[
            "call", "--session",
            "--dest", "me.timschneeberger.GalaxyBudsClient",
            "--object-path", "/me/timschneeberger/galaxybudsclient",
            "--method", "me.timschneeberger.GalaxyBudsClient.Application.ExecuteAction",
            &arg,
        ])?;
        Ok(r#"{"ok":true}"#.into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gbc_activate() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        gdbus_call(&[
            "call", "--session",
            "--dest", "me.timschneeberger.GalaxyBudsClient",
            "--object-path", "/me/timschneeberger/galaxybudsclient",
            "--method", "me.timschneeberger.GalaxyBudsClient.Application.Activate",
        ])?;
        Ok(r#"{"ok":true}"#.into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Very small parser for `gdbus call` output of GetAll: `({'Key': <value>, ...},)`
/// Values: `<99>`, `<'str'>`, `<0.0>`, `<true>`.
fn parse_gdbus_props(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("({").and_then(|s| s.rsplit_once("},"))
        .map(|(a, _)| a)
        .unwrap_or(trimmed);
    let mut map = serde_json::Map::new();
    let chars: Vec<char> = inner.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        while i < chars.len() && (chars[i] == ' ' || chars[i] == ',' || chars[i] == '\n') { i += 1; }
        if i >= chars.len() || chars[i] != '\'' { break; }
        i += 1;
        let key_start = i;
        while i < chars.len() && chars[i] != '\'' { i += 1; }
        let key: String = chars[key_start..i].iter().collect();
        if i < chars.len() { i += 1; }
        while i < chars.len() && chars[i] != '<' { i += 1; }
        if i >= chars.len() { break; }
        i += 1;
        let mut depth = 1;
        let mut val = String::new();
        while i < chars.len() && depth > 0 {
            let c = chars[i];
            if c == '<' { depth += 1; val.push(c); }
            else if c == '>' { depth -= 1; if depth > 0 { val.push(c); } }
            else { val.push(c); }
            i += 1;
        }
        let v = val.trim();
        let jv: serde_json::Value = if v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2 {
            serde_json::Value::String(v[1..v.len()-1].to_string())
        } else if v == "true" || v == "false" {
            serde_json::Value::Bool(v == "true")
        } else if let Ok(n) = v.parse::<i64>() {
            serde_json::Value::Number(n.into())
        } else if let Ok(f) = v.parse::<f64>() {
            serde_json::Number::from_f64(f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::Value::String(v.to_string())
        };
        map.insert(key, jv);
    }
    serde_json::Value::Object(map).to_string()
}
