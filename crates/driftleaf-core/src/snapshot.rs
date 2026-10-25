//! Read-only format compatibility. No reconciliation or migration writes happen here.
use crate::{decrypt, open_branch, valid_id, Key};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Snapshot {
    root: PathBuf,
    key: Key,
    pub manifest: Value,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}
fn parse(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing {name}"))
}

impl Snapshot {
    pub fn open(root: &Path, passphrase: &str) -> Result<Self, String> {
        let (root, key, manifest) = open_branch(root, passphrase)?;
        Ok(Self {
            root,
            key,
            manifest,
        })
    }
    fn member(&self, collection: &str, id: &str) -> Result<&Value, String> {
        if !valid_id(id) {
            return Err("Invalid item ID".into());
        }
        self.manifest[collection]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == id))
            .ok_or_else(|| "Item not found".into())
    }
    fn read_encrypted(&self, path: &Path) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&self.root) {
            return Err("Item path leaves the branch".into());
        }
        decrypt(&read(&canonical)?, &self.key)
    }
    pub fn read_note(&self, id: &str) -> Result<String, String> {
        let meta = self.member("notes", id)?;
        let private = self.root.join(".driftleaf/notes").join(format!("{id}.enc"));
        let path = if private.try_exists().map_err(|e| e.to_string())? {
            private
        } else {
            let folder = field(meta, "folderPath")?;
            let file = meta
                .get("fileName")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{id}.enc"));
            if folder.contains("..")
                || folder.contains('\\')
                || Path::new(folder).is_absolute()
                || folder.split('/').any(|part| part == ".driftleaf")
                || file.contains(['/', '\\'])
                || file == "."
                || file == ".."
            {
                return Err("Invalid legacy note path".into());
            }
            self.root.join(folder).join(file)
        };
        String::from_utf8(self.read_encrypted(&path)?.to_vec())
            .map_err(|_| "Note is not valid UTF-8".into())
    }
    pub fn read_database(&self, id: &str) -> Result<Value, String> {
        self.member("databases", id)?;
        parse(&self.read_encrypted(&self.root.join(".driftleaf").join(format!("{id}.db.enc")))?)
    }
}
