use std::io::{self, Read};
fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin()
        .read_to_string(&mut request)
        .map_err(|e| e.to_string())?;
    let request: serde_json::Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let root = request["root"].as_str().ok_or("Missing root")?;
    let passphrase = request["passphrase"].as_str().ok_or("Missing passphrase")?;
    let snapshot =
        driftleaf_core::snapshot::Snapshot::open(std::path::Path::new(root), passphrase)?;
    let mut notes = serde_json::Map::new();
    for note in snapshot.manifest["notes"]
        .as_array()
        .ok_or("Missing notes")?
    {
        let id = note["id"].as_str().ok_or("Missing note ID")?;
        notes.insert(id.into(), serde_json::json!(snapshot.read_note(id)?));
    }
    let mut databases = serde_json::Map::new();
    if let Some(items) = snapshot.manifest["databases"].as_array() {
        for item in items {
            let id = item["id"].as_str().ok_or("Missing database ID")?;
            databases.insert(id.into(), snapshot.read_database(id)?);
        }
    }
    println!(
        "{}",
        serde_json::json!({"manifest":snapshot.manifest,"notes":notes,"databases":databases})
    );
    Ok(())
}
