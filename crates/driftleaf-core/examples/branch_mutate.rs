// Drives a scripted sequence of native mutations against a real branch, for the Node
// interop harnesses (scripts/tests/mutation-interop.mjs, database-interop.mjs, ...) to
// compare against vault.ts. Each op is a JSON object with a "type" field; any string value
// anywhere in an op (including nested in arrays/objects) matching "$note:N", "$db:N",
// "$row:N", or "$ext:N" is replaced with the Nth id created by a prior op of that kind in
// this same invocation, before the op runs — so a script can chain "create X, then
// reference X's real generated id" without the caller needing to predict UUIDs.
use driftleaf_core::mutation::Branch;
use serde_json::Value;
use std::io::{self, Read};

fn resolve_placeholder(text: &str, lists: &Lists) -> Option<String> {
    let (list, rest) = if let Some(r) = text.strip_prefix("$note:") {
        (&lists.notes, r)
    } else if let Some(r) = text.strip_prefix("$db:") {
        (&lists.databases, r)
    } else if let Some(r) = text.strip_prefix("$row:") {
        (&lists.rows, r)
    } else if let Some(r) = text.strip_prefix("$ext:") {
        (&lists.extensions, r)
    } else {
        return None;
    };
    list.get(rest.parse::<usize>().ok()?).cloned()
}

fn resolve(value: &mut Value, lists: &Lists) {
    match value {
        Value::String(s) => {
            if let Some(resolved) = resolve_placeholder(s, lists) {
                *s = resolved;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| resolve(item, lists)),
        Value::Object(map) => map.values_mut().for_each(|item| resolve(item, lists)),
        _ => {}
    }
}

#[derive(Default)]
struct Lists {
    notes: Vec<String>,
    databases: Vec<String>,
    rows: Vec<String>,
    extensions: Vec<String>,
    orphans: Vec<String>,
    imports: Vec<Value>,
    exports: Vec<Value>,
}

fn str_field<'a>(op: &'a Value, name: &str) -> Result<&'a str, String> {
    op.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing \"{name}\" on op {op}"))
}

fn opt_str_field<'a>(op: &'a Value, name: &str) -> Option<&'a str> {
    op.get(name).and_then(Value::as_str)
}

