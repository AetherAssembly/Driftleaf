use std::io::{ErrorKind, Write};
use std::path::Path;

// Copy preferences once. Never move/delete the Electron profile or modify its branch.
pub fn import_once(config_root: &Path, destination: &Path) -> std::io::Result<()> {
    let target = destination.join("settings.json");
    if target.exists() {
        return Ok(());
    }
    for name in ["Driftleaf", "driftleaf"] {
        let source = config_root.join(name).join("settings.json");
        let bytes = match std::fs::read(&source) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if bytes.len() > 1024 * 1024 {
            continue;
        }
        if !serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| value.is_object())
        {
            continue;
        }
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => return Ok(()),
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
        return Ok(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_without_modifying_original_or_replacing_current_preferences() {
        let root = std::env::temp_dir().join(format!(
            "driftleaf-settings-{}-{}",
            std::process::id(),
            super::super::uuid_like_suffix()
        ));
        let old = root.join("Driftleaf");
        let new = root.join("preview");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let bytes = br#"{"theme":"dark","lastVaultPath":"/example"}"#;
        std::fs::write(old.join("settings.json"), bytes).unwrap();
        import_once(&root, &new).unwrap();
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), bytes);
        std::fs::write(new.join("settings.json"), b"{}").unwrap();
        import_once(&root, &new).unwrap();
        assert_eq!(std::fs::read(new.join("settings.json")).unwrap(), b"{}");
        assert_eq!(std::fs::read(old.join("settings.json")).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}
