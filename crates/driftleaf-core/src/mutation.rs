//! Native mutation of a branch: notes, folders, databases, canvas items, and extensions —
//! every write path in src/main/vault.ts except backup/import/export and search, which stay
//! on the Node sidecar. Disk-first for create/write, manifest-first for delete, matching
//! vault.ts's exact ordering (see createNote/writeNote/deleteNote) so a crash between steps
//! leaves an orphaned file or a stale manifest entry for Node's reconcileVault to self-heal,
//! never lost content. Like snapshot.rs, this never runs reconciliation or legacy-path
//! migration itself: callers are assumed to already be operating on a branch Node has
//! unlocked (and thus already reconciled) at least once. Properties/rows/views/extensions/
//! canvas items are handled as `serde_json::Value` rather than typed structs, matching the
//! rest of this crate's posture: validate the same way Node does, round-trip whatever shape
//! is already there, and don't require a full Rust model of the IPC type hierarchy.
use crate::{decrypt, encrypt, open_branch, random_hex, random_uuid_v4, valid_id, Key, DRIFTLEAF_DIR};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Branch {
    pub root: PathBuf,
    key: Key,
    pub manifest: Value,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Writes go to a sibling temp file and land via rename(), same atomicity guarantee (and
// reasoning) as writeFileAtomic() in src/main/vault.ts.
fn write_file_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid path")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid path")?;
    let tmp = dir.join(format!(".{name}.tmp-{}", random_hex(16)));
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// Same traversal and reserved-name checks as validateFolderPath() in src/main/vault.ts.
pub(crate) fn validate_folder_path(folder_path: &str) -> Result<(), String> {
    if folder_path.contains("..") || folder_path.starts_with('/') {
        return Err(format!("Invalid folder path: {folder_path}"));
    }
    if folder_path.split('/').any(|part| part == DRIFTLEAF_DIR) {
        return Err(format!(
            "\"{DRIFTLEAF_DIR}\" is a reserved name and can't be used as a folder"
        ));
    }
    Ok(())
}

impl Branch {
    pub fn open(root: &Path, passphrase: &str) -> Result<Self, String> {
        let (root, key, manifest) = open_branch(root, passphrase)?;
        Ok(Self {
            root,
            key,
            manifest,
        })
    }

    fn notes(&mut self) -> &mut Vec<Value> {
        // open_branch() already verified manifest["notes"] is an array.
        self.manifest["notes"].as_array_mut().unwrap()
    }

    fn note_path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid note ID".into());
        }
        Ok(self
            .root
            .join(DRIFTLEAF_DIR)
            .join("notes")
            .join(format!("{id}.enc")))
    }

    fn write_manifest(&self) -> Result<(), String> {
        let path = self.root.join(DRIFTLEAF_DIR).join("manifest.enc");
        let data = serde_json::to_vec(&self.manifest).map_err(|e| e.to_string())?;
        write_file_atomic(&path, &encrypt(&data, &self.key)?)
    }

    fn write_note_file(&self, id: &str, content: &str) -> Result<(), String> {
        let path = self.note_path(id)?;
        fs::create_dir_all(path.parent().ok_or("Invalid path")?).map_err(|e| e.to_string())?;
        write_file_atomic(&path, &encrypt(content.as_bytes(), &self.key)?)
    }

    pub fn read_note(&self, id: &str) -> Result<String, String> {
        let encrypted = fs::read(self.note_path(id)?).map_err(|e| e.to_string())?;
        String::from_utf8(decrypt(&encrypted, &self.key)?.to_vec())
            .map_err(|_| "Note is not valid UTF-8".into())
    }

    /// Note content is written before the manifest, matching writeNote()'s ordering: a
    /// crash between the two leaves at worst a stale `updatedAt`, never lost content.
    pub fn create_note(&mut self, folder_path: &str, title: &str) -> Result<Value, String> {
        validate_folder_path(folder_path)?;
        let id = random_uuid_v4();
        let meta = json!({
            "id": id,
            "title": title,
            "folderPath": folder_path,
            "fileName": format!("{id}.enc"),
            "updatedAt": now_ms(),
        });
        self.write_note_file(&id, "")?;
        self.notes().push(meta.clone());
        if let Err(err) = self.write_manifest() {
            // Mirror createNote()'s rollback: don't leave the note visible in-memory if
            // it was never actually recorded on disk.
            let notes = self.notes();
            if let Some(index) = notes.iter().position(|n| n["id"] == id) {
                notes.remove(index);
            }
            return Err(err);
        }
        Ok(meta)
    }

    pub fn write_note(&mut self, id: &str, content: &str) -> Result<(), String> {
        if !self.notes().iter().any(|n| n["id"] == id) {
            return Err(format!("Note not found: {id}"));
        }
        self.write_note_file(id, content)?;
        if let Some(meta) = self.notes().iter_mut().find(|n| n["id"] == id) {
            meta["updatedAt"] = json!(now_ms());
        }
        self.write_manifest()
    }

    pub fn rename_note(&mut self, id: &str, title: &str) -> Result<(), String> {
        {
            let meta = self
                .notes()
                .iter_mut()
                .find(|n| n["id"] == id)
                .ok_or_else(|| format!("Note not found: {id}"))?;
            meta["title"] = json!(title);
            meta["updatedAt"] = json!(now_ms());
        }
        // No rollback here, matching renameNote(): a failed write leaves the in-memory
        // title ahead of disk until the next reload, same as the reference implementation.
        self.write_manifest()
    }

    pub fn delete_note(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .notes()
            .iter()
            .position(|n| n["id"] == id)
            .ok_or_else(|| format!("Note not found: {id}"))?;
        let meta = self.notes().remove(index);
        let previous_canvas = self.manifest["canvasItems"].clone();
        if let Some(items) = self.manifest["canvasItems"].as_array_mut() {
            items.retain(|item| !(item["kind"] == "note" && item["targetId"] == id));
        }
        if let Err(err) = self.write_manifest() {
            self.notes().insert(index, meta);
            self.manifest["canvasItems"] = previous_canvas;
            return Err(err);
        }
        // force: true — ignore an already-missing file, same as rm(path, { force: true }).
        if let Err(err) = fs::remove_file(self.note_path(id)?) {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Err(err.to_string());
            }
        }
        Ok(())
    }

    pub fn create_folder(&mut self, folder_path: &str) -> Result<(), String> {
        validate_folder_path(folder_path)?;
        let folders = self.manifest["folders"]
            .as_array_mut()
            .ok_or("Invalid branch manifest")?;
        if !folders.iter().any(|f| f == folder_path) {
            folders.push(json!(folder_path));
            self.write_manifest()?;
        }
        Ok(())
    }

    /// Test-only hook simulating a crash between a note file's write and the manifest
    /// write inside `create_note` — writes the file but never touches the manifest, so
    /// the file is left exactly as orphaned as a real interrupted write would leave it.
    pub fn write_orphan_note_file(&self, content: &str) -> Result<String, String> {
        let id = random_uuid_v4();
        self.write_note_file(&id, content)?;
        Ok(id)
    }

    /// Mirrors inspectVault(): a health report cross-checking this branch's manifest
    /// against what's actually on disk (see crate::backup).
    pub fn inspect(&self) -> Value {
        crate::backup::inspect(&self.root, &self.key, &self.manifest)
    }
}

