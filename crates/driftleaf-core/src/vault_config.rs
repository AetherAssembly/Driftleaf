//! vault.json handling, ported from VaultConfig/parseVaultConfig/readVaultConfig/
//! dataKeyFromConfig/changeVaultPassphrase in src/main/vault.ts.
//!
//! Version 1 derives the data key straight from the passphrase (or, for the legacy
//! `kdf: "none"`, stores it as `keyHex`). Version 2 keeps the same data key but stores it
//! wrapped: scrypt(passphrase, salt) is a key-encryption key and `wrappedKeyHex` is the
//! 32-byte data key sealed with it in the usual `[12-byte iv][16-byte tag][ciphertext]`
//! framing. Changing the passphrase is then one atomic rewrite of vault.json.
use crate::{decrypt, derive_key, encrypt, mutation::Branch, random_hex, Key, DRIFTLEAF_DIR};
use serde_json::{json, Value};
use std::path::Path;
use zeroize::Zeroizing;

const KEY_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VaultConfig {
    ScryptV1 { salt_hex: String },
    NoneV1 { key_hex: String },
    ScryptV2 { salt_hex: String, wrapped_key_hex: String },
}

/// Whose vault.json is being read. It only changes the wording of the errors, so a damaged
/// backup and a damaged open branch are reported as what they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Subject {
    Branch,
    Backup,
}

impl Subject {
    fn label(self) -> &'static str {
        match self {
            Subject::Branch => "Branch",
            Subject::Backup => "Backup",
        }
    }
}

