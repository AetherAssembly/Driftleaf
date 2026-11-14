//! Whole-branch plaintext export, ported from exportBranchPlaintext() in
//! src/main/branch-export.ts: every live note as a Markdown file in its folder, every live
//! database as CSV and JSON, and every attachment as an ordinary file. It is the one place
//! decrypted content is deliberately written to disk; the caller is responsible for making
//! sure the user asked for that and chose the destination. Nothing in Trash is exported.
use crate::{
    backup::{chrono_like_timestamp, path_is_within},
    decrypt, js_trim,
    mutation::Branch,
    random_uuid_v4,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

fn attachment_link() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i-u)attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        )
        .expect("attachment link pattern is valid")
    })
}

// `.replace(/[. ]+$/g, "")`
fn strip_trailing_dots_and_spaces(text: &str) -> &str {
    text.trim_end_matches(['.', ' '])
}

// WINDOWS_RESERVED: /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
fn is_windows_reserved(name: &str) -> bool {
    let (stem, rest) = match name.find('.') {
        Some(dot) => (&name[..dot], &name[dot..]),
        None => (name, ""),
    };
    // `.` in the pattern does not match a line terminator.
    if rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return false;
    }
    let lower = stem.to_ascii_lowercase();
    if matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    let bytes = lower.as_bytes();
    bytes.len() == 4
        && (lower.starts_with("com") || lower.starts_with("lpt"))
        && (b'1'..=b'9').contains(&bytes[3])
}

/// Mirrors safeSegment(): makes one path segment safe on Windows, macOS, and Linux at
/// once: no separators, no characters NTFS rejects, no trailing dots or spaces, no device
/// names.
pub(crate) fn safe_segment(value: &str, fallback: &str) -> String {
    let replaced: String = value
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\u{0000}'..='\u{001f}') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = js_trim(strip_trailing_dots_and_spaces(&replaced));
    // `.slice(0, 100)` counts UTF-16 code units; a character that would straddle the
    // limit is dropped whole (see clean_attachment_name in attachments.rs).
    let mut cut = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > 100 {
            break;
        }
        cut.push(c);
    }
    let cleaned = strip_trailing_dots_and_spaces(&cut);
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    if is_windows_reserved(cleaned) {
        format!("{cleaned}_")
    } else {
        cleaned.to_string()
    }
}

/// Mirrors splitExtension(): the extension is whatever follows the last dot, unless there
/// is no dot, the name starts with it, or the extension would be longer than 11 characters.
pub(crate) fn split_extension(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(dot) if dot > 0 && file_name[dot..].encode_utf16().count() <= 12 => {
            (&file_name[..dot], &file_name[dot..])
        }
        _ => (file_name, ""),
    }
}

/// Mirrors NameRegistry: hands out file names that are unique within a directory, compared
/// case-insensitively so the export also unpacks cleanly on case-insensitive filesystems.
#[derive(Default)]
struct NameRegistry {
    used: HashMap<String, HashSet<String>>,
}

impl NameRegistry {
    fn claim(&mut self, directory: &str, stem: &str, extension: &str) -> String {
        // Same as NameRegistry in src/main/branch-export.ts: "Case" and "case" are one
        // folder on macOS and Windows, so they share one set of taken names.
        let names = self.used.entry(directory.to_lowercase()).or_default();
        let mut candidate = format!("{stem}{extension}");
        let mut suffix = 2;
        while names.contains(&candidate.to_lowercase()) {
            candidate = format!("{stem} ({suffix}){extension}");
            suffix += 1;
        }
        names.insert(candidate.to_lowercase());
        candidate
    }
}

/// Mirrors exportFolderFor().
pub(crate) fn export_folder_for(folder_path: &str) -> String {
    folder_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| safe_segment(segment, "folder"))
        .collect::<Vec<_>>()
        .join("/")
}