// ---------------------------------------------------------------------------------------
// Databases. Ports validateDatabaseProperties/Rows/Views, clearRelationToRow, and the
// create/read/update/delete family from src/main/vault.ts, operating on serde_json::Value
// rather than typed structs (same posture as the rest of this module: round-trip whatever
// shape Node wrote, validate it the same way Node does, don't require a full Rust type
// model of the IPC schema).
const DATABASE_PROPERTY_TYPES: &[&str] = &[
    "title",
    "text",
    "number",
    "checkbox",
    "date",
    "select",
    "multi_select",
    "url",
    "email",
    "phone",
    "status",
    "people",
    "files",
    "formula",
    "relation",
    "rollup",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
];

pub(crate) fn validate_database_properties(properties: &[Value]) -> Result<(), String> {
    if properties.is_empty() {
        return Err("A database needs at least one property".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    let mut title_count = 0;
    for property in properties {
        let id = property["id"].as_str().filter(|s| !s.is_empty());
        let name = property["name"].as_str().filter(|s| !s.trim().is_empty());
        let property_type = property["type"].as_str();
        let valid_type = property_type.is_some_and(|t| DATABASE_PROPERTY_TYPES.contains(&t));
        if id.is_none() || name.is_none() || !valid_type {
            return Err("Database has an invalid property definition".into());
        }
        let (id, name, property_type) = (id.unwrap(), name.unwrap(), property_type.unwrap());
        let normalized_name = name.trim().to_lowercase();
        if ids.contains(id) || names.contains(&normalized_name) {
            return Err("Database property IDs and names must be unique".into());
        }
        ids.insert(id.to_string());
        names.insert(normalized_name);
        if property_type == "title" {
            title_count += 1;
        }
        if property_type == "formula" && property["formula"].as_str().is_none() {
            return Err(format!("Formula property \"{name}\" needs a formula"));
        }
        if let Some(options) = property.get("options").filter(|o| !o.is_null()) {
            let mut seen = std::collections::HashSet::new();
            let valid_options = options
                .as_array()
                .is_some_and(|items| items.iter().all(|item| item.is_string()))
                && options.as_array().unwrap().iter().all(|item| {
                    seen.insert(item.as_str().unwrap())
                });
            if !valid_options {
                return Err(format!("Database property \"{name}\" has invalid options"));
            }
        }
        if property_type == "relation"
            && !property["relationDatabaseId"].as_str().is_some_and(valid_id)
        {
            return Err(format!("Relation property \"{name}\" needs a valid database"));
        }
        if property_type == "rollup" {
            let valid_function = property["rollupFunction"].as_str().is_some_and(|f| {
                ["count", "sum", "average", "min", "max", "show_original"].contains(&f)
            });
            if property["rollupRelationPropertyId"].as_str().is_none()
                || property["rollupTargetPropertyId"].as_str().is_none()
                || !valid_function
            {
                return Err(format!("Rollup property \"{name}\" has an invalid configuration"));
            }
        }
    }
    if title_count != 1 {
        return Err("A database needs exactly one title property".into());
    }
    Ok(())
}

pub(crate) fn validate_database_rows(properties: &[Value], rows: &Value) -> Result<(), String> {
    let rows = rows.as_array().ok_or("Database rows must be an array")?;
    let property_ids: std::collections::HashSet<&str> =
        properties.iter().filter_map(|p| p["id"].as_str()).collect();
    let mut row_ids = std::collections::HashSet::new();
    for row in rows {
        let id = row["id"].as_str().filter(|s| !s.is_empty());
        let values = row.get("values").filter(|v| v.is_object());
        if id.is_none() || values.is_none() {
            return Err("Database has an invalid row".into());
        }
        let id = id.unwrap();
        if !row_ids.insert(id) {
            return Err("Database row IDs must be unique".into());
        }
        for (property_id, value) in values.unwrap().as_object().unwrap() {
            if !property_ids.contains(property_id.as_str()) {
                return Err("Database row references an unknown property".into());
            }
            let ok = value.is_null()
                || value.is_string()
                || value.is_number()
                || value.is_boolean()
                || value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string));
            if !ok {
                return Err("Database cell has an unsupported value".into());
            }
        }
    }
    Ok(())
}

