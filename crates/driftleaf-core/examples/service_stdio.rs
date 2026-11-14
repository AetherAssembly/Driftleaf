//! The service behind the same private stdin/stdout protocol the Node sidecar spoke: a
//! 4-byte big-endian length, then that many bytes of UTF-8 JSON, `{ id, method, args }` in
//! and `{ id, ok, result | error }` out. The desktop app links the service directly and
//! does not use this; it exists so the protocol tests (scripts/tests/sidecar.mjs) and the
//! browser harness (scripts/dev/web-harness.mjs) can drive the real Rust backend.
use driftleaf_core::service::Service;
use serde_json::{json, Value};
use std::io::{Read, Write};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const TRUSTED: &[&str] = &[
    "lifecycle.trustedDrain", "extensions.trustedOpen", "extensions.trustedClose",
    "extensions.trustedCall", "extensions.trustedInstall", "vault.trustedCreateBackup",
    "vault.trustedVerifyBackup", "vault.trustedExportPlaintext", "notes.trustedImport",
    "databases.trustedExportContent", "attachments.trustedSaveCopy",
];

fn fail(message: &str) -> ! {
    eprintln!("[sidecar] {message}");
    std::process::exit(1);
}

fn main() {
    let Some(settings_dir) = std::env::var_os("DRIFTLEAF_SETTINGS_DIR") else {
        fail("DRIFTLEAF_SETTINGS_DIR is not set; refusing to start");
    };
    let public: Vec<String> =
        serde_json::from_str(include_str!("../../../sidecar/public-methods.json")).expect("valid method list");
    let mut service = Service::new(settings_dir.into(), env!("CARGO_PKG_VERSION"));
    let (mut stdin, mut stdout) = (std::io::stdin().lock(), std::io::stdout().lock());
    eprintln!("[sidecar] ready");
    loop {
        let mut header = [0u8; 4];
        match stdin.read(&mut header[..1]) {
            Ok(0) => {
                eprintln!("[sidecar] stdin closed, exiting");
                return;
            }
            Ok(_) => {}
            Err(_) => fail("could not read stdin; exiting"),
        }
        if stdin.read_exact(&mut header[1..]).is_err() {
            return;
        }
        let length = u32::from_be_bytes(header) as usize;
        if length > MAX_FRAME_BYTES {
            fail("incoming frame exceeds the frame size bound, exiting");
        }
        let mut body = vec![0u8; length];
        if stdin.read_exact(&mut body).is_err() {
            return;
        }
        let Ok(request) = serde_json::from_slice::<Value>(&body) else { fail("malformed frame; exiting") };
        let Some(id) = request.get("id").and_then(Value::as_u64).filter(|id| *id >= 1) else {
            fail("invalid request envelope; exiting");
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
        let result = match request.get("args").and_then(Value::as_array) {
            None => Err("Sidecar arguments must be an array".to_string()),
            Some(_) if !public.iter().any(|m| m == method) && !TRUSTED.contains(&method) => {
                Err("Unknown sidecar command".to_string())
            }
            Some(args) => service.call(method, args).map_err(|error| {
                if error == "Unknown command" { "Unknown sidecar command".into() } else { error }
            }),
        };
        let response = match result {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        let bytes = serde_json::to_vec(&response).unwrap_or_default();
        if stdout.write_all(&(bytes.len() as u32).to_be_bytes()).is_err()
            || stdout.write_all(&bytes).is_err()
            || stdout.flush().is_err()
        {
            return;
        }
    }
}
