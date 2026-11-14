//! The unlock pass, ported from unlockVault()/reconcileVault() in src/main/vault.ts: open the
//! branch, cross-check the manifest against the encrypted files actually on disk, repair what
//! a crash between a file write and its manifest write can leave behind, migrate notes from
//! the legacy named-file layout to opaque IDs, and sweep expired Trash.
use crate::mutation::{now_ms, validate_folder_path, Branch};
use crate::{random_uuid_v4, valid_id, DRIFTLEAF_DIR};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

struct DiskFile {
    key: String,
    folder_path: String,
    file_name: String,
    private: bool,
}

// Every `*.enc` file under the branch root, skipping the private directory at every depth.
// An unreadable directory is skipped, as in scanEncFiles().
fn scan_enc_files(root: &Path, dir: &Path, found: &mut Vec<DiskFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if name != DRIFTLEAF_DIR {
                scan_enc_files(root, &entry.path(), found);
            }
        } else if kind.is_file() && name.ends_with(".enc") {
            let folder_path = dir
                .strip_prefix(root)
                .unwrap_or(Path::new(""))
                .to_string_lossy()
                .replace('\\', "/");
            found.push(DiskFile {
                key: format!("{folder_path}/{name}"),
                folder_path,
                file_name: name,
                private: false,
            });
        }
    }
}

// Removes now-empty folders left behind by the legacy layout, walking upward. Stops at the
// first folder that is not empty. Only ever removes empty directories inside the branch.
fn prune_empty_legacy_folders(root: &Path, folder_path: &str) {
    if validate_folder_path(folder_path).is_err() {
        return;
    }
    let mut parts: Vec<&str> = folder_path.split('/').filter(|p| !p.is_empty()).collect();
    while !parts.is_empty() {
        let folder = parts.iter().fold(root.to_path_buf(), |path, part| path.join(part));
        match fs::remove_dir(&folder) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => break,
        }
        parts.pop();
    }
}

fn legacy_note_path(root: &Path, folder_path: &str, file_name: &str) -> Result<PathBuf, String> {
    validate_folder_path(folder_path)?;
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name == "."
        || file_name == ".."
    {
        return Err("Invalid legacy note filename".into());
    }
    let mut path = root.to_path_buf();
    for part in folder_path.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    Ok(path.join(file_name))
}

fn title_from_file_name(file_name: &str) -> String {
    let without_enc = file_name.strip_suffix(".enc").unwrap_or(file_name);
    let without_md = without_enc.strip_suffix(".md").unwrap_or(without_enc);
    if without_md.is_empty() { "Recovered note".into() } else { without_md.into() }
}

fn is_private_note_file(file_name: &str) -> bool {
    file_name.strip_suffix(".enc").is_some_and(valid_id)
}

