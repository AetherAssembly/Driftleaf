// Tauri shell for the Phase 2 first slice (see docs/ELECTRON_MIGRATION_REVIEW.md). Rust owns
// every OS dialog and the window close handshake; everything else (session state, the
// save/lock op queue, note/search commands) runs in the existing Node domain service, reached
// through a sidecar child process over a private, length-prefixed JSON stdin/stdout protocol.
// No localhost listener, no secrets on the command line — passphrases travel only inside
// request bodies on that private pipe, and only method names are ever logged.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt;
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
        self.pending.lock().await.insert(id, tx);

        let payload = json!({ "id": id, "method": method, "args": args });
        let frame = encode_frame(&payload).map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().await;
            if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
                self.pending.lock().await.remove(&id);
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

fn encode_frame(value: &Value) -> serde_json::Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

// Spawns the Node sidecar and a background task that reads framed responses off its stdout,
// matching each one back to the caller awaiting it in `pending`. Never logs frame bodies —
// only that a response for a given request id arrived, or that the child died.
fn spawn_sidecar(settings_dir: std::path::PathBuf, project_root: std::path::PathBuf) -> std::sync::Arc<Sidecar> {
    let mut command = Command::new("node");
    command
        .current_dir(&project_root)
        .arg("--experimental-strip-types")
        .arg("--loader")
        .arg(project_root.join("scripts/tests/typescript-loader.mjs"))
        .arg(project_root.join("sidecar/index.mjs"))
        .env("DRIFTLEAF_SETTINGS_DIR", &settings_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().expect("failed to start the Driftleaf sidecar (node)");
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
    // lifecycle lines and failed-command method names (see sidecar/index.mjs).
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
                        eprintln!("[tauri] sidecar sent a malformed frame, dropping it");
                        continue;
                    };
                    let Some(id) = response.get("id").and_then(Value::as_u64) else {
                        eprintln!("[tauri] sidecar response had no numeric id, dropping it");
                        continue;
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
                        .fail_all_pending("Lost the connection to the Driftleaf background service.")
                        .await;
                    break;
                }
            }
        }
    });

    sidecar
}

async fn read_frame<R: tokio::io::AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    if let Err(error) = reader.read_exact(&mut header).await {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(error);
    }
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
    state: tauri::State<'_, std::sync::Arc<Sidecar>>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    state.call(&method, args).await
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|f| f.to_string()));
    });
    rx.await.map_err(|_| "The folder picker closed unexpectedly".to_string())
}

// Window close handshake, mirroring src/main/window-lifecycle.ts's Electron implementation:
// ask the frontend to flush pending drafts, wait for it to report success (bounded by the
// same 30s budget), lock the vault through the sidecar, then actually close. Declining to
// close (flush failed or timed out) matches Electron's "stayed open to protect your edits".
struct FlushState {
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<(), String>>>>,
    next_id: AtomicU64,
    approved: StdMutex<std::collections::HashSet<String>>,
}

#[tauri::command]
fn flush_result(
    state: tauri::State<'_, std::sync::Arc<FlushState>>,
    id: u64,
    error: Option<String>,
) {
    if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
        let _ = sender.send(error.map_or(Ok(()), Err));
    }
}

fn request_flush(app: &AppHandle, flush_state: &std::sync::Arc<FlushState>) -> oneshot::Receiver<Result<(), String>> {
    let id = flush_state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    flush_state.pending.lock().unwrap().insert(id, tx);
    let _ = app.emit("driftleaf:beforeClose", id);
    rx
}

fn main() {
    let project_root = std::env::current_dir()
        .expect("failed to read the current directory")
        .join("..");
    let project_root = project_root
        .canonicalize()
        .expect("failed to resolve the project root (expected to run from src-tauri/)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let settings_dir = app
                .path()
                .app_data_dir()
                .expect("no app data directory is available on this platform");
            std::fs::create_dir_all(&settings_dir).ok();

            // setup() runs before Tauri's async runtime context is entered on this thread, but
            // spawn_sidecar needs it (tokio::process::Command::spawn and tokio::spawn both
            // panic with "no reactor running" otherwise) — block_on enters that context for
            // the duration of the synchronous call.
            let sidecar = tauri::async_runtime::block_on(async { spawn_sidecar(settings_dir, project_root.clone()) });
            app.manage(sidecar);
            app.manage(std::sync::Arc::new(FlushState {
                pending: StdMutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                approved: StdMutex::new(std::collections::HashSet::new()),
            }));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let flush_state = window.state::<std::sync::Arc<FlushState>>().inner().clone();
                let label = window.label().to_string();
                if flush_state.approved.lock().unwrap().contains(&label) {
                    // Already flushed and locked by a previous close attempt below; let it through.
                    return;
                }
                api.prevent_close();

                let app = window.app_handle().clone();
                let window = window.clone();
                let sidecar = window.state::<std::sync::Arc<Sidecar>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let rx = request_flush(&app, &flush_state);
                    let flushed = tokio::time::timeout(Duration::from_secs(30), rx).await;
                    let flush_ok = match flushed {
                        Ok(Ok(Ok(()))) => true,
                        Ok(Ok(Err(message))) => {
                            eprintln!("[tauri] renderer flush failed: {message}");
                            false
                        }
                        Ok(Err(_)) => {
                            eprintln!("[tauri] renderer flush channel dropped");
                            false
                        }
                        Err(_) => {
                            eprintln!("[tauri] renderer flush timed out after 30s");
                            false
                        }
                    };
                    if !flush_ok {
                        // Matches Electron: stay open rather than risk losing an edit.
                        let _ = app.emit("driftleaf:closeCancelled", ());
                        return;
                    }
                    if let Err(message) = sidecar.call("vault.lock", vec![]).await {
                        eprintln!("[tauri] lock-on-close failed: {message}");
                    }
                    flush_state.approved.lock().unwrap().insert(label);
                    window.close().ok();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![sidecar_call, pick_directory, flush_result])
        .run(tauri::generate_context!())
        .expect("error while running the Driftleaf Tauri shell");
}
