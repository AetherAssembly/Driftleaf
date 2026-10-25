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

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing {name}"))
}

// Shared by Snapshot::open (read-only) and mutation::Branch::open (read-write): parses
// vault.json, derives the key, verifies the passphrase against canary.enc, and loads the
// manifest (current encrypted path, falling back to the legacy plaintext one). Neither
// caller runs reconciliation/migration here — see snapshot.rs's module comment.
pub(crate) fn open_branch(root: &Path, passphrase: &str) -> Result<(PathBuf, Key, Value), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let private = root.join(DRIFTLEAF_DIR);
    let config: Value = serde_json::from_slice(
        &std::fs::read(private.join("vault.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if config["version"] != 1 {
        return Err("Unsupported branch version".into());
    }
    let key = if config["kdf"] == "scrypt" {
        derive_key(
            passphrase,
            &hex::decode(field(&config, "saltHex")?).map_err(|e| e.to_string())?,
        )?
    } else {
        let bytes = hex::decode(field(&config, "keyHex")?).map_err(|e| e.to_string())?;
        Key::new(bytes.try_into().map_err(|_| "Invalid legacy key")?)
    };
    let canary_bytes = std::fs::read(private.join("canary.enc")).map_err(|e| e.to_string())?;
    let canary = decrypt(&canary_bytes, &key).map_err(|_| "Incorrect passphrase".to_string())?;
    if canary.as_slice() != b"driftleaf-vault-v1" {
        return Err("Incorrect passphrase".into());
    }
    let mut manifest: Value = match std::fs::read(private.join("manifest.enc")) {
        Ok(bytes) => {
            serde_json::from_slice(&decrypt(&bytes, &key)?).map_err(|e| e.to_string())?
        }
        Err(error) if error.kind() == ErrorKind::NotFound => serde_json::from_slice(
            &std::fs::read(private.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
        Err(error) => return Err(error.to_string()),
    };
    if !manifest.is_object() || !manifest["notes"].is_array() || !manifest["folders"].is_array() {
        return Err("Invalid branch manifest".into());
    }
    // Same defaulting as parseManifest() in src/main/vault.ts, so older manifests that
    // predate these fields behave the same under mutation as a freshly created one.
    let object = manifest.as_object_mut().unwrap();
    for key in ["databases", "extensions", "canvasItems"] {
        if !object.get(key).is_some_and(Value::is_array) {
            object.insert(key.to_string(), Value::Array(Vec::new()));
        }
    }
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

pub mod backup;
pub mod database_export;
pub mod database_import;
pub mod date;
pub mod formula;
pub mod import;
pub mod locking;
pub mod note_links;
pub mod search;
pub mod mutation;
pub mod snapshot;