impl Branch {
    /// reconcileVault(). Returns `{ renamedLegacy, removedDangling, recoveredOrphans }`.
    pub fn reconcile(&mut self) -> Result<Value, String> {
        let root = self.root.clone();
        let mut on_disk: Vec<DiskFile> = Vec::new();
        scan_enc_files(&root, &root, &mut on_disk);
        let private_notes = root.join(DRIFTLEAF_DIR).join("notes");
        fs::create_dir_all(&private_notes).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&private_notes).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().is_ok_and(|kind| kind.is_file()) && name.ends_with(".enc") {
                on_disk.push(DiskFile {
                    key: format!("@private/{name}"),
                    folder_path: String::new(),
                    file_name: name,
                    private: true,
                });
            }
        }
        let mut present: HashSet<String> = on_disk.iter().map(|file| file.key.clone()).collect();

        let mut renamed_legacy: Vec<Value> = Vec::new();
        let mut removed_dangling: Vec<Value> = Vec::new();
        let mut recovered_orphans: Vec<Value> = Vec::new();
        let mut claimed: HashSet<String> = HashSet::new();
        let mut survivors: Vec<Value> = Vec::new();

        let notes = self.manifest["notes"].as_array().cloned().unwrap_or_default();
        for mut meta in notes {
            let id = meta["id"].as_str().unwrap_or_default().to_string();
            let folder_path = meta["folderPath"].as_str().unwrap_or_default().to_string();
            let private_name = format!("{id}.enc");
            let private_key = format!("@private/{private_name}");
            let old_name = meta["fileName"].as_str().map(String::from).unwrap_or_else(|| private_name.clone());
            let legacy_key = format!("{folder_path}/{old_name}");
            let private_path = self.note_path(&id)?;
            if !present.contains(&private_key) && present.contains(&legacy_key) {
                fs::rename(legacy_note_path(&root, &folder_path, &old_name)?, &private_path)
                    .map_err(|e| e.to_string())?;
                present.remove(&legacy_key);
                present.insert(private_key.clone());
                prune_empty_legacy_folders(&root, &folder_path);
                renamed_legacy.push(json!(id));
            }
            if !present.contains(&private_key) {
                removed_dangling.push(json!(id));
                continue;
            }
            claimed.insert(private_key);
            meta["fileName"] = json!(private_name);
            survivors.push(meta);
        }

        for folder in self.manifest["folders"].as_array().cloned().unwrap_or_default() {
            if let Some(folder) = folder.as_str() {
                prune_empty_legacy_folders(&root, folder);
            }
        }

        // Trashed notes still own their encrypted file: claim those files so the orphan pass
        // below does not "recover" them, and drop any Trash entry whose file is gone. A
        // release from before Trash existed will have recovered each trashed file as a live
        // "Recovered note" with the same ID; then the live note wins and takes its real
        // title and folder back from the Trash entry.
        let live_database_ids: HashSet<String> = self
            .databases()
            .iter()
            .filter_map(|database| database["id"].as_str().map(String::from))
            .collect();
        let trash = self.trash().to_vec();
        let mut kept_trash: Vec<Value> = Vec::new();
        for entry in &trash {
            let id = entry["meta"]["id"].as_str().unwrap_or_default();
            if entry["kind"] == "note" {
                let private_key = format!("@private/{id}.enc");
                if let Some(live) = survivors.iter_mut().find(|note| note["id"] == id) {
                    if live["title"] == "Recovered note" {
                        live["title"] = entry["meta"]["title"].clone();
                        live["folderPath"] = entry["meta"]["folderPath"].clone();
                    }
                    continue;
                }
                if !present.contains(&private_key) {
                    continue;
                }
                claimed.insert(private_key);
            } else {
                if live_database_ids.contains(id) {
                    continue;
                }
                match self.database_path(id) {
                    Ok(path) if path.exists() => {}
                    _ => continue,
                }
            }
            kept_trash.push(entry.clone());
        }
        self.manifest["trash"] = Value::Array(kept_trash);

        for file in &on_disk {
            if claimed.contains(&file.key) || !present.contains(&file.key) {
                continue;
            }
            let id = if file.private && is_private_note_file(&file.file_name) {
                file.file_name.trim_end_matches(".enc").to_string()
            } else {
                random_uuid_v4()
            };
            if !(file.private && is_private_note_file(&file.file_name)) {
                // The file is not where a note with this ID is read from. Move it there, or
                // the recovered note would be listed but unreadable and "recovered" again on
                // every unlock.
                let from = if file.private {
                    private_notes.join(&file.file_name)
                } else {
                    match legacy_note_path(&root, &file.folder_path, &file.file_name) {
                        Ok(path) => path,
                        Err(_) => continue,
                    }
                };
                if fs::rename(&from, self.note_path(&id)?).is_err() {
                    continue;
                }
                prune_empty_legacy_folders(&root, &file.folder_path);
            }
            survivors.push(json!({
                "id": id,
                "title": if file.private { "Recovered note".to_string() } else { title_from_file_name(&file.file_name) },
                "folderPath": if file.private { "" } else { file.folder_path.as_str() },
                "fileName": format!("{id}.enc"),
                "updatedAt": now_ms(),
            }));
            recovered_orphans.push(json!(id));
        }

        let valid_note_ids: HashSet<String> =
            survivors.iter().filter_map(|note| note["id"].as_str().map(String::from)).collect();
        self.manifest["notes"] = Value::Array(survivors);
        if let Some(items) = self.manifest["canvasItems"].as_array_mut() {
            items.retain(|item| {
                let target = item["targetId"].as_str().unwrap_or_default();
                if item["kind"] == "note" { valid_note_ids.contains(target) } else { live_database_ids.contains(target) }
            });
        }
        self.write_manifest()?;
        Ok(json!({
            "renamedLegacy": renamed_legacy,
            "removedDangling": removed_dangling,
            "recoveredOrphans": recovered_orphans,
        }))
    }
}

/// unlockVault(): opens the branch, reconciles it, removes the legacy plaintext manifest
/// once the encrypted one is written, and sweeps expired Trash. Returns the open branch and
/// the reconcile report.
pub fn unlock_branch(root: &Path, passphrase: &str) -> Result<(Branch, Value), String> {
    let mut branch = Branch::open(root, passphrase)?;
    let report = branch.reconcile()?;
    let _ = fs::remove_file(branch.root.join(DRIFTLEAF_DIR).join("manifest.json"));
    // Best effort: a failed sweep must never stop a branch from opening.
    let _ = branch.purge_expired_trash(now_ms());
    Ok((branch, report))
}

/// vaultHasPassphrase().
pub fn branch_has_passphrase(root: &Path) -> Result<bool, String> {
    let config = crate::vault_config::read_vault_config(root, crate::vault_config::Subject::Branch)?;
    Ok(!matches!(config, crate::vault_config::VaultConfig::NoneV1 { .. }))
}
