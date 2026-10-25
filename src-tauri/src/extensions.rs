use super::{validate_main_window, Sidecar};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct ExtensionWindows {
    sources: Mutex<HashMap<String, Option<String>>>,
    next_id: AtomicU64,
    pub lifecycle: AsyncMutex<()>,
}

impl ExtensionWindows {
    pub fn close_all(&self, app: &AppHandle) {
        let labels: Vec<_> = self
            .sources
            .lock()
            .unwrap()
            .drain()
            .map(|(label, _)| label)
            .collect();
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
    }
    pub fn forget(&self, label: &str) {
        self.sources.lock().unwrap().remove(label);
    }
    fn contains(&self, label: &str) -> bool {
        self.sources.lock().unwrap().contains_key(label)
    }
}

#[tauri::command]
pub async fn run_extension(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    state: tauri::State<'_, Arc<ExtensionWindows>>,
    sidecar: tauri::State<'_, Arc<Sidecar>>,
) -> Result<(), String> {
    validate_main_window(window.label())?;
    let _guard = state.lifecycle.lock().await;
    let label = format!("extension-{}", state.next_id.fetch_add(1, Ordering::SeqCst));
    let extension = sidecar
        .call("extensions.trustedOpen", vec![json!(id), json!(label)])
        .await?;
    let source = extension
        .get("source")
        .and_then(Value::as_str)
        .ok_or("Invalid extension source")?;
    let name = extension
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Extension");
    let allowed_url = window
        .url()
        .map_err(|e| e.to_string())?
        .join("extension.html")
        .map_err(|e| e.to_string())?;
    state
        .sources
        .lock()
        .unwrap()
        .insert(label.clone(), Some(source.to_owned()));
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("extension.html".into()))
        .title(format!("{name} — Driftleaf extension"))
        .inner_size(800.0, 600.0)
        .incognito(true)
        .devtools(false)
        .on_navigation(move |url| url == &allowed_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    if let Err(error) = built {
        state.forget(&label);
        let _ = sidecar
            .call("extensions.trustedClose", vec![json!(label)])
            .await;
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn extension_bootstrap(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<ExtensionWindows>>,
) -> Result<String, String> {
    state
        .sources
        .lock()
        .unwrap()
        .get_mut(window.label())
        .and_then(Option::take)
        .ok_or_else(|| "This extension session is no longer available".into())
}

#[tauri::command]
pub async fn extension_call(
    window: WebviewWindow,
    method: String,
    args: Vec<Value>,
    state: tauri::State<'_, Arc<ExtensionWindows>>,
    sidecar: tauri::State<'_, Arc<Sidecar>>,
) -> Result<Value, String> {
    if !state.contains(window.label()) {
        return Err("This window is not an active extension".into());
    }
    validate_method(&method, &args)?;
    sidecar
        .call(
            "extensions.trustedCall",
            vec![json!(window.label()), json!(method), json!(args)],
        )
        .await
}

fn validate_method(method: &str, args: &[Value]) -> Result<(), String> {
    let valid = match method {
        "listNotes" | "listDatabases" | "graph" => args.is_empty(),
        "readNote" | "readDatabase" => args.len() == 1 && args[0].is_string(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Unknown extension command or invalid arguments".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_read_contract_is_exposed() {
        assert!(validate_method("listNotes", &[]).is_ok());
        assert!(validate_method("readNote", &[json!("id")]).is_ok());
        for method in [
            "constructor",
            "__internal.requireVault",
            "notes.write",
            "vault.unlock",
        ] {
            assert!(validate_method(method, &[]).is_err());
        }
        assert!(validate_method("readNote", &[]).is_err());
        assert!(validate_method("listNotes", &[Value::Null]).is_err());
    }
}
