//! Ports importFiles()/importZipArchive()/importTemplateArchive()/importZipEntries() from
//! src/main/vault.ts. Unlike vault.ts (which receives bare file paths from an Electron
//! picker), this runs *inside* Rust, which already owns the native file dialog in the
//! Tauri shell — so there is no separate "trusted" picker-allowlist step to reproduce here,
//! only the import logic itself.
use crate::database_import::{parse_csv_database, parse_json_database};
use crate::mutation::Branch;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;

// Same zip-bomb guards as vault.ts: reject by entry count, and by each entry's *uncompressed*
// size (available from the zip central directory without decompressing) before reading it.
const MAX_IMPORT_ENTRIES: usize = 20_000;
const MAX_IMPORT_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEMPLATE_ARCHIVE_BYTES: usize = 25 * 1024 * 1024;

pub struct ImportResult {
    pub imported: Vec<Value>,         // note metas
    pub imported_databases: Vec<Value>, // database metas
    pub skipped: Vec<String>,
}

impl ImportResult {
    fn to_json(&self) -> Value {
        json!({
            "imported": self.imported,
            "importedDatabases": self.imported_databases,
            "skipped": self.skipped,
        })
    }
}

fn decode_strict_utf8(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "not valid UTF-8 text".to_string())
}

fn import_table(branch: &mut Branch, ext: &str, content: &str, title: &str, folder_path: &str) -> Result<Value, String> {
    let parsed = if ext == "csv" { parse_csv_database(content, title) } else { parse_json_database(content, title) }?;
    branch.create_database(&parsed.title, folder_path, parsed.properties, parsed.rows, None, None)
}

impl Branch {
    /// Imports a mix of real files from disk: each `.md` becomes its own note, `.zip`
    /// archives are expanded (see `import_zip_entries`), and `.csv`/`.json` become
    /// databases. One bad file never aborts the rest of the batch.
    pub fn import_files(&mut self, file_paths: &[impl AsRef<Path>], target_folder: &str) -> ImportResult {
        let mut result = ImportResult { imported: Vec::new(), imported_databases: Vec::new(), skipped: Vec::new() };
        for file_path in file_paths {
            let file_path = file_path.as_ref();
            let base_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let ext = file_path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let outcome: Result<(), String> = (|| {
                if ext == "md" {
                    let content = decode_strict_utf8(std::fs::read(file_path).map_err(|e| e.to_string())?)?;
                    let title = file_path.file_stem().map(|s| s.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Untitled".into());
                    self.ensure_folder_chain(target_folder)?;
                    let meta = self.create_note(target_folder, &title)?;
                    self.write_note(meta["id"].as_str().unwrap(), &content)?;
                    result.imported.push(meta);
                } else if ext == "zip" {
                    let bytes = std::fs::read(file_path).map_err(|e| e.to_string())?;
                    let sub = self.import_zip_bytes(&bytes, &base_name, target_folder);
                    result.imported.extend(sub.imported);
                    result.imported_databases.extend(sub.imported_databases);
                    result.skipped.extend(sub.skipped);
                } else if ext == "csv" || ext == "json" {
                    let metadata = std::fs::metadata(file_path).map_err(|e| e.to_string())?;
                    if metadata.len() > MAX_IMPORT_ENTRY_BYTES {
                        return Err(format!("file too large to import (over {}MB)", MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)));
                    }
                    let bytes = std::fs::read(file_path).map_err(|e| e.to_string())?;
                    if bytes.len() as u64 > MAX_IMPORT_ENTRY_BYTES {
                        return Err(format!("file too large to import (over {}MB)", MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)));
                    }
                    let text = decode_strict_utf8(bytes)?;
                    let title = file_path.file_stem().map(|s| s.to_string_lossy().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Untitled database".into());
                    let meta = import_table(self, &ext, &text, &title, target_folder)?;
                    result.imported_databases.push(meta);
                } else {
                    result.skipped.push(format!("{base_name} (unsupported file type — only .md, .csv, .json, and .zip can be imported)"));
                }
                Ok(())
            })();
            if let Err(message) = outcome {
                result.skipped.push(format!("{base_name} ({message})"));
            }
        }
        result
    }

