//! App settings persistence, ported from src/main/settings-store.ts: one small JSON file in
//! the per-user settings directory, written atomically, with the same defaults and bounds.
use crate::random_hex;
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};

const AUTO_LOCK_MINUTES: [i64; 6] = [0, 1, 5, 15, 30, 60];

pub struct SettingsStore {
    dir: PathBuf,
}

fn defaults() -> Map<String, Value> {
    json!({
        "lastVaultPath": null,
        "theme": "system",
        "editorFontSizePx": 15,
        "autosaveIntervalMs": 500,
        "checkUpdatesAutomatically": true,
        "autoLockMinutes": 0,
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

fn clamp(value: &Value, min: f64, max: f64, fallback: f64) -> Value {
    match value.as_f64() {
        Some(number) if number.is_finite() => {
            let clamped = number.clamp(min, max);
            // Whole numbers stay integers in the file, as they are when Node writes it.
            if clamped.fract() == 0.0 { json!(clamped as i64) } else { json!(clamped) }
        }
        _ => json!(fallback),
    }
}

impl SettingsStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    /// Defaults overlaid with whatever is on disk. A missing or unreadable file is defaults.
    pub fn read(&self) -> Value {
        let mut settings = defaults();
        if let Ok(Value::Object(stored)) =
            fs::read(self.path()).map_err(|_| ()).and_then(|bytes| serde_json::from_slice(&bytes).map_err(|_| ()))
        {
            settings.extend(stored);
        }
        Value::Object(settings)
    }

    pub fn patch(&self, patch: &Value) -> Result<Value, String> {
        let mut next = self.read().as_object().cloned().unwrap_or_default();
        if let Some(patch) = patch.as_object() {
            next.extend(patch.clone());
        }
        let font = clamp(&next["editorFontSizePx"], 12.0, 24.0, 15.0);
        let autosave = clamp(&next["autosaveIntervalMs"], 200.0, 5000.0, 500.0);
        next.insert("editorFontSizePx".into(), font);
        next.insert("autosaveIntervalMs".into(), autosave);
        if !next["checkUpdatesAutomatically"].is_boolean() {
            next.insert("checkUpdatesAutomatically".into(), json!(true));
        }
        let auto_lock_ok = next["autoLockMinutes"]
            .as_f64()
            .is_some_and(|m| AUTO_LOCK_MINUTES.iter().any(|allowed| *allowed as f64 == m));
        if !auto_lock_ok {
            next.insert("autoLockMinutes".into(), json!(0));
        }

        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let temporary = self.dir.join(format!(".settings.json.tmp-{}", random_hex(16)));
        let serialized = serde_json::to_string_pretty(&Value::Object(next.clone())).map_err(|e| e.to_string())?;
        fs::write(&temporary, serialized).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&temporary, self.path()) {
            let _ = fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        Ok(Value::Object(next))
    }
}
