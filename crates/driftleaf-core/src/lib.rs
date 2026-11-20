//! Branch-format primitives. The application remains on the reference backend
//! until the full storage and fault-recovery compatibility suite is satisfied.
use aes_gcm::{
    aead::{rand_core::RngCore, AeadInPlace, KeyInit, OsRng},
    Aes256Gcm, Nonce, Tag,
};
use serde_json::Value;
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

pub type Key = Zeroizing<[u8; 32]>;

pub(crate) const DRIFTLEAF_DIR: &str = ".driftleaf";

pub(crate) fn random_hex(bytes_len: usize) -> String {
    let mut bytes = vec![0u8; bytes_len];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// Same 36-character `[0-9a-f-]` check as src/main/vault.ts's note/item ID validation.
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

// Random RFC 4122 version-4 UUID, matching the shape (not the CSPRNG) of Node's
// `crypto.randomUUID()` well enough to satisfy `valid_id` and look like a real note ID.
pub(crate) fn random_uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

// JS `String.prototype.trim()`: WhiteSpace + LineTerminator, which is not quite Rust's
// `str::trim()` (JS also strips U+FEFF and does not strip U+0085).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

// validManifestNote() in src/main/vault.ts.
pub(crate) fn valid_manifest_note(value: &Value) -> bool {
    value["id"].is_string()
        && value["title"].is_string()
        && value["folderPath"].is_string()
        && (value.get("fileName").is_none() || value["fileName"].is_string())
        && value["updatedAt"].is_number()
}

// validDatabaseMeta() in src/main/vault.ts.
pub(crate) fn valid_database_meta(value: &Value) -> bool {
    value["id"].as_str().is_some_and(valid_id)
        && value["title"].is_string()
        && value["folderPath"].is_string()
        && value["updatedAt"].is_number()
}

// validTrashEntry() in src/main/vault.ts. A JSON number is always finite, so the
// Number.isFinite() half of the deletedAt check has nothing left to reject here.
pub(crate) fn valid_trash_entry(value: &Value) -> bool {
    if !value["deletedAt"].is_number() {
        return false;
    }
    match value["kind"].as_str() {
        Some("note") => {
            valid_manifest_note(&value["meta"]) && value["meta"]["id"].as_str().is_some_and(valid_id)
        }
        Some("database") => valid_database_meta(&value["meta"]),
        _ => false,
    }
}

// validAttachmentMeta() in src/main/vault.ts.
pub(crate) fn valid_attachment_meta(value: &Value) -> bool {
    value["id"].as_str().is_some_and(valid_id)
        && value["name"].is_string()
        && value["mimeType"].is_string()
        && value["size"].is_number()
        && value["createdAt"].is_number()
}

// The part of parseManifest() in src/main/vault.ts this crate applies on every read of a
// manifest: the notes/folders shape check, defaulting the optional lists, and silently
// dropping damaged Trash and attachment entries. A damaged entry must never stop a branch
// from opening; dropping it only forgets the bookkeeping, and the encrypted file is still
// on disk where Node's reconcile (notes) or the health check (databases, attachments)
// reports it.
pub(crate) fn parse_manifest(mut manifest: Value) -> Result<Value, String> {
    if !manifest.is_object() || !manifest["notes"].is_array() || !manifest["folders"].is_array() {
        return Err("Invalid branch manifest".into());
    }
    let object = manifest.as_object_mut().unwrap();
    for key in ["databases", "extensions", "canvasItems"] {
        if !object.get(key).is_some_and(Value::is_array) {
            object.insert(key.to_string(), Value::Array(Vec::new()));
        }
    }
    for (key, valid) in [
        ("trash", valid_trash_entry as fn(&Value) -> bool),
        ("attachments", valid_attachment_meta as fn(&Value) -> bool),
    ] {
        match object.get_mut(key).and_then(Value::as_array_mut) {
            Some(items) => items.retain(valid),
            None => {
                object.insert(key.to_string(), Value::Array(Vec::new()));
            }
        }
    }
    Ok(manifest)
}

// readManifest() in src/main/vault.ts: the current encrypted manifest, falling back to the
// legacy plaintext one only when the encrypted file does not exist.
pub(crate) fn read_manifest(root: &Path, key: &Key) -> Result<Value, String> {
    let private = root.join(DRIFTLEAF_DIR);
    let raw: Value = match std::fs::read(private.join("manifest.enc")) {
        Ok(bytes) => {
            serde_json::from_slice(&decrypt(&bytes, key)?).map_err(|e| e.to_string())?
        }
        Err(error) if error.kind() == ErrorKind::NotFound => serde_json::from_slice(
            &std::fs::read(private.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
        Err(error) => return Err(error.to_string()),
    };
    parse_manifest(raw)
}

// Shared by Snapshot::open (read-only) and mutation::Branch::open (read-write): parses
// vault.json (version 1 or 2, see vault_config.rs), obtains the data key, verifies it
// against canary.enc, and loads the manifest (current encrypted path, falling back to the
// legacy plaintext one). Neither caller runs reconciliation/migration or the Trash
// retention sweep here — see snapshot.rs's and mutation.rs's module comments.
pub(crate) fn open_branch(root: &Path, passphrase: &str) -> Result<(PathBuf, Key, Value), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let private = root.join(DRIFTLEAF_DIR);
    let config = vault_config::read_vault_config(&root, vault_config::Subject::Branch)?;
    let key = vault_config::data_key_from_config(&config, passphrase)?;
    let canary_bytes = std::fs::read(private.join("canary.enc")).map_err(|e| e.to_string())?;
    let canary = decrypt(&canary_bytes, &key).map_err(|_| "Incorrect passphrase".to_string())?;
    if canary.as_slice() != b"driftleaf-vault-v1" {
        return Err("Incorrect passphrase".into());
    }
    let manifest = read_manifest(&root, &key)?;
    Ok((root, key, manifest))
}

pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Key, String> {
    if salt.len() != 16 {
        return Err("Invalid branch salt".into());
    }
    let parameters = scrypt::Params::new(17, 8, 1, 32).map_err(|e| e.to_string())?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &parameters, key.as_mut())
        .map_err(|e| e.to_string())?;
    Ok(key)
}

// Existing Node format: 12-byte nonce, 16-byte detached GCM tag, ciphertext.
pub fn encrypt(plaintext: &[u8], key: &Key) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid key")?;
    let mut ciphertext = plaintext.to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&nonce), b"", &mut ciphertext)
        .map_err(|_| "Encryption failed")?;
    let mut packed = Vec::with_capacity(28 + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&tag);
    packed.extend_from_slice(&ciphertext);
    Ok(packed)
}

