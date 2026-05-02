//! Wi-Fi Direct P2P management for Book Share.
//!
//! Uses NetworkManager D-Bus (WifiP2P device) to:
//!   1. Discover nearby P2P peers (S22 Ultra with Nearby Share open)
//!   2. Connect → creates p2p-wlan0-X interface with DHCP
//!   3. rquickshare then finds the device via mDNS on that interface
//!
//! Frontend events:
//!   "p2p-peer-added"   — P2PPeer JSON (new device found)
//!   "p2p-peer-removed" — { "mac": "..." }
//!   "p2p-connected"    — { "iface": "p2p-wlan0-0", "peer": "..." }
//!   "p2p-disconnected" — {}

use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zbus::{Connection, proxy};

// ── NM WifiP2P device proxy ───────────────────────────────────────────────

#[proxy(
    interface = "org.freedesktop.NetworkManager.Device.WifiP2P",
    default_service = "org.freedesktop.NetworkManager"
)]
trait WifiP2P {
    fn start_find(&self, options: std::collections::HashMap<String, zbus::zvariant::Value<'_>>) -> zbus::Result<()>;
    fn stop_find(&self) -> zbus::Result<()>;
    #[zbus(property)]
    fn peers(&self) -> zbus::Result<Vec<zbus::zvariant::OwnedObjectPath>>;
    #[zbus(signal)]
    fn peer_added(&self, peer: zbus::zvariant::ObjectPath<'_>) -> zbus::Result<()>;
    #[zbus(signal)]
    fn peer_removed(&self, peer: zbus::zvariant::ObjectPath<'_>) -> zbus::Result<()>;
}

#[proxy(
    interface = "org.freedesktop.NetworkManager.WifiP2PPeer",
    default_service = "org.freedesktop.NetworkManager"
)]
trait WifiP2PPeer {
    #[zbus(property)]
    fn hw_address(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn name(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn strength(&self) -> zbus::Result<u8>;
    #[zbus(property)]
    fn wpa_supports_supplicant(&self) -> zbus::Result<bool>;
}

#[proxy(
    interface = "org.freedesktop.NetworkManager",
    default_service = "org.freedesktop.NetworkManager",
    default_path = "/org/freedesktop/NetworkManager"
)]
trait NetworkManager {
    fn get_devices(&self) -> zbus::Result<Vec<zbus::zvariant::OwnedObjectPath>>;
}

#[proxy(
    interface = "org.freedesktop.NetworkManager.Device",
    default_service = "org.freedesktop.NetworkManager"
)]
trait NMDevice {
    #[zbus(property)]
    fn device_type(&self) -> zbus::Result<u32>;
    #[zbus(property)]
    fn interface(&self) -> zbus::Result<String>;
}

// ── State ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct P2PPeer {
    pub mac:      String,
    pub name:     String,
    pub strength: u8,
    pub path:     String,
}

