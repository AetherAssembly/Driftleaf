//! Attachments, ported from addAttachment/readAttachment/listAttachments/
//! findUnusedAttachments/removeUnusedAttachments in src/main/vault.ts.
//!
//! An attachment is an arbitrary file (image, PDF, ...) encrypted with the branch key at
//! `.driftleaf/attachments/<uuid>.enc`, in the same `[iv][tag][ciphertext]` framing as
//! every other `.enc` file. Its `{ id, name, mimeType, size, createdAt }` record lives in
//! the manifest's `attachments` list. Notes refer to one as `attachment:<uuid>` in an
//! ordinary Markdown image or link, so the bytes never sit in a note.
use crate::{
    decrypt, encrypt, js_trim,
    mutation::{now_ms, write_file_atomic, Branch},
    random_uuid_v4, valid_id, DRIFTLEAF_DIR,
};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::PathBuf, sync::OnceLock};

pub const ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;
/// An attachment is added the moment it is pasted, but the note that refers to it is only
/// saved a moment later (or not at all if that save fails and is retried). Cleanup
/// therefore never touches anything this recent.
pub const ATTACHMENT_UNUSED_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

// ATTACHMENT_REFERENCE in vault.ts. Matched on the decrypted bytes directly: the pattern is
// pure ASCII, so this finds exactly what the reference implementation finds in the
// (lossily) decoded text, without rejecting a note that is not valid UTF-8.
fn attachment_reference() -> &'static regex::bytes::Regex {
    static PATTERN: OnceLock<regex::bytes::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::bytes::Regex::new(
            r"(?i-u)attachment:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        )
        .expect("attachment reference pattern is valid")
    })
}

/// Mirrors cleanAttachmentName(). The original filename is only ever shown to the user and
/// offered as a default when saving a copy; it is never used as a path inside the branch.
/// This strips anything that could still make it one when it is suggested to a save dialog
/// or written by an export.
pub(crate) fn clean_attachment_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let stripped: String = base
        .chars()
        .filter(|c| !matches!(c, '\u{0000}'..='\u{001f}' | '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    // `.slice(0, 200)` counts UTF-16 code units. A character that would straddle the limit
    // is dropped whole here; JS would keep its lone leading surrogate, which a Rust string
    // cannot hold.
    let mut cleaned = String::new();
    let mut units = 0;
    for c in js_trim(&stripped).chars() {
        units += c.len_utf16();
        if units > 200 {
            break;
        }
        cleaned.push(c);
    }
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".into()
    } else {
        cleaned
    }
}

