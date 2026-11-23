//! The application service: session state (one unlocked branch, its search index, and its
//! writer lock) and every command the renderer can issue, ported from src/main/service.ts,
//! src/main/extension-access.ts, and the trusted commands in sidecar/index.mjs.
//!
//! `Service::call` takes the same method names and positional JSON arguments the Node
//! sidecar took, and returns the same JSON, so the desktop shell and the renderer bridge did
//! not have to change when the backend moved from Node to this crate.
//!
//! It is synchronous and takes `&mut self`: the caller holds it behind one mutex, which is
//! what serializes commands. A lock therefore cannot overtake a write that is in progress,
//! and a command issued after a lock sees no session.
use crate::backup::{create_vault_backup, verify_vault_backup};
use crate::create::{create_branch, list_extension_samples};
use crate::locking::BranchLock;
use crate::mutation::Branch;
use crate::reconcile::{branch_has_passphrase, unlock_branch};
use crate::search::SearchIndex;
use crate::settings::SettingsStore;
use crate::{random_hex, random_uuid_v4};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Path, PathBuf}};

const ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;
const NO_BRANCH: &str = "No branch is unlocked";

struct Session {
    branch: Branch,
    index: SearchIndex,
    _lock: BranchLock,
}

pub struct Service {
    settings: SettingsStore,
    session: Option<Session>,
    // Incremented every time a branch is opened. An extension window is only valid for the
    // session it was opened in.
    generation: u64,
    extension_contexts: HashMap<String, (String, u64)>,
    version: String,
}

fn text(args: &[Value], index: usize) -> Result<&str, String> {
    args.get(index).and_then(Value::as_str).ok_or_else(|| "Invalid arguments".to_string())
}

fn optional_text(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(Value::as_str)
}

fn value(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}

fn optional_value(args: &[Value], index: usize) -> Option<Value> {
    args.get(index).filter(|v| !v.is_null()).cloned()
}

fn string_list(args: &[Value], index: usize) -> Result<Vec<String>, String> {
    match args.get(index) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(String::from).ok_or_else(|| "Invalid arguments".to_string()))
            .collect(),
        Some(_) => Err("Invalid arguments".into()),
    }
}

// Turns raw operating-system errors into messages a person can act on, the job
// friendlyError() did in service.ts. Storage code reports them as "<text> (os error N)".
fn friendly(error: String) -> String {
    let Some(code) = error
        .rsplit_once("(os error ")
        .and_then(|(_, rest)| rest.strip_suffix(')'))
        .and_then(|code| code.parse::<i32>().ok())
    else {
        return error;
    };
    let (full, denied, missing): (&[i32], &[i32], &[i32]) = if cfg!(windows) {
        (&[39, 112], &[5], &[2, 3])
    } else {
        (&[28], &[1, 13], &[2])
    };
    if full.contains(&code) {
        "Disk is full. Free up space and try again.".into()
    } else if denied.contains(&code) {
        "Permission denied. Check that Driftleaf can write to this folder.".into()
    } else if missing.contains(&code) {
        "A branch file is missing. The branch folder may have moved.".into()
    } else {
        error
    }
}

fn write_copy(destination: &Path, data: &[u8]) -> Result<(), String> {
    let temporary = PathBuf::from(format!("{}.tmp-{}", destination.display(), random_hex(16)));
    let result = fs::write(&temporary, data).and_then(|()| fs::rename(&temporary, destination));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

fn note_meta<'a>(branch: &'a Branch, id: &str) -> Option<&'a Value> {
    branch.manifest["notes"].as_array()?.iter().find(|note| note["id"] == id)
}

fn read_live_note(branch: &Branch, id: &str) -> Result<String, String> {
    if note_meta(branch, id).is_none() {
        return Err(format!("Note not found: {id}"));
    }
    branch.read_note(id).map_err(|error| {
        // AES-GCM's tag fails on any bit-flip or truncation, so a decrypt failure here means
        // the file itself is damaged; the key was already proven at unlock.
        if error.contains("authentication failed") || error.contains("truncated") || error.contains("UTF-8") {
            format!("Note is corrupted and cannot be decrypted: {id}")
        } else {
            error
        }
    })
}

