//! Branch backup and health-check compatibility, ported from createVaultBackup(),
//! inspectVaultData()/inspectVault(), and verifyVaultBackup() in src/main/vault.ts.
use crate::{decrypt, derive_key, open_branch, valid_id, Key, DRIFTLEAF_DIR};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const CANARY_TEXT: &[u8] = b"driftleaf-vault-v1";
const WRITER_LOCK_NAMES: &[&str] = &[
    ".driftleaf-writer.sqlite",
    ".driftleaf-writer.sqlite-journal",
    ".driftleaf-writer.sqlite-wal",
    ".driftleaf-writer.sqlite-shm",
];

fn path_is_within(parent: &Path, child: &Path) -> bool {
    child == parent || child.strip_prefix(parent).is_ok()
}

fn copy_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if WRITER_LOCK_NAMES.iter().any(|lock| *lock == name.to_string_lossy()) {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copies the whole branch folder (excluding the writer-lock file and its journal/WAL/SHM
/// sidecars) into a sibling temp directory, then renames it into place — the same
/// copy-then-atomic-rename shape as createVaultBackup(), without a zip step on either side:
/// vault.ts's own backup format is a plain directory copy, not an archive.
pub fn create_vault_backup(root: &Path, destination_parent: &Path) -> Result<PathBuf, String> {
    let source = root.canonicalize().map_err(|e| e.to_string())?;
    let destination = destination_parent.canonicalize().map_err(|e| e.to_string())?;
    if path_is_within(&source, &destination) {
        return Err("Choose a backup destination outside the open vault folder".into());
    }
    let timestamp = chrono_like_timestamp();
    let base_name = format!("Driftleaf-Backup-{timestamp}");
    let mut backup_name = base_name.clone();
    let mut suffix = 2;
    while destination.join(&backup_name).exists() {
        backup_name = format!("{base_name}-{suffix}");
        suffix += 1;
    }
    let backup_path = destination.join(&backup_name);
    let temporary_path = destination.join(format!(".{backup_name}.tmp-{}", crate::random_hex(16)));
    let result = copy_recursive(&source, &temporary_path)
        .and_then(|()| fs::rename(&temporary_path, &backup_path).map_err(|e| e.to_string()));
    match result {
        Ok(()) => Ok(backup_path),
        Err(err) => {
            let _ = fs::remove_dir_all(&temporary_path);
            Err(err)
        }
    }
}

// ISO-8601-ish, colons replaced with "-" and milliseconds dropped — same shape as
// `new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z")` in vault.ts.
fn chrono_like_timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let (year, month, day, hour, minute, second, _) = crate::date::millis_to_parts(millis);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}Z")
}

struct DiskScan {
    encrypted_files: HashMap<String, (String, String, bool)>, // key -> (folderPath, fileName, private)
    temporary_files: usize,
}

fn scan_vault_files(root: &Path) -> Result<DiskScan, String> {
    let mut encrypted_files = HashMap::new();
    let mut temporary_files = 0usize;

    fn scan_dir(
        root: &Path,
        dir: &Path,
        encrypted_files: &mut HashMap<String, (String, String, bool)>,
        temporary_files: &mut usize,
    ) -> Result<(), String> {
        let rel_folder = dir
            .strip_prefix(root)
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                if name != DRIFTLEAF_DIR {
                    scan_dir(root, &entry.path(), encrypted_files, temporary_files)?;
                }
            } else if file_type.is_file() {
                if name.contains(".tmp-") {
                    *temporary_files += 1;
                }
                if name.ends_with(".enc") {
                    encrypted_files.insert(
                        format!("{rel_folder}/{name}"),
                        (rel_folder.clone(), name, false),
                    );
                }
            }
        }
        Ok(())
    }
    scan_dir(root, root, &mut encrypted_files, &mut temporary_files)?;

    let private_notes = root.join(DRIFTLEAF_DIR).join("notes");
    if let Ok(entries) = fs::read_dir(&private_notes) {
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains(".tmp-") {
                    temporary_files += 1;
                }
                if name.ends_with(".enc") {
                    encrypted_files.insert(format!("@private/{name}"), (String::new(), name, true));
                }
            }
        }
    }
    Ok(DiskScan { encrypted_files, temporary_files })
}