/// Mirrors cleanMimeType(): `type/subtype` made of `[a-z0-9][a-z0-9.+-]{0,60}` on each
/// side, lower-cased; anything else becomes `application/octet-stream`.
pub(crate) fn clean_mime_type(mime_type: &str) -> String {
    fn token(part: &str) -> bool {
        let bytes = part.as_bytes();
        (1..=61).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes[1..]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
    }
    match mime_type.split_once('/') {
        Some((kind, subtype)) if token(kind) && token(subtype) => mime_type.to_ascii_lowercase(),
        _ => "application/octet-stream".into(),
    }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

impl Branch {
    pub(crate) fn attachments(&self) -> &[Value] {
        self.manifest["attachments"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    fn attachments_mut(&mut self) -> &mut Vec<Value> {
        // open_branch() already defaults this to an array; the check stays as a safeguard.
        if !self.manifest["attachments"].is_array() {
            self.manifest["attachments"] = json!([]);
        }
        self.manifest["attachments"].as_array_mut().unwrap()
    }

    pub(crate) fn attachment_path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid attachment ID".into());
        }
        Ok(self
            .root
            .join(DRIFTLEAF_DIR)
            .join("attachments")
            .join(format!("{id}.enc")))
    }

    /// Mirrors listAttachments().
    pub fn list_attachments(&self) -> Value {
        Value::Array(self.attachments().to_vec())
    }

    /// Mirrors addAttachment(). File first, manifest second (the same "disk first" order as
    /// create_note): a crash between the two leaves an unindexed ciphertext file the health
    /// check reports, never an index entry for bytes that were not written.
    pub fn add_attachment(&mut self, name: &str, mime_type: &str, data: &[u8]) -> Result<Value, String> {
        if data.is_empty() {
            return Err("That file is empty".into());
        }
        if data.len() > ATTACHMENT_MAX_BYTES {
            return Err(format!(
                "Attachments can be at most {} MB",
                ATTACHMENT_MAX_BYTES / (1024 * 1024)
            ));
        }
        let id = random_uuid_v4();
        let meta = json!({
            "id": id,
            "name": clean_attachment_name(name),
            "mimeType": clean_mime_type(mime_type),
            "size": data.len(),
            "createdAt": now_ms(),
        });
        let file_path = self.attachment_path(&id)?;
        fs::create_dir_all(file_path.parent().ok_or("Invalid path")?).map_err(|e| e.to_string())?;
        write_file_atomic(&file_path, &encrypt(data, &self.key)?)?;
        self.attachments_mut().push(meta.clone());
        if let Err(err) = self.write_manifest() {
            self.attachments_mut().retain(|item| item["id"] != id.as_str());
            let _ = fs::remove_file(&file_path);
            return Err(err);
        }
        Ok(meta)
    }

    /// Mirrors readAttachment(): the manifest record and the decrypted bytes.
    pub fn read_attachment(&self, id: &str) -> Result<(Value, Vec<u8>), String> {
        let meta = self
            .attachments()
            .iter()
            .find(|item| item["id"] == id)
            .cloned()
            .ok_or("Attachment not found")?;
        let bytes = fs::read(self.attachment_path(id)?).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "This attachment's encrypted file is missing".to_string()
            } else {
                error.to_string()
            }
        })?;
        let data = decrypt(&bytes, &self.key)
            .map_err(|_| "Attachment is corrupted and cannot be decrypted".to_string())?;
        Ok((meta, data.to_vec()))
    }

    /// Mirrors findUnusedAttachments(): attachments no note refers to. Trashed notes count
    /// as referring (restoring one must bring its images back with it), and anything added
    /// within ATTACHMENT_UNUSED_GRACE_MS of `now_ms` is never reported. If any note cannot
    /// be read this fails rather than guess: treating an unreadable note as "refers to
    /// nothing" could delete its attachments.
    pub fn find_unused_attachments(&self, now_ms: u64) -> Result<Vec<Value>, String> {
        let attachments = self.attachments();
        if attachments.is_empty() {
            return Ok(Vec::new());
        }
        let mut referenced: HashSet<String> = HashSet::new();
        let live_notes = self.manifest["notes"].as_array().into_iter().flatten();
        let trashed_notes = self
            .trash()
            .iter()
            .filter(|entry| entry["kind"] == "note")
            .map(|entry| &entry["meta"]);
        for meta in live_notes.chain(trashed_notes) {
            let content = self
                .note_path(meta["id"].as_str().unwrap_or(""))
                .ok()
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| decrypt(&bytes, &self.key).ok())
                .ok_or_else(|| {
                    format!(
                        "Could not read \"{}\", so unused attachments cannot be worked out safely",
                        meta["title"].as_str().unwrap_or("")
                    )
                })?;
            for found in attachment_reference().captures_iter(&content) {
                referenced.insert(String::from_utf8_lossy(&found[1]).to_ascii_lowercase());
            }
        }
        let now = now_ms as f64;
        Ok(attachments
            .iter()
            .filter(|item| {
                !referenced.contains(&item["id"].as_str().unwrap_or("").to_ascii_lowercase())
                    && number(&item["createdAt"]) + ATTACHMENT_UNUSED_GRACE_MS as f64 <= now
            })
            .cloned()
            .collect())
    }

    /// Mirrors listAttachmentUsage(): every attachment with the notes that refer to it, as
    /// `{ ...meta, usedBy: [{ id, title, folderPath, trashed }] }`, newest first. This is a
    /// listing, not a safety decision, so a note that cannot be read is simply skipped.
    pub fn attachment_usage(&self) -> Value {
        let mut used_by: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
        let live = self.manifest["notes"].as_array().into_iter().flatten().map(|meta| (meta, false));
        let trashed = self
            .trash()
            .iter()
            .filter(|entry| entry["kind"] == "note")
            .map(|entry| (&entry["meta"], true));
        for (meta, is_trashed) in live.chain(trashed) {
            let Some(content) = self
                .note_path(meta["id"].as_str().unwrap_or(""))
                .ok()
                .and_then(|path| fs::read(path).ok())
                .and_then(|bytes| decrypt(&bytes, &self.key).ok())
            else {
                continue;
            };
            let mut seen: HashSet<String> = HashSet::new();
            for found in attachment_reference().captures_iter(&content) {
                let id = String::from_utf8_lossy(&found[1]).to_ascii_lowercase();
                if seen.insert(id.clone()) {
                    used_by.entry(id).or_default().push(json!({
                        "id": meta["id"],
                        "title": meta["title"],
                        "folderPath": meta["folderPath"],
                        "trashed": is_trashed,
                    }));
                }
            }
        }
        let mut items: Vec<Value> = self
            .attachments()
            .iter()
            .map(|item| {
                let mut entry = item.clone();
                let id = item["id"].as_str().unwrap_or("").to_ascii_lowercase();
                entry["usedBy"] = Value::Array(used_by.remove(&id).unwrap_or_default());
                entry
            })
            .collect();
        items.sort_by(|a, b| {
            number(&b["createdAt"]).partial_cmp(&number(&a["createdAt"])).unwrap_or(std::cmp::Ordering::Equal)
        });
        Value::Array(items)
    }

    /// Mirrors removeAttachment(): deletes one attachment the user chose, whether or not a
    /// note still refers to it (the caller has warned them). The manifest forgets it first,
    /// then the file is removed.
    pub fn remove_attachment(&mut self, id: &str) -> Result<(), String> {
        let path = self.attachment_path(id).map_err(|_| "Attachment not found".to_string())?;
        if !self.attachments().iter().any(|item| item["id"] == id) {
            return Err("Attachment not found".into());
        }
        let previous = self.manifest["attachments"].clone();
        self.attachments_mut().retain(|item| item["id"] != id);
        if let Err(err) = self.write_manifest() {
            self.manifest["attachments"] = previous;
            return Err(err);
        }
        match fs::remove_file(path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.to_string()),
            _ => Ok(()),
        }
    }

    /// Mirrors removeUnusedAttachments(): the manifest forgets them first, then the files
    /// are removed. Returns `{ removed, bytes }`.
    pub fn remove_unused_attachments(&mut self, now_ms: u64) -> Result<Value, String> {
        let unused = self.find_unused_attachments(now_ms)?;
        if unused.is_empty() {
            return Ok(json!({ "removed": 0, "bytes": 0 }));
        }
        let unused_ids: HashSet<&str> = unused.iter().filter_map(|item| item["id"].as_str()).collect();
        let previous = self.manifest["attachments"].clone();
        self.attachments_mut()
            .retain(|item| !item["id"].as_str().is_some_and(|id| unused_ids.contains(id)));
        if let Err(err) = self.write_manifest() {
            self.manifest["attachments"] = previous;
            return Err(err);
        }
        let mut first_error = None;
        for id in &unused_ids {
            let removed = self.attachment_path(id).and_then(|path| match fs::remove_file(path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.to_string()),
                _ => Ok(()),
            });
            if let Err(err) = removed {
                first_error.get_or_insert(err);
            }
        }
        if let Some(err) = first_error {
            return Err(err);
        }
        let bytes = unused.iter().fold(0u64, |total, item| {
            total + item["size"].as_u64().unwrap_or_else(|| number(&item["size"]) as u64)
        });
        Ok(json!({ "removed": unused.len(), "bytes": bytes }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{random_hex, test_support::legacy_key_branch};

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("driftleaf-attachment-unit-{label}-{}", random_hex(8)))
    }

    fn id_of(meta: &Value) -> String {
        meta["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn names_are_reduced_to_a_safe_display_name() {
        assert_eq!(clean_attachment_name("photo.png"), "photo.png");
        assert_eq!(clean_attachment_name("/home/me/photo.png"), "photo.png");
        assert_eq!(clean_attachment_name("C:\\Users\\me\\a<b>:\"c|?*.png"), "abc.png");
        assert_eq!(clean_attachment_name("mixed/sep\\last one.pdf"), "last one.pdf");
        assert_eq!(clean_attachment_name("  spaced.txt\u{FEFF} "), "spaced.txt");
        assert_eq!(clean_attachment_name("line\nbreak\t.txt"), "linebreak.txt");
        for empty in ["", "   ", ".", "..", "dir/", "a/..", "\u{0001}\u{001f}", "???"] {
            assert_eq!(clean_attachment_name(empty), "attachment", "{empty:?}");
        }
        // Only the control range U+0000..U+001F is stripped; DEL and beyond are kept.
        assert_eq!(clean_attachment_name("a\u{007f}b"), "a\u{007f}b");
        assert_eq!(clean_attachment_name("日本語 🌿.png"), "日本語 🌿.png");
    }

    #[test]
    fn names_are_cut_at_200_utf16_units() {
        assert_eq!(clean_attachment_name(&"a".repeat(300)), "a".repeat(200));
        // Each 🌿 is two UTF-16 units, so 100 of them fill the limit exactly.
        assert_eq!(clean_attachment_name(&"🌿".repeat(150)), "🌿".repeat(100));
        // Trimming happens before the cut, so a space left at the cut point survives.
        let cut_on_space = format!("{} tail", "a".repeat(199));
        assert_eq!(clean_attachment_name(&cut_on_space), format!("{} ", "a".repeat(199)));
    }

    #[test]
    fn mime_types_are_validated_and_lower_cased() {
        assert_eq!(clean_mime_type("image/png"), "image/png");
        assert_eq!(clean_mime_type("Image/SVG+XML"), "image/svg+xml");
        assert_eq!(
            clean_mime_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        for bad in [
            "",
            "png",
            "image/",
            "/png",
            "image/png; charset=utf-8",
            "image/png/extra",
            "image /png",
            ".image/png",
            "image/+png",
            "imagé/png",
            "text/html\n",
        ] {
            assert_eq!(clean_mime_type(bad), "application/octet-stream", "{bad:?}");
        }
        // One leading character plus at most 60 more on each side.
        let longest = format!("{}/{}", "a".repeat(61), "b".repeat(61));
        assert_eq!(clean_mime_type(&longest), longest);
        assert_eq!(
            clean_mime_type(&format!("{}/b", "a".repeat(62))),
            "application/octet-stream"
        );
    }

    #[test]
    fn attachments_round_trip_encrypted_and_are_bounded() {
        let root = temp_root("roundtrip");
        let mut branch = legacy_key_branch(&root);
        let data: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        let meta = branch.add_attachment("../../etc/Photo.PNG", "IMAGE/PNG", &data).unwrap();
        let id = id_of(&meta);
        assert_eq!(meta["name"], "Photo.PNG");
        assert_eq!(meta["mimeType"], "image/png");
        assert_eq!(meta["size"], 5000);
        assert_eq!(
            meta.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "name", "mimeType", "size", "createdAt"]
        );

        let on_disk = fs::read(branch.attachment_path(&id).unwrap()).unwrap();
        assert_eq!(on_disk.len(), 12 + 16 + data.len());
        assert!(!on_disk.windows(16).any(|window| window == &data[..16]));
        let (read_meta, read_data) = branch.read_attachment(&id).unwrap();
        assert_eq!(read_meta, meta);
        assert_eq!(read_data, data);

        // Recorded in the manifest on disk, not just in memory.
        let reopened = Branch::open(&root, "").unwrap();
        assert_eq!(reopened.list_attachments(), json!([meta]));
        assert_eq!(reopened.read_attachment(&id).unwrap().1, data);

        assert_eq!(branch.add_attachment("empty", "text/plain", &[]).err(), Some("That file is empty".into()));
        let too_big = vec![0u8; ATTACHMENT_MAX_BYTES + 1];
        assert_eq!(
            branch.add_attachment("big", "text/plain", &too_big).err(),
            Some("Attachments can be at most 25 MB".into())
        );
        assert_eq!(branch.attachments().len(), 1);
        assert_eq!(
            branch.read_attachment("11111111-1111-1111-1111-111111111111").err(),
            Some("Attachment not found".into())
        );

        let file = branch.attachment_path(&id).unwrap();
        let mut damaged = on_disk.clone();
        damaged[30] ^= 1;
        fs::write(&file, damaged).unwrap();
        assert_eq!(
            branch.read_attachment(&id).err(),
            Some("Attachment is corrupted and cannot be decrypted".into())
        );
        fs::remove_file(&file).unwrap();
        assert_eq!(
            branch.read_attachment(&id).err(),
            Some("This attachment's encrypted file is missing".into())
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unused_cleanup_spares_referenced_trashed_and_recent_attachments() {
        let root = temp_root("unused");
        let mut branch = legacy_key_branch(&root);
        let live = id_of(&branch.add_attachment("live.png", "image/png", b"live").unwrap());
        let trashed = id_of(&branch.add_attachment("trashed.png", "image/png", b"trashed").unwrap());
        let unused = id_of(&branch.add_attachment("unused.png", "image/png", b"unused!").unwrap());
        let recent = id_of(&branch.add_attachment("recent.png", "image/png", b"recent").unwrap());

        let keeper = id_of(&branch.create_note("", "Keeper").unwrap());
        // References are matched case-insensitively.
        branch
            .write_note(&keeper, &format!("![a](ATTACHMENT:{})", live.to_uppercase()))
            .unwrap();
        let gone = id_of(&branch.create_note("", "Gone").unwrap());
        branch.write_note(&gone, &format!("[b](attachment:{trashed})")).unwrap();
        branch.delete_note(&gone).unwrap();

        let now = 100 * ATTACHMENT_UNUSED_GRACE_MS;
        for item in branch.manifest["attachments"].as_array_mut().unwrap() {
            let fresh = item["id"] == recent.as_str();
            item["createdAt"] = json!(if fresh { now - 1 } else { now - ATTACHMENT_UNUSED_GRACE_MS });
        }

        let found = branch.find_unused_attachments(now).unwrap();
        assert_eq!(found.iter().map(id_of).collect::<Vec<_>>(), [unused.clone()]);
        assert_eq!(
            branch.remove_unused_attachments(now).unwrap(),
            json!({ "removed": 1, "bytes": 7 })
        );
        assert!(!branch.attachment_path(&unused).unwrap().exists());
        for kept in [&live, &trashed, &recent] {
            assert!(branch.attachment_path(kept).unwrap().exists());
        }
        assert_eq!(Branch::open(&root, "").unwrap().attachments().len(), 3);
        assert_eq!(
            branch.remove_unused_attachments(now).unwrap(),
            json!({ "removed": 0, "bytes": 0 })
        );

        // An unreadable note (live or trashed) stops the cleanup instead of guessing.
        let note_file = branch.note_path(&gone).unwrap();
        let mut bytes = fs::read(&note_file).unwrap();
        bytes[20] ^= 1;
        fs::write(&note_file, bytes).unwrap();
        let far_future = now + 10 * ATTACHMENT_UNUSED_GRACE_MS;
        assert_eq!(
            branch.find_unused_attachments(far_future).err(),
            Some("Could not read \"Gone\", so unused attachments cannot be worked out safely".into())
        );
        assert!(branch.remove_unused_attachments(far_future).is_err());
        assert_eq!(branch.attachments().len(), 3);

        fs::remove_dir_all(&root).ok();
    }
}
