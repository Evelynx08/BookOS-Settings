//! Native BlueZ SPP profile registration for Galaxy Buds.
//!
//! Samsung Galaxy Buds use a proprietary UUID (2e73a4ad-…) that BlueZ doesn't
//! expose as a raw RFCOMM channel unless a Profile1 implementation claims it.
//! This module registers a Profile1 object, calls Device1.ConnectProfile, and
//! captures the returned file descriptor for use with the SPP framing in
//! `buds.rs`.

use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{interface, fdo, Connection};

const SAMSUNG_UUID: &str = "2e73a4ad-332d-41fc-90e2-16bef06523f2";
const SPP_UUID: &str     = "00001101-0000-1000-8000-00805f9b34fb";
const PROFILE_PATH: &str = "/com/bookos/buds/profile";

struct BudsProfile {
    tx: Arc<Mutex<Option<oneshot::Sender<i32>>>>,
}

#[interface(name = "org.bluez.Profile1")]
impl BudsProfile {
    async fn new_connection(
        &self,
        _device: OwnedObjectPath,
        fd: zbus::zvariant::OwnedFd,
        _props: HashMap<String, OwnedValue>,
    ) -> fdo::Result<()> {
        let raw = fd.as_raw_fd();
        // dup because OwnedFd closes on drop
        let dup = unsafe { libc::dup(raw) };
        if dup >= 0 {
            // Clear O_NONBLOCK — BlueZ hands the fd in non-blocking mode
            unsafe {
                let flags = libc::fcntl(dup, libc::F_GETFL, 0);
                if flags >= 0 {
                    libc::fcntl(dup, libc::F_SETFL, flags & !libc::O_NONBLOCK);
                }
            }
            if let Some(sender) = self.tx.lock().unwrap().take() {
                let _ = sender.send(dup);
            }
        }
        Ok(())
    }

    async fn release(&self) {}

    async fn request_disconnection(&self, _device: OwnedObjectPath) {}
}

fn mac_to_path(mac: &str) -> String {
    format!("/org/bluez/hci0/dev_{}", mac.replace(':', "_"))
}

/// Register a Profile1 for the Samsung SPP UUID, trigger ConnectProfile on the
/// device, and wait for the fd callback. Returns a duplicated raw fd.
pub async fn connect_buds_native(mac: &str) -> Result<i32, String> {
    let conn = Connection::system()
        .await
        .map_err(|e| format!("DBus system bus: {e}"))?;

    let (tx, rx) = oneshot::channel();
    let profile = BudsProfile {
        tx: Arc::new(Mutex::new(Some(tx))),
    };

    let path = ObjectPath::try_from(PROFILE_PATH).map_err(|e| e.to_string())?;

    // Register object on the system bus
    conn.object_server()
        .at(&path, profile)
        .await
        .map_err(|e| format!("object_server: {e}"))?;

    let pm = zbus::Proxy::new(
        &conn,
        "org.bluez",
        "/org/bluez",
        "org.bluez.ProfileManager1",
    )
    .await
    .map_err(|e| format!("ProfileManager1 proxy: {e}"))?;

    let dev_path_str = mac_to_path(mac);
    let dev_path = ObjectPath::try_from(dev_path_str.as_str()).map_err(|e| e.to_string())?;
    let dev = zbus::Proxy::new(&conn, "org.bluez", dev_path, "org.bluez.Device1")
        .await
        .map_err(|e| format!("Device1 proxy: {e}"))?;

    let mut last_err = String::from("no UUID attempted");
    for uuid in &[SAMSUNG_UUID, SPP_UUID] {
        // Clean any prior registration so we can reuse the path
        let _ = pm
            .call::<_, _, ()>("UnregisterProfile", &(path.clone(),))
            .await;

        let mut opts: HashMap<&str, Value> = HashMap::new();
        opts.insert("Role", Value::from("client"));
        opts.insert("RequireAuthentication", Value::from(false));
        opts.insert("RequireAuthorization", Value::from(false));
        opts.insert("AutoConnect", Value::from(false));

        if let Err(e) = pm
            .call::<_, _, ()>("RegisterProfile", &(path.clone(), *uuid, opts))
            .await
        {
            last_err = format!("RegisterProfile({uuid}): {e}");
            continue;
        }

        match dev.call::<_, _, ()>("ConnectProfile", &(*uuid,)).await {
            Ok(_) => { last_err.clear(); break; }
            Err(e) => {
                last_err = format!("ConnectProfile({uuid}): {e}");
                // try next UUID
            }
        }
    }

    if !last_err.is_empty() {
        let _ = conn.object_server().remove::<BudsProfile, _>(&path).await;
        return Err(last_err);
    }

    let fd = tokio::time::timeout(std::time::Duration::from_secs(8), rx)
        .await
        .map_err(|_| "Timeout esperando fd de BlueZ".to_string())?
        .map_err(|_| "Canal cerrado antes de recibir fd".to_string())?;

    // Leave the profile registered for the lifetime of the process so BlueZ
    // can hand off further connections without re-registering.
    Ok(fd)
}
