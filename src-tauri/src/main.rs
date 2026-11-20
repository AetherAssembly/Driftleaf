#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod announcements;
mod community;
mod extensions;
mod settings_migration;
mod updates;
// Tauri shell. Rust owns every OS dialog, the window close handshake, updates, and the
// backend itself: session state, storage, search, and every note/database command live in
// the driftleaf-core crate (crates/driftleaf-core/src/service.rs) and run in this process.
// There is no child process, no localhost listener, and no bundled runtime. Passphrases and
// note contents travel only between the webview and this process over Tauri's IPC, and
// request contents are never logged.
use driftleaf_core::service::Service;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

// One mutex around the service is what serializes commands: a lock cannot overtake a write
// that is in progress, and a command issued after a lock sees no session. Storage work
// (scrypt, file I/O, SQLite) is blocking, so each call runs on the blocking thread pool
// instead of stalling the async runtime that drives the window.
struct Backend {
    service: Arc<StdMutex<Service>>,
}

impl Backend {
    fn new(settings_dir: std::path::PathBuf) -> Self {
        Self {
            service: Arc::new(StdMutex::new(Service::new(settings_dir, env!("CARGO_PKG_VERSION")))),
        }
    }

    async fn with_service<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Service) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let service = self.service.clone();
        tokio::task::spawn_blocking(move || {
            // A panic inside one command must not make every later command fail too.
            let mut guard = service.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            work(&mut guard)
        })
        .await
        .map_err(|_| "The Driftleaf backend stopped unexpectedly. Restart the app.".to_string())?
    }

    async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        // The community gallery needs the network, which the service never touches: the
        // download happens here, and only the result is handed to the service to store.
        match method {
            "extensions.community" => return Ok(community::list().await),
            "extensions.previewCommunityExtension" | "extensions.installCommunityExtension" => {
                let asset_id = args.first().cloned().unwrap_or(Value::Null);
                let (name, bytes) = community::download(&asset_id, community::Kind::Extension).await?;
                let source = String::from_utf8(bytes)
                    .map_err(|_| "The extension release asset is not valid UTF-8 JavaScript".to_string())?;
                if method == "extensions.previewCommunityExtension" {
                    return Ok(json!(source));
                }
                return self.with_service(move |service| service.install_extension(&name, &source)).await;
            }
            "extensions.installCommunityTemplate" => {
                let asset_id = args.first().cloned().unwrap_or(Value::Null);
                // Checked before the download so a locked branch does not cost a request.
                self.with_service(|service| {
                    if service.is_unlocked() { Ok(()) } else { Err("No branch is unlocked".to_string()) }
                })
                .await?;
                let (name, bytes) = community::download(&asset_id, community::Kind::Template).await?;
                return self.with_service(move |service| service.import_template(&bytes, &name)).await;
            }
            _ => {}
        }
        let method = method.to_string();
        self.with_service(move |service| service.call(&method, &args)).await
    }
}

#[tauri::command]
async fn backend_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    validate_public_method(window.label(), &method)?;
    let extensions = window.state::<std::sync::Arc<extensions::ExtensionWindows>>();
    if matches!(
        method.as_str(),
        "vault.lock" | "vault.unlock" | "vault.create"
    ) {
        let _guard = extensions.lifecycle.lock().await;
        extensions.close_all(window.app_handle());
        state.call(&method, args).await
    } else {
        state.call(&method, args).await
    }
}

fn validate_public_method(window: &str, method: &str) -> Result<(), String> {
    let allowed: Vec<&str> =
        serde_json::from_str(include_str!("../public-methods.json"))
            .expect("public method list must be valid JSON");
    validate_main_window(window)?;
    if !allowed.contains(&method) {
        return Err("This command is not available through the renderer bridge".into());
    }
    Ok(())
}

fn validate_main_window(window: &str) -> Result<(), String> {
    if window != "main" {
        return Err("This command is only available to the main window".into());
    }
    Ok(())
}

#[tauri::command]
async fn pick_directory(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Option<String>, String> {
    validate_main_window(window.label())?;
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|f| f.to_string()));
    });
    rx.await
        .map_err(|_| "The folder picker closed unexpectedly".to_string())
}

// Single-use tracking of what the native pickers actually returned, for the commands that
// act on a path (import, create backup, verify backup). The renderer only ever passes a path
// back; these commands refuse any path that did not come from the matching picker, so a
// compromised renderer cannot make the backend read or write somewhere the user never chose.
// Each field is reset when its picker runs and consumed by the one call allowed to use it.
struct PickerState {
    last_backup_path: StdMutex<Option<String>>,
    last_backup_destination: StdMutex<Option<String>>,
    last_import_paths: StdMutex<Option<std::collections::HashSet<String>>>,
}

