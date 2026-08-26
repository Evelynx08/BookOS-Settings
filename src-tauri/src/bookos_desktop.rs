//! Cliente de `org.bookos.Desktop`: la gestión de pantallas de una sesión
//! BookOS.
//!
//! Reemplaza a `kscreen-doctor` **solo cuando el compositor de BookOS está en
//! el bus**. En Plasma este módulo contesta que no hay nadie y la interfaz sigue
//! usando `kscreen_get`/`kscreen_set` como siempre: no se escribe en los dos
//! sitios a la vez, y por eso la detección es lo primero que se pregunta.
//!
//! Los tipos de aquí son la otra mitad del contrato que documenta
//! `bookos-comp/src/ajustes.rs`. Tienen que coincidir campo a campo y en orden:
//! D-Bus comprueba la firma, así que un desajuste falla al llamar y no en
//! silencio.

use serde::{Deserialize, Serialize};
use zbus::zvariant::Type;

const SERVICIO: &str = "org.bookos.Desktop";
const RUTA: &str = "/org/bookos/Desktop";
const INTERFAZ: &str = "org.bookos.Desktop";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Modo {
    pub ancho: u32,
    pub alto: u32,
    pub refresco_mhz: u32,
    pub preferido: bool,
    pub actual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Salida {
    pub id: String,
    pub conector: String,
    pub fabricante: String,
    pub modelo: String,
    pub serie: String,
    pub mm_ancho: u32,
    pub mm_alto: u32,
    pub activa: bool,
    pub modos: Vec<Modo>,
    pub escala: f64,
    pub escalas: Vec<f64>,
    pub x: i32,
    pub y: i32,
    pub transformacion: String,
    pub vrr_capaz: bool,
    pub vrr: bool,
    pub principal: bool,
    pub logico_ancho: i32,
    pub logico_alto: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Peticion {
    pub id: String,
    pub activa: bool,
    pub ancho: u32,
    pub alto: u32,
    pub refresco_mhz: u32,
    pub escala: f64,
    pub x: i32,
    pub y: i32,
    pub transformacion: String,
    pub vrr: bool,
    pub principal: bool,
}

async fn proxy<'a>(conn: &'a zbus::Connection) -> Result<zbus::Proxy<'a>, String> {
    zbus::Proxy::new(conn, SERVICIO, RUTA, INTERFAZ)
        .await
        .map_err(|e| e.to_string())
}

/// ¿Hay una sesión BookOS Desktop escuchando?
///
/// Se pregunta por el dueño del nombre y no se llama a un método: activar el
/// servicio por accidente en una sesión de Plasma sería justo lo que no
/// queremos, y `NameHasOwner` no arranca nada.
#[tauri::command]
pub async fn bookos_desktop_available() -> bool {
    let Ok(conn) = zbus::Connection::session().await else {
        return false;
    };
    let Ok(dbus) = zbus::fdo::DBusProxy::new(&conn).await else {
        return false;
    };
    let Ok(nombre) = SERVICIO.try_into() else {
        return false;
    };
    dbus.name_has_owner(nombre).await.unwrap_or(false)
}

/// Qué sabe hacer el compositor, como JSON. Las claves las documenta
/// `ajustes.rs`; aquí solo se traducen los tipos de D-Bus a JSON.
#[tauri::command]
pub async fn bookos_get_capabilities() -> Result<String, String> {
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;

    let conn = zbus::Connection::session().await.map_err(|e| e.to_string())?;
    let p = proxy(&conn).await?;
    let caps: HashMap<String, OwnedValue> = p
        .call("GetCapabilities", &())
        .await
        .map_err(|e| e.to_string())?;

    let mut json = serde_json::Map::new();
    for (clave, valor) in caps {
        // Se traduce sobre el `Value` prestado: convertir a un tipo concreto
        // por prueba y error (`try_from` encadenados) obliga a clonar y en
        // zvariant clonar un `OwnedValue` puede fallar.
        let v = match &*valor {
            zbus::zvariant::Value::Bool(b) => serde_json::Value::Bool(*b),
            zbus::zvariant::Value::U32(n) => serde_json::Value::from(*n),
            zbus::zvariant::Value::I32(n) => serde_json::Value::from(*n),
            zbus::zvariant::Value::F64(n) => serde_json::Value::from(*n),
            zbus::zvariant::Value::Str(s) => serde_json::Value::String(s.to_string()),
            zbus::zvariant::Value::Array(a) => {
                let nums: Vec<f64> = a
                    .iter()
                    .filter_map(|v| match v {
                        zbus::zvariant::Value::F64(n) => Some(*n),
                        _ => None,
                    })
                    .collect();
                serde_json::Value::from(nums)
            }
            // Una capacidad de un tipo que esta versión de Settings no conoce
            // todavía: se anuncia como presente en vez de perderse, que es lo
            // que permite que el compositor crezca sin actualizar la interfaz.
            _ => serde_json::Value::Null,
        };
        json.insert(clave, v);
    }
    serde_json::to_string(&json).map_err(|e| e.to_string())
}

/// El censo de salidas, como JSON.
#[tauri::command]
pub async fn bookos_get_outputs() -> Result<String, String> {
    let conn = zbus::Connection::session().await.map_err(|e| e.to_string())?;
    let p = proxy(&conn).await?;
    let salidas: Vec<Salida> = p.call("GetOutputs", &()).await.map_err(|e| e.to_string())?;
    serde_json::to_string(&salidas).map_err(|e| e.to_string())
}

/// Aplica una configuración. Devuelve `{"ok":bool,"error":string}`.
///
/// El error del compositor se propaga tal cual: la interfaz **no** puede
/// enseñar un éxito cuando el modeset falló, y para eso hace falta el motivo.
#[tauri::command]
pub async fn bookos_apply_output_config(config: Vec<Peticion>) -> String {
    let fallo = |e: String| serde_json::json!({"ok": false, "error": e}).to_string();

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => return fallo(e.to_string()),
    };
    let p = match proxy(&conn).await {
        Ok(p) => p,
        Err(e) => return fallo(e),
    };
    match p.call::<_, _, (bool, String)>("ApplyOutputConfig", &(config,)).await {
        Ok((true, _)) => serde_json::json!({"ok": true, "error": ""}).to_string(),
        Ok((false, err)) => fallo(err),
        Err(e) => fallo(e.to_string()),
    }
}

/// Pide releer `panel.conf`. Ya existía para la pantalla de bloqueo; aquí queda
/// expuesto para poder recargar el resto sin duplicar la llamada.
#[tauri::command]
pub async fn bookos_reload_config(section: String) -> bool {
    let Ok(conn) = zbus::Connection::session().await else {
        return false;
    };
    let Ok(p) = proxy(&conn).await else {
        return false;
    };
    p.call::<_, _, bool>("ReloadConfig", &(section,))
        .await
        .unwrap_or(false)
}