// isHex() in vault.ts: a string of exactly `bytes * 2` hex digits, either case.
fn hex_field(config: &Value, name: &str, bytes: usize) -> Option<String> {
    config
        .get(name)
        .and_then(Value::as_str)
        .filter(|text| text.len() == bytes * 2 && text.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(String::from)
}

// `config.version === 1` in JS is true for any JSON number equal to 1 (1, 1.0, 1e0).
fn version_of(config: &Value) -> Option<u8> {
    match config.get("version").and_then(Value::as_f64) {
        Some(1.0) => Some(1),
        Some(2.0) => Some(2),
        _ => None,
    }
}

pub(crate) fn parse_vault_config(raw: &Value, subject: Subject) -> Result<VaultConfig, String> {
    let label = subject.label();
    // `!raw || typeof raw !== "object"`: arrays pass this check in JS and then fail the
    // version check below, exactly as they do here (an array has no "version").
    if !raw.is_object() && !raw.is_array() {
        return Err(format!("{label} has an invalid branch configuration"));
    }
    let Some(version) = version_of(raw) else {
        return Err(match subject {
            Subject::Backup => "This backup uses an unsupported branch format".into(),
            Subject::Branch => {
                "This branch was created by a newer version of Driftleaf. Update the app to open it."
                    .into()
            }
        });
    };
    let kdf = raw.get("kdf").and_then(Value::as_str);
    if kdf == Some("scrypt") {
        let salt_hex = hex_field(raw, "saltHex", 16)
            .ok_or_else(|| format!("{label} has an invalid key-derivation salt"))?;
        if version == 2 {
            // 12-byte iv + 16-byte tag + 32-byte key.
            let wrapped_key_hex = hex_field(raw, "wrappedKeyHex", 12 + 16 + KEY_BYTES)
                .ok_or_else(|| format!("{label} has an invalid wrapped encryption key"))?;
            return Ok(VaultConfig::ScryptV2 { salt_hex, wrapped_key_hex });
        }
        return Ok(VaultConfig::ScryptV1 { salt_hex });
    }
    if kdf == Some("none") && version == 1 {
        let key_hex = hex_field(raw, "keyHex", KEY_BYTES)
            .ok_or_else(|| format!("{label} has an invalid encryption key"))?;
        return Ok(VaultConfig::NoneV1 { key_hex });
    }
    Err(format!("{label} uses an unsupported key-derivation method"))
}

pub(crate) fn config_path(root: &Path) -> std::path::PathBuf {
    root.join(DRIFTLEAF_DIR).join("vault.json")
}

pub(crate) fn read_vault_config(root: &Path, subject: Subject) -> Result<VaultConfig, String> {
    let bytes = std::fs::read(config_path(root)).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    parse_vault_config(&raw, subject)
}

fn key_from_bytes(bytes: &[u8]) -> Option<Key> {
    let array: [u8; KEY_BYTES] = bytes.try_into().ok()?;
    Some(Zeroizing::new(array))
}

/// Returns the branch's data key for this config and passphrase. A wrong passphrase on a
/// version-2 config fails here (the wrapped key will not authenticate); on version 1 it
/// yields a wrong key that the caller's canary check then rejects.
pub(crate) fn data_key_from_config(config: &VaultConfig, passphrase: &str) -> Result<Key, String> {
    match config {
        VaultConfig::NoneV1 { key_hex } => {
            let bytes = Zeroizing::new(hex::decode(key_hex).map_err(|e| e.to_string())?);
            key_from_bytes(&bytes).ok_or_else(|| "Invalid legacy key".to_string())
        }
        VaultConfig::ScryptV1 { salt_hex } => {
            derive_key(passphrase, &hex::decode(salt_hex).map_err(|e| e.to_string())?)
        }
        VaultConfig::ScryptV2 { salt_hex, wrapped_key_hex } => {
            let derived = derive_key(passphrase, &hex::decode(salt_hex).map_err(|e| e.to_string())?)?;
            let wrapped = hex::decode(wrapped_key_hex).map_err(|e| e.to_string())?;
            decrypt(&wrapped, &derived)
                .ok()
                .and_then(|key| key_from_bytes(&key))
                .ok_or_else(|| "Incorrect passphrase".to_string())
        }
    }
}

// Same purpose as Node's timingSafeEqual: no early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Branch {
    /// Mirrors changeVaultPassphrase(): the data key stays the same and is stored wrapped
    /// under a key derived from the new passphrase. The swap is a single atomic rewrite of
    /// vault.json, and the new config is proven to open before it replaces the old one, so
    /// a failure at any point leaves the branch opening with the old passphrase exactly as
    /// before. Nothing else (notes, databases, attachments, manifest, canary) is rewritten.
    pub fn change_passphrase(
        &mut self,
        current_passphrase: &str,
        new_passphrase: &str,
    ) -> Result<(), String> {
        if crate::js_trim(new_passphrase).is_empty() {
            return Err("A new passphrase is required.".into());
        }
        let config = read_vault_config(&self.root, Subject::Branch)?;
        let current_key = data_key_from_config(&config, current_passphrase)
            .map_err(|_| "Current passphrase is incorrect".to_string())?;
        if !constant_time_eq(current_key.as_ref(), self.key.as_ref()) {
            return Err("Current passphrase is incorrect".into());
        }
        drop(current_key);

        let salt = hex::decode(random_hex(16)).map_err(|e| e.to_string())?;
        let wrapping_key = derive_key(new_passphrase, &salt)?;
        // Key order matches the object literal in vault.ts, and to_string_pretty() matches
        // JSON.stringify(value, null, 2) for a flat object, so the file is laid out the same.
        let next = json!({
            "version": 2,
            "kdf": "scrypt",
            "saltHex": hex::encode(&salt),
            "wrappedKeyHex": hex::encode(encrypt(self.key.as_ref(), &wrapping_key)?),
        });
        let serialized = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        let reparsed_raw: Value = serde_json::from_str(&serialized).map_err(|e| e.to_string())?;
        let VaultConfig::ScryptV2 { wrapped_key_hex, .. } =
            parse_vault_config(&reparsed_raw, Subject::Branch)?
        else {
            return Err("Could not prepare the new passphrase".into());
        };
        let opens = hex::decode(&wrapped_key_hex)
            .ok()
            .and_then(|wrapped| decrypt(&wrapped, &wrapping_key).ok())
            .is_some_and(|unwrapped| constant_time_eq(&unwrapped, self.key.as_ref()));
        if !opens {
            return Err("Could not verify the new passphrase; nothing was changed".into());
        }
        crate::mutation::write_file_atomic(&config_path(&self.root), serialized.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: &str = "000102030405060708090a0b0c0d0e0f";

    fn wrapped_hex() -> String {
        "ab".repeat(12 + 16 + 32)
    }

    #[test]
    fn version_1_and_2_configs_parse_and_other_versions_are_refused() {
        assert_eq!(
            parse_vault_config(&json!({ "version": 1, "kdf": "scrypt", "saltHex": SALT }), Subject::Branch),
            Ok(VaultConfig::ScryptV1 { salt_hex: SALT.into() })
        );
        assert_eq!(
            parse_vault_config(
                &json!({ "version": 1, "kdf": "none", "keyHex": "AB".repeat(32) }),
                Subject::Branch
            ),
            Ok(VaultConfig::NoneV1 { key_hex: "AB".repeat(32) })
        );
        assert_eq!(
            parse_vault_config(
                &json!({ "version": 2, "kdf": "scrypt", "saltHex": SALT, "wrappedKeyHex": wrapped_hex() }),
                Subject::Branch
            ),
            Ok(VaultConfig::ScryptV2 { salt_hex: SALT.into(), wrapped_key_hex: wrapped_hex() })
        );
        // 1.0 is the same JSON number as 1 to the reference implementation.
        assert!(parse_vault_config(
            &json!({ "version": 1.0, "kdf": "scrypt", "saltHex": SALT }),
            Subject::Branch
        )
        .is_ok());
        assert_eq!(
            parse_vault_config(&json!({ "version": 3, "kdf": "scrypt", "saltHex": SALT }), Subject::Branch),
            Err("This branch was created by a newer version of Driftleaf. Update the app to open it.".into())
        );
        assert_eq!(
            parse_vault_config(&json!({ "version": 3, "kdf": "scrypt", "saltHex": SALT }), Subject::Backup),
            Err("This backup uses an unsupported branch format".into())
        );
        assert_eq!(
            parse_vault_config(&json!({ "version": "2", "kdf": "scrypt" }), Subject::Backup),
            Err("This backup uses an unsupported branch format".into())
        );
        assert_eq!(
            parse_vault_config(&json!("nope"), Subject::Backup),
            Err("Backup has an invalid branch configuration".into())
        );
        assert_eq!(
            parse_vault_config(&Value::Null, Subject::Branch),
            Err("Branch has an invalid branch configuration".into())
        );
    }

    #[test]
    fn damaged_fields_are_reported_by_name() {
        assert_eq!(
            parse_vault_config(&json!({ "version": 2, "kdf": "scrypt", "saltHex": "zz" }), Subject::Branch),
            Err("Branch has an invalid key-derivation salt".into())
        );
        assert_eq!(
            parse_vault_config(
                &json!({ "version": 2, "kdf": "scrypt", "saltHex": SALT, "wrappedKeyHex": "abcd" }),
                Subject::Branch
            ),
            Err("Branch has an invalid wrapped encryption key".into())
        );
        assert_eq!(
            parse_vault_config(&json!({ "version": 2, "kdf": "scrypt", "saltHex": SALT }), Subject::Backup),
            Err("Backup has an invalid wrapped encryption key".into())
        );
        assert_eq!(
            parse_vault_config(&json!({ "version": 1, "kdf": "none", "keyHex": "ab" }), Subject::Backup),
            Err("Backup has an invalid encryption key".into())
        );
        // The legacy unencrypted-key form exists only in version 1.
        assert_eq!(
            parse_vault_config(
                &json!({ "version": 2, "kdf": "none", "keyHex": "ab".repeat(32) }),
                Subject::Branch
            ),
            Err("Branch uses an unsupported key-derivation method".into())
        );
        assert_eq!(
            parse_vault_config(&json!({ "version": 1, "kdf": "argon2" }), Subject::Branch),
            Err("Branch uses an unsupported key-derivation method".into())
        );
    }

    #[test]
    fn legacy_none_config_returns_its_stored_key_whatever_the_passphrase() {
        let config = VaultConfig::NoneV1 { key_hex: "11".repeat(32) };
        let key = data_key_from_config(&config, "ignored").unwrap();
        assert_eq!(key.as_ref(), &[0x11u8; 32]);
    }

    #[test]
    fn wrapped_key_unwraps_only_with_the_right_passphrase() {
        let salt = hex::decode(SALT).unwrap();
        let data_key: Key = Zeroizing::new([7u8; 32]);
        let wrapping = derive_key("right 🌿", &salt).unwrap();
        let config = VaultConfig::ScryptV2 {
            salt_hex: SALT.into(),
            wrapped_key_hex: hex::encode(encrypt(data_key.as_ref(), &wrapping).unwrap()),
        };
        assert_eq!(data_key_from_config(&config, "right 🌿").unwrap().as_ref(), data_key.as_ref());
        assert_eq!(
            data_key_from_config(&config, "wrong").err(),
            Some("Incorrect passphrase".to_string())
        );

        // A wrapped payload that authenticates but is not 32 bytes long is not a key.
        let short = VaultConfig::ScryptV2 {
            salt_hex: SALT.into(),
            wrapped_key_hex: hex::encode(encrypt(&[7u8; 31], &wrapping).unwrap()),
        };
        assert_eq!(
            data_key_from_config(&short, "right 🌿").err(),
            Some("Incorrect passphrase".to_string())
        );
    }

    #[test]
    fn changing_the_passphrase_rewrites_only_vault_json() {
        let temp = std::env::temp_dir().join(format!("driftleaf-passphrase-unit-{}", random_hex(8)));
        let mut branch = crate::test_support::legacy_key_branch(&temp);
        let private = branch.root.join(DRIFTLEAF_DIR);
        let canary_before = std::fs::read(private.join("canary.enc")).unwrap();
        let manifest_before = std::fs::read(private.join("manifest.enc")).unwrap();

        assert_eq!(
            branch.change_passphrase("anything", "   ").err(),
            Some("A new passphrase is required.".to_string())
        );
        // A legacy "none" branch has no passphrase to check, so the first change always
        // succeeds and upgrades it to a wrapped key.
        branch.change_passphrase("", "first passphrase").unwrap();
        let written = std::fs::read_to_string(private.join("vault.json")).unwrap();
        assert!(written.starts_with("{\n  \"version\": 2,\n  \"kdf\": \"scrypt\",\n  \"saltHex\": \""));
        assert!(!written.ends_with('\n'));
        assert_eq!(std::fs::read(private.join("canary.enc")).unwrap(), canary_before);
        assert_eq!(std::fs::read(private.join("manifest.enc")).unwrap(), manifest_before);

        assert_eq!(
            branch.change_passphrase("not the first passphrase", "second").err(),
            Some("Current passphrase is incorrect".to_string())
        );
        assert_eq!(std::fs::read_to_string(private.join("vault.json")).unwrap(), written);

        branch.change_passphrase("first passphrase", "second passphrase").unwrap();
        assert_eq!(
            Branch::open(&temp, "first passphrase").err(),
            Some("Incorrect passphrase".to_string())
        );
        assert!(Branch::open(&temp, "second passphrase").is_ok());
        // No temp file is left next to vault.json.
        assert!(std::fs::read_dir(&private)
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")));

        std::fs::remove_dir_all(&temp).ok();
    }
}