#[tauri::command]
async fn pick_backup_directory(
    window: tauri::WebviewWindow,
    app: AppHandle,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Option<String>, String> {
    validate_main_window(window.label())?;
    *picker.last_backup_path.lock().unwrap() = None;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a Driftleaf backup folder")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|f| f.to_string()));
        });
    let picked = rx
        .await
        .map_err(|_| "The folder picker closed unexpectedly".to_string())?;
    *picker.last_backup_path.lock().unwrap() = picked.clone();
    Ok(picked)
}

#[tauri::command]
async fn pick_backup_destination(
    window: tauri::WebviewWindow,
    app: AppHandle,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Option<String>, String> {
    validate_main_window(window.label())?;
    *picker.last_backup_destination.lock().unwrap() = None;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose where to save the backup")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|f| f.to_string()));
        });
    let picked = rx
        .await
        .map_err(|_| "The folder picker closed unexpectedly".to_string())?;
    *picker.last_backup_destination.lock().unwrap() = picked.clone();
    Ok(picked)
}

#[tauri::command]
async fn pick_import_files(
    window: tauri::WebviewWindow,
    app: AppHandle,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Option<Vec<String>>, String> {
    validate_main_window(window.label())?;
    *picker.last_import_paths.lock().unwrap() = None;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Notes, tables, and zip archives",
            &["md", "csv", "json", "zip"],
        )
        .add_filter("Markdown", &["md"])
        .add_filter("Tables (CSV / JSON)", &["csv", "json"])
        .add_filter("Zip archive", &["zip"])
        .pick_files(move |files| {
            let _ = tx.send(files);
        });
    let picked = rx
        .await
        .map_err(|_| "The file picker closed unexpectedly".to_string())?;
    let Some(files) = picked else { return Ok(None) };
    let paths: Vec<String> = files.iter().map(|f| f.to_string()).collect();
    *picker.last_import_paths.lock().unwrap() = Some(paths.iter().cloned().collect());
    Ok(Some(paths))
}

#[tauri::command]
async fn create_backup(
    window: tauri::WebviewWindow,
    destination_path: String,
    backend: tauri::State<'_, Arc<Backend>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let selected = picker.last_backup_destination.lock().unwrap().take();
    if selected.as_deref() != Some(destination_path.as_str()) {
        return Err("Choose the backup destination using the folder picker first".to_string());
    }
    backend
        .call("vault.trustedCreateBackup", vec![json!(destination_path)])
        .await
}

#[tauri::command]
async fn verify_backup(
    window: tauri::WebviewWindow,
    root_path: String,
    passphrase: String,
    backend: tauri::State<'_, Arc<Backend>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let selected = picker.last_backup_path.lock().unwrap().clone();
    if selected.as_deref() != Some(root_path.as_str()) {
        return Err(
            "Choose the backup folder using the folder picker before verifying it".to_string(),
        );
    }
    backend
        .call(
            "vault.trustedVerifyBackup",
            vec![json!(root_path), json!(passphrase)],
        )
        .await
}

#[tauri::command]
async fn import_files(
    window: tauri::WebviewWindow,
    file_paths: Vec<String>,
    target_folder: String,
    backend: tauri::State<'_, Arc<Backend>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    // Only forward paths that actually came back from the
    // most recent pick_import_files call, single-use (consumed here so it can't be replayed).
    let allowed = picker
        .last_import_paths
        .lock()
        .unwrap()
        .take()
        .unwrap_or_default();
    let safe_paths: Vec<String> = file_paths
        .iter()
        .filter(|p| allowed.contains(*p))
        .cloned()
        .collect();
    let rejected_paths: Vec<&String> = file_paths
        .iter()
        .filter(|p| !allowed.contains(*p))
        .collect();

    let mut result = backend
        .call(
            "notes.trustedImport",
            vec![json!(safe_paths), json!(target_folder)],
        )
        .await?;
    if !rejected_paths.is_empty() {
        if let Some(skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
            for path in rejected_paths {
                let base = std::path::Path::new(path)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                skipped.push(json!(format!("{base} (not selected via the file picker)")));
            }
        }
    }
    Ok(result)
}