fn validate_database_views(views: &Value, properties: &[Value]) -> Result<(), String> {
    let views = views
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("A database needs at least one view")?;
    const VIEW_TYPES: &[&str] = &["table", "board", "calendar", "gallery", "list", "timeline"];
    let property_ids: std::collections::HashSet<&str> =
        properties.iter().filter_map(|p| p["id"].as_str()).collect();
    let date_property_ids: std::collections::HashSet<&str> = properties
        .iter()
        .filter(|p| p["type"] == "date")
        .filter_map(|p| p["id"].as_str())
        .collect();
    let mut ids = std::collections::HashSet::new();
    for view in views {
        let id = view["id"].as_str().filter(|s| !s.is_empty());
        let name = view["name"].as_str().filter(|s| !s.trim().is_empty());
        let view_type = view["type"].as_str();
        let valid_type = view_type.is_some_and(|t| VIEW_TYPES.contains(&t));
        if id.is_none() || name.is_none() || !valid_type || ids.contains(id.unwrap()) {
            return Err("Database has an invalid view definition".into());
        }
        ids.insert(id.unwrap().to_string());
        let property_ok = |key: &str| match view.get(key).and_then(Value::as_str) {
            Some(p) if !p.is_empty() => property_ids.contains(p),
            _ => true,
        };
        let date_property_ok = |key: &str| match view.get(key).and_then(Value::as_str) {
            Some(p) if !p.is_empty() => date_property_ids.contains(p),
            _ => true,
        };
        if !property_ok("sortPropertyId")
            || !property_ok("groupPropertyId")
            || !date_property_ok("datePropertyId")
            || !date_property_ok("endDatePropertyId")
        {
            return Err("Database view references an unknown or incompatible property".into());
        }
        if let Some(direction) = view.get("sortDirection").and_then(Value::as_str) {
            if direction != "ascending" && direction != "descending" {
                return Err("Database view has an invalid sort direction".into());
            }
        }
        let empty_filters = json!([]);
        let filters = view
            .get("filters")
            .unwrap_or(&empty_filters)
            .as_array()
            .ok_or("Database view filters must be an array")?;
        for filter in filters {
            let valid = filter["propertyId"]
                .as_str()
                .is_some_and(|p| property_ids.contains(p))
                && filter["operator"].as_str().is_some_and(|operator| {
                    ["contains", "equals", "is_empty", "is_not_empty"].contains(&operator)
                })
                && filter["value"].is_string();
            if !valid {
                return Err("Database view has an invalid filter".into());
            }
        }
    }
    Ok(())
}

fn clear_relation_to_row(
    rows: &[Value],
    properties: &[Value],
    database_id: &str,
    row_id: &str,
) -> (Vec<Value>, bool) {
    let relation_ids: Vec<&str> = properties
        .iter()
        .filter(|p| p["type"] == "relation" && p["relationDatabaseId"] == database_id)
        .filter_map(|p| p["id"].as_str())
        .collect();
    let mut changed = false;
    let updated_rows = rows
        .iter()
        .map(|row| {
            let mut values = row["values"].clone();
            let mut row_changed = false;
            if let Some(object) = values.as_object_mut() {
                for property_id in &relation_ids {
                    let Some(value) = object.get(*property_id).cloned() else {
                        continue;
                    };
                    if let Some(items) = value.as_array() {
                        let next: Vec<Value> = items
                            .iter()
                            .filter(|item| item.as_str() != Some(row_id))
                            .cloned()
                            .collect();
                        if next.len() != items.len() {
                            object.insert((*property_id).to_string(), Value::Array(next));
                            row_changed = true;
                        }
                    } else if let Some(text) = value.as_str() {
                        let parts: Vec<&str> = text.split(',').map(str::trim).collect();
                        let next: Vec<&str> =
                            parts.iter().copied().filter(|p| *p != row_id).collect();
                        if next.len() != parts.len() {
                            object.insert((*property_id).to_string(), json!(next.join(", ")));
                            row_changed = true;
                        }
                    }
                }
            }
            if !row_changed {
                return row.clone();
            }
            changed = true;
            let mut updated = row.clone();
            updated["values"] = values;
            updated["updatedAt"] = json!(now_ms());
            updated
        })
        .collect();
    (updated_rows, changed)
}

impl Branch {
    fn databases(&self) -> &[Value] {
        self.manifest["databases"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn databases_mut(&mut self) -> &mut Vec<Value> {
        // open_branch() already defaults this to an array; the check stays as a safeguard.
        if !self.manifest["databases"].is_array() {
            self.manifest["databases"] = json!([]);
        }
        self.manifest["databases"].as_array_mut().unwrap()
    }

    fn database_path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid database ID".into());
        }
        Ok(self.root.join(DRIFTLEAF_DIR).join(format!("{id}.db.enc")))
    }

    fn write_database_data(&self, data: &Value) -> Result<(), String> {
        let id = data["meta"]["id"].as_str().ok_or("Missing database ID")?;
        let bytes = serde_json::to_vec(data).map_err(|e| e.to_string())?;
        write_file_atomic(&self.database_path(id)?, &encrypt(&bytes, &self.key)?)
    }

    pub fn list_databases(&self, folder_path: Option<&str>) -> Value {
        match folder_path {
            None => Value::Array(self.databases().to_vec()),
            Some(folder) => Value::Array(
                self.databases()
                    .iter()
                    .filter(|d| d["folderPath"] == folder)
                    .cloned()
                    .collect(),
            ),
        }
    }

    pub fn read_database(&self, id: &str) -> Result<Value, String> {
        let meta = self
            .databases()
            .iter()
            .find(|d| d["id"] == id)
            .cloned()
            .ok_or("Database not found")?;
        let title = meta["title"].as_str().unwrap_or("").to_string();
        let corrupted = || format!("Database is corrupted or cannot be read: {title}");
        let encrypted = fs::read(self.database_path(id)?).map_err(|_| corrupted())?;
        let decrypted = decrypt(&encrypted, &self.key).map_err(|_| corrupted())?;
        let mut data: Value = serde_json::from_slice(&decrypted).map_err(|_| corrupted())?;
        if !data.is_object() || !data["properties"].is_array() || !data["rows"].is_array() {
            return Err(format!("Database data is invalid: {title}"));
        }
        let properties = data["properties"].as_array().cloned().unwrap();
        validate_database_properties(&properties)?;
        validate_database_rows(&properties, &data["rows"])?;
        let views = if data["views"].is_array() {
            data["views"].clone()
        } else {
            json!([{ "id": "table", "name": "Table", "type": "table" }])
        };
        validate_database_views(&views, &properties)?;
        let active_view_id = if data["activeViewId"].is_string() {
            data["activeViewId"].clone()
        } else {
            views[0]["id"].clone()
        };
        data["meta"] = meta;
        data["views"] = views;
        data["activeViewId"] = active_view_id;
        Ok(data)
    }

    pub(crate) fn ensure_folder_chain(&mut self, folder_path: &str) -> Result<(), String> {
        if folder_path.is_empty() {
            return Ok(());
        }
        let mut current = String::new();
        for part in folder_path.split('/') {
            current = if current.is_empty() {
                part.to_string()
            } else {
                format!("{current}/{part}")
            };
            self.create_folder(&current)?;
        }
        Ok(())
    }

