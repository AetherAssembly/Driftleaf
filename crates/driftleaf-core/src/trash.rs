//! Trash, ported from the TrashEntry family in src/main/vault.ts (listTrash,
//! restoreTrashItem, purgeTrashItem, emptyTrash, purgeExpiredTrash, trashedDatabaseLinks,
//! assertNotLinkedFromTrash).
//!
//! A deleted note or database keeps its encrypted file exactly where it was; only its
//! manifest entry moves from `notes`/`databases` into `trash` as
//! `{ kind: "note" | "database", meta, deletedAt }` (see delete_note/delete_database/
//! delete_folder in mutation.rs). That makes "delete" a single atomic manifest write with
//! nothing to roll back on disk, and "restore" the same write in reverse. Files are only
//! removed when an entry is purged, and then manifest first, files second, so a crash in
//! between leaves stray ciphertext and never an entry pointing at nothing.
//!
//! Not ported: the Trash handling inside reconcileVault() (claiming trashed notes' files,
//! dropping entries whose file is gone, resolving a note an older client recovered) and the
//! automatic purgeExpiredTrash() call in unlockVault(). This crate has no reconcile or
//! unlock pass at all (see mutation.rs); `purge_expired_trash` is here for a caller to run.
use crate::{decrypt, mutation::validate_folder_path, mutation::Branch};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::PathBuf};

pub const TRASH_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// One trashed database and the databases its relation properties point at, in the order
/// the properties list them (the reference implementation's Set keeps insertion order, and
/// restore order follows from it).
pub(crate) struct TrashedDatabaseLinks {
    pub id: String,
    pub title: String,
    pub targets: Vec<String>,
}

fn entry_id(entry: &Value) -> &str {
    entry["meta"]["id"].as_str().unwrap_or("")
}

fn deleted_at(entry: &Value) -> f64 {
    entry["deletedAt"].as_f64().unwrap_or(0.0)
}

fn expires_at(entry: &Value) -> Value {
    // Stays an integer whenever deletedAt is one, so it serializes the way JS prints it.
    match entry["deletedAt"].as_u64() {
        Some(at) => json!(at + TRASH_RETENTION_MS),
        None => json!(deleted_at(entry) + TRASH_RETENTION_MS as f64),
    }
}