    fn import_zip_bytes(&mut self, bytes: &[u8], archive_name: &str, target_folder: &str) -> ImportResult {
        let archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
            Ok(archive) => archive,
            Err(error) => {
                return ImportResult {
                    imported: Vec::new(),
                    imported_databases: Vec::new(),
                    skipped: vec![format!("{archive_name} ({error})")],
                };
            }
        };
        self.import_zip_entries(archive, archive_name, target_folder)
    }

    fn import_zip_entries<R: Read + std::io::Seek>(
        &mut self,
        mut archive: zip::ZipArchive<R>,
        archive_name: &str,
        target_folder: &str,
    ) -> ImportResult {
        let mut result = ImportResult { imported: Vec::new(), imported_databases: Vec::new(), skipped: Vec::new() };
        if archive.len() > MAX_IMPORT_ENTRIES {
            result.skipped.push(format!("{archive_name} (archive has too many entries — over {MAX_IMPORT_ENTRIES})"));
            return result;
        }
        for index in 0..archive.len() {
            let mut entry = match archive.by_index(index) {
                Ok(entry) => entry,
                Err(error) => {
                    result.skipped.push(format!("entry {index} ({error})"));
                    continue;
                }
            };
            if entry.is_dir() {
                continue;
            }
            let entry_name = entry.name().to_string();
            let ext = Path::new(&entry_name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !["md", "csv", "json"].contains(&ext.as_str()) {
                continue;
            }
            let outcome: Result<(), String> = (|| {
                if entry.size() > MAX_IMPORT_ENTRY_BYTES {
                    return Err(format!("file too large to import (over {}MB)", MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)));
                }
                // Zip entry names always use "/"; reject anything that could escape the
                // branch (zip-slip): ".." segments or an absolute-looking path.
                let rel_path = entry_name.replace('\\', "/");
                if rel_path.contains("..") || rel_path.starts_with('/') {
                    return Err("unsafe path in archive".into());
                }
                let (rel_dir, file_name) = match rel_path.rfind('/') {
                    Some(i) => (&rel_path[..i], &rel_path[i + 1..]),
                    None => ("", rel_path.as_str()),
                };
                let title = {
                    let stripped = file_name
                        .strip_suffix(".md")
                        .or_else(|| file_name.strip_suffix(".csv"))
                        .or_else(|| file_name.strip_suffix(".json"))
                        .unwrap_or(file_name);
                    if stripped.is_empty() { "Untitled".to_string() } else { stripped.to_string() }
                };
                let folder_path = if !target_folder.is_empty() {
                    if !rel_dir.is_empty() { format!("{target_folder}/{rel_dir}") } else { target_folder.to_string() }
                } else {
                    rel_dir.to_string()
                };
                crate::mutation::validate_folder_path(&folder_path)?;

                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                let content = decode_strict_utf8(bytes)?;
                if ext == "md" {
                    self.ensure_folder_chain(&folder_path)?;
                    let meta = self.create_note(&folder_path, &title)?;
                    self.write_note(meta["id"].as_str().unwrap(), &content)?;
                    result.imported.push(meta);
                } else {
                    let meta = import_table(self, &ext, &content, &title, &folder_path)?;
                    result.imported_databases.push(meta);
                }
                Ok(())
            })();
            if let Err(message) = outcome {
                result.skipped.push(format!("{entry_name} ({message})"));
            }
        }
        result
    }

    /// Imports a community template archive (raw bytes, as received over the network —
    /// not a path on disk) under a sanitized `Community templates/<name>` folder.
    pub fn import_template_archive(&mut self, archive: &[u8], template_name: &str) -> Result<Value, String> {
        if archive.len() > MAX_TEMPLATE_ARCHIVE_BYTES {
            return Err("Templates must be smaller than 25 MB".into());
        }
        let zip_archive = zip::ZipArchive::new(std::io::Cursor::new(archive))
            .map_err(|error| format!("Could not read template archive: {error}"))?;
        let safe_name: String = template_name
            .chars()
            .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c })
            .collect::<String>()
            .trim()
            .to_string();
        if safe_name.is_empty() {
            return Err("Template name is invalid".into());
        }
        let result = self.import_zip_entries(zip_archive, &format!("{safe_name}.zip"), &format!("Community templates/{safe_name}"));
        Ok(result.to_json())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // There is no Rust createVault() (vault *creation* isn't ported — only mutation of an
    // already-existing one), so this test needs its own minimal from-scratch branch layout:
    // just enough of vault.json/canary.enc/manifest.enc for Branch::open() to succeed.
    fn open_branch(root: &Path, passphrase: &str) -> Branch {
        use crate::{derive_key, encrypt};
        let private = root.join(crate::DRIFTLEAF_DIR);
        std::fs::create_dir_all(private.join("notes")).unwrap();
        let salt = [7u8; 16];
        let key = derive_key(passphrase, &salt).unwrap();
        std::fs::write(
            private.join("vault.json"),
            format!(r#"{{"version":1,"kdf":"scrypt","saltHex":"{}"}}"#, hex::encode(salt)),
        )
        .unwrap();
        std::fs::write(private.join("canary.enc"), encrypt(b"driftleaf-vault-v1", &key).unwrap()).unwrap();
        let manifest = br#"{"notes":[],"folders":[],"databases":[],"extensions":[],"canvasItems":[]}"#;
        std::fs::write(private.join("manifest.enc"), encrypt(manifest, &key).unwrap()).unwrap();
        Branch::open(root, passphrase).unwrap()
    }

    // AdmZip (the Node reference implementation's zip library, used on the Node side of
    // the interop test) silently strips ".." from entry names on write, so a zip-slip
    // fixture can't survive a round trip through it — this builds a raw zip with the
    // literal entry name directly, the way a hand-crafted or non-AdmZip archive could.
    fn zip_with_raw_entry_names(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_slip_entries_are_rejected_without_aborting_the_rest() {
        let temp = std::env::temp_dir().join(format!("driftleaf-import-unit-{}", crate::random_hex(8)));
        std::fs::create_dir_all(&temp).unwrap();
        let mut branch = open_branch(&temp, "Test fixture passphrase");

        let bytes = zip_with_raw_entry_names(&[
            ("../escape.md", b"must not escape"),
            ("safe.md", b"this one is fine"),
        ]);
        let archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let result = branch.import_zip_entries(archive, "archive.zip", "");
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0]["title"], "safe");
        assert_eq!(result.skipped.len(), 1);
        assert!(result.skipped[0].contains("unsafe path in archive"));

        std::fs::remove_dir_all(&temp).ok();
    }
}