fn reindex(session: &Session, id: &str) {
    if let Some(meta) = note_meta(&session.branch, id) {
        if let Ok(content) = session.branch.read_note(id) {
            let _ = session.index.reindex_note(
                id,
                meta["title"].as_str().unwrap_or_default(),
                meta["folderPath"].as_str().unwrap_or_default(),
                &content,
            );
        }
    }
}

fn os_release() -> String {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct OsVersionInfoExW {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            _platform_id: u32,
            _service_pack: [u16; 128],
            _service_pack_major: u16,
            _service_pack_minor: u16,
            _suite_mask: u16,
            _product_type: u8,
            _reserved: u8,
        }

        #[link(name = "ntdll")]
        unsafe extern "system" {
            #[link_name = "RtlGetVersion"]
            fn rtl_get_version(info: *mut OsVersionInfoExW) -> i32;
        }

        let mut info = OsVersionInfoExW {
            size: std::mem::size_of::<OsVersionInfoExW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            _platform_id: 0,
            _service_pack: [0; 128],
            _service_pack_major: 0,
            _service_pack_minor: 0,
            _suite_mask: 0,
            _product_type: 0,
            _reserved: 0,
        };
        if unsafe { rtl_get_version(&mut info) } == 0 {
            return format!("{}.{}.{}", info.major, info.minor, info.build);
        }
    }
    if cfg!(target_os = "linux") {
        if let Ok(release) = fs::read_to_string("/proc/sys/kernel/osrelease") {
            return release.trim().to_string();
        }
    }
    if cfg!(unix) {
        if let Ok(output) = std::process::Command::new("uname").arg("-r").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
    }
    "unknown".into()
}

impl Service {
    pub fn new(settings_dir: PathBuf, version: &str) -> Self {
        Self {
            settings: SettingsStore::new(settings_dir),
            session: None,
            generation: 0,
            extension_contexts: HashMap::new(),
            version: version.to_string(),
        }
    }

    fn session(&self) -> Result<&Session, String> {
        self.session.as_ref().ok_or_else(|| NO_BRANCH.to_string())
    }

    fn session_mut(&mut self) -> Result<&mut Session, String> {
        self.session.as_mut().ok_or_else(|| NO_BRANCH.to_string())
    }

    fn branch(&self) -> Result<&Branch, String> {
        Ok(&self.session()?.branch)
    }

    fn branch_mut(&mut self) -> Result<&mut Branch, String> {
        Ok(&mut self.session_mut()?.branch)
    }

    /// Drops the session: the key is zeroized as the branch is dropped, the in-memory index
    /// is closed, the writer lock is released, and every extension window loses its access.
    pub fn lock(&mut self) {
        self.session = None;
        self.extension_contexts.clear();
    }

    pub fn is_unlocked(&self) -> bool {
        self.session.is_some()
    }

    // startSession() in service.ts. The writer lock is taken before anything is read or
    // written, and nothing becomes the current session unless every step succeeded.
    fn start_session(
        &mut self,
        root: &str,
        create: bool,
        load: impl FnOnce(&Path) -> Result<(Branch, Value), String>,
    ) -> Result<Value, String> {
        if self.session.is_some() {
            return Err("Lock the current branch before opening another one".into());
        }
        if create {
            fs::create_dir_all(root).map_err(|e| e.to_string())?;
        }
        let lock = BranchLock::acquire(Path::new(root))?;
        let (branch, result) = load(&lock.root)?;
        self.settings.patch(&json!({ "lastVaultPath": lock.root.to_string_lossy() }))?;
        let index = SearchIndex::open()?;
        index.build_from_branch(&branch)?;
        self.extension_contexts.clear();
        self.session = Some(Session { branch, index, _lock: lock });
        self.generation += 1;
        Ok(result)
    }

    /// Installs an extension from source the shell has already read and size-checked.
    pub fn install_extension(&mut self, name: &str, source: &str) -> Result<Value, String> {
        self.branch_mut()?.install_extension(name, source)
    }

    /// Imports a community template archive the shell has already downloaded.
    pub fn import_template(&mut self, archive: &[u8], name: &str) -> Result<Value, String> {
        let session = self.session_mut()?;
        let result = session.branch.import_template_archive(archive, name)?;
        let imported = result["imported"].as_array().cloned().unwrap_or_default();
        for meta in &imported {
            reindex(session, meta["id"].as_str().unwrap_or_default());
        }
        Ok(json!({
            "imported": imported.len(),
            "importedDatabases": result["importedDatabases"].as_array().map_or(0, Vec::len),
            "skipped": result["skipped"],
        }))
    }