impl Branch {
    pub(crate) fn trash(&self) -> &[Value] {
        self.manifest["trash"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    pub(crate) fn trash_mut(&mut self) -> &mut Vec<Value> {
        // open_branch() already defaults this to an array; the check stays as a safeguard.
        if !self.manifest["trash"].is_array() {
            self.manifest["trash"] = json!([]);
        }
        self.manifest["trash"].as_array_mut().unwrap()
    }

    fn trash_entry_path(&self, entry: &Value) -> Result<PathBuf, String> {
        if entry["kind"] == "note" {
            self.note_path(entry_id(entry))
        } else {
            self.database_path(entry_id(entry))
        }
    }

    /// Mirrors trashedDatabaseLinks(): which databases each trashed database links to
    /// through its relation properties. A trashed database cannot go through
    /// read_database() (that only serves live ones), so its file is read directly. An
    /// unreadable file reports no links: it cannot be restored anyway.
    pub(crate) fn trashed_database_links(&self) -> Vec<TrashedDatabaseLinks> {
        let mut links = Vec::new();
        for entry in self.trash() {
            if entry["kind"] != "database" {
                continue;
            }
            let mut targets: Vec<String> = Vec::new();
            let parsed = self
                .database_path(entry_id(entry))
                .ok()
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| decrypt(&bytes, &self.key).ok())
                .and_then(|plaintext| serde_json::from_slice::<Value>(&plaintext).ok());
            if let Some(properties) = parsed.as_ref().and_then(|data| data["properties"].as_array()) {
                for property in properties {
                    if let Some(target) = property["relationDatabaseId"].as_str() {
                        if !targets.iter().any(|known| known == target) {
                            targets.push(target.to_string());
                        }
                    }
                }
            }
            links.push(TrashedDatabaseLinks {
                id: entry_id(entry).to_string(),
                title: entry["meta"]["title"].as_str().unwrap_or("").to_string(),
                targets,
            });
        }
        links
    }

    /// Mirrors assertNotLinkedFromTrash(): relations must never dangle, including across
    /// Trash. A database that something in Trash still links to cannot be deleted or
    /// purged on its own, or restoring the linking database later would bring back a
    /// relation to nothing.
    pub(crate) fn assert_not_linked_from_trash(
        &self,
        ids: &[String],
        ignore: &[String],
    ) -> Result<(), String> {
        for trashed in self.trashed_database_links() {
            if ids.contains(&trashed.id) || ignore.contains(&trashed.id) {
                continue;
            }
            if trashed.targets.iter().any(|target| ids.contains(target)) {
                return Err(format!(
                    "A database in Trash, \"{}\", links to this. Restore it or delete it permanently first",
                    trashed.title
                ));
            }
        }
        Ok(())
    }

    /// Mirrors listTrash(): `{ kind, id, title, folderPath, deletedAt, expiresAt }`, most
    /// recently deleted first (a stable sort, so equal timestamps keep manifest order).
    pub fn list_trash(&self) -> Value {
        let mut items: Vec<Value> = self
            .trash()
            .iter()
            .map(|entry| {
                json!({
                    "kind": entry["kind"],
                    "id": entry["meta"]["id"],
                    "title": entry["meta"]["title"],
                    "folderPath": entry["meta"]["folderPath"],
                    "deletedAt": entry["deletedAt"],
                    "expiresAt": expires_at(entry),
                })
            })
            .collect();
        items.sort_by(|a, b| {
            deleted_at(b).partial_cmp(&deleted_at(a)).unwrap_or(std::cmp::Ordering::Equal)
        });
        Value::Array(items)
    }

    /// Mirrors restoreTrashItem(): puts a trashed note or database back where it was. The
    /// folder it came from may have been deleted since, so every folder on its path is
    /// registered again in the same manifest write. Databases deleted together (a folder
    /// delete) can link to each other, so restoring one also restores every trashed
    /// database it links to, directly or indirectly, in that same write. Returns everything
    /// that was restored as `{ kind, meta }`, the requested item first.
    pub fn restore_trash_item(&mut self, kind: &str, id: &str) -> Result<Vec<Value>, String> {
        let trash = self.trash().to_vec();
        let find_entry = |wanted_kind: &str, wanted_id: &str| {
            trash
                .iter()
                .position(|entry| entry["kind"] == wanted_kind && entry["meta"]["id"] == wanted_id)
        };
        let requested = find_entry(kind, id).ok_or("That item is no longer in Trash")?;

        // Indices into `trash`, in restore order.
        let mut restoring = vec![requested];
        if trash[requested]["kind"] == "database" {
            let links = self.trashed_database_links();
            let live_ids: HashSet<&str> =
                self.databases().iter().filter_map(|d| d["id"].as_str()).collect();
            let mut queue = vec![id.to_string()];
            let mut seen: HashSet<String> = queue.iter().cloned().collect();
            while let Some(current_id) = queue.pop() {
                let Some(link) = links.iter().find(|link| link.id == current_id) else {
                    continue;
                };
                for target in &link.targets {
                    if live_ids.contains(target.as_str()) || seen.contains(target) {
                        continue;
                    }
                    let linked = find_entry("database", target).ok_or(
                        "This database links to another database that no longer exists, so it cannot be restored",
                    )?;
                    seen.insert(target.clone());
                    queue.push(target.clone());
                    restoring.push(linked);
                }
            }
        }

        for &index in &restoring {
            let entry = &trash[index];
            validate_folder_path(entry["meta"]["folderPath"].as_str().unwrap_or(""))?;
            let present = self
                .trash_entry_path(entry)
                .ok()
                .is_some_and(|path| fs::metadata(path).is_ok());
            if !present {
                return Err(format!(
                    "The encrypted file for \"{}\" is missing, so it cannot be restored",
                    entry["meta"]["title"].as_str().unwrap_or("")
                ));
            }
        }

        let previous_manifest = self.manifest.clone();
        {
            let folders = self.manifest["folders"]
                .as_array_mut()
                .ok_or("Invalid branch manifest")?;
            for &index in &restoring {
                let folder_path = trash[index]["meta"]["folderPath"].as_str().unwrap_or("");
                let mut current = String::new();
                for part in folder_path.split('/').filter(|part| !part.is_empty()) {
                    current = if current.is_empty() {
                        part.to_string()
                    } else {
                        format!("{current}/{part}")
                    };
                    if !folders.iter().any(|folder| folder == current.as_str()) {
                        folders.push(json!(current));
                    }
                }
            }
        }
        let restoring_set: HashSet<usize> = restoring.iter().copied().collect();
        self.manifest["trash"] = Value::Array(
            trash
                .iter()
                .enumerate()
                .filter(|(index, _)| !restoring_set.contains(index))
                .map(|(_, entry)| entry.clone())
                .collect(),
        );
        for &index in &restoring {
            let entry = &trash[index];
            if entry["kind"] == "note" {
                self.manifest["notes"]
                    .as_array_mut()
                    .ok_or("Invalid branch manifest")?
                    .push(entry["meta"].clone());
            }
        }
        for &index in &restoring {
            let entry = &trash[index];
            if entry["kind"] == "database" {
                self.databases_mut().push(entry["meta"].clone());
            }
        }
        if let Err(err) = self.write_manifest() {
            self.manifest = previous_manifest;
            return Err(err);
        }
        Ok(restoring
            .iter()
            .map(|&index| json!({ "kind": trash[index]["kind"], "meta": trash[index]["meta"] }))
            .collect())
    }

    /// Mirrors purgeTrashEntries(): permanently removes every Trash entry `should_purge`
    /// selects. Same ordering as every other destructive step: the manifest forgets the
    /// entries first, then the encrypted files are removed.
    fn purge_trash_entries(
        &mut self,
        should_purge: impl Fn(&Value) -> bool,
    ) -> Result<usize, String> {
        let previous = self.trash().to_vec();
        let (purged, kept): (Vec<Value>, Vec<Value>) =
            previous.iter().cloned().partition(|entry| should_purge(entry));
        if purged.is_empty() {
            return Ok(0);
        }
        self.manifest["trash"] = Value::Array(kept);
        if let Err(err) = self.write_manifest() {
            self.manifest["trash"] = Value::Array(previous);
            return Err(err);
        }
        // rm(path, { force: true }) for every purged entry: a file that is already gone is
        // fine, every removal is attempted, and the first real failure is what is reported.
        let mut first_error = None;
        for entry in &purged {
            let removed = self.trash_entry_path(entry).and_then(|path| match fs::remove_file(path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.to_string()),
                _ => Ok(()),
            });
            if let Err(err) = removed {
                first_error.get_or_insert(err);
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(purged.len()),
        }
    }

    /// Mirrors purgeTrashItem(): permanently deletes one Trash entry and its file.
    pub fn purge_trash_item(&mut self, kind: &str, id: &str) -> Result<(), String> {
        if kind == "database" {
            self.assert_not_linked_from_trash(&[id.to_string()], &[])?;
        }
        let removed =
            self.purge_trash_entries(|entry| entry["kind"] == kind && entry["meta"]["id"] == id)?;
        if removed == 0 {
            return Err("That item is no longer in Trash".into());
        }
        Ok(())
    }

    /// Mirrors emptyTrash(): returns how many entries were purged.
    pub fn empty_trash(&mut self) -> Result<usize, String> {
        self.purge_trash_entries(|_| true)
    }

    /// Mirrors purgeExpiredTrash(): the retention sweep Node runs on unlock. A database
    /// that a not-yet-expired trashed database still links to is kept until that one
    /// expires too (see assert_not_linked_from_trash).
    pub fn purge_expired_trash(&mut self, now_ms: u64) -> Result<usize, String> {
        let now = now_ms as f64;
        let expired = |entry: &Value| deleted_at(entry) + TRASH_RETENTION_MS as f64 <= now;
        if !self.trash().iter().any(expired) {
            return Ok(0);
        }
        let kept_ids: HashSet<String> = self
            .trash()
            .iter()
            .filter(|entry| entry["kind"] == "database" && !expired(entry))
            .map(|entry| entry_id(entry).to_string())
            .collect();
        let mut protected_ids: HashSet<String> = HashSet::new();
        if !kept_ids.is_empty() {
            let links = self.trashed_database_links();
            let mut queue: Vec<String> = kept_ids.iter().cloned().collect();
            while let Some(current_id) = queue.pop() {
                let Some(link) = links.iter().find(|link| link.id == current_id) else {
                    continue;
                };
                for target in &link.targets {
                    if kept_ids.contains(target) || protected_ids.contains(target) {
                        continue;
                    }
                    protected_ids.insert(target.clone());
                    queue.push(target.clone());
                }
            }
        }
        self.purge_trash_entries(|entry| {
            expired(entry) && !(entry["kind"] == "database" && protected_ids.contains(entry_id(entry)))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{random_hex, test_support::legacy_key_branch, DRIFTLEAF_DIR};

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("driftleaf-trash-unit-{label}-{}", random_hex(8)))
    }

    fn title_property() -> Value {
        json!({ "id": "p_title", "name": "Name", "type": "title" })
    }

    fn create_database(branch: &mut Branch, title: &str, folder: &str, relation: Option<&str>) -> String {
        let mut properties = vec![title_property()];
        if let Some(target) = relation {
            properties.push(json!({
                "id": "p_rel", "name": "Related", "type": "relation", "relationDatabaseId": target,
            }));
        }
        let meta = branch
            .create_database(title, folder, Value::Array(properties), json!([]), None, None)
            .unwrap();
        meta["id"].as_str().unwrap().to_string()
    }

    fn id_of(meta: &Value) -> String {
        meta["id"].as_str().unwrap().to_string()
    }

    fn set_deleted_at(branch: &mut Branch, id: &str, deleted_at: u64) {
        let entry = branch
            .trash_mut()
            .iter_mut()
            .find(|entry| entry["meta"]["id"] == id)
            .unwrap();
        entry["deletedAt"] = json!(deleted_at);
    }

    #[test]
    fn deleting_a_note_moves_it_to_trash_without_touching_its_file() {
        let root = temp_root("note");
        let mut branch = legacy_key_branch(&root);
        branch.create_folder("Ideas/Deep").unwrap();
        let note = branch.create_note("Ideas/Deep", "Kept safe").unwrap();
        let id = id_of(&note);
        branch.write_note(&id, "body").unwrap();
        let file = branch.note_path(&id).unwrap();
        let before = fs::read(&file).unwrap();

        branch.delete_note(&id).unwrap();
        assert!(branch.manifest["notes"].as_array().unwrap().is_empty());
        assert_eq!(fs::read(&file).unwrap(), before, "delete must not rewrite or remove the file");
        let entry = &branch.trash()[0];
        assert_eq!(entry["kind"], "note");
        assert_eq!(entry["meta"]["title"], "Kept safe");
        assert_eq!(entry["meta"]["folderPath"], "Ideas/Deep");
        // Key order is part of what a manifest written here looks like next to Node's.
        assert_eq!(
            entry.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["kind", "meta", "deletedAt"]
        );
        let listed = branch.list_trash();
        assert_eq!(listed[0]["id"], id.as_str());
        assert_eq!(
            listed[0]["expiresAt"].as_u64().unwrap(),
            listed[0]["deletedAt"].as_u64().unwrap() + TRASH_RETENTION_MS
        );
        assert_eq!(
            branch.delete_note(&id).err(),
            Some(format!("Note not found: {id}"))
        );

        // What was written is what a fresh open sees.
        let mut reopened = Branch::open(&root, "").unwrap();
        assert_eq!(reopened.trash().len(), 1);

        // The folder is deleted while the note sits in Trash; restoring re-registers the
        // whole chain.
        reopened.delete_folder("Ideas").unwrap();
        assert_eq!(reopened.manifest["folders"], json!([]));
        let restored = reopened.restore_trash_item("note", &id).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0]["kind"], "note");
        assert_eq!(restored[0]["meta"]["id"], id.as_str());
        assert_eq!(reopened.manifest["folders"], json!(["Ideas", "Ideas/Deep"]));
        assert!(reopened.trash().is_empty());
        assert_eq!(reopened.read_note(&id).unwrap(), "body");
        assert_eq!(
            reopened.restore_trash_item("note", &id).err(),
            Some("That item is no longer in Trash".to_string())
        );
        // The kind is part of the lookup.
        reopened.delete_note(&id).unwrap();
        assert_eq!(
            reopened.restore_trash_item("database", &id).err(),
            Some("That item is no longer in Trash".to_string())
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_purging_removes_files_and_the_manifest_forgets_first() {
        let root = temp_root("purge");
        let mut branch = legacy_key_branch(&root);
        let a = id_of(&branch.create_note("", "A").unwrap());
        let b = id_of(&branch.create_note("", "B").unwrap());
        let database = create_database(&mut branch, "D", "", None);
        branch.delete_note(&a).unwrap();
        branch.delete_note(&b).unwrap();
        branch.delete_database(&database).unwrap();
        let note_a = branch.note_path(&a).unwrap();
        let note_b = branch.note_path(&b).unwrap();
        let database_file = branch.database_path(&database).unwrap();
        assert!(note_a.exists() && note_b.exists() && database_file.exists());

        branch.purge_trash_item("note", &a).unwrap();
        assert!(!note_a.exists());
        assert!(note_b.exists() && database_file.exists());
        assert_eq!(
            branch.purge_trash_item("note", &a).err(),
            Some("That item is no longer in Trash".to_string())
        );
        assert_eq!(Branch::open(&root, "").unwrap().trash().len(), 2);

        // A file that has already vanished does not stop the entry from being purged.
        fs::remove_file(&note_b).unwrap();
        assert_eq!(branch.empty_trash().unwrap(), 2);
        assert!(!database_file.exists());
        assert!(branch.trash().is_empty());
        assert_eq!(branch.empty_trash().unwrap(), 0);
        assert!(Branch::open(&root, "").unwrap().trash().is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_is_newest_first_and_stable() {
        let root = temp_root("list");
        let mut branch = legacy_key_branch(&root);
        let ids: Vec<String> = ["A", "B", "C"]
            .iter()
            .map(|title| id_of(&branch.create_note("", title).unwrap()))
            .collect();
        for id in &ids {
            branch.delete_note(id).unwrap();
        }
        set_deleted_at(&mut branch, &ids[0], 2_000);
        set_deleted_at(&mut branch, &ids[1], 3_000);
        set_deleted_at(&mut branch, &ids[2], 2_000);
        let listed = branch.list_trash();
        let order: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["title"].as_str().unwrap())
            .collect();
        assert_eq!(order, ["B", "A", "C"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn relations_never_dangle_across_trash() {
        let root = temp_root("relations");
        let mut branch = legacy_key_branch(&root);
        branch.create_folder("Work").unwrap();
        let people = create_database(&mut branch, "People", "Work", None);
        let tasks = create_database(&mut branch, "Tasks", "Work", Some(&people));
        let blocked = "A database in Trash, \"Tasks\", links to this. Restore it or delete it permanently first";

        // Tasks (which links to People) goes to Trash alone. People must then be undeletable.
        branch.delete_database(&tasks).unwrap();
        assert_eq!(branch.delete_database(&people).err(), Some(blocked.to_string()));
        assert_eq!(branch.delete_folder("Work").err(), Some(blocked.to_string()));
        assert_eq!(branch.databases().len(), 1, "a refused delete must leave the manifest alone");
        branch.restore_trash_item("database", &tasks).unwrap();

        // Deleted together by a folder delete, both sit in Trash. Purging the target alone
        // is refused, and restoring the linking database brings its target back with it.
        branch.delete_folder("Work").unwrap();
        assert_eq!(branch.trash().len(), 2);
        assert_eq!(branch.trash()[0]["meta"]["id"], people.as_str(), "manifest order is kept");
        assert_eq!(branch.trash()[0]["deletedAt"], branch.trash()[1]["deletedAt"]);
        assert_eq!(branch.purge_trash_item("database", &people).err(), Some(blocked.to_string()));
        assert!(branch.database_path(&people).unwrap().exists());
        let restored = branch.restore_trash_item("database", &tasks).unwrap();
        let restored_ids: Vec<&str> =
            restored.iter().map(|item| item["meta"]["id"].as_str().unwrap()).collect();
        assert_eq!(restored_ids, [tasks.as_str(), people.as_str()], "requested item first");
        assert!(branch.trash().is_empty());
        assert_eq!(branch.manifest["folders"], json!(["Work"]));
        assert_eq!(
            branch.read_database(&tasks).unwrap()["properties"][1]["relationDatabaseId"],
            people.as_str()
        );

        // Restoring the target on its own leaves the linking database in Trash.
        branch.delete_folder("Work").unwrap();
        let restored = branch.restore_trash_item("database", &people).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(branch.trash().len(), 1);
        branch.restore_trash_item("database", &tasks).unwrap();

        // A linked database whose Trash entry is gone cannot be brought back.
        branch.delete_folder("Work").unwrap();
        branch.trash_mut().retain(|entry| entry["meta"]["id"] != people.as_str());
        assert_eq!(
            branch.restore_trash_item("database", &tasks).err(),
            Some(
                "This database links to another database that no longer exists, so it cannot be restored"
                    .to_string()
            )
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn restore_refuses_when_the_encrypted_file_is_missing() {
        let root = temp_root("missing");
        let mut branch = legacy_key_branch(&root);
        let id = id_of(&branch.create_note("", "Vanishing").unwrap());
        branch.delete_note(&id).unwrap();
        fs::remove_file(branch.note_path(&id).unwrap()).unwrap();
        assert_eq!(
            branch.restore_trash_item("note", &id).err(),
            Some("The encrypted file for \"Vanishing\" is missing, so it cannot be restored".to_string())
        );
        assert_eq!(branch.trash().len(), 1);
        assert!(branch.manifest["notes"].as_array().unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn retention_sweep_purges_expired_entries_but_keeps_linked_targets() {
        let root = temp_root("retention");
        let mut branch = legacy_key_branch(&root);
        let old_note = id_of(&branch.create_note("", "Old").unwrap());
        let new_note = id_of(&branch.create_note("", "New").unwrap());
        branch.create_folder("Work").unwrap();
        let people = create_database(&mut branch, "People", "Work", None);
        let tasks = create_database(&mut branch, "Tasks", "Work", Some(&people));
        branch.delete_note(&old_note).unwrap();
        branch.delete_note(&new_note).unwrap();
        branch.delete_folder("Work").unwrap();

        let now = 10 * TRASH_RETENTION_MS;
        let fresh = now - 1_000;
        let expired = now - TRASH_RETENTION_MS;
        set_deleted_at(&mut branch, &old_note, fresh);
        set_deleted_at(&mut branch, &new_note, fresh);
        set_deleted_at(&mut branch, &people, fresh);
        set_deleted_at(&mut branch, &tasks, fresh);
        assert_eq!(branch.purge_expired_trash(now).unwrap(), 0);

        // Exactly at the boundary counts as expired (`deletedAt + retention <= now`).
        set_deleted_at(&mut branch, &old_note, expired);
        // People has expired, but unexpired Tasks still links to it.
        set_deleted_at(&mut branch, &people, expired);
        assert_eq!(branch.purge_expired_trash(now).unwrap(), 1);
        assert!(!branch.note_path(&old_note).unwrap().exists());
        assert!(branch.note_path(&new_note).unwrap().exists());
        assert!(branch.database_path(&people).unwrap().exists());
        assert_eq!(branch.trash().len(), 3);

        // Once Tasks expires too, both go.
        set_deleted_at(&mut branch, &tasks, expired);
        assert_eq!(branch.purge_expired_trash(now).unwrap(), 2);
        assert!(!branch.database_path(&people).unwrap().exists());
        assert!(!branch.database_path(&tasks).unwrap().exists());
        assert_eq!(branch.trash().len(), 1);
        assert_eq!(Branch::open(&root, "").unwrap().trash().len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn deleting_drops_canvas_items_for_the_trashed_targets() {
        let root = temp_root("canvas");
        let mut branch = legacy_key_branch(&root);
        let note = id_of(&branch.create_note("", "On canvas").unwrap());
        let database = create_database(&mut branch, "On canvas too", "", None);
        branch
            .update_canvas(json!([
                { "id": "11111111-1111-1111-1111-111111111111", "kind": "note", "targetId": note, "x": 1, "y": 1 },
                { "id": "22222222-2222-2222-2222-222222222222", "kind": "database", "targetId": database, "x": 2, "y": 2 },
            ]))
            .unwrap();
        branch.delete_note(&note).unwrap();
        assert_eq!(branch.read_canvas().as_array().unwrap().len(), 1);
        branch.delete_database(&database).unwrap();
        assert!(branch.read_canvas().as_array().unwrap().is_empty());
        // Restoring does not bring canvas items back, same as the reference implementation.
        branch.restore_trash_item("note", &note).unwrap();
        assert!(branch.read_canvas().as_array().unwrap().is_empty());
        assert!(root.join(DRIFTLEAF_DIR).join("manifest.enc").exists());
        fs::remove_dir_all(&root).ok();
    }
}
