//! Branch creation, ported from createVault() in src/main/vault.ts, plus the built-in
//! sample extensions. The welcome note, starter templates, and sample extensions are data
//! files generated from the TypeScript source; create-interop.mjs fails if the two drift.
use crate::mutation::Branch;
use crate::{derive_key, encrypt, random_hex, Key, DRIFTLEAF_DIR};
use serde_json::{json, Value};
use std::{fs, io::ErrorKind, path::Path};

const WELCOME_NOTE: &str = include_str!("welcome_note.md");
const TEMPLATES: &str = include_str!("templates.json");
const EXTENSION_SAMPLES: &str = include_str!("extension_samples.json");
pub(crate) const CANARY_TEXT: &[u8] = b"driftleaf-vault-v1";

fn templates() -> Vec<Value> {
    serde_json::from_str(TEMPLATES).expect("templates.json is valid JSON")
}

pub(crate) fn extension_samples() -> Vec<Value> {
    serde_json::from_str(EXTENSION_SAMPLES).expect("extension_samples.json is valid JSON")
}

/// listExtensionSamples(): id, name and description, never the source.
pub fn list_extension_samples() -> Value {
    Value::Array(
        extension_samples()
            .iter()
            .map(|s| json!({ "id": s["id"], "name": s["name"], "description": s["description"] }))
            .collect(),
    )
}

fn local_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Creates a new branch in `root` and returns it open. Refuses a folder that already holds
/// one: the private directory is created exclusively, so neither an existing salt nor an
/// existing manifest can ever be overwritten, even by two creators racing each other.
pub fn create_branch(root: &Path, passphrase: &str, template_id: &str) -> Result<Branch, String> {
    if passphrase.trim().is_empty() {
        return Err("A passphrase is required to create a branch.".into());
    }
    let template = templates()
        .into_iter()
        .find(|t| t["id"] == template_id)
        .ok_or_else(|| format!("Unknown vault template: {template_id}"))?;

    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let private = root.join(DRIFTLEAF_DIR);
    match fs::create_dir(&private) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(
                "This folder already contains a branch. Open it instead, or choose a new folder."
                    .into(),
            )
        }
        Err(error) => return Err(error.to_string()),
    }
    fs::create_dir(private.join("notes")).map_err(|e| e.to_string())?;

    let salt_hex = random_hex(16);
    let key: Key = derive_key(passphrase, &hex::decode(&salt_hex).map_err(|e| e.to_string())?)?;
    let config = json!({ "version": 1, "kdf": "scrypt", "saltHex": salt_hex });
    fs::write(
        private.join("vault.json"),
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::write(private.join("canary.enc"), encrypt(CANARY_TEXT, &key)?).map_err(|e| e.to_string())?;

    let mut branch = Branch {
        root: root.canonicalize().map_err(|e| e.to_string())?,
        key,
        manifest: json!({
            "notes": [], "folders": [], "databases": [], "extensions": [],
            "canvasItems": [], "trash": [], "attachments": [],
        }),
    };
    branch.write_manifest()?;

    let welcome = branch.create_note("", "Welcome to Driftleaf")?;
    branch.write_note(welcome["id"].as_str().unwrap_or_default(), WELCOME_NOTE)?;

    for folder in template["folders"].as_array().into_iter().flatten() {
        branch.create_folder(folder.as_str().unwrap_or_default())?;
    }
    let date = local_date();
    for note in template["notes"].as_array().into_iter().flatten() {
        let title = note["title"].as_str().unwrap_or_default().replace("{{date}}", &date);
        let content = note["content"].as_str().unwrap_or_default().replace("{{date}}", &date);
        let meta = branch.create_note(note["folderPath"].as_str().unwrap_or_default(), &title)?;
        branch.write_note(meta["id"].as_str().unwrap_or_default(), &content)?;
    }
    Ok(branch)
}

impl Branch {
    /// installExtensionSample(): installs a built-in sample and records which one it was.
    pub fn install_extension_sample(&mut self, sample_id: &str) -> Result<Value, String> {
        let sample = extension_samples()
            .into_iter()
            .find(|s| s["id"] == sample_id)
            .ok_or("Unknown extension sample")?;
        let summary = self.install_extension(
            sample["name"].as_str().unwrap_or_default(),
            sample["source"].as_str().unwrap_or_default(),
        )?;
        let id = summary["id"].clone();
        let stored = self.manifest["extensions"]
            .as_array_mut()
            .and_then(|items| items.iter_mut().find(|e| e["id"] == id))
            .ok_or("The sample extension could not be stored")?;
        stored["sampleId"] = json!(sample_id);
        if let Err(error) = self.write_manifest() {
            let _ = self.remove_extension(id.as_str().unwrap_or_default());
            return Err(error);
        }
        let mut summary = summary;
        summary["sampleId"] = json!(sample_id);
        Ok(summary)
    }

    /// getExtension(): the stored extension including its source, or None.
    pub fn get_extension(&self, id: &str) -> Option<&Value> {
        self.manifest["extensions"].as_array()?.iter().find(|e| e["id"] == id)
    }
}
