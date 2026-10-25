// Drives parse_csv_database/parse_json_database for the Node interop harness
// (scripts/tests/database-import-interop.mjs). stdin: {"format":"csv"|"json","text":"...",
// "title":"..."}. Prints {"title","properties","rows"} on success.
use driftleaf_core::database_import::{parse_csv_database, parse_json_database};
use std::io::{self, Read};

fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin().read_to_string(&mut request).map_err(|e| e.to_string())?;
    let request: serde_json::Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let text = request["text"].as_str().ok_or("Missing text")?;
    let title = request["title"].as_str().ok_or("Missing title")?;
    let parsed = match request["format"].as_str().ok_or("Missing format")? {
        "csv" => parse_csv_database(text, title)?,
        "json" => parse_json_database(text, title)?,
        other => return Err(format!("Unknown format: {other}")),
    };
    println!(
        "{}",
        serde_json::json!({ "title": parsed.title, "properties": parsed.properties, "rows": parsed.rows })
    );
    Ok(())
}
