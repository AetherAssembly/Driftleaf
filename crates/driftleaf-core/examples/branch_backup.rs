// Drives driftleaf_core::backup's create/verify entry points for the Node interop harness
// (scripts/tests/backup-interop.mjs). stdin is one JSON request with an "action" field.
use std::io::{self, Read};
use std::path::Path;

fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin().read_to_string(&mut request).map_err(|e| e.to_string())?;
    let request: serde_json::Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let output = match request["action"].as_str().ok_or("Missing action")? {
        "create" => {
            let root = request["root"].as_str().ok_or("Missing root")?;
            let destination_parent = request["destinationParent"].as_str().ok_or("Missing destinationParent")?;
            let backup_path = driftleaf_core::backup::create_vault_backup(
                Path::new(root),
                Path::new(destination_parent),
            )?;
            serde_json::json!({ "backupPath": backup_path.to_string_lossy() })
        }
        "verify" => {
            let root = request["root"].as_str().ok_or("Missing root")?;
            let passphrase = request["passphrase"].as_str().ok_or("Missing passphrase")?;
            driftleaf_core::backup::verify_vault_backup(Path::new(root), passphrase)?
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    println!("{output}");
    Ok(())
}