    /// `properties`/`rows`/`views` are taken as `Value` (expected to be arrays) rather than
    /// typed slices so callers can pass straight through what they received, same as every
    /// other database method here.
    pub fn create_database(
        &mut self,
        title: &str,
        folder_path: &str,
        properties: Value,
        rows: Value,
        views: Option<Value>,
        active_view_id: Option<&str>,
    ) -> Result<Value, String> {
        validate_folder_path(folder_path)?;
        let properties_arr = properties.as_array().cloned().ok_or("Invalid properties")?;
        validate_database_properties(&properties_arr)?;
        validate_database_rows(&properties_arr, &rows)?;

        let existing_ids: std::collections::HashSet<String> = self
            .databases()
            .iter()
            .filter_map(|d| d["id"].as_str().map(String::from))
            .collect();
        for property in &properties_arr {
            let name = property["name"].as_str().unwrap_or("");
            if property["type"] == "relation" {
                let relation_id = property["relationDatabaseId"].as_str().unwrap_or("");
                if !existing_ids.contains(relation_id) {
                    return Err(format!(
                        "Relation property \"{name}\" references an unknown database"
                    ));
                }
            }
            if property["type"] == "rollup" {
                let relation = property["rollupRelationPropertyId"].as_str().and_then(|rel| {
                    properties_arr
                        .iter()
                        .find(|p| p["id"] == rel && p["type"] == "relation")
                });
                let target_property_id = property["rollupTargetPropertyId"].as_str();
                let (Some(relation), Some(target_property_id)) = (relation, target_property_id)
                else {
                    return Err(format!(
                        "Rollup property \"{name}\" needs a valid relation and target"
                    ));
                };
                let relation_database_id = relation["relationDatabaseId"].as_str().unwrap_or("");
                let target_database = self.read_database(relation_database_id)?;
                if !target_database["properties"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["id"] == target_property_id)
                {
                    return Err(format!(
                        "Rollup property \"{name}\" references an unknown target property"
                    ));
                }
            }
        }

        self.ensure_folder_chain(folder_path)?;
        let id = random_uuid_v4();
        let trimmed_title = title.trim();
        let database_title = if trimmed_title.is_empty() { "Untitled database" } else { trimmed_title };
        let meta = json!({
            "id": id,
            "title": database_title,
            "folderPath": folder_path,
            "updatedAt": now_ms(),
        });
        let database_views =
            views.unwrap_or_else(|| json!([{ "id": "table", "name": "Table", "type": "table" }]));
        validate_database_views(&database_views, &properties_arr)?;
        let selected_active_view_id = active_view_id
            .map(String::from)
            .or_else(|| database_views[0]["id"].as_str().map(String::from));
        let active_ok = selected_active_view_id
            .as_deref()
            .is_some_and(|vid| database_views.as_array().unwrap().iter().any(|v| v["id"] == vid));
        if !active_ok {
            return Err("Active database view does not exist".into());
        }
        let data = json!({
            "meta": meta,
            "properties": properties_arr,
            "rows": rows,
            "views": database_views,
            "activeViewId": selected_active_view_id,
        });
        self.write_database_data(&data)?;
        self.databases_mut().push(meta.clone());
        if let Err(err) = self.write_manifest() {
            self.databases_mut().retain(|d| d["id"] != id);
            let _ = fs::remove_file(self.database_path(&id)?);
            return Err(err);
        }
        Ok(meta)
    }

    pub fn rename_database(&mut self, id: &str, title: &str) -> Result<Value, String> {
        let next_title = title.trim();
        if next_title.is_empty() {
            return Err("Database name cannot be empty".into());
        }
        {
            let database = self
                .databases_mut()
                .iter_mut()
                .find(|d| d["id"] == id)
                .ok_or("Database not found")?;
            database["title"] = json!(next_title);
            database["updatedAt"] = json!(now_ms());
        }
        self.write_manifest()?;
        Ok(self.databases().iter().find(|d| d["id"] == id).unwrap().clone())
    }

    /// Unlike note/folder mutations, a failed manifest write here is **not** rolled back
    /// in memory, matching renameDatabase()/updateDatabase() in vault.ts exactly: both
    /// mutate the in-memory meta and only then attempt the write, with no catch block.
    pub fn update_database(
        &mut self,
        id: &str,
        properties: Value,
        rows: Value,
        views: Option<Value>,
        active_view_id: Option<&str>,
    ) -> Result<(), String> {
        let properties_arr = properties.as_array().cloned().ok_or("Invalid properties")?;
        validate_database_properties(&properties_arr)?;
        validate_database_rows(&properties_arr, &rows)?;
        if !self.databases().iter().any(|d| d["id"] == id) {
            return Err("Database not found".into());
        }
        let existing_ids: std::collections::HashSet<String> = self
            .databases()
            .iter()
            .filter_map(|d| d["id"].as_str().map(String::from))
            .collect();
        for property in &properties_arr {
            if property["type"] == "relation" {
                let relation_id = property["relationDatabaseId"].as_str().unwrap_or("");
                let name = property["name"].as_str().unwrap_or("");
                if !existing_ids.contains(relation_id) || relation_id == id {
                    return Err(format!(
                        "Relation property \"{name}\" references an unknown database"
                    ));
                }
            }
        }
        let current = self.read_database(id)?;
        let schema_changed = current["properties"] != properties;
        if schema_changed {
            for property in properties_arr.iter().filter(|p| p["type"] == "rollup") {
                let name = property["name"].as_str().unwrap_or("");
                let relation = property["rollupRelationPropertyId"].as_str().and_then(|rel| {
                    properties_arr
                        .iter()
                        .find(|p| p["id"] == rel && p["type"] == "relation")
                });
                let target_property_id = property["rollupTargetPropertyId"].as_str();
                let (Some(relation), Some(target_property_id)) = (relation, target_property_id)
                else {
                    return Err(format!(
                        "Rollup property \"{name}\" needs a valid relation and target"
                    ));
                };
                let relation_database_id = relation["relationDatabaseId"].as_str().unwrap_or("");
                let target_database = self.read_database(relation_database_id)?;
                if !target_database["properties"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["id"] == target_property_id)
                {
                    return Err(format!(
                        "Rollup property \"{name}\" references an unknown target property"
                    ));
                }
            }
            let current_properties = current["properties"].as_array().cloned().unwrap_or_default();
            let removed_property_ids: std::collections::HashSet<String> = current_properties
                .iter()
                .filter(|p| !properties_arr.iter().any(|next| next["id"] == p["id"]))
                .filter_map(|p| p["id"].as_str().map(String::from))
                .collect();
            if !removed_property_ids.is_empty() {
                let other_ids: Vec<String> = self
                    .databases()
                    .iter()
                    .filter_map(|d| d["id"].as_str().map(String::from))
                    .filter(|other| other != id)
                    .collect();
                for other_id in other_ids {
                    let referencing = self.read_database(&other_id)?;
                    let referencing_title = referencing["meta"]["title"].as_str().unwrap_or("");
                    for rollup in referencing["properties"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|p| p["type"] == "rollup")
                    {
                        let relation = rollup["rollupRelationPropertyId"].as_str().and_then(|rel| {
                            referencing["properties"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|p| p["id"] == rel && p["type"] == "relation")
                        });
                        let relation_database_id =
                            relation.and_then(|r| r["relationDatabaseId"].as_str());
                        let target_property_id =
                            rollup["rollupTargetPropertyId"].as_str().unwrap_or("");
                        if relation_database_id == Some(id)
                            && removed_property_ids.contains(target_property_id)
                        {
                            let rollup_name = rollup["name"].as_str().unwrap_or("");
                            return Err(format!(
                                "Property is used by the \"{rollup_name}\" rollup in \"{referencing_title}\" and cannot be deleted"
                            ));
                        }
                    }
                }
            }
        }
        let next_views = views.unwrap_or_else(|| current["views"].clone());
        validate_database_views(&next_views, &properties_arr)?;
        let next_active_view_id = active_view_id
            .map(String::from)
            .or_else(|| current["activeViewId"].as_str().map(String::from));
        let views_ok = next_active_view_id
            .as_deref()
            .is_some_and(|vid| next_views.as_array().unwrap().iter().any(|v| v["id"] == vid));
        if !views_ok {
            return Err("Active database view does not exist".into());
        }
        let mut next_meta = current["meta"].clone();
        next_meta["updatedAt"] = json!(now_ms());
        self.write_database_data(&json!({
            "meta": next_meta,
            "properties": properties_arr,
            "rows": rows,
            "views": next_views,
            "activeViewId": next_active_view_id,
        }))?;
        let database = self
            .databases_mut()
            .iter_mut()
            .find(|d| d["id"] == id)
            .unwrap();
        *database = next_meta;
        self.write_manifest()
    }