/// Mirrors encodeLinkPath(): encodeURIComponent() on each segment (".." left alone), with
/// parentheses escaped too, since a Markdown link target cannot contain them raw.
pub(crate) fn encode_link_path(relative_path: &str) -> String {
    relative_path
        .split('/')
        .map(|segment| {
            if segment == ".." {
                return segment.to_string();
            }
            let mut encoded = String::new();
            for byte in segment.bytes() {
                if byte.is_ascii_alphanumeric() || b"-_.!~*'".contains(&byte) {
                    encoded.push(byte as char);
                } else if byte == b'(' || byte == b')' {
                    // The reference escapes these with lower-case hex ("%28", "%29" have
                    // no letters, so the case never shows).
                    encoded.push_str(&format!("%{byte:x}"));
                } else {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
            encoded
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn join_segments(base: &Path, folder: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for segment in folder.split('/').filter(|segment| !segment.is_empty()) {
        path.push(segment);
    }
    path
}

// writeFile(path, data, { flag: "wx" }): never overwrite.
fn write_new_file(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())
}

// Archives everything under `directory` into `zip_path`, under one top-level folder named
// `top`. Entries are written in sorted order so the archive's listing is stable, and empty
// folders are kept as directory entries.
fn zip_directory(directory: &Path, top: &str, zip_path: &Path) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    fn walk(dir: &Path, relative: &str, entries: &mut Vec<(String, std::path::PathBuf, bool)>) -> Result<(), String> {
        let mut children: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child.file_name().to_string_lossy().to_string();
            let child_relative = format!("{relative}/{name}");
            if child.file_type().map_err(|e| e.to_string())?.is_dir() {
                entries.push((format!("{child_relative}/"), child.path(), true));
                walk(&child.path(), &child_relative, entries)?;
            } else {
                entries.push((child_relative, child.path(), false));
            }
        }
        Ok(())
    }
    let mut entries = vec![(format!("{top}/"), directory.to_path_buf(), true)];
    walk(directory, top, &mut entries)?;

    let file = fs::OpenOptions::new().write(true).create_new(true).open(zip_path).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, path, is_dir) in entries {
        if is_dir {
            writer.add_directory(name, options).map_err(|e| e.to_string())?;
        } else {
            writer.start_file(name, options).map_err(|e| e.to_string())?;
            writer.write_all(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
    }
    let file = writer.finish().map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

impl Branch {
    // readNote() as the export sees it: the same "corrupted" wording when the file does
    // not decrypt, and the same lossy UTF-8 decoding as Buffer#toString("utf-8").
    fn read_note_for_export(&self, id: &str) -> Result<String, String> {
        let encrypted = fs::read(self.note_path(id)?).map_err(|e| e.to_string())?;
        let decrypted = decrypt(&encrypted, &self.key)
            .map_err(|_| format!("Note is corrupted and cannot be decrypted: {id}"))?;
        Ok(String::from_utf8_lossy(&decrypted).into_owned())
    }

    /// Mirrors exportBranchPlaintext(). Writes into a hidden work folder next to the final
    /// one and renames it into place at the end, so an interrupted export leaves nothing
    /// that looks complete. One unreadable item does not abort the rest: it is listed in
    /// `skipped` as `"<name> (<reason>)"`. Returns
    /// `{ path, notes, databases, attachments, skipped }`.
    pub fn export_plaintext(&self, destination_parent: &Path) -> Result<Value, String> {
        let source = self.root.canonicalize().map_err(|e| e.to_string())?;
        let destination = destination_parent.canonicalize().map_err(|e| e.to_string())?;
        if path_is_within(&source, &destination) {
            return Err("Choose an export destination outside the open branch folder".into());
        }
        let base_name = format!(
            "Driftleaf-Export-{}-{}",
            crate::backup::branch_label(&source),
            chrono_like_timestamp()
        );
        let mut export_name = base_name.clone();
        let mut suffix = 2;
        while destination.join(format!("{export_name}.zip")).exists() {
            export_name = format!("{base_name}-{suffix}");
            suffix += 1;
        }
        // The export is one .zip holding a single top-level folder of the same name, which
        // is what other notes apps import. The plain files are staged in a hidden work
        // folder beside it, archived into a hidden temporary file, and only that finished
        // archive is renamed into place; the work folder is removed either way.
        let final_path = destination.join(format!("{export_name}.zip"));
        let work_path = destination.join(format!(".{export_name}.tmp-{}", random_uuid_v4()));
        let temporary_zip = destination.join(format!(".{export_name}.zip.tmp-{}", random_uuid_v4()));

        let result = self.export_into(&work_path).and_then(|counts| {
            zip_directory(&work_path, &export_name, &temporary_zip)?;
            fs::rename(&temporary_zip, &final_path).map_err(|e| e.to_string())?;
            Ok(counts)
        });
        let _ = fs::remove_dir_all(&work_path);
        if result.is_err() {
            let _ = fs::remove_file(&temporary_zip);
        }
        match result {
            Ok((notes, databases, attachments, skipped)) => Ok(json!({
                "path": final_path.to_string_lossy(),
                "notes": notes,
                "databases": databases,
                "attachments": attachments,
                "skipped": skipped,
            })),
            Err(err) => Err(err),
        }
    }

    fn export_into(&self, work_path: &Path) -> Result<(usize, usize, usize, Vec<String>), String> {
        let mut names = NameRegistry::default();
        let mut skipped: Vec<String> = Vec::new();
        let (mut notes, mut databases, mut attachments) = (0usize, 0usize, 0usize);
        fs::create_dir(work_path).map_err(|e| e.to_string())?;

        // Attachments first, so notes can be rewritten to point at the exported files.
        let mut attachment_files: HashMap<String, String> = HashMap::new();
        let attachment_metas = self.attachments().to_vec();
        if !attachment_metas.is_empty() {
            fs::create_dir(work_path.join("attachments")).map_err(|e| e.to_string())?;
        }
        for meta in &attachment_metas {
            let id = meta["id"].as_str().unwrap_or("");
            let name = meta["name"].as_str().unwrap_or("");
            let exported = (|| -> Result<String, String> {
                let (_, data) = self.read_attachment(id)?;
                let (stem, extension) = split_extension(name);
                // An extension that would clean down to nothing (".", ". ") is dropped;
                // otherwise it is used as recorded.
                let kept_extension = if !safe_segment(extension, "").is_empty() && extension.starts_with('.') {
                    extension
                } else {
                    ""
                };
                let file_name = names.claim("attachments", &safe_segment(stem, "attachment"), kept_extension);
                write_new_file(&work_path.join("attachments").join(&file_name), &data)?;
                Ok(file_name)
            })();
            match exported {
                Ok(file_name) => {
                    attachment_files.insert(id.to_ascii_lowercase(), format!("attachments/{file_name}"));
                    attachments += 1;
                }
                Err(reason) => skipped.push(format!("{name} ({reason})")),
            }
        }

        for folder in self.list_folders() {
            fs::create_dir_all(join_segments(work_path, &export_folder_for(&folder)))
                .map_err(|e| e.to_string())?;
        }

        for meta in self.manifest["notes"].as_array().into_iter().flatten() {
            let id = meta["id"].as_str().unwrap_or("");
            let title = meta["title"].as_str().unwrap_or("");
            let exported = (|| -> Result<(), String> {
                let folder = export_folder_for(meta["folderPath"].as_str().unwrap_or(""));
                let depth = if folder.is_empty() { 0 } else { folder.split('/').count() };
                let raw = self.read_note_for_export(id)?;
                let content = attachment_link().replace_all(&raw, |found: &regex::Captures| {
                    match attachment_files.get(&found[1].to_ascii_lowercase()) {
                        Some(file) => encode_link_path(&format!("{}{file}", "../".repeat(depth))),
                        None => found[0].to_string(),
                    }
                });
                let directory = join_segments(work_path, &folder);
                fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                let file_name = names.claim(&folder, &safe_segment(title, "Untitled"), ".md");
                write_new_file(&directory.join(file_name), content.as_bytes())
            })();
            match exported {
                Ok(()) => notes += 1,
                Err(reason) => {
                    skipped.push(format!("{} ({reason})", if title.is_empty() { "Untitled" } else { title }))
                }
            }
        }

        for meta in self.databases().to_vec() {
            let id = meta["id"].as_str().unwrap_or("");
            let title = meta["title"].as_str().unwrap_or("");
            let exported = (|| -> Result<(), String> {
                let folder = export_folder_for(meta["folderPath"].as_str().unwrap_or(""));
                let directory = join_segments(work_path, &folder);
                fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                let stem = safe_segment(title, "Database");
                for format in ["csv", "json"] {
                    let (_, content) = self.export_database(id, format)?;
                    let file_name = names.claim(&folder, &stem, &format!(".{format}"));
                    write_new_file(&directory.join(file_name), content.as_bytes())?;
                }
                Ok(())
            })();
            match exported {
                Ok(()) => databases += 1,
                Err(reason) => {
                    skipped.push(format!("{} ({reason})", if title.is_empty() { "Database" } else { title }))
                }
            }
        }

        Ok((notes, databases, attachments, skipped))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{random_hex, test_support::legacy_key_branch};
    use std::io::Read;

    fn archive_entry(path: &Path, name: &str) -> Option<Vec<u8>> {
        let file = fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).ok()?;
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents).unwrap();
        Some(contents)
    }

    fn archive_has_entry(path: &Path, name: &str) -> bool {
        let file = fs::File::open(path).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        let found = archive
            .file_names()
            .any(|entry| entry.expect("valid archive path").as_ref() == name);
        found
    }

    #[test]
    fn segments_are_made_safe_for_every_platform() {
        assert_eq!(safe_segment("Road/map", "x"), "Road-map");
        assert_eq!(safe_segment("Q4: Plans?", "x"), "Q4- Plans-");
        assert_eq!(safe_segment("a\tb\u{0000}c", "x"), "a-b-c");
        assert_eq!(safe_segment("trailing. . ", "x"), "trailing");
        assert_eq!(safe_segment("  padded  ", "x"), "padded");
        assert_eq!(safe_segment("...", "Untitled"), "Untitled");
        assert_eq!(safe_segment("", "folder"), "folder");
        assert_eq!(safe_segment(&"a".repeat(150), "x"), "a".repeat(100));
        // The cut can expose a new trailing dot or space, which is stripped again.
        assert_eq!(safe_segment(&format!("{}. tail", "a".repeat(99)), "x"), "a".repeat(99));
        assert_eq!(safe_segment(&"🌿".repeat(80), "x"), "🌿".repeat(50));
        for reserved in ["CON", "con", "Prn", "AUX", "nul", "COM1", "lpt9", "con.txt", "NUL.tar.gz"] {
            assert_eq!(safe_segment(reserved, "x"), format!("{reserved}_"), "{reserved}");
        }
        for fine in ["CONSOLE", "com0", "com10", "lpt", "a.con", "con-", "aux1"] {
            assert_eq!(safe_segment(fine, "x"), fine, "{fine}");
        }
    }

    #[test]
    fn extensions_are_split_like_the_reference() {
        assert_eq!(split_extension("photo.png"), ("photo", ".png"));
        assert_eq!(split_extension("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_extension("no extension"), ("no extension", ""));
        assert_eq!(split_extension(".hidden"), (".hidden", ""));
        assert_eq!(split_extension("trailing."), ("trailing", "."));
        // A dot plus eleven characters is still an extension; one more is not.
        assert_eq!(split_extension("a.12345678901"), ("a", ".12345678901"));
        assert_eq!(split_extension("a.123456789012"), ("a.123456789012", ""));
    }

    #[test]
    fn names_are_unique_per_directory_ignoring_case() {
        let mut names = NameRegistry::default();
        assert_eq!(names.claim("a", "Note", ".md"), "Note.md");
        assert_eq!(names.claim("a", "note", ".md"), "note (2).md");
        assert_eq!(names.claim("a", "NOTE", ".md"), "NOTE (3).md");
        assert_eq!(names.claim("a", "Note (2)", ".md"), "Note (2) (2).md");
        assert_eq!(names.claim("b", "Note", ".md"), "Note.md");
        assert_eq!(names.claim("B", "note", ".md"), "note (2).md");
        assert_eq!(names.claim("a", "Note", ".csv"), "Note.csv");
    }

    #[test]
    fn link_paths_are_percent_encoded_per_segment() {
        assert_eq!(
            encode_link_path("../../attachments/diagram (v2).png"),
            "../../attachments/diagram%20%28v2%29.png"
        );
        assert_eq!(encode_link_path("attachments/日本 🌿.pdf"), "attachments/%E6%97%A5%E6%9C%AC%20%F0%9F%8C%BF.pdf");
        assert_eq!(encode_link_path("a/b-_.!~*'c#?&=+,;@$[]"), "a/b-_.!~*'c%23%3F%26%3D%2B%2C%3B%40%24%5B%5D");
        assert_eq!(export_folder_for("Projects//Q4: Plans?/ . "), "Projects/Q4- Plans-/folder");
    }

    #[test]
    fn export_writes_live_content_only_and_rewrites_attachment_links() {
        let temp = std::env::temp_dir().join(format!("driftleaf-export-unit-{}", random_hex(8)));
        let root = temp.join("branch");
        let destination = temp.join("out");
        fs::create_dir_all(&destination).unwrap();
        let mut branch = legacy_key_branch(&root);
        let image = branch.add_attachment("diagram (v2).png", "image/png", b"PNGDATA").unwrap();
        let image_id = image["id"].as_str().unwrap().to_string();
        branch.create_folder("Empty").unwrap();
        let nested = branch.create_note("Projects/Q4: Plans?", "Road/map").unwrap();
        branch
            .write_note(nested["id"].as_str().unwrap(), &format!("See ![d](attachment:{image_id})"))
            .unwrap();
        let trashed = branch.create_note("", "Deleted").unwrap();
        branch.delete_note(trashed["id"].as_str().unwrap()).unwrap();
        branch
            .create_database(
                "Tasks",
                "Projects",
                json!([{ "id": "t", "name": "Name", "type": "title" }]),
                json!([{ "id": "r", "values": { "t": "Ship it" } }]),
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            branch.export_plaintext(&root).err(),
            Some("Choose an export destination outside the open branch folder".to_string())
        );
        let result = branch.export_plaintext(&destination).unwrap();
        assert_eq!(result["notes"], 1);
        assert_eq!(result["databases"], 1);
        assert_eq!(result["attachments"], 1);
        assert_eq!(result["skipped"], json!([]));
        let exported = PathBuf::from(result["path"].as_str().unwrap());
        assert!(exported.file_name().unwrap().to_string_lossy().starts_with("Driftleaf-Export-"));
        assert_eq!(exported.extension().and_then(|extension| extension.to_str()), Some("zip"));
        let export_root = exported.file_stem().unwrap().to_string_lossy();
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 1, "no work folder is left behind");
        assert_eq!(
            String::from_utf8(archive_entry(
                &exported,
                &format!("{export_root}/Projects/Q4- Plans-/Road-map.md"),
            ).unwrap()).unwrap(),
            "See ![d](../../attachments/diagram%20%28v2%29.png)"
        );
        assert_eq!(
            archive_entry(&exported, &format!("{export_root}/attachments/diagram (v2).png")).unwrap(),
            b"PNGDATA"
        );
        assert!(archive_has_entry(&exported, &format!("{export_root}/Empty/")));
        assert!(!archive_has_entry(&exported, &format!("{export_root}/Deleted.md")));
        assert!(
            String::from_utf8(archive_entry(&exported, &format!("{export_root}/Projects/Tasks.csv")).unwrap())
                .unwrap()
                .contains("Ship it")
        );
        assert!(archive_has_entry(&exported, &format!("{export_root}/Projects/Tasks.json")));

        // A second export never overwrites the first.
        let again = branch.export_plaintext(&destination).unwrap();
        assert_ne!(again["path"], result["path"]);

        fs::remove_dir_all(&temp).ok();
    }
}