pub struct P2PState {
    scanning:      Mutex<bool>,
    connected_mac: Mutex<Option<String>>,
    stop_tx:       Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for P2PState {
    fn default() -> Self {
        Self {
            scanning:      Mutex::new(false),
            connected_mac: Mutex::new(None),
            stop_tx:       Mutex::new(None),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Find the NM object path of the wifi-p2p device (p2p-dev-wlan0).
async fn find_p2p_device_path(conn: &Connection) -> Option<String> {
    let nm = NetworkManagerProxy::new(conn).await.ok()?;
    let devices = nm.get_devices().await.ok()?;
    for path in devices {
        let dev = NMDeviceProxy::builder(conn)
            .path(path.as_str()).ok()?
            .build().await.ok()?;
        // DeviceType 30 = NM_DEVICE_TYPE_WIFI_P2P
        if dev.device_type().await.ok() == Some(30) {
            return Some(path.to_string());
        }
    }
    None
}

/// Get info for a peer object path.
async fn peer_info(conn: &Connection, path: &str) -> Option<P2PPeer> {
    let peer = WifiP2PPeerProxy::builder(conn)
        .path(path).ok()?
        .build().await.ok()?;
    let mac      = peer.hw_address().await.unwrap_or_default();
    let name     = peer.name().await.unwrap_or_else(|_| mac.clone());
    let strength = peer.strength().await.unwrap_or(0);
    Some(P2PPeer { mac, name, strength, path: path.to_string() })
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Start Wi-Fi Direct discovery. Emits "p2p-peer-added" / "p2p-peer-removed" events.
#[tauri::command]
pub async fn p2p_start_discover(
    app:   AppHandle,
    state: State<'_, P2PState>,
) -> Result<String, String> {
    // Idempotent
    {
        let mut scan = state.scanning.lock().map_err(|e| e.to_string())?;
        if *scan { return Ok(r#"{"ok":true,"already":true}"#.into()); }
        *scan = true;
    }

    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    *state.stop_tx.lock().map_err(|e| e.to_string())? = Some(stop_tx);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(conn) = Connection::system().await else { return; };
        let Some(dev_path) = find_p2p_device_path(&conn).await else { return; };

        let Ok(p2p) = WifiP2PProxy::builder(&conn)
            .path(dev_path.as_str())
            .unwrap()
            .build().await else { return; };

        // Start find
        let _ = p2p.start_find(Default::default()).await;

        // Subscribe to signals
        let Ok(mut added)   = p2p.receive_peer_added().await else { return; };
        let Ok(mut removed) = p2p.receive_peer_removed().await else { return; };

        // Emit already-known peers
        if let Ok(peers) = p2p.peers().await {
            for path in peers {
                if let Some(info) = peer_info(&conn, path.as_str()).await {
                    let _ = app2.emit("p2p-peer-added", &info);
                }
            }
        }

        use futures::StreamExt;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                Some(sig) = added.next() => {
                    if let Ok(args) = sig.args() {
                        let path: zbus::zvariant::ObjectPath<'_> = args.peer;
                        if let Some(info) = peer_info(&conn, path.as_str()).await {
                            let _ = app2.emit("p2p-peer-added", &info);
                        }
                    }
                },
                Some(sig) = removed.next() => {
                    if let Ok(args) = sig.args() {
                        let path: zbus::zvariant::ObjectPath<'_> = args.peer;
                        let _ = app2.emit("p2p-peer-removed",
                            serde_json::json!({ "path": path.as_str() }));
                    }
                },
            }
        }

        let _ = p2p.stop_find().await;
    });

    Ok(r#"{"ok":true}"#.into())
}

/// Stop Wi-Fi Direct discovery.
#[tauri::command]
pub async fn p2p_stop_discover(state: State<'_, P2PState>) -> Result<String, String> {
    if let Some(tx) = state.stop_tx.lock().map_err(|e| e.to_string())?.take() {
        let _ = tx.send(());
    }
    *state.scanning.lock().map_err(|e| e.to_string())? = false;
    Ok(r#"{"ok":true}"#.into())
}

/// Connect to a P2P peer by MAC address (PBC = push-button, no PIN needed).
/// NM creates p2p-wlan0-X and configures DHCP automatically.
#[tauri::command]
pub async fn p2p_connect(
    mac:   String,
    name:  String,
    app:   AppHandle,
    state: State<'_, P2PState>,
) -> Result<String, String> {
    // nmcli device wifi p2p-connect <mac> pbc ifname p2p-dev-wlan0
    let out = tokio::process::Command::new("nmcli")
        .args(["device", "wifi", "p2p-connect", &mac, "pbc",
               "ifname", "p2p-dev-wlan0"])
        .output().await.map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("p2p_connect failed: {err}"));
    }

    *state.connected_mac.lock().map_err(|e| e.to_string())? = Some(mac.clone());

    // Find the created p2p interface (p2p-wlan0-*)
    let iface = find_p2p_iface().await.unwrap_or_else(|| "p2p-wlan0-0".into());
    let _ = app.emit("p2p-connected",
        serde_json::json!({ "iface": iface, "mac": mac, "name": name }));

    Ok(serde_json::json!({ "ok": true, "iface": iface }).to_string())
}

/// Disconnect from the current P2P peer / remove the P2P group.
#[tauri::command]
pub async fn p2p_disconnect(
    app:   AppHandle,
    state: State<'_, P2PState>,
) -> Result<String, String> {
    let iface = find_p2p_iface().await.unwrap_or_else(|| "p2p-wlan0-0".into());
    let _ = tokio::process::Command::new("nmcli")
        .args(["device", "disconnect", &iface])
        .output().await;

    *state.connected_mac.lock().map_err(|e| e.to_string())? = None;
    let _ = app.emit("p2p-disconnected", serde_json::json!({}));
    Ok(r#"{"ok":true}"#.into())
}

/// Find the active p2p-wlan0-X interface name.
async fn find_p2p_iface() -> Option<String> {
    let out = tokio::process::Command::new("ip")
        .args(["-o", "link", "show"])
        .output().await.ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .find(|l| l.contains("p2p-wlan") && !l.contains("p2p-dev"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
}
