//! Quick Share (rquickshare) integration for BookOS Settings — Book Connect section.
//!
//! Wraps rqs_lib as a Tauri-managed service. Exposes commands for:
//!   • Starting / stopping the receive service
//!   • Discovering nearby devices (mDNS)
//!   • Sending files to a discovered device
//!   • Accepting / rejecting incoming transfers
//!
//! Frontend receives two Tauri events:
//!   • "qs-transfer"  — ChannelMessage JSON (state updates, incoming files, progress)
//!   • "qs-device"    — EndpointInfo JSON   (device appeared / disappeared on LAN)

use std::sync::Mutex;

use crate::p2p::P2PState;
use rqs_lib::channel::{ChannelAction, ChannelDirection, ChannelMessage};
use rqs_lib::{EndpointInfo, OutboundPayload, SendInfo, Visibility, RQS};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct QsState {
    rqs:          Mutex<Option<RQS>>,
    file_sender:  Mutex<Option<mpsc::Sender<SendInfo>>>,
    msg_tx:       broadcast::Sender<ChannelMessage>,
    /// Clone of rqs.message_sender — used to send FrontToLib actions (accept/reject/cancel)
    /// directly to the rqs_lib InboundRequest receiver.
    lib_msg_tx:   Mutex<Option<broadcast::Sender<ChannelMessage>>>,
    dch_tx:       broadcast::Sender<EndpointInfo>,
}

impl Default for QsState {
    fn default() -> Self {
        let (msg_tx, _) = broadcast::channel(50);
        let (dch_tx, _) = broadcast::channel(50);
        Self {
            rqs:         Mutex::new(None),
            file_sender: Mutex::new(None),
            msg_tx,
            lib_msg_tx:  Mutex::new(None),
            dch_tx,
        }
    }
}

// ── Event forwarding tasks (spawned once on qs_start) ────────────────────────

