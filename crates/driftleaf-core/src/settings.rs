//! App settings persistence, ported from src/main/settings-store.ts: one small JSON file in
//! the per-user settings directory, written atomically, with the same defaults and bounds.
use crate::random_hex;
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};

const AUTO_LOCK_MINUTES: [i64; 6] = [0, 1, 5, 15, 30, 60];
const MAX_CUSTOM_CSS_BYTES: usize = 64 * 1024;

pub struct SettingsStore {
    dir: PathBuf,
}

fn defaults() -> Map<String, Value> {
    json!({
        "lastVaultPath": null,
        "theme": "system",
        "accentColor": null,
        "customCss": "",
        "editorFontSizePx": 15,
        "autosaveIntervalMs": 500,
        "checkUpdatesAutomatically": true,
        "autoLockMinutes": 0,
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

fn validate_custom_css(css: &str) -> Result<(), String> {
    if css.len() > MAX_CUSTOM_CSS_BYTES {
        return Err("Custom CSS must be 64 KB or smaller".into());
    }
    if css.contains('\\') {
        return Err("Custom CSS cannot use escape sequences".into());
    }

    let mut code = String::new();
    let mut quote = None;
    let mut chars = css.chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            }
            code.push(' ');
        } else if character == '"' || character == '\'' {
            quote = Some(character);
            code.push(' ');
        } else if character == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut closed = false;
            while let Some(comment_character) = chars.next() {
                if comment_character == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("Custom CSS contains an unfinished comment".into());
            }
            code.push(' ');
        } else {
            code.push(character);
        }
    }
    if quote.is_some() {
        return Err("Custom CSS contains an unfinished string".into());
    }

    let code = code.to_ascii_lowercase();
    let has_function = |name: &str| {
        code.match_indices(name).any(|(index, matched)| {
            let starts_identifier =
                index == 0 || !code[..index].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
            starts_identifier
                && code[index + matched.len()..]
                .trim_start()
                .starts_with('(')
        })
    };
    if code.contains("@import") || has_function("url") || has_function("image-set") {
        return Err("Custom CSS cannot load external resources".into());
    }
    Ok(())
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
        let valid_color = settings["accentColor"].is_null()
            || settings["accentColor"].as_str().is_some_and(|value| {
                value.len() == 7
                    && value.starts_with('#')
                    && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !valid_color {
            settings.insert("accentColor".into(), Value::Null);
        } else if let Some(color) = settings["accentColor"].as_str() {
            settings.insert("accentColor".into(), json!(color.to_ascii_lowercase()));
        }
        if let Some(css) = settings.get("customCss").and_then(Value::as_str) {
            if validate_custom_css(css).is_err() {
                settings.insert("customCss".into(), json!(""));
            }
        } else {
            settings.insert("customCss".into(), json!(""));
        }
        Value::Object(settings)
    }

    pub fn patch(&self, patch: &Value) -> Result<Value, String> {
        let mut next = self.read().as_object().cloned().unwrap_or_default();
        if let Some(patch) = patch.as_object() {
            next.extend(patch.clone());
        }
        let accent_color = next.get("accentColor").cloned().ok_or("Invalid accent color")?;
        if !accent_color.is_null()
            && !accent_color.as_str().is_some_and(|value| {
                value.len() == 7
                    && value.starts_with('#')
                    && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("Accent color must be a six-digit hex color".into());
        }
        if let Some(color) = accent_color.as_str() {
            next.insert("accentColor".into(), json!(color.to_ascii_lowercase()));
        }
        let custom_css = next
            .get("customCss")
            .and_then(Value::as_str)
            .ok_or("Custom CSS must be text")?;
        validate_custom_css(custom_css)?;
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

#[cfg(test)]
mod tests {
    use super::validate_custom_css;

    #[test]
    fn custom_css_blocks_resource_loading_but_allows_local_styles() {
        assert!(validate_custom_css(".app { color: red; }").is_ok());
        assert!(validate_custom_css(r#".app::after { content: "url(ignored)"; }"#).is_ok());
        assert!(validate_custom_css("@import 'https://example.test/theme.css';").is_err());
        assert!(validate_custom_css(".app { background: url (https://example.test/x); }").is_err());
        assert!(validate_custom_css("/*safe*/.app { background: image-set ('x' 1x); }").is_err());
        assert!(validate_custom_css(r#".app { background: u\72l(https://example.test/x); }"#).is_err());
    }
}
