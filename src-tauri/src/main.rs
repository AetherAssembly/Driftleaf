mod extensions;
mod settings_migration;
mod updates;
// Tauri shell for the Phase 2 first slice (see docs/ELECTRON_MIGRATION_REVIEW.md). Rust owns
// every OS dialog and the window close handshake; everything else (session state, the
// save/lock op queue, note/search commands) runs in the existing Node domain service, reached
// through a sidecar child process over a private, length-prefixed JSON stdin/stdout protocol.
// No localhost listener, no secrets on the command line — passphrases travel only inside
// request bodies on that private pipe, and request contents are never logged.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

type PendingMap = AsyncMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;

struct Sidecar {
    stdin: AsyncMutex<tokio::process::ChildStdin>,
    pending: PendingMap,
    next_id: AtomicU64,
    dead: AtomicBool,
    // Kept alive for the process's lifetime; dropping it would close the pipes.
    _child: StdMutex<Option<Child>>,
}

impl Sidecar {
    async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        if self.dead.load(Ordering::SeqCst) {
            return Err("The Driftleaf background service has stopped. Restart the app.".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        let payload = json!({ "id": id, "method": method, "args": args });
        let frame = encode_frame(&payload).map_err(|e| e.to_string())?;
        {
            let mut pending = self.pending.lock().await;
            // EOF may race request registration. Check under the same lock used
            // by fail_all_pending so no caller can be stranded after it drains.
            if self.dead.load(Ordering::SeqCst) {
                return Err(
                    "The Driftleaf background service has stopped. Restart the app.".into(),
                );
            }
            pending.insert(id, tx);
        }
        {
            let mut stdin = self.stdin.lock().await;
            if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
                self.fail_all_pending("Lost the connection to the Driftleaf background service.")
                    .await;
                return Err("Lost the connection to the Driftleaf background service.".into());
            }
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err("The Driftleaf background service stopped before responding.".into()),
        }
    }

    async fn fail_all_pending(&self, message: &str) {
        self.dead.store(true, Ordering::SeqCst);
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

const MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;

fn encode_frame(value: &Value) -> std::io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME_BYTES as usize {
        return Err(std::io::Error::other(
            "Request exceeds the sidecar frame size limit",
        ));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

// Spawns the Node sidecar and a background task that reads framed responses off its stdout,
// matching each one back to the caller awaiting it in `pending`. Never logs frame bodies —
// only that a response for a given request id arrived, or that the child died.
fn spawn_sidecar(
    settings_dir: std::path::PathBuf,
    project_root: std::path::PathBuf,
    node: std::path::PathBuf,
) -> std::sync::Arc<Sidecar> {
    // Node's `--loader` argument is parsed as a URL, not a plain path: on Windows an
    // absolute path like `D:\a\...\typescript-loader.mjs` is mistaken for a URL with
    // scheme `d`, failing with ERR_UNSUPPORTED_ESM_URL_SCHEME. `Url::from_file_path`
    // produces a real `file://` URL on every platform instead.
    let loader_url = Url::from_file_path(project_root.join("scripts/tests/typescript-loader.mjs"))
        .expect("typescript-loader.mjs path must be absolute");
    let mut command = Command::new(node);
    command
        .current_dir(&project_root)
        .arg("--experimental-strip-types")
        .arg("--loader")
        .arg(loader_url.as_str())
        .arg(project_root.join("sidecar/index.mjs"))
        .env("DRIFTLEAF_SETTINGS_DIR", &settings_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .expect("failed to start the Driftleaf sidecar (node)");
    let stdin = child.stdin.take().expect("sidecar stdin was not piped");
    let stdout = child.stdout.take().expect("sidecar stdout was not piped");
    let stderr = child.stderr.take().expect("sidecar stderr was not piped");

    let sidecar = std::sync::Arc::new(Sidecar {
        stdin: AsyncMutex::new(stdin),
        pending: AsyncMutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        dead: AtomicBool::new(false),
        _child: StdMutex::new(Some(child)),
    });

    // Diagnostics only: the sidecar never writes request/response bodies to stderr, only
    // lifecycle lines and generic command failures (see sidecar/index.mjs).
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match tokio::io::AsyncBufReadExt::read_until(&mut reader, b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    eprint!("[sidecar] {}", line);
                }
            }
        }
    });