#[tauri::command]
async fn install_extension(
    window: tauri::WebviewWindow,
    app: AppHandle,
    backend: tauri::State<'_, Arc<Backend>>,
) -> Result<Option<Value>, String> {
    validate_main_window(window.label())?;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a JavaScript extension")
        .add_filter("JavaScript extension", &["js"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "The file picker closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };
    let path_string = picked.to_string();
    let path = std::path::Path::new(&path_string);
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("js"))
    {
        return Err("Choose a JavaScript (.js) extension file".to_string());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Could not read the extension file: {e}"))?;
    if metadata.len() > 512 * 1024 {
        return Err("Extension files must be smaller than 512 KB".to_string());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Could not read the extension file: {e}"))?;
    if bytes.len() > 512 * 1024 {
        return Err("Extension files must be smaller than 512 KB".to_string());
    }
    let source = String::from_utf8(bytes)
        .map_err(|_| "Extension files must contain valid UTF-8 JavaScript".to_string())?;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Extension")
        .to_string();
    let result = backend
        .call(
            "extensions.trustedInstall",
            vec![json!(name), json!(source)],
        )
        .await?;
    Ok(Some(result))
}

// databases.export's content (the encrypted data, decrypted) comes from the backend; the save
// dialog and the file write both happen here since by this point the content is already
// plaintext and Rust needs no vault access to write it to disk.
fn sanitize_filename_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 {
                '-'
            } else {
                c
            }
        })
        .take(100)
        .collect()
}

#[tauri::command]
async fn export_database(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
    format: String,
    backend: tauri::State<'_, Arc<Backend>>,
) -> Result<bool, String> {
    validate_main_window(window.label())?;
    if format != "csv" && format != "json" {
        return Err("Unsupported database export format".to_string());
    }
    let content_result = backend
        .call(
            "databases.trustedExportContent",
            vec![json!(id), json!(format)],
        )
        .await?;
    let title = content_result
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("database");
    let content = content_result
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let safe_title = sanitize_filename_component(title);
    let suggested_name = format!(
        "{}.{format}",
        if safe_title.is_empty() {
            "database"
        } else {
            &safe_title
        }
    );
    let filter_name = if format == "csv" {
        "CSV spreadsheet"
    } else {
        "Driftleaf database JSON"
    };

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(format!("Export {title}"))
        .set_file_name(&suggested_name)
        .add_filter(filter_name, &[format.as_str()])
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(destination) = rx
        .await
        .map_err(|_| "The save dialog closed unexpectedly".to_string())?
    else {
        return Ok(false);
    };
    let destination_path = destination.into_path().map_err(|e| e.to_string())?;
    // Plain string-appended temp path (not PathBuf::with_extension, whose "replace after the
    // last dot" semantics are easy to get subtly wrong) — same atomic write-then-rename
    // pattern the storage layer uses.
    let temp_path = std::path::PathBuf::from(format!(
        "{}.tmp-{}",
        destination_path.display(),
        uuid_like_suffix(),
    ));
    tokio::fs::write(&temp_path, content)
        .await
        .map_err(|e| format!("Could not write the export file: {e}"))?;
    if let Err(error) = tokio::fs::rename(&temp_path, &destination_path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!("Could not write the export file: {error}"));
    }
    Ok(true)
}

// Whole-branch plaintext export. Rust owns the folder picker; the backend does the decrypting
// and writing (it already holds the key), into a new dated folder under what was picked.
#[tauri::command]
async fn export_branch(
    window: tauri::WebviewWindow,
    app: AppHandle,
    backend: tauri::State<'_, Arc<Backend>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose where to put the unencrypted export")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|f| f.to_string()));
        });
    let Some(destination) = rx
        .await
        .map_err(|_| "The folder picker closed unexpectedly".to_string())?
    else {
        return Ok(Value::Null);
    };
    backend
        .call("vault.trustedExportPlaintext", vec![json!(destination)])
        .await
}