fn valid_manifest_note(value: &Value) -> bool {
    value["id"].is_string()
        && value["title"].is_string()
        && value["folderPath"].is_string()
        && (value.get("fileName").is_none() || value["fileName"].is_string())
        && value["updatedAt"].is_number()
}

fn valid_database_meta(value: &Value) -> bool {
    value["id"].as_str().is_some_and(valid_id)
        && value["title"].is_string()
        && value["folderPath"].is_string()
        && value["updatedAt"].is_number()
}

fn add_check(checks: &mut Vec<Value>, name: &str, status: &str, details: String) {
    checks.push(json!({ "name": name, "status": status, "details": details }));
}

fn validate_folder_path_ok(folder_path: &str) -> bool {
    !folder_path.contains("..")
        && !folder_path.starts_with('/')
        && !folder_path.split('/').any(|part| part == DRIFTLEAF_DIR)
}

/// Reads the manifest strictly off disk (no legacy-path fallback beyond what readManifest
/// already does) the way inspectVaultData() does, independent of whatever in-memory
/// manifest a caller might otherwise be holding.
fn read_manifest_strict(root: &Path, key: &Key) -> Result<Value, String> {
    let private = root.join(DRIFTLEAF_DIR);
    match fs::read(private.join("manifest.enc")) {
        Ok(bytes) => serde_json::from_slice(&decrypt(&bytes, key)?).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::from_slice(&fs::read(private.join("manifest.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn inspect_vault_data(root: &Path, key: &Key, manifest: &Value) -> Value {
    let mut checks = Vec::new();

    let canary_valid = (|| -> Option<bool> {
        let config: Value =
            serde_json::from_slice(&fs::read(root.join(DRIFTLEAF_DIR).join("vault.json")).ok()?).ok()?;
        let canary = fs::read(root.join(DRIFTLEAF_DIR).join("canary.enc")).ok()?;
        let decrypted = decrypt(&canary, key).ok()?;
        Some(config["version"] == 1 && decrypted.as_slice() == CANARY_TEXT)
    })()
    .unwrap_or(false);
    add_check(
        &mut checks,
        "Vault metadata and key check",
        if canary_valid { "ok" } else { "error" },
        if canary_valid {
            "Vault configuration and encrypted key check are readable.".into()
        } else {
            "Vault configuration or encrypted key check is missing, invalid, or damaged.".into()
        },
    );

    let on_disk_manifest = read_manifest_strict(root, key).ok();
    let manifest_valid = on_disk_manifest.as_ref().is_some_and(|m| {
        m["notes"].as_array().is_some_and(|notes| notes.iter().all(valid_manifest_note))
            && m["folders"].as_array().is_some_and(|folders| folders.iter().all(Value::is_string))
    });
    let note_count = manifest["notes"].as_array().map(Vec::len).unwrap_or(0);
    let folder_count = manifest["folders"].as_array().map(Vec::len).unwrap_or(0);
    add_check(
        &mut checks,
        "Vault index",
        if manifest_valid { "ok" } else { "error" },
        if manifest_valid {
            format!("{note_count} note entries and {folder_count} folders are indexed.")
        } else {
            "The vault manifest is missing, unreadable, or has an invalid structure.".into()
        },
    );
    if !manifest_valid {
        return json!({ "checkedAt": crate::mutation::now_ms(), "checks": checks });
    }

    let disk = match scan_vault_files(root) {
        Ok(disk) => disk,
        Err(error) => {
            add_check(
                &mut checks,
                "Encrypted files",
                "error",
                format!("Could not scan the vault folder: {error}"),
            );
            return json!({ "checkedAt": crate::mutation::now_ms(), "checks": checks });
        }
    };

    let mut expected = std::collections::HashSet::new();
    let mut invalid_entries = 0u32;
    let mut missing_files = 0u32;
    for note in manifest["notes"].as_array().into_iter().flatten() {
        if !valid_manifest_note(note) {
            invalid_entries += 1;
            continue;
        }
        let id = note["id"].as_str().unwrap_or("");
        let file_name = note["fileName"].as_str().map(String::from).unwrap_or_else(|| format!("{id}.enc"));
        let folder_path = note["folderPath"].as_str().unwrap_or("");
        let basename_matches = !file_name.contains('/') && !file_name.contains('\\');
        if !basename_matches || !file_name.ends_with(".enc") || !valid_id(id) || !validate_folder_path_ok(folder_path) {
            invalid_entries += 1;
            continue;
        }
        let private_key = format!("@private/{id}.enc");
        let legacy_key = format!("{folder_path}/{file_name}");
        let file_key = if disk.encrypted_files.contains_key(&private_key) { private_key } else { legacy_key };
        if !disk.encrypted_files.contains_key(&file_key) {
            missing_files += 1;
        }
        expected.insert(file_key);
    }

    let orphan_files = disk.encrypted_files.keys().filter(|key| !expected.contains(*key)).count();
    let mut unreadable_files = 0u32;
    for (folder_path, file_name, private) in disk.encrypted_files.values() {
        let path = if *private {
            root.join(DRIFTLEAF_DIR).join("notes").join(file_name)
        } else {
            root.join(folder_path).join(file_name)
        };
        let readable = fs::read(&path)
            .ok()
            .and_then(|bytes| decrypt(&bytes, key).ok())
            .and_then(|plaintext| String::from_utf8(plaintext.to_vec()).ok())
            .is_some();
        if !readable {
            unreadable_files += 1;
        }
    }
    let integrity_status = if invalid_entries + missing_files + unreadable_files > 0 { "error" } else { "ok" };
    add_check(
        &mut checks,
        "Encrypted note contents",
        integrity_status,
        if invalid_entries + missing_files + unreadable_files == 0 {
            format!("All {} encrypted note file(s) decrypt successfully.", disk.encrypted_files.len())
        } else {
            format!(
                "{invalid_entries} invalid index entries, {missing_files} missing note files, and {unreadable_files} unreadable or damaged encrypted file(s)."
            )
        },
    );
    add_check(
        &mut checks,
        "Unindexed encrypted files",
        if orphan_files > 0 { "warning" } else { "ok" },
        if orphan_files > 0 {
            format!("{orphan_files} encrypted file(s) are not listed in the manifest and may be recoverable on the next unlock.")
        } else {
            "All encrypted note files are represented in the manifest.".into()
        },
    );
    add_check(
        &mut checks,
        "Incomplete-write leftovers",
        if disk.temporary_files > 0 { "warning" } else { "ok" },
        if disk.temporary_files > 0 {
            format!("{} temporary file(s) remain in the vault folder.", disk.temporary_files)
        } else {
            "No temporary write files were found.".into()
        },
    );

    let database_metas: Vec<&Value> = manifest["databases"].as_array().into_iter().flatten().collect();
    let mut invalid_databases = 0u32;
    let mut unreadable_databases = 0u32;
    let mut expected_database_files = std::collections::HashSet::new();
    for database in &database_metas {
        if !valid_database_meta(database) {
            invalid_databases += 1;
            continue;
        }
        let id = database["id"].as_str().unwrap_or("");
        expected_database_files.insert(format!("{id}.db.enc"));
        let valid = fs::read(root.join(DRIFTLEAF_DIR).join(format!("{id}.db.enc")))
            .ok()
            .and_then(|bytes| decrypt(&bytes, key).ok())
            .and_then(|plaintext| serde_json::from_slice::<Value>(&plaintext).ok())
            .filter(|data| data["properties"].is_array() && data["rows"].is_array())
            .map(|data| {
                let properties = data["properties"].as_array().cloned().unwrap_or_default();
                crate::mutation::validate_database_properties(&properties).is_ok()
                    && crate::mutation::validate_database_rows(&properties, &data["rows"]).is_ok()
            })
            .unwrap_or(false);
        if !valid {
            unreadable_databases += 1;
        }
    }
    let (orphan_database_files, metadata_temp_files) = fs::read_dir(root.join(DRIFTLEAF_DIR))
        .map(|entries| {
            let mut orphan = 0usize;
            let mut temp = 0usize;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if entry.file_type().is_ok_and(|t| t.is_file()) {
                    if name.ends_with(".db.enc") && !expected_database_files.contains(&name) {
                        orphan += 1;
                    }
                    if name.contains(".tmp-") {
                        temp += 1;
                    }
                }
            }
            (orphan, temp)
        })
        .unwrap_or((database_metas.len(), 0));
    let database_status = if invalid_databases + unreadable_databases > 0 {
        "error"
    } else if orphan_database_files > 0 {
        "warning"
    } else {
        "ok"
    };
    add_check(
        &mut checks,
        "Encrypted databases",
        database_status,
        if invalid_databases + unreadable_databases == 0 && orphan_database_files == 0 {
            format!("{} database(s) decrypt and validate successfully.", database_metas.len())
        } else {
            format!(
                "{invalid_databases} invalid metadata entries, {unreadable_databases} unreadable databases, and {orphan_database_files} unindexed database file(s)."
            )
        },
    );
    if metadata_temp_files > 0 {
        add_check(
            &mut checks,
            "Database write leftovers",
            "warning",
            format!("{metadata_temp_files} temporary file(s) remain in the vault metadata folder."),
        );
    }

    json!({ "checkedAt": crate::mutation::now_ms(), "checks": checks })
}

/// Health report for an already-open branch (mirrors inspectVault()).
pub fn inspect(root: &Path, key: &Key, manifest: &Value) -> Value {
    inspect_vault_data(root, key, manifest)
}

/// Opens an on-disk branch with its own passphrase (independent of any already-open
/// `Branch`/`Snapshot`) and runs the same health check, mirroring verifyVaultBackup().
pub fn verify_vault_backup(root: &Path, passphrase: &str) -> Result<Value, String> {
    let config: Value =
        serde_json::from_slice(&fs::read(root.join(DRIFTLEAF_DIR).join("vault.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if config["version"] != 1 {
        return Err("This backup uses an unsupported vault format".into());
    }
    let key = if config["kdf"] == "scrypt" {
        let salt_hex = config["saltHex"].as_str().filter(|s| s.len() == 32).ok_or("Backup has an invalid key-derivation salt")?;
        derive_key(passphrase, &hex::decode(salt_hex).map_err(|e| e.to_string())?)?
    } else if config["kdf"] == "none" {
        let key_hex = config["keyHex"].as_str().filter(|s| s.len() == 64).ok_or("Backup has an invalid encryption key")?;
        let bytes = hex::decode(key_hex).map_err(|e| e.to_string())?;
        Key::new(bytes.try_into().map_err(|_| "Invalid legacy key")?)
    } else {
        return Err("Backup uses an unsupported key-derivation method".into());
    };
    let canary = fs::read(root.join(DRIFTLEAF_DIR).join("canary.enc")).map_err(|e| e.to_string())?;
    let decrypted = decrypt(&canary, &key).map_err(|_| "Backup passphrase is incorrect or its key check is damaged".to_string())?;
    if decrypted.as_slice() != CANARY_TEXT {
        return Err("Backup passphrase is incorrect or its key check is damaged".into());
    }
    let manifest = read_manifest_strict(root, &key)?;
    Ok(inspect_vault_data(root, &key, &manifest))
}

/// Re-opens `root` purely to run the same health check `verify_vault_backup` does, used by
/// `branch_mutate`'s read pass; kept separate from `Branch` since inspecting never mutates.
pub fn inspect_open_branch(root: &Path, passphrase: &str) -> Result<Value, String> {
    let (root, key, manifest) = open_branch(root, passphrase)?;
    Ok(inspect(&root, &key, &manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    // civil_from_days itself is now tested in date.rs, where it lives.

    #[test]
    fn backup_copy_excludes_writer_lock_files() {
        let temp = std::env::temp_dir().join(format!("driftleaf-backup-unit-{}", crate::random_hex(8)));
        let source = temp.join("source");
        let destination_parent = temp.join("dest");
        fs::create_dir_all(source.join(DRIFTLEAF_DIR)).unwrap();
        fs::create_dir_all(&destination_parent).unwrap();
        fs::write(source.join(DRIFTLEAF_DIR).join("vault.json"), b"{}").unwrap();
        fs::write(source.join(".driftleaf-writer.sqlite"), b"lock").unwrap();
        fs::write(source.join("note.txt"), b"hello").unwrap();

        let backup_path = create_vault_backup(&source, &destination_parent).unwrap();
        assert!(backup_path.join(DRIFTLEAF_DIR).join("vault.json").exists());
        assert!(backup_path.join("note.txt").exists());
        assert!(!backup_path.join(".driftleaf-writer.sqlite").exists());

        // A destination inside the source branch must be refused.
        assert!(create_vault_backup(&source, &source.join(DRIFTLEAF_DIR)).is_err());

        fs::remove_dir_all(&temp).ok();
    }
}