    /// Runs one command. `method` is one of the renderer-facing names in
    /// sidecar/public-methods.json or one of the shell-only "trusted" names; deciding which
    /// of those a given caller may use is the shell's job, not this function's.
    pub fn call(&mut self, method: &str, args: &[Value]) -> Result<Value, String> {
        self.dispatch(method, args).map_err(friendly)
    }

    fn dispatch(&mut self, method: &str, args: &[Value]) -> Result<Value, String> {
        match method {
            // ---- session ----
            "vault.create" => {
                let (passphrase, template) = (text(args, 1)?.to_string(), text(args, 2)?.to_string());
                self.start_session(text(args, 0)?, true, |root| {
                    Ok((create_branch(root, &passphrase, &template)?, Value::Null))
                })
            }
            "vault.unlock" => {
                let passphrase = text(args, 1)?.to_string();
                self.start_session(text(args, 0)?, false, |root| unlock_branch(root, &passphrase))
            }
            "vault.hasPassphrase" => Ok(json!(branch_has_passphrase(Path::new(text(args, 0)?))?)),
            "vault.lock" => {
                self.lock();
                Ok(Value::Null)
            }
            "lifecycle.trustedDrain" => Ok(Value::Null),
            "vault.changePassphrase" => {
                let (current, next) = (text(args, 0)?.to_string(), text(args, 1)?.to_string());
                self.branch_mut()?.change_passphrase(&current, &next)?;
                Ok(Value::Null)
            }
            "vault.healthCheck" => {
                let session = self.session()?;
                let mut report = session.branch.inspect();
                let indexed = session.index.count()?;
                let notes = session.branch.manifest["notes"].as_array().map_or(0, Vec::len) as u64;
                if let Some(checks) = report["checks"].as_array_mut() {
                    checks.push(json!({
                        "name": "Search index",
                        "status": if indexed == notes { "ok" } else { "warning" },
                        "details": if indexed == notes {
                            format!("{indexed} note(s) are indexed for search.")
                        } else {
                            format!("Search contains {indexed} of {notes} indexed note(s).")
                        },
                    }));
                }
                Ok(report)
            }
            "vault.trustedCreateBackup" => {
                let root = self.branch()?.root.clone();
                let path = create_vault_backup(&root, Path::new(text(args, 0)?))?;
                Ok(json!(path.to_string_lossy()))
            }
            "vault.trustedVerifyBackup" => verify_vault_backup(Path::new(text(args, 0)?), text(args, 1)?),
            "vault.trustedExportPlaintext" => self.branch()?.export_plaintext(Path::new(text(args, 0)?)),

            // ---- notes ----
            "notes.list" => {
                let notes = self.branch()?.manifest["notes"].as_array().cloned().unwrap_or_default();
                Ok(Value::Array(match optional_text(args, 0) {
                    None => notes,
                    Some(folder) => notes.into_iter().filter(|note| note["folderPath"] == folder).collect(),
                }))
            }
            "notes.listFolders" => Ok(json!(self.branch()?.list_folders())),
            "notes.read" => Ok(json!(read_live_note(self.branch()?, text(args, 0)?)?)),
            "notes.write" => {
                let (id, content) = (text(args, 0)?, text(args, 1)?);
                let session = self.session_mut()?;
                session.branch.write_note(id, content)?;
                if let Some(meta) = note_meta(&session.branch, id) {
                    session.index.reindex_note(
                        id,
                        meta["title"].as_str().unwrap_or_default(),
                        meta["folderPath"].as_str().unwrap_or_default(),
                        content,
                    )?;
                }
                Ok(Value::Null)
            }
            "notes.create" => {
                let (folder, title) = (text(args, 0)?, text(args, 1)?);
                let session = self.session_mut()?;
                let meta = session.branch.create_note(folder, title)?;
                session.index.reindex_note(meta["id"].as_str().unwrap_or_default(), title, folder, "")?;
                Ok(meta)
            }
            "notes.rename" => {
                let (id, title) = (text(args, 0)?, text(args, 1)?);
                let session = self.session_mut()?;
                session.branch.rename_note(id, title)?;
                reindex(session, id);
                Ok(Value::Null)
            }
            "notes.remove" => {
                let id = text(args, 0)?;
                let session = self.session_mut()?;
                session.branch.delete_note(id)?;
                session.index.remove_from_index(id)?;
                Ok(Value::Null)
            }
            "notes.move" => {
                let (id, target) = (text(args, 0)?, text(args, 1)?);
                let session = self.session_mut()?;
                let meta = session.branch.move_note(id, target)?;
                reindex(session, id);
                Ok(meta)
            }
            "notes.trustedImport" => {
                let paths = string_list(args, 0)?;
                let target = text(args, 1)?;
                let session = self.session_mut()?;
                let result = session.branch.import_files(&paths, target);
                for meta in &result.imported {
                    reindex(session, meta["id"].as_str().unwrap_or_default());
                }
                Ok(json!({
                    "imported": result.imported.len(),
                    "importedDatabases": result.imported_databases.len(),
                    "skipped": result.skipped,
                }))
            }
            "notes.graph" => self.session()?.index.build_note_graph(),

            // ---- databases ----
            "databases.list" => Ok(self.branch()?.list_databases(optional_text(args, 0))),
            "databases.read" => self.branch()?.read_database(text(args, 0)?),
            "databases.create" => {
                let properties = json!([{ "id": random_uuid_v4(), "name": "Title", "type": "title" }]);
                self.branch_mut()?.create_database(text(args, 0)?, text(args, 1)?, properties, json!([]), None, None)
            }
            "databases.rename" => self.branch_mut()?.rename_database(text(args, 0)?, text(args, 1)?),
            "databases.update" => {
                self.branch_mut()?.update_database(
                    text(args, 0)?,
                    value(args, 1),
                    value(args, 2),
                    optional_value(args, 3),
                    optional_text(args, 4),
                )?;
                Ok(Value::Null)
            }
            "databases.createRow" => self.branch_mut()?.create_database_row(text(args, 0)?),
            "databases.deleteRow" => {
                self.branch_mut()?.delete_database_row(text(args, 0)?, text(args, 1)?)?;
                Ok(Value::Null)
            }
            "databases.delete" => {
                self.branch_mut()?.delete_database(text(args, 0)?)?;
                Ok(Value::Null)
            }
            "databases.trustedExportContent" => {
                let format = text(args, 1)?;
                if format != "csv" && format != "json" {
                    return Err("Unsupported database export format".into());
                }
                let (title, content) = self.branch()?.export_database(text(args, 0)?, format)?;
                Ok(json!({ "title": title, "content": content }))
            }

            // ---- folders ----
            "folders.create" => {
                self.branch_mut()?.create_folder(text(args, 0)?)?;
                Ok(Value::Null)
            }
            "folders.rename" => {
                let (old, new) = (text(args, 0)?, text(args, 1)?);
                let session = self.session_mut()?;
                session.branch.rename_folder(old, new)?;
                session.index.build_from_branch(&session.branch)?;
                Ok(Value::Null)
            }
            "folders.delete" => {
                let folder = text(args, 0)?;
                let session = self.session_mut()?;
                let deleted = session.branch.delete_folder(folder)?;
                for id in &deleted {
                    session.index.remove_from_index(id)?;
                }
                Ok(json!(deleted))
            }

            // ---- search ----
            "search.query" => match &self.session {
                Some(session) => session.index.search(text(args, 0)?),
                None => Ok(json!([])),
            },

            // ---- trash ----
            "trash.list" => Ok(self.branch()?.list_trash()),
            "trash.restore" | "trash.purge" => {
                let (kind, id) = (text(args, 0)?, text(args, 1)?);
                if kind != "note" && kind != "database" {
                    return Err("Unknown Trash item type".into());
                }
                let session = self.session_mut()?;
                if method == "trash.purge" {
                    session.branch.purge_trash_item(kind, id)?;
                    return Ok(Value::Null);
                }
                let restored = session.branch.restore_trash_item(kind, id)?;
                for item in restored.iter().filter(|item| item["kind"] == "note") {
                    // The restore is already written. A note that cannot be read back is
                    // still restored (and reported by the health check), just not indexed.
                    reindex(session, item["meta"]["id"].as_str().unwrap_or_default());
                }
                Ok(Value::Null)
            }
            "trash.empty" => Ok(json!(self.branch_mut()?.empty_trash()?)),

            // ---- attachments ----
            "attachments.add" => {
                let (name, mime, data) = (text(args, 0)?, text(args, 1)?, args.get(2).and_then(Value::as_str));
                let branch = self.branch_mut()?;
                let data = data.ok_or("Invalid attachment data")?;
                // Reject oversized input before decoding it into a second, larger buffer.
                if data.len() > ATTACHMENT_MAX_BYTES.div_ceil(3) * 4 + 4 {
                    return Err(format!("Attachments can be at most {} MB", ATTACHMENT_MAX_BYTES / (1024 * 1024)));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| "Invalid attachment data".to_string())?;
                branch.add_attachment(name, mime, &bytes)
            }
            "attachments.read" => {
                let (meta, data) = self.branch()?.read_attachment(text(args, 0)?)?;
                Ok(json!({ "meta": meta, "dataBase64": base64::engine::general_purpose::STANDARD.encode(data) }))
            }
            "attachments.list" => Ok(self.branch()?.list_attachments()),
            "attachments.listUsage" => Ok(self.branch()?.attachment_usage()),
            "attachments.remove" => {
                self.branch_mut()?.remove_attachment(text(args, 0)?)?;
                Ok(Value::Null)
            }
            "attachments.unused" => {
                let unused = self.branch()?.find_unused_attachments(crate::mutation::now_ms())?;
                let bytes: f64 = unused.iter().filter_map(|item| item["size"].as_f64()).sum();
                Ok(json!({ "count": unused.len(), "bytes": bytes as u64 }))
            }
            "attachments.removeUnused" => {
                let removed = self.branch_mut()?.remove_unused_attachments(crate::mutation::now_ms())?;
                Ok(json!({ "count": removed["removed"], "bytes": removed["bytes"] }))
            }
            "attachments.trustedSaveCopy" => {
                let destination = Path::new(text(args, 1)?);
                if !destination.is_absolute() {
                    return Err("Invalid save destination".into());
                }
                let (_, data) = self.branch()?.read_attachment(text(args, 0)?)?;
                write_copy(destination, &data)?;
                Ok(json!(true))
            }

            // ---- extensions ----
            "extensions.list" => Ok(self.branch()?.list_extensions()),
            "extensions.samples" => Ok(list_extension_samples()),
            "extensions.installSample" => self.branch_mut()?.install_extension_sample(text(args, 0)?),
            "extensions.trustedInstall" => self.install_extension(text(args, 0)?, text(args, 1)?),
            "extensions.setPermissions" => {
                let (permissions, database_ids) = (string_list(args, 1)?, string_list(args, 2)?);
                self.branch_mut()?.set_extension_permissions(text(args, 0)?, &permissions, &database_ids)?;
                Ok(Value::Null)
            }
            "extensions.remove" => {
                self.branch_mut()?.remove_extension(text(args, 0)?)?;
                Ok(Value::Null)
            }
            "extensions.trustedOpen" => {
                let (id, label) = (text(args, 0)?, text(args, 1)?);
                let valid_label = label
                    .strip_prefix("extension-")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
                if !valid_label || self.extension_contexts.contains_key(label) {
                    return Err("Invalid extension window".into());
                }
                let extension = self.branch()?.get_extension(id).ok_or("Extension not found")?;
                let opened = json!({ "name": extension["name"], "source": extension["source"] });
                self.extension_contexts.insert(label.to_string(), (id.to_string(), self.generation));
                Ok(opened)
            }
            "extensions.trustedClose" => {
                self.extension_contexts.remove(text(args, 0)?);
                Ok(Value::Null)
            }
            "extensions.trustedCall" => {
                let call_args = args.get(2).and_then(Value::as_array).ok_or("Unknown extension command")?;
                self.extension_call(text(args, 0)?, text(args, 1)?, call_args)
            }

            // ---- canvas, settings, diagnostics ----
            "canvas.read" => Ok(self.branch()?.read_canvas()),
            "canvas.update" => {
                self.branch_mut()?.update_canvas(value(args, 0))?;
                Ok(Value::Null)
            }
            // Updates belong to the desktop shell (src-tauri/src/updates.rs). This is what the
            // service reports when it is driven without one.
            "updates.status" => Ok(json!({
                "state": "unsupported",
                "currentVersion": self.version,
                "availableVersion": null,
                "downloadUrl": null,
                "checkedAt": null,
                "message": "Updates are handled by the desktop app.",
                "automaticInstall": false,
            })),
            "settings.read" => Ok(self.settings.read()),
            "settings.patch" => self.settings.patch(&value(args, 0)),
            "diagnostics.read" => Ok(json!({
                "version": self.version,
                // The names Node reported, which the diagnostics screen and bug reports use.
                "platform": match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", other => other },
                "osRelease": os_release(),
                "architecture": match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", other => other },
                "runtime": "Rust core (native)",
                "displayServer": display_server(),
                "desktopEnvironment": std::env::var("XDG_CURRENT_DESKTOP")
                    .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
                    .unwrap_or_else(|_| "Not detected".into()),
            })),
            _ => Err("Unknown command".into()),
        }
    }