    pub fn create_database_row(&mut self, id: &str) -> Result<Value, String> {
        let data = self.read_database(id)?;
        let now = now_ms();
        let mut values = serde_json::Map::new();
        for property in data["properties"].as_array().into_iter().flatten() {
            let property_type = property["type"].as_str().unwrap_or("");
            let property_id = property["id"].as_str().unwrap_or("").to_string();
            if property_type == "checkbox" {
                values.insert(property_id, json!(false));
            } else if property_type == "multi_select" || property_type == "relation" {
                values.insert(property_id, json!([]));
            } else if !["formula", "rollup", "created_time", "last_edited_time"]
                .contains(&property_type)
            {
                values.insert(property_id, Value::Null);
            }
        }
        let row = json!({ "id": random_uuid_v4(), "values": values, "createdAt": now, "updatedAt": now });
        let mut rows = data["rows"].as_array().cloned().unwrap_or_default();
        rows.push(row.clone());
        self.update_database(
            id,
            data["properties"].clone(),
            Value::Array(rows),
            Some(data["views"].clone()),
            data["activeViewId"].as_str(),
        )?;
        Ok(row)
    }

    pub fn delete_database_row(&mut self, id: &str, row_id: &str) -> Result<(), String> {
        let data = self.read_database(id)?;
        let rows = data["rows"].as_array().cloned().unwrap_or_default();
        let retained_rows: Vec<Value> =
            rows.iter().filter(|r| r["id"] != row_id).cloned().collect();
        if retained_rows.len() == rows.len() {
            return Err("Database row not found".into());
        }
        let other_ids: Vec<String> = self
            .databases()
            .iter()
            .filter_map(|d| d["id"].as_str().map(String::from))
            .filter(|other| other != id)
            .collect();
        for other_id in other_ids {
            let linked_data = self.read_database(&other_id)?;
            let linked_rows = linked_data["rows"].as_array().cloned().unwrap_or_default();
            let linked_properties = linked_data["properties"].as_array().cloned().unwrap_or_default();
            let (cleared_rows, changed) =
                clear_relation_to_row(&linked_rows, &linked_properties, id, row_id);
            if changed {
                self.update_database(
                    &other_id,
                    Value::Array(linked_properties),
                    Value::Array(cleared_rows),
                    Some(linked_data["views"].clone()),
                    linked_data["activeViewId"].as_str(),
                )?;
            }
        }
        let properties = data["properties"].as_array().cloned().unwrap_or_default();
        let (cleared_rows, _) = clear_relation_to_row(&retained_rows, &properties, id, row_id);
        self.update_database(
            id,
            Value::Array(properties),
            Value::Array(cleared_rows),
            Some(data["views"].clone()),
            data["activeViewId"].as_str(),
        )
    }