fn strings_field(op: &Value, name: &str) -> Vec<String> {
    op.get(name)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin()
        .read_to_string(&mut request)
        .map_err(|e| e.to_string())?;
    let request: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let root = str_field(&request, "root")?;
    let passphrase = str_field(&request, "passphrase")?;
    let mut branch = Branch::open(std::path::Path::new(root), passphrase)?;

    let mut lists = Lists::default();
    for raw_op in request["ops"].as_array().ok_or("Missing ops")? {
        let mut op = raw_op.clone();
        resolve(&mut op, &lists);
        match str_field(&op, "type")? {
            "createNote" => {
                let meta = branch.create_note(str_field(&op, "folderPath")?, str_field(&op, "title")?)?;
                lists.notes.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
            }
            "writeNote" => branch.write_note(str_field(&op, "id")?, str_field(&op, "content")?)?,
            "renameNote" => branch.rename_note(str_field(&op, "id")?, str_field(&op, "title")?)?,
            "deleteNote" => branch.delete_note(str_field(&op, "id")?)?,
            "moveNote" => {
                branch.move_note(str_field(&op, "id")?, str_field(&op, "targetFolder")?)?;
            }
            "createFolder" => branch.create_folder(str_field(&op, "folderPath")?)?,
            "renameFolder" => branch.rename_folder(str_field(&op, "oldFolderPath")?, str_field(&op, "newFolderPath")?)?,
            "deleteFolder" => {
                branch.delete_folder(str_field(&op, "folderPath")?)?;
            }
            "orphanNoteFile" => {
                let id = branch.write_orphan_note_file(str_field(&op, "content")?)?;
                lists.orphans.push(id);
            }
            "createDatabase" => {
                let meta = branch.create_database(
                    str_field(&op, "title")?,
                    str_field(&op, "folderPath")?,
                    op["properties"].clone(),
                    op.get("rows").cloned().unwrap_or(Value::Array(vec![])),
                    op.get("views").cloned(),
                    opt_str_field(&op, "activeViewId"),
                )?;
                lists.databases.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
            }
            "renameDatabase" => {
                branch.rename_database(str_field(&op, "id")?, str_field(&op, "title")?)?;
            }
            "updateDatabase" => branch.update_database(
                str_field(&op, "id")?,
                op["properties"].clone(),
                op["rows"].clone(),
                op.get("views").cloned(),
                opt_str_field(&op, "activeViewId"),
            )?,
            "createDatabaseRow" => {
                let row = branch.create_database_row(str_field(&op, "id")?)?;
                lists.rows.push(row["id"].as_str().ok_or("Missing row id")?.to_owned());
            }
            "deleteDatabaseRow" => branch.delete_database_row(str_field(&op, "id")?, str_field(&op, "rowId")?)?,
            "deleteDatabase" => branch.delete_database(str_field(&op, "id")?)?,
            "updateCanvas" => branch.update_canvas(op["items"].clone())?,
            "installExtension" => {
                let summary = branch.install_extension(str_field(&op, "name")?, str_field(&op, "source")?)?;
                lists
                    .extensions
                    .push(summary["id"].as_str().ok_or("Missing id")?.to_owned());
            }
            "setExtensionPermissions" => branch.set_extension_permissions(
                str_field(&op, "id")?,
                &strings_field(&op, "permissions"),
                &strings_field(&op, "databaseIds"),
            )?,
            "removeExtension" => branch.remove_extension(str_field(&op, "id")?)?,
            "importFiles" => {
                let file_paths: Vec<&str> = op["filePaths"]
                    .as_array()
                    .ok_or("Missing filePaths")?
                    .iter()
                    .map(|v| v.as_str().ok_or("filePaths must be strings"))
                    .collect::<Result<_, _>>()?;
                let result = branch.import_files(&file_paths, str_field(&op, "targetFolder")?);
                for meta in &result.imported {
                    lists.notes.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
                }
                for meta in &result.imported_databases {
                    lists.databases.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
                }
                lists.imports.push(serde_json::json!({
                    "imported": result.imported,
                    "importedDatabases": result.imported_databases,
                    "skipped": result.skipped,
                }));
            }
            "importTemplateArchive" => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(str_field(&op, "archiveBase64")?)
                    .map_err(|e| e.to_string())?;
                let imported = branch.import_template_archive(&bytes, str_field(&op, "templateName")?)?;
                for meta in imported["imported"].as_array().into_iter().flatten() {
                    lists.notes.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
                }
                for meta in imported["importedDatabases"].as_array().into_iter().flatten() {
                    lists.databases.push(meta["id"].as_str().ok_or("Missing id")?.to_owned());
                }
                lists.imports.push(imported);
            }
            "exportDatabase" => {
                let (title, content) = branch.export_database(str_field(&op, "id")?, str_field(&op, "format")?)?;
                lists.exports.push(serde_json::json!({ "title": title, "content": content }));
            }
            other => return Err(format!("Unknown op type: {other}")),
        }
    }

    let mut notes = serde_json::Map::new();
    for note in branch.manifest["notes"].as_array().ok_or("Missing notes")? {
        let id = note["id"].as_str().ok_or("Missing note ID")?;
        notes.insert(id.into(), serde_json::json!(branch.read_note(id)?));
    }
    let mut databases = serde_json::Map::new();
    for database in branch.list_databases(None).as_array().ok_or("Missing databases")? {
        let id = database["id"].as_str().ok_or("Missing database ID")?;
        databases.insert(id.into(), branch.read_database(id)?);
    }

    let search_index = driftleaf_core::search::SearchIndex::open()?;
    search_index.build_from_branch(&branch)?;
    let mut search_results = serde_json::Map::new();
    for query in request["searchQueries"].as_array().into_iter().flatten() {
        let query = query.as_str().ok_or("searchQueries must be strings")?;
        search_results.insert(query.to_string(), search_index.search(query)?);
    }
    let search_output = serde_json::json!({ "results": search_results, "noteGraph": search_index.build_note_graph()? });

    println!(
        "{}",
        serde_json::json!({
            "manifest": branch.manifest,
            "createdNotes": lists.notes,
            "createdDatabases": lists.databases,
            "createdRows": lists.rows,
            "createdExtensions": lists.extensions,
            "orphans": lists.orphans,
            "notes": notes,
            "databases": databases,
            "canvas": branch.read_canvas(),
            "extensions": branch.list_extensions(),
            "health": branch.inspect(),
            "imports": lists.imports,
            "exports": lists.exports,
            "search": search_output,
        })
    );
    Ok(())
}