// Saves a decrypted copy of one attachment wherever the user chooses. The suggested file
// name comes from the attachment's own metadata, never from the renderer.
#[tauri::command]
async fn save_attachment(
    window: tauri::WebviewWindow,
    app: AppHandle,
    id: String,
    backend: tauri::State<'_, Arc<Backend>>,
) -> Result<bool, String> {
    validate_main_window(window.label())?;
    let attachments = backend.call("attachments.list", vec![]).await?;
    let name = attachments
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .and_then(|item| item.get("name").and_then(Value::as_str))
        .ok_or_else(|| "Attachment not found".to_string())?;
    let safe_name = sanitize_filename_component(name);
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(format!("Save {name}"))
        .set_file_name(if safe_name.is_empty() {
            "attachment"
        } else {
            &safe_name
        })
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(destination) = rx
        .await
        .map_err(|_| "The save dialog closed unexpectedly".to_string())?
    else {
        return Ok(false);
    };
    let destination_path = destination.into_path().map_err(|e| e.to_string())?;
    backend
        .call(
            "attachments.trustedSaveCopy",
            vec![json!(id), json!(destination_path.to_string_lossy())],
        )
        .await?;
    Ok(true)
}

fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

// Window close handshake, mirroring src/main/window-lifecycle.ts's Electron implementation:
// ask the frontend to flush pending drafts, wait for it to report success (bounded by the
// same 30s budget), lock the vault through the backend, then actually close. Declining to
// close (flush failed or timed out) matches Electron's "stayed open to protect your edits".
struct FlushState {
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<(), String>>>>,
    next_id: AtomicU64,
    approved: StdMutex<std::collections::HashSet<String>>,
    closing: StdMutex<std::collections::HashSet<String>>,
}

#[tauri::command]
fn flush_result(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<FlushState>>,
    id: u64,
    error: Option<String>,
) {
    if window.label() != "main" {
        return;
    }
    if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
        let _ = sender.send(error.map_or(Ok(()), Err));
    }
}

fn request_flush(
    window: &tauri::Window,
    flush_state: &std::sync::Arc<FlushState>,
) -> (u64, oneshot::Receiver<Result<(), String>>) {
    let id = flush_state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    flush_state.pending.lock().unwrap().insert(id, tx);
    if window.emit("driftleaf:beforeClose", id).is_err() {
        flush_state.pending.lock().unwrap().remove(&id);
    }
    (id, rx)
}

// Keep ordering and cleanup testable without a GUI. A failed or missing flush
// acknowledgement must never reach the lock step.
async fn prepare_close<F, Fut>(
    state: &FlushState,
    id: u64,
    receiver: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
    lock: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let flushed = tokio::time::timeout(timeout, receiver).await;
    state.pending.lock().unwrap().remove(&id);
    match flushed {
        Ok(Ok(Ok(()))) => lock().await,
        _ => Err("Saving did not finish; the window has been kept open.".into()),
    }
}

// True for the app's own pages/resources: the Vite dev server in debug builds, or the
// production asset origin. Mirrors the same-origin check Electron's will-navigate handler
// used to make; anything else is an external link that should open in the system browser
// instead of navigating this window away from the app.
//
// Matches Tauri's own asset origin exactly (see the upstream `protocol::origin()` helper):
// `http(s)://tauri.localhost` on Windows/Android, `tauri://localhost` everywhere else
// (macOS/Linux here) — rather than the previous blanket "any non-http(s) scheme is
// internal", which also waved through `file:`, `data:`, and any other custom scheme. The
// dev-server check compares scheme/host/port structurally instead of a string prefix on
// the whole URL, so a lookalike like `http://localhost:5183.evil.example` or
// `http://localhost:5183@evil.example` (a valid URL whose userinfo, not host, is
// "localhost:5183") can't be mistaken for it.
fn is_internal_navigation(url: &Url) -> bool {
    if cfg!(windows) || cfg!(target_os = "android") {
        if url.host_str() == Some("tauri.localhost") && matches!(url.scheme(), "http" | "https") {
            return true;
        }
    } else if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(5183)
}

fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let opener = app.clone();
    let opener2 = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Driftleaf")
        .inner_size(1100.0, 720.0)
        // Tauri's native drag-drop handler swallows drag events before the page sees them.
        // The renderer relies on plain HTML5 drag and drop twice over: dragging Canvas
        // cards (which, with the native handler on, does not work at all on Windows), and
        // dropping files onto a note to attach them. Nothing here uses Tauri's own
        // drag-drop events, so the handler is turned off.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if is_internal_navigation(url) {
                return true;
            }
            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .on_new_window(move |url, _features| {
            let _ = opener2.opener().open_url(url.as_str(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn main() {
    // reqwest is built with "rustls-no-provider", so every reqwest::Client (release
    // discovery in updates.rs, the announcement fetch in announcements.rs) panics on first
    // TLS use unless a default crypto provider is installed before either ever runs.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Works even when Driftleaf isn't focused — jot something down without
                    // breaking flow in whatever app you were in, same as the Electron build's
                    // globalShortcut registration in the now-removed src/main/index.ts.
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("driftleaf:quickCapture", ());
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            create_main_window(app.handle())?;
            if let Err(error) = app.global_shortcut().register("CommandOrControl+Shift+N") {
                eprintln!(
                    "[tauri] failed to register the quick-capture shortcut (Ctrl/Cmd+Shift+N) — \
                     it may already be in use by another application: {error}"
                );
            }
            let settings_dir = app
                .path()
                .app_data_dir()
                .expect("no app data directory is available on this platform");
            std::fs::create_dir_all(&settings_dir)?;
            if let Ok(config_root) = app.path().config_dir() {
                settings_migration::import_once(&config_root, &settings_dir)?;
            }

            app.manage(Arc::new(Backend::new(settings_dir)));
            app.manage(updates::setup(app.handle())?);
            app.manage(announcements::setup());
            app.manage(std::sync::Arc::new(extensions::ExtensionWindows::default()));
            app.manage(std::sync::Arc::new(FlushState {
                pending: StdMutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                approved: StdMutex::new(std::collections::HashSet::new()),
                closing: StdMutex::new(std::collections::HashSet::new()),
            }));
            app.manage(std::sync::Arc::new(PickerState {
                last_backup_path: StdMutex::new(None),
                last_backup_destination: StdMutex::new(None),
                last_import_paths: StdMutex::new(None),
            }));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let backend = handle.state::<Arc<Backend>>();
                if let Ok(settings) = backend.call("settings.read", vec![]).await {
                    if settings
                        .get("checkUpdatesAutomatically")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                    {
                        // The update check and the announcement feed are the only requests
                        // Driftleaf makes on its own at startup, and one setting turns both
                        // off. If settings cannot be read at all, neither request is made.
                        let announcements_handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = announcements_handle
                                .state::<announcements::Announcements>()
                                .check(&announcements_handle)
                                .await;
                        });
                        let _ = handle.state::<updates::Updates>().check(&handle).await;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                if matches!(event, WindowEvent::Destroyed) {
                    window
                        .state::<std::sync::Arc<extensions::ExtensionWindows>>()
                        .forget(window.label());
                    let backend = window.state::<Arc<Backend>>().inner().clone();
                    let label = window.label().to_owned();
                    tauri::async_runtime::spawn(async move {
                        let _ = backend
                            .call("extensions.trustedClose", vec![json!(label)])
                            .await;
                    });
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let flush_state = window.state::<std::sync::Arc<FlushState>>().inner().clone();
                let label = window.label().to_string();
                if flush_state.approved.lock().unwrap().contains(&label) {
                    // Already flushed and locked by a previous close attempt below; let it through.
                    return;
                }
                api.prevent_close();
                if !flush_state.closing.lock().unwrap().insert(label.clone()) {
                    return;
                }
                let window = window.clone();
                let backend = window.state::<Arc<Backend>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let (id, rx) = request_flush(&window, &flush_state);
                    let ready =
                        prepare_close(&flush_state, id, rx, Duration::from_secs(30), || async {
                            let extensions =
                                window.state::<std::sync::Arc<extensions::ExtensionWindows>>();
                            let _guard = extensions.lifecycle.lock().await;
                            extensions.close_all(window.app_handle());
                            backend.call("vault.lock", vec![]).await.map(|_| ())
                        })
                        .await;
                    if ready.is_err() {
                        flush_state.closing.lock().unwrap().remove(&label);
                        let _ = window.emit("driftleaf:closeCancelled", ());
                        return;
                    }
                    // Approve before releasing the in-progress guard so a second
                    // close event cannot begin another flush in between.
                    flush_state.approved.lock().unwrap().insert(label.clone());
                    flush_state.closing.lock().unwrap().remove(&label);
                    if window.close().is_err() {
                        flush_state.approved.lock().unwrap().remove(&label);
                        let _ = window.emit("driftleaf:closeCancelled", ());
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend_call,
            updates::update_status,
            updates::update_check,
            updates::update_download,
            updates::update_install,
            updates::update_open_download,
            announcements::announcement_status,
            announcements::announcement_check,
            extensions::run_extension,
            extensions::extension_bootstrap,
            extensions::extension_call,
            pick_directory,
            pick_backup_directory,
            pick_backup_destination,
            pick_import_files,
            create_backup,
            verify_backup,
            import_files,
            install_extension,
            export_database,
            export_branch,
            save_attachment,
            flush_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Driftleaf Tauri shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flush_state() -> FlushState {
        FlushState {
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            approved: StdMutex::new(Default::default()),
            closing: StdMutex::new(Default::default()),
        }
    }

    #[tokio::test]
    async fn failed_missing_and_timed_out_flushes_never_lock() {
        for mode in ["failed", "dropped", "timeout"] {
            let state = flush_state();
            let (tx, rx) = oneshot::channel();
            state.pending.lock().unwrap().insert(1, tx);
            match mode {
                "failed" => {
                    state
                        .pending
                        .lock()
                        .unwrap()
                        .remove(&1)
                        .unwrap()
                        .send(Err("disk full".into()))
                        .unwrap();
                }
                "dropped" => {
                    state.pending.lock().unwrap().remove(&1);
                }
                _ => {}
            }
            let result = prepare_close(&state, 1, rx, Duration::from_millis(1), || async {
                panic!("lock must not run without a successful flush");
            })
            .await;
            assert!(result.is_err(), "{mode}");
            assert!(state.pending.lock().unwrap().is_empty(), "{mode}");
        }
    }

    #[tokio::test]
    async fn lock_failure_blocks_close_and_a_fresh_flush_can_retry() {
        let state = flush_state();
        for succeeds in [false, true] {
            let (tx, rx) = oneshot::channel();
            tx.send(Ok(())).unwrap();
            let result = prepare_close(&state, 1, rx, Duration::from_secs(1), || async {
                if succeeds {
                    Ok(())
                } else {
                    Err("backend stopped".into())
                }
            })
            .await;
            assert_eq!(result.is_ok(), succeeds);
        }
    }

    #[tokio::test]
    async fn lock_waits_for_renderer_acknowledgement() {
        let state = flush_state();
        let (tx, rx) = oneshot::channel();
        let acknowledged = AtomicBool::new(false);
        let flush = async {
            tokio::task::yield_now().await;
            acknowledged.store(true, Ordering::SeqCst);
            tx.send(Ok(())).unwrap();
        };
        let close = prepare_close(&state, 1, rx, Duration::from_secs(1), || async {
            assert!(acknowledged.load(Ordering::SeqCst));
            Ok(())
        });
        let (_, result) = tokio::join!(flush, close);
        assert!(result.is_ok());
    }

    #[test]
    fn internal_navigation_matches_tauris_real_asset_origin_only() {
        let internal = if cfg!(windows) || cfg!(target_os = "android") {
            vec!["http://tauri.localhost/", "https://tauri.localhost/index.html"]
        } else {
            vec!["tauri://localhost/", "tauri://localhost/index.html"]
        };
        for raw in internal {
            assert!(is_internal_navigation(&Url::parse(raw).unwrap()), "{raw}");
        }

        // Everything else is external, including schemes the old "any non-http(s) scheme is
        // internal" check used to wave through, and URLs crafted to look like the dev server
        // or the real asset origin without actually being them.
        let external = [
            "https://example.com/",
            "http://example.com/",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "ftp://example.com/",
            "http://localhost.5183.evil.example/",
            "http://evil.example/?x=localhost:5183",
            "http://evil.example/?x=tauri.localhost",
            "http://tauri.localhost.evil.example/",
        ];
        for raw in external {
            assert!(!is_internal_navigation(&Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn dev_server_origin_is_internal_only_in_debug_builds_and_only_exactly() {
        let dev = Url::parse("http://localhost:5183/").unwrap();
        assert_eq!(is_internal_navigation(&dev), cfg!(debug_assertions));

        // A different port, or https instead of http, must never match even in debug builds.
        assert!(!is_internal_navigation(
            &Url::parse("http://localhost:5184/").unwrap()
        ));
        assert!(!is_internal_navigation(
            &Url::parse("https://localhost:5183/").unwrap()
        ));
    }

    #[test]
    fn renderer_can_only_call_explicit_public_methods() {
        assert!(validate_public_method("main", "notes.list").is_ok());
        for method in [
            "notes.trustedImport",
            "vault.trustedCreateBackup",
            "vault.trustedVerifyBackup",
            "extensions.trustedInstall",
            "databases.trustedExportContent",
            "__internal.requireVault",
            "__internal.currentVault",
            "notes.constructor",
            "notes.list.extra",
        ] {
            assert!(validate_public_method("main", method).is_err(), "{method}");
        }
        assert!(validate_public_method("extension", "notes.list").is_err());
        assert!(validate_main_window("extension").is_err());
    }

}