fn spawn_event_tasks(app: AppHandle) {
    // Forward ChannelMessage → "qs-transfer" event
    let app1 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state: State<QsState> = app1.state();
        let mut rx = state.msg_tx.subscribe();
        loop {
            match rx.recv().await {
                Ok(msg) => { let _ = app1.emit("qs-transfer", &msg); }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // Forward EndpointInfo → "qs-device" event
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state: State<QsState> = app2.state();
        let mut rx = state.dch_tx.subscribe();
        loop {
            match rx.recv().await {
                Ok(info) => { let _ = app2.emit("qs-device", &info); }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start the Quick Share receive service (TCP listener + mDNS advertisement).
/// Idempotent — calling again while running is a no-op.
#[tauri::command]
pub async fn qs_start(
    app: AppHandle,
    state: State<'_, QsState>,
    p2p: State<'_, P2PState>,
) -> Result<String, String> {
    {
        let guard = state.rqs.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(r#"{"ok":true,"already":true}"#.into());
        }
    }

    let msg_tx  = state.msg_tx.clone();
    let mut rqs = RQS::new(Visibility::Visible, Some(44551), None);

    // Redirect the lib's message_sender to our broadcast channel
    // by replacing it before run() — not possible directly, so we subscribe
    // after run() and forward.
    let (file_sender, _ble_rx) = rqs.run().await.map_err(|e| e.to_string())?;

    // Bridge: forward rqs internal events → our msg_tx (LibToFront direction)
    let lib_tx = rqs.message_sender.clone();
    let fwd_tx  = msg_tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = lib_tx.subscribe();
        loop {
            match rx.recv().await {
                Ok(msg) => { let _ = fwd_tx.send(msg); }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // Store lib_msg_tx so qs_action/qs_cancel can send FrontToLib actions directly to rqs_lib
    *state.lib_msg_tx.lock().map_err(|e| e.to_string())? = Some(rqs.message_sender.clone());

    *state.rqs.lock().map_err(|e| e.to_string())? = Some(rqs);
    *state.file_sender.lock().map_err(|e| e.to_string())? = Some(file_sender);

    // Spawn tasks that push events to the frontend (only once)
    spawn_event_tasks(app.clone());

    // Also start Wi-Fi Direct P2P discovery (best-effort, don't fail qs_start if it errors)
    let _ = crate::p2p::p2p_start_discover(app, p2p).await;

    Ok(r#"{"ok":true}"#.into())
}

/// Stop the service.
#[tauri::command]
pub async fn qs_stop(state: State<'_, QsState>, p2p: State<'_, P2PState>) -> Result<String, String> {
    // Release the lock before awaiting stop()
    let rqs_opt = {
        let mut guard = state.rqs.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut rqs) = rqs_opt {
        rqs.stop().await;
    }
    *state.file_sender.lock().map_err(|e| e.to_string())? = None;
    *state.lib_msg_tx.lock().map_err(|e| e.to_string())? = None;
    let _ = crate::p2p::p2p_stop_discover(p2p).await;
    Ok(r#"{"ok":true}"#.into())
}

/// Start mDNS discovery — emits "qs-device" events as devices appear/disappear.
#[tauri::command]
pub async fn qs_discover(state: State<'_, QsState>) -> Result<String, String> {
    let dch_tx = state.dch_tx.clone();
    let mut guard = state.rqs.lock().map_err(|e| e.to_string())?;
    let rqs = guard.as_mut().ok_or("Servicio no iniciado. Llama a qs_start primero.")?;
    rqs.discovery(dch_tx).map_err(|e| e.to_string())?;
    Ok(r#"{"ok":true}"#.into())
}

/// Stop mDNS discovery.
#[tauri::command]
pub async fn qs_stop_discover(state: State<'_, QsState>) -> Result<String, String> {
    let mut guard = state.rqs.lock().map_err(|e| e.to_string())?;
    let rqs = guard.as_mut().ok_or("Servicio no iniciado.")?;
    rqs.stop_discovery();
    Ok(r#"{"ok":true}"#.into())
}

/// Send files to a discovered device.
/// `files` — absolute paths to the files to send.
/// `endpoint_id`, `name`, `addr` — from the EndpointInfo received via "qs-device".
#[tauri::command]
pub async fn qs_send_files(
    endpoint_id: String,
    name: String,
    addr: String,
    files: Vec<String>,
    state: State<'_, QsState>,
) -> Result<String, String> {
    // Clone sender to release the MutexGuard before .await
    let sender = {
        let guard = state.file_sender.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("Servicio no iniciado. Llama a qs_start primero.")?.clone()
    };

    let info = SendInfo {
        id:   endpoint_id,
        name,
        addr,
        ob:   OutboundPayload::Files(files),
    };

    sender.send(info).await.map_err(|e| e.to_string())?;
    Ok(r#"{"ok":true}"#.into())
}

/// Accept or reject an incoming transfer.
/// `transfer_id` — the `id` field from the ChannelMessage.
#[tauri::command]
pub async fn qs_action(
    transfer_id: String,
    accept: bool,
    state: State<'_, QsState>,
) -> Result<String, String> {
    let msg = ChannelMessage {
        id: transfer_id,
        direction: ChannelDirection::FrontToLib,
        action: Some(if accept { ChannelAction::AcceptTransfer } else { ChannelAction::RejectTransfer }),
        ..Default::default()
    };
    let tx = state.lib_msg_tx.lock().map_err(|e| e.to_string())?
        .as_ref().ok_or("Servicio no iniciado.")?.clone();
    tx.send(msg).map_err(|e| e.to_string())?;
    Ok(r#"{"ok":true}"#.into())
}

/// Cancel an ongoing transfer.
#[tauri::command]
pub async fn qs_cancel(
    transfer_id: String,
    state: State<'_, QsState>,
) -> Result<String, String> {
    let msg = ChannelMessage {
        id: transfer_id,
        direction: ChannelDirection::FrontToLib,
        action: Some(ChannelAction::CancelTransfer),
        ..Default::default()
    };
    let tx = state.lib_msg_tx.lock().map_err(|e| e.to_string())?
        .as_ref().ok_or("Servicio no iniciado.")?.clone();
    tx.send(msg).map_err(|e| e.to_string())?;
    Ok(r#"{"ok":true}"#.into())
}

/// Change device visibility (Visible / Invisible).
#[tauri::command]
pub async fn qs_set_visibility(
    visible: bool,
    state: State<'_, QsState>,
) -> Result<String, String> {
    let mut guard = state.rqs.lock().map_err(|e| e.to_string())?;
    let rqs = guard.as_mut().ok_or("Servicio no iniciado.")?;
    rqs.change_visibility(if visible { Visibility::Visible } else { Visibility::Invisible });
    Ok(r#"{"ok":true}"#.into())
}

/// Set download directory for incoming files (None = default ~/Downloads).
#[tauri::command]
pub async fn qs_set_download_path(
    path: Option<String>,
    state: State<'_, QsState>,
) -> Result<String, String> {
    let guard = state.rqs.lock().map_err(|e| e.to_string())?;
    let rqs = guard.as_ref().ok_or("Servicio no iniciado.")?;
    rqs.set_download_path(path.map(std::path::PathBuf::from));
    Ok(r#"{"ok":true}"#.into())
}
