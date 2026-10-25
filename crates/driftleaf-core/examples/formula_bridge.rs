// Drives evaluate_formula() directly (no branch) for the Node interop harness
// (scripts/tests/formula-interop.mjs). stdin: {"formula":"...","properties":[{"id","name"}],
// "rowValues":{"<propertyId>":<value>}}. prop("Name") resolves straight to that property's
// raw stored value — chained formula-to-formula references are exercised separately via
// exportDatabase in mutation-interop-style tests, not this bridge.
use driftleaf_core::formula::evaluate_formula;
use serde_json::Value;
use std::io::{self, Read};

fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin().read_to_string(&mut request).map_err(|e| e.to_string())?;
    let request: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let formula = request["formula"].as_str().ok_or("Missing formula")?;
    let properties = request["properties"].as_array().cloned().unwrap_or_default();
    let row_values = request["rowValues"].clone();
    let lookup = move |name: &str| -> Result<Value, String> {
        let property = properties
            .iter()
            .find(|p| p["name"] == name)
            .ok_or_else(|| format!("Unknown property: {name}"))?;
        Ok(row_values.get(property["id"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null))
    };
    let result = evaluate_formula(formula, &lookup)?;
    println!("{}", serde_json::json!({ "result": result }));
    Ok(())
}
