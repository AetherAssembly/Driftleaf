//! Ports exportDatabase()/exportCsv() from src/main/database-export.ts.
use crate::formula::{evaluate_formula, text};
use crate::mutation::Branch;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Evaluates one property's value for one row, recursing into prop() references for
/// formula properties with the same cycle detection as formulaValue() in database-export.ts.
fn formula_value(data: &Value, row: &Value, property: &Value, visited: &HashSet<String>) -> Result<Value, String> {
    if property["type"] != "formula" {
        let id = property["id"].as_str().unwrap_or("");
        return Ok(row["values"].get(id).cloned().unwrap_or(Value::Null));
    }
    let property_id = property["id"].as_str().unwrap_or("").to_string();
    if visited.contains(&property_id) {
        return Err("Formula dependency cycle".into());
    }
    let mut next_visited = visited.clone();
    next_visited.insert(property_id);
    let formula_source = property["formula"].as_str().unwrap_or("").to_string();
    let data = data.clone();
    let row = row.clone();
    let lookup = move |name: &str| -> Result<Value, String> {
        let properties = data["properties"].as_array().cloned().unwrap_or_default();
        let referenced = properties
            .iter()
            .find(|p| p["name"] == name)
            .cloned()
            .ok_or_else(|| format!("Unknown property: {name}"))?;
        formula_value(&data, &row, &referenced, &next_visited)
    };
    evaluate_formula(&formula_source, &lookup)
}

fn quote_csv(value: &str) -> String {
    if value.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn export_csv(data: &Value) -> String {
    let properties = data["properties"].as_array().cloned().unwrap_or_default();
    let rows = data["rows"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![properties
        .iter()
        .map(|p| quote_csv(p["name"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join(",")];
    for row in &rows {
        let line = properties
            .iter()
            .map(|property| {
                if property["type"] == "formula" {
                    match formula_value(data, row, property, &HashSet::new()) {
                        Ok(value) => quote_csv(&text(&value)),
                        Err(error) => quote_csv(&format!("#ERROR: {error}")),
                    }
                } else {
                    let id = property["id"].as_str().unwrap_or("");
                    let value = row["values"].get(id).cloned().unwrap_or(Value::Null);
                    quote_csv(&text(&value))
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        lines.push(line);
    }
    format!("{}\r\n", lines.join("\r\n"))
}

impl Branch {
    /// Mirrors exportDatabase(): returns (title, content). `format` is "csv" or "json".
    pub fn export_database(&self, id: &str, format: &str) -> Result<(String, String), String> {
        let data = self.read_database(id)?;
        let title = data["meta"]["title"].as_str().unwrap_or("").to_string();
        if format == "csv" {
            return Ok((title, export_csv(&data)));
        }
        if format != "json" {
            return Err("Unsupported database export format".into());
        }
        let export = json!({
            "format": "driftleaf/database-v1",
            "title": title,
            "properties": data["properties"],
            "rows": data["rows"],
            "views": data["views"],
            "activeViewId": data["activeViewId"],
        });
        Ok((title, serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?))
    }
}