    pub fn delete_database(&mut self, id: &str) -> Result<(), String> {
        let databases = self.databases().to_vec();
        let index = databases
            .iter()
            .position(|d| d["id"] == id)
            .ok_or("Database not found")?;
        for referenced_by in &databases {
            if referenced_by["id"] == id {
                continue;
            }
            let referenced_id = referenced_by["id"].as_str().unwrap_or("");
            let referenced_data = self.read_database(referenced_id)?;
            if referenced_data["properties"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["relationDatabaseId"] == id)
            {
                let title = referenced_by["title"].as_str().unwrap_or("");
                return Err(format!(
                    "Database is linked from \"{title}\" and cannot be deleted yet"
                ));
            }
        }
        let meta = self.databases_mut().remove(index);
        let previous_canvas = self.manifest["canvasItems"].clone();
        if let Some(items) = self.manifest["canvasItems"].as_array_mut() {
            items.retain(|item| !(item["kind"] == "database" && item["targetId"] == id));
        }
        if let Err(err) = self.write_manifest() {
            self.databases_mut().insert(index, meta);
            self.manifest["canvasItems"] = previous_canvas;
            return Err(err);
        }
        if let Err(err) = fs::remove_file(self.database_path(id)?) {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Err(err.to_string());
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Canvas and extensions. Both live entirely in the manifest — no separate on-disk files —
// so these are the simplest mutations here, ported from vault.ts's readCanvas/updateCanvas
// and listExtensions/installExtension/setExtensionPermissions/removeExtension.
// installExtensionSample/listExtensionSamples are not ported: they only materialize
// hardcoded sample JS source for the UI and don't affect branch-format compatibility.
const EXTENSION_MAX_BYTES: usize = 512 * 1024;
const EXTENSION_PERMISSIONS: &[&str] = &["read_notes", "read_graph", "read_databases"];

fn validate_canvas_items(items: &[Value], notes: &[Value], databases: &[Value]) -> Result<(), String> {
    if items.len() > 500 {
        return Err("The canvas may contain up to 500 items".into());
    }
    let mut ids = std::collections::HashSet::new();
    for item in items {
        let targets: &[Value] = match item["kind"].as_str() {
            Some("note") => notes,
            Some("database") => databases,
            _ => &[],
        };
        let valid = (|| {
            let id = item["id"].as_str().filter(|s| valid_id(s))?;
            if ids.contains(id) {
                return None;
            }
            let target_id = item["targetId"].as_str()?;
            if !targets.iter().any(|t| t["id"] == target_id) {
                return None;
            }
            let x = item["x"].as_f64()?;
            let y = item["y"].as_f64()?;
            Some(x.is_finite() && y.is_finite() && (0.0..=10000.0).contains(&x) && (0.0..=10000.0).contains(&y))
        })()
        .unwrap_or(false);
        if !valid {
            return Err("The canvas contains an invalid item".into());
        }
        ids.insert(item["id"].as_str().unwrap().to_string());
    }
    Ok(())
}

fn validate_extension(extension: &Value) -> Result<(), String> {
    let valid = extension["id"].as_str().is_some_and(valid_id)
        && extension["name"]
            .as_str()
            .is_some_and(|n| !n.trim().is_empty() && n.len() <= 100)
        && extension["source"]
            .as_str()
            .is_some_and(|s| s.len() <= EXTENSION_MAX_BYTES)
        && extension["permissions"].as_array().is_some_and(|permissions| {
            permissions
                .iter()
                .all(|p| p.as_str().is_some_and(|p| EXTENSION_PERMISSIONS.contains(&p)))
        })
        && extension["databaseIds"].as_array().is_some_and(|ids| {
            ids.iter().all(|id| id.as_str().is_some_and(valid_id))
        });
    if !valid {
        return Err("Vault contains an invalid extension definition".into());
    }
    Ok(())
}

fn extension_summary(extension: &Value) -> Value {
    let mut summary = json!({
        "id": extension["id"],
        "name": extension["name"],
        "permissions": extension["permissions"],
        "databaseIds": extension["databaseIds"],
    });
    if let Some(sample_id) = extension.get("sampleId").filter(|s| !s.is_null()) {
        summary["sampleId"] = sample_id.clone();
    }
    summary
}

impl Branch {
    pub fn read_canvas(&self) -> Value {
        self.manifest["canvasItems"].clone()
    }

    pub fn update_canvas(&mut self, items: Value) -> Result<(), String> {
        let items_arr = items.as_array().cloned().ok_or("Invalid canvas items")?;
        let notes = self.manifest["notes"].as_array().cloned().unwrap_or_default();
        let databases = self.databases().to_vec();
        validate_canvas_items(&items_arr, &notes, &databases)?;
        let previous = self.manifest["canvasItems"].clone();
        self.manifest["canvasItems"] = Value::Array(items_arr);
        if let Err(err) = self.write_manifest() {
            self.manifest["canvasItems"] = previous;
            return Err(err);
        }
        Ok(())
    }

    fn extensions_mut(&mut self) -> &mut Vec<Value> {
        if !self.manifest["extensions"].is_array() {
            self.manifest["extensions"] = json!([]);
        }
        self.manifest["extensions"].as_array_mut().unwrap()
    }

    pub fn list_extensions(&self) -> Value {
        Value::Array(
            self.manifest["extensions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(extension_summary)
                .collect(),
        )
    }

    pub fn install_extension(&mut self, name: &str, source: &str) -> Result<Value, String> {
        if source.len() > EXTENSION_MAX_BYTES {
            return Err("Extension files must be smaller than 512 KB".into());
        }
        if source.trim().is_empty() {
            return Err("The selected extension file is empty".into());
        }
        let trimmed: String = name.trim().chars().take(100).collect();
        let final_name = if trimmed.is_empty() { "Extension" } else { &trimmed };
        let extension = json!({
            "id": random_uuid_v4(),
            "name": final_name,
            "source": source,
            "permissions": [],
            "databaseIds": [],
        });
        validate_extension(&extension)?;
        let id = extension["id"].as_str().unwrap().to_string();
        self.extensions_mut().push(extension.clone());
        if let Err(err) = self.write_manifest() {
            self.extensions_mut().retain(|e| e["id"] != id);
            return Err(err);
        }
        Ok(extension_summary(&extension))
    }

    pub fn set_extension_permissions(
        &mut self,
        id: &str,
        permissions: &[String],
        database_ids: &[String],
    ) -> Result<(), String> {
        let mut seen_permissions = std::collections::HashSet::new();
        let mut seen_database_ids = std::collections::HashSet::new();
        let existing_database_ids: std::collections::HashSet<String> = self
            .databases()
            .iter()
            .filter_map(|d| d["id"].as_str().map(String::from))
            .collect();
        let valid = permissions
            .iter()
            .all(|p| EXTENSION_PERMISSIONS.contains(&p.as_str()) && seen_permissions.insert(p.as_str()))
            && database_ids.iter().all(|d| {
                existing_database_ids.contains(d) && seen_database_ids.insert(d.as_str())
            })
            && (database_ids.is_empty() || permissions.iter().any(|p| p == "read_databases"));
        if !valid {
            return Err("Invalid extension permissions".into());
        }
        {
            let extension = self
                .extensions_mut()
                .iter_mut()
                .find(|e| e["id"] == id)
                .ok_or("Extension not found")?;
            extension["permissions"] = json!(permissions);
            extension["databaseIds"] = json!(database_ids);
        }
        self.write_manifest()
    }

    pub fn remove_extension(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .extensions_mut()
            .iter()
            .position(|e| e["id"] == id)
            .ok_or("Extension not found")?;
        let removed = self.extensions_mut().remove(index);
        if let Err(err) = self.write_manifest() {
            self.extensions_mut().insert(index, removed);
            return Err(err);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Folder rename/move/delete. Unlike vault.ts, these never touch real on-disk directories:
// mutation.rs only ever creates notes at the private canonical path (.driftleaf/notes/<id>.enc),
// so a note's folderPath is pure manifest metadata here, never a real filesystem location —
// pruneEmptyLegacyFolders() has nothing to prune for a branch mutation.rs itself wrote to.
impl Branch {
    pub fn move_note(&mut self, id: &str, target_folder: &str) -> Result<Value, String> {
        validate_folder_path(target_folder)?;
        let (previous, result) = {
            let notes = self.notes();
            let meta = notes
                .iter_mut()
                .find(|n| n["id"] == id)
                .ok_or_else(|| format!("Note not found: {id}"))?;
            let previous = meta.clone();
            meta["folderPath"] = json!(target_folder);
            meta["fileName"] = json!(format!("{id}.enc"));
            meta["updatedAt"] = json!(now_ms());
            (previous, meta.clone())
        };
        if let Err(err) = self.write_manifest() {
            let notes = self.notes();
            let meta = notes.iter_mut().find(|n| n["id"] == id).unwrap();
            *meta = previous;
            return Err(err);
        }
        Ok(result)
    }

    pub fn list_folders(&self) -> Vec<String> {
        let mut folders = std::collections::BTreeSet::new();
        folders.insert(String::new());
        for folder in self.manifest["folders"].as_array().into_iter().flatten() {
            if let Some(f) = folder.as_str() {
                folders.insert(f.to_string());
            }
        }
        for note in self.manifest["notes"].as_array().into_iter().flatten() {
            let mut current = note["folderPath"].as_str().unwrap_or("");
            while !current.is_empty() {
                folders.insert(current.to_string());
                current = match current.rfind('/') {
                    Some(index) => &current[..index],
                    None => "",
                };
            }
        }
        folders.into_iter().collect()
    }

    pub fn rename_folder(&mut self, old_folder_path: &str, new_folder_path: &str) -> Result<(), String> {
        if old_folder_path.is_empty() {
            return Err("Cannot rename the vault root".into());
        }
        validate_folder_path(old_folder_path)?;
        validate_folder_path(new_folder_path)?;
        if new_folder_path != old_folder_path
            && self.list_folders().iter().any(|f| f == new_folder_path)
        {
            return Err(format!("A folder named \"{new_folder_path}\" already exists"));
        }
        let previous_manifest = self.manifest.clone();
        let prefix = format!("{old_folder_path}/");
        let rewrite = |folder: &str| -> String {
            if folder == old_folder_path || folder.starts_with(&prefix) {
                format!("{new_folder_path}{}", &folder[old_folder_path.len()..])
            } else {
                folder.to_string()
            }
        };
        for note in self.manifest["notes"].as_array_mut().into_iter().flatten() {
            if let Some(folder) = note["folderPath"].as_str() {
                note["folderPath"] = json!(rewrite(folder));
            }
        }
        for folder in self.manifest["folders"].as_array_mut().into_iter().flatten() {
            if let Some(f) = folder.as_str() {
                *folder = json!(rewrite(f));
            }
        }
        for database in self.manifest["databases"].as_array_mut().into_iter().flatten() {
            if let Some(folder) = database["folderPath"].as_str() {
                database["folderPath"] = json!(rewrite(folder));
            }
        }
        if let Err(err) = self.write_manifest() {
            self.manifest = previous_manifest;
            return Err(err);
        }
        Ok(())
    }

    pub fn delete_folder(&mut self, folder_path: &str) -> Result<Vec<String>, String> {
        if folder_path.is_empty() {
            return Err("Cannot delete the vault root".into());
        }
        validate_folder_path(folder_path)?;
        let prefix = format!("{folder_path}/");
        let in_folder = |f: &str| f == folder_path || f.starts_with(&prefix);

        let affected_ids: Vec<String> = self.manifest["notes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["folderPath"].as_str().is_some_and(in_folder))
            .filter_map(|n| n["id"].as_str().map(String::from))
            .collect();
        let affected_database_ids: std::collections::HashSet<String> = self
            .databases()
            .iter()
            .filter(|d| d["folderPath"].as_str().is_some_and(in_folder))
            .filter_map(|d| d["id"].as_str().map(String::from))
            .collect();

        // No surviving database may keep a relation pointed at one being deleted — same
        // guard as deleteFolder() in vault.ts.
        for database in self.databases().to_vec() {
            let id = database["id"].as_str().unwrap_or("");
            if affected_database_ids.contains(id) {
                continue;
            }
            let data = self.read_database(id)?;
            if data["properties"].as_array().into_iter().flatten().any(|p| {
                p["relationDatabaseId"]
                    .as_str()
                    .is_some_and(|rel| affected_database_ids.contains(rel))
            }) {
                let title = database["title"].as_str().unwrap_or("");
                return Err(format!(
                    "Folder contains a database linked from \"{title}\"; remove that relation before deleting the folder"
                ));
            }
        }

        let previous_manifest = self.manifest.clone();
        let affected_note_ids: std::collections::HashSet<&str> =
            affected_ids.iter().map(String::as_str).collect();
        if let Some(notes) = self.manifest["notes"].as_array_mut() {
            notes.retain(|n| !n["id"].as_str().is_some_and(|id| affected_note_ids.contains(id)));
        }
        self.databases_mut()
            .retain(|d| !d["id"].as_str().is_some_and(|id| affected_database_ids.contains(id)));
        if let Some(folders) = self.manifest["folders"].as_array_mut() {
            folders.retain(|f| !f.as_str().is_some_and(in_folder));
        }
        if let Some(items) = self.manifest["canvasItems"].as_array_mut() {
            items.retain(|item| {
                let target = item["targetId"].as_str().unwrap_or("");
                if item["kind"] == "note" {
                    !affected_note_ids.contains(target)
                } else {
                    !affected_database_ids.contains(target)
                }
            });
        }
        if let Err(err) = self.write_manifest() {
            self.manifest = previous_manifest;
            return Err(err);
        }
        for id in &affected_database_ids {
            let _ = fs::remove_file(self.database_path(id)?);
        }
        for id in &affected_ids {
            let _ = fs::remove_file(self.note_path(id)?);
        }
        Ok(affected_ids)
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    fn title_property() -> Value {
        json!({ "id": "p1", "name": "Name", "type": "title" })
    }

    #[test]
    fn database_properties_require_exactly_one_title() {
        assert!(validate_database_properties(&[]).is_err());
        assert!(validate_database_properties(&[
            json!({ "id": "p1", "name": "A", "type": "text" }),
        ])
        .is_err());
        assert!(validate_database_properties(&[title_property(), title_property()]).is_err());
        assert!(validate_database_properties(&[title_property()]).is_ok());
    }

    #[test]
    fn database_properties_reject_duplicate_ids_and_names() {
        let duplicate_id = [
            title_property(),
            json!({ "id": "p1", "name": "Other", "type": "text" }),
        ];
        assert!(validate_database_properties(&duplicate_id).is_err());
        let duplicate_name = [
            title_property(),
            json!({ "id": "p2", "name": "name", "type": "text" }),
        ];
        // "Name" vs "name" collide case-insensitively, same as vault.ts's normalizedName.
        assert!(validate_database_properties(&duplicate_name).is_err());
    }

    #[test]
    fn database_properties_validate_relation_and_rollup_shape() {
        let bad_relation = [
            title_property(),
            json!({ "id": "p2", "name": "Rel", "type": "relation", "relationDatabaseId": "not-a-uuid" }),
        ];
        assert!(validate_database_properties(&bad_relation).is_err());
        let good_relation = [
            title_property(),
            json!({
                "id": "p2", "name": "Rel", "type": "relation",
                "relationDatabaseId": "11111111-1111-1111-1111-111111111111",
            }),
        ];
        assert!(validate_database_properties(&good_relation).is_ok());
        let bad_rollup = [
            title_property(),
            json!({ "id": "p2", "name": "Roll", "type": "rollup" }),
        ];
        assert!(validate_database_properties(&bad_rollup).is_err());
        let good_rollup = [
            title_property(),
            json!({
                "id": "p2", "name": "Roll", "type": "rollup",
                "rollupRelationPropertyId": "p1", "rollupTargetPropertyId": "p1",
                "rollupFunction": "count",
            }),
        ];
        assert!(validate_database_properties(&good_rollup).is_ok());
    }

    #[test]
    fn database_rows_reject_unknown_properties_duplicate_ids_and_bad_cells() {
        let properties = [title_property()];
        assert!(validate_database_rows(&properties, &json!("not an array")).is_err());
        assert!(validate_database_rows(&properties, &json!([{ "id": "r1", "values": {} }])).is_ok());
        assert!(validate_database_rows(
            &properties,
            &json!([{ "id": "r1", "values": { "unknown": "x" } }])
        )
        .is_err());
        assert!(validate_database_rows(
            &properties,
            &json!([
                { "id": "r1", "values": {} },
                { "id": "r1", "values": {} },
            ])
        )
        .is_err());
        assert!(validate_database_rows(
            &properties,
            &json!([{ "id": "r1", "values": { "p1": { "nested": true } } }])
        )
        .is_err());
        assert!(validate_database_rows(
            &properties,
            &json!([{ "id": "r1", "values": { "p1": ["a", "b"] } }])
        )
        .is_ok());
    }

    #[test]
    fn database_views_require_valid_property_references() {
        let properties = [title_property()];
        assert!(validate_database_views(&json!([]), &properties).is_err());
        assert!(validate_database_views(
            &json!([{ "id": "v1", "name": "Table", "type": "table" }]),
            &properties
        )
        .is_ok());
        assert!(validate_database_views(
            &json!([{
                "id": "v1", "name": "Table", "type": "table", "sortPropertyId": "missing",
            }]),
            &properties
        )
        .is_err());
        assert!(validate_database_views(
            &json!([{ "id": "v1", "name": "Table", "type": "table", "sortDirection": "sideways" }]),
            &properties
        )
        .is_err());
    }

    #[test]
    fn clear_relation_to_row_handles_array_and_csv_shaped_values() {
        let properties = [json!({
            "id": "rel", "name": "Rel", "type": "relation", "relationDatabaseId": "db1",
        })];
        let array_rows = [json!({ "id": "r1", "values": { "rel": ["row-a", "row-b"] } })];
        let (updated, changed) = clear_relation_to_row(&array_rows, &properties, "db1", "row-a");
        assert!(changed);
        assert_eq!(updated[0]["values"]["rel"], json!(["row-b"]));

        let csv_rows = [json!({ "id": "r1", "values": { "rel": "row-a, row-b" } })];
        let (updated, changed) = clear_relation_to_row(&csv_rows, &properties, "db1", "row-a");
        assert!(changed);
        assert_eq!(updated[0]["values"]["rel"], json!("row-b"));

        let unrelated_rows = [json!({ "id": "r1", "values": { "rel": ["row-b"] } })];
        let (_, changed) = clear_relation_to_row(&unrelated_rows, &properties, "db1", "row-a");
        assert!(!changed);
    }

    #[test]
    fn canvas_items_enforce_bounds_unique_ids_and_valid_targets() {
        let notes = [json!({ "id": "11111111-1111-1111-1111-111111111111" })];
        let databases: [Value; 0] = [];
        let good = json!({
            "id": "22222222-2222-2222-2222-222222222222",
            "kind": "note",
            "targetId": "11111111-1111-1111-1111-111111111111",
            "x": 5, "y": 5,
        });
        assert!(validate_canvas_items(std::slice::from_ref(&good), &notes, &databases).is_ok());

        let mut out_of_bounds = good.clone();
        out_of_bounds["x"] = json!(20000);
        assert!(validate_canvas_items(&[out_of_bounds], &notes, &databases).is_err());

        let mut wrong_target = good.clone();
        wrong_target["targetId"] = json!("not-a-real-note");
        assert!(validate_canvas_items(&[wrong_target], &notes, &databases).is_err());

        assert!(validate_canvas_items(&[good.clone(), good], &notes, &databases).is_err());
    }

    #[test]
    fn extension_validation_enforces_permission_and_id_shape() {
        let valid = json!({
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "Ext",
            "source": "void 0;",
            "permissions": ["read_notes"],
            "databaseIds": [],
        });
        assert!(validate_extension(&valid).is_ok());

        let mut bad_permission = valid.clone();
        bad_permission["permissions"] = json!(["delete_everything"]);
        assert!(validate_extension(&bad_permission).is_err());

        let mut empty_name = valid.clone();
        empty_name["name"] = json!("   ");
        assert!(validate_extension(&empty_name).is_err());

        let mut bad_database_id = valid;
        bad_database_id["databaseIds"] = json!(["not-a-uuid"]);
        assert!(validate_extension(&bad_database_id).is_err());
    }
}