    let reader_sidecar = sidecar.clone();
    tokio::spawn(async move {
        let mut reader = stdout;
        loop {
            match read_frame(&mut reader).await {
                Ok(Some(bytes)) => {
                    let parsed: Result<Value, _> = serde_json::from_slice(&bytes);
                    let Ok(response) = parsed else {
                        reader_sidecar
                            .fail_all_pending("The background service sent an invalid response.")
                            .await;
                        break;
                    };
                    let Some(id) = response.get("id").and_then(Value::as_u64) else {
                        reader_sidecar
                            .fail_all_pending("The background service sent an invalid response.")
                            .await;
                        break;
                    };
                    let sender = reader_sidecar.pending.lock().await.remove(&id);
                    if let Some(sender) = sender {
                        let ok = response.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        let result = if ok {
                            Ok(response.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(response
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown sidecar error")
                                .to_string())
                        };
                        let _ = sender.send(result);
                    }
                }
                Ok(None) => {
                    eprintln!("[tauri] sidecar stdout closed; it has exited");
                    reader_sidecar
                        .fail_all_pending("The Driftleaf background service exited unexpectedly.")
                        .await;
                    break;
                }
                Err(error) => {
                    eprintln!("[tauri] error reading from sidecar: {error}");
                    reader_sidecar
                        .fail_all_pending(
                            "Lost the connection to the Driftleaf background service.",
                        )
                        .await;
                    break;
                }
            }
        }
    });

    sidecar
}

async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    if reader.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await?;
    let length = u32::from_be_bytes(header);
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::other(format!(
            "sidecar frame of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte bound"
        )));
    }
    let mut body = vec![0u8; length as usize];
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

#[tauri::command]
async fn sidecar_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<Sidecar>>,
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
        serde_json::from_str(include_str!("../../sidecar/public-methods.json"))
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

// Single-use picked-path tracking for the commands whose security check in service.ts
// requires that a matching pick*() call happened first (notes.import / vault.createBackup /
// vault.verifyBackup) — see the "Trusted commands" comment in sidecar/index.mjs for why that
// check had to move here instead of staying in the sidecar. Each field is reset when its
// picker runs and consumed (taken) by the one mutating call that's allowed to use it, the
// same single-use semantics service.ts originally had.
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
    sidecar: tauri::State<'_, std::sync::Arc<Sidecar>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let selected = picker.last_backup_destination.lock().unwrap().take();
    if selected.as_deref() != Some(destination_path.as_str()) {
        return Err("Choose the backup destination using the folder picker first".to_string());
    }
    sidecar
        .call("vault.trustedCreateBackup", vec![json!(destination_path)])
        .await
}

#[tauri::command]
async fn verify_backup(
    window: tauri::WebviewWindow,
    root_path: String,
    passphrase: String,
    sidecar: tauri::State<'_, std::sync::Arc<Sidecar>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    let selected = picker.last_backup_path.lock().unwrap().clone();
    if selected.as_deref() != Some(root_path.as_str()) {
        return Err(
            "Choose the backup folder using the folder picker before verifying it".to_string(),
        );
    }
    sidecar
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
    sidecar: tauri::State<'_, std::sync::Arc<Sidecar>>,
    picker: tauri::State<'_, std::sync::Arc<PickerState>>,
) -> Result<Value, String> {
    validate_main_window(window.label())?;
    // Mirrors service.ts's notes.import: only forward paths that actually came back from the
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

    let mut result = sidecar
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
    sidecar: tauri::State<'_, std::sync::Arc<Sidecar>>,
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
    let result = sidecar
        .call(
            "extensions.trustedInstall",
            vec![json!(name), json!(source)],
        )
        .await?;
    Ok(Some(result))
}