    // createExtensionAccess() in src/main/extension-access.ts. Grants are re-read on every
    // call, so a revocation, removal, or lock takes effect before the next request runs.
    fn extension_call(&mut self, label: &str, method: &str, args: &[Value]) -> Result<Value, String> {
        let permission = match method {
            "listNotes" | "readNote" => "read_notes",
            "graph" => "read_graph",
            "listDatabases" | "readDatabase" => "read_databases",
            _ => return Err("Unknown extension command".into()),
        };
        let inactive = || "This window is not an active Driftleaf extension".to_string();
        let (extension_id, generation) = self.extension_contexts.get(label).cloned().ok_or_else(inactive)?;
        let session = self.session.as_ref().ok_or_else(inactive)?;
        if generation != self.generation {
            return Err(inactive());
        }
        let extension = session.branch.get_extension(&extension_id).ok_or("This extension was removed")?;
        let granted = |list: &str, wanted: &str| {
            extension[list].as_array().is_some_and(|items| items.iter().any(|item| item == wanted))
        };
        if !granted("permissions", permission) {
            return Err(format!("This extension has not been granted {} access", permission.replacen('_', " ", 1)));
        }
        let branch = &session.branch;
        match method {
            "listNotes" => Ok(Value::Array(
                branch.manifest["notes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|note| json!({
                        "id": note["id"], "title": note["title"],
                        "folderPath": note["folderPath"], "updatedAt": note["updatedAt"],
                    }))
                    .collect(),
            )),
            "readNote" => Ok(json!(read_live_note(branch, text(args, 0)?)?)),
            "graph" => session.index.build_note_graph(),
            "listDatabases" => Ok(Value::Array(
                branch
                    .list_databases(None)
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|database| database["id"].as_str().is_some_and(|id| granted("databaseIds", id)))
                    .cloned()
                    .collect(),
            )),
            _ => {
                let id = text(args, 0)?;
                if !granted("databaseIds", id) {
                    return Err("This extension has not been granted access to that database".into());
                }
                let mut data = branch.read_database(id)?;
                let properties = data["properties"].as_array().cloned().unwrap_or_default();
                // A relation into a database the extension may not read is hidden, and so is
                // any rollup computed through one.
                let relation_safe: Vec<&str> = properties
                    .iter()
                    .filter(|property| {
                        property["type"] != "relation"
                            || property["relationDatabaseId"].as_str().is_none_or(|target| target.is_empty() || granted("databaseIds", target))
                    })
                    .filter_map(|property| property["id"].as_str())
                    .collect();
                let permitted: Vec<String> = properties
                    .iter()
                    .filter(|property| {
                        let id = property["id"].as_str().unwrap_or_default();
                        if property["type"] == "rollup" {
                            if let Some(via) = property["rollupRelationPropertyId"].as_str().filter(|via| !via.is_empty()) {
                                if !relation_safe.contains(&via) {
                                    return false;
                                }
                            }
                        }
                        relation_safe.contains(&id)
                    })
                    .filter_map(|property| property["id"].as_str().map(String::from))
                    .collect();
                if let Some(items) = data["properties"].as_array_mut() {
                    items.retain(|property| property["id"].as_str().is_some_and(|id| permitted.iter().any(|p| p == id)));
                }
                for row in data["rows"].as_array_mut().into_iter().flatten() {
                    if let Some(values) = row["values"].as_object_mut() {
                        values.retain(|property_id, _| permitted.iter().any(|p| p == property_id));
                    }
                }
                Ok(data)
            }
        }
    }
}

fn display_server() -> &'static str {
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    if session_type == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "Wayland"
    } else if session_type == "x11" || std::env::var_os("DISPLAY").is_some() {
        "X11"
    } else {
        "Not detected"
    }
}