pub fn decrypt(packed: &[u8], key: &Key) -> Result<Zeroizing<Vec<u8>>, String> {
    if packed.len() < 28 {
        return Err("Encrypted file is truncated".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "Invalid key")?;
    let mut plaintext = Zeroizing::new(packed[28..].to_vec());
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&packed[..12]),
            b"",
            &mut plaintext,
            Tag::from_slice(&packed[12..28]),
        )
        .map_err(|_| "Encrypted file authentication failed")?;
    Ok(plaintext)
}

pub mod attachments;
pub mod backup;
pub mod branch_export;
pub mod create;
pub mod database_export;
pub mod database_import;
pub mod date;
pub mod formula;
pub mod import;
pub mod locking;
pub mod note_links;
pub mod reconcile;
pub mod search;
pub mod service;
pub mod settings;
pub mod mutation;
pub mod snapshot;
pub mod trash;
pub mod vault_config;

#[cfg(test)]
pub(crate) mod test_support {
    use crate::{encrypt, mutation::Branch, Key, DRIFTLEAF_DIR};
    use std::path::Path;

    // There is no Rust createVault() (branch *creation* is not ported), so unit tests build
    // the minimal layout Branch::open() needs. This one uses the legacy `kdf: "none"` form
    // so tests that do not care about key derivation skip scrypt entirely.
    pub(crate) fn legacy_key_branch(root: &Path) -> Branch {
        let private = root.join(DRIFTLEAF_DIR);
        std::fs::create_dir_all(private.join("notes")).unwrap();
        let key: Key = zeroize::Zeroizing::new([0x42u8; 32]);
        std::fs::write(
            private.join("vault.json"),
            format!(r#"{{"version":1,"kdf":"none","keyHex":"{}"}}"#, hex::encode(key.as_ref())),
        )
        .unwrap();
        std::fs::write(private.join("canary.enc"), encrypt(b"driftleaf-vault-v1", &key).unwrap()).unwrap();
        let manifest = br#"{"notes":[],"folders":[],"databases":[],"extensions":[],"canvasItems":[]}"#;
        std::fs::write(private.join("manifest.enc"), encrypt(manifest, &key).unwrap()).unwrap();
        Branch::open(root, "").unwrap()
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "11111111-1111-1111-1111-111111111111";

    #[test]
    fn js_trim_follows_javascript_whitespace_not_rusts() {
        assert_eq!(js_trim("\u{FEFF} \t a b \u{3000}\n"), "a b");
        // U+0085 is whitespace to Rust's trim() but not to JavaScript's.
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
    }

    #[test]
    fn manifests_without_trash_or_attachments_get_empty_lists() {
        let parsed = parse_manifest(json!({ "notes": [], "folders": [] })).unwrap();
        for key in ["databases", "extensions", "canvasItems", "trash", "attachments"] {
            assert_eq!(parsed[key], json!([]), "{key}");
        }
        let wrong_type =
            parse_manifest(json!({ "notes": [], "folders": [], "trash": "x", "attachments": {} })).unwrap();
        assert_eq!(wrong_type["trash"], json!([]));
        assert_eq!(wrong_type["attachments"], json!([]));
        assert!(parse_manifest(json!({ "notes": [] })).is_err());
        assert!(parse_manifest(json!([])).is_err());
    }

    #[test]
    fn damaged_trash_and_attachment_entries_are_dropped_not_fatal() {
        let note_meta = json!({ "id": ID, "title": "T", "folderPath": "", "fileName": "x.enc", "updatedAt": 1 });
        let database_meta = json!({ "id": ID, "title": "D", "folderPath": "", "updatedAt": 1 });
        let attachment = json!({ "id": ID, "name": "a.png", "mimeType": "image/png", "size": 3, "createdAt": 1 });
        let parsed = parse_manifest(json!({
            "notes": [],
            "folders": [],
            "trash": [
                { "kind": "note", "meta": note_meta, "deletedAt": 5 },
                { "kind": "database", "meta": database_meta, "deletedAt": 6 },
                { "kind": "note", "meta": { "id": "not-a-uuid" }, "deletedAt": "soon" },
                { "kind": "note", "meta": { "id": "not-a-uuid", "title": "T", "folderPath": "", "updatedAt": 1 }, "deletedAt": 7 },
                { "kind": "folder", "meta": note_meta, "deletedAt": 7 },
                { "kind": "note", "meta": note_meta },
                { "kind": "note", "meta": { "id": ID, "title": "T", "folderPath": "", "fileName": null, "updatedAt": 1 }, "deletedAt": 8 },
                null,
                "junk",
            ],
            "attachments": [
                attachment,
                { "id": "nope", "name": "a", "mimeType": "x/y", "size": 1, "createdAt": 1 },
                { "id": ID, "name": "a", "mimeType": "x/y", "size": "1", "createdAt": 1 },
                { "id": ID, "name": 4, "mimeType": "x/y", "size": 1, "createdAt": 1 },
                null,
            ],
        }))
        .unwrap();
        assert_eq!(
            parsed["trash"],
            json!([
                { "kind": "note", "meta": note_meta, "deletedAt": 5 },
                { "kind": "database", "meta": database_meta, "deletedAt": 6 },
            ])
        );
        assert_eq!(parsed["attachments"], json!([attachment]));
    }
}