// databases.export's content (the encrypted data, decrypted) comes from the sidecar; the save
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
    sidecar: tauri::State<'_, std::sync::Arc<Sidecar>>,
) -> Result<bool, String> {
    validate_main_window(window.label())?;
    if format != "csv" && format != "json" {
        return Err("Unsupported database export format".to_string());
    }
    let content_result = sidecar
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
    // pattern vault.ts and settings-store.ts already use.
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
// same 30s budget), lock the vault through the sidecar, then actually close. Declining to
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
// production asset origin (a non-http(s) scheme on Windows/Linux, "tauri.localhost" on
// macOS/iOS). Mirrors the same-origin check Electron's will-navigate handler used to make;
// anything else is an external link that should open in the system browser instead of
// navigating this window away from the app.
fn is_internal_navigation(url: &Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return true;
    }
    if cfg!(debug_assertions) && url.as_str().starts_with("http://localhost:5183") {
        return true;
    }
    url.host_str() == Some("tauri.localhost")
}

fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let opener = app.clone();
    let opener2 = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Driftleaf")
        .inner_size(1100.0, 720.0)
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
    // This remains a source-tree preview. Resolve from the build manifest rather
    // than the launch directory; packaged resources are a separate Phase 3 step.
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a project parent")
        .to_path_buf();

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

            // setup() runs before Tauri's async runtime context is entered on this thread, but
            // spawn_sidecar needs it (tokio::process::Command::spawn and tokio::spawn both
            // panic with "no reactor running" otherwise) — block_on enters that context for
            // the duration of the synchronous call.
            let sidecar = tauri::async_runtime::block_on(async {
                let resource_root = app
                    .path()
                    .resource_dir()
                    .expect("resource directory unavailable")
                    .join("backend");
                let (backend, node) = if cfg!(debug_assertions) {
                    (project_root.clone(), std::path::PathBuf::from("node"))
                } else {
                    let node = resource_root.join(if cfg!(windows) { "node.exe" } else { "node" });
                    (resource_root, node)
                };
                spawn_sidecar(settings_dir, backend, node)
            });
            app.manage(sidecar);
            app.manage(updates::setup(app.handle())?);
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
                let sidecar = handle.state::<std::sync::Arc<Sidecar>>();
                if let Ok(settings) = sidecar.call("settings.read", vec![]).await {
                    if settings
                        .get("checkUpdatesAutomatically")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                    {
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
                    let sidecar = window.state::<std::sync::Arc<Sidecar>>().inner().clone();
                    let label = window.label().to_owned();
                    tauri::async_runtime::spawn(async move {
                        let _ = sidecar
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
                let sidecar = window.state::<std::sync::Arc<Sidecar>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let (id, rx) = request_flush(&window, &flush_state);
                    let ready =
                        prepare_close(&flush_state, id, rx, Duration::from_secs(30), || async {
                            let extensions =
                                window.state::<std::sync::Arc<extensions::ExtensionWindows>>();
                            let _guard = extensions.lifecycle.lock().await;
                            extensions.close_all(window.app_handle());
                            sidecar.call("vault.lock", vec![]).await.map(|_| ())
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
            sidecar_call,
            updates::update_status,
            updates::update_check,
            updates::update_download,
            updates::update_install,
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
                    Err("sidecar stopped".into())
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

    #[tokio::test]
    async fn framed_json_roundtrip() {
        let value = json!({"id": 1, "args": ["Unicode 🪴", null]});
        let bytes = encode_frame(&value).unwrap();
        let mut reader = bytes.as_slice();
        let body = read_frame(&mut reader).await.unwrap().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), value);
        assert!(read_frame(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reject_oversized_and_truncated_frames() {
        let header = (MAX_FRAME_BYTES + 1).to_be_bytes();
        assert!(read_frame(&mut header.as_slice()).await.is_err());
        assert!(read_frame(&mut [0u8, 0].as_slice()).await.is_err());
        assert!(read_frame(&mut [0u8, 0, 0, 3, b'{'].as_slice())
            .await
            .is_err());
    }

    #[test]
    fn outgoing_frames_obey_same_limit() {
        let value = Value::String("x".repeat(MAX_FRAME_BYTES as usize));
        assert!(encode_frame(&value).is_err());
    }
}
