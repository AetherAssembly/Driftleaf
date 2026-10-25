//! Ports parseCsvDatabase()/parseJsonDatabase() from src/main/database-import.ts: pure,
//! branch-independent heuristics that turn a CSV or JSON file into database properties and
//! rows. Unlike the encryption/manifest logic elsewhere in this crate, a mismatch here is a
//! minor import-heuristic difference (e.g. a column inferred as text instead of date), not a
//! data-safety issue — but the goal is still to match Node's behavior field-for-field.
use crate::random_uuid_v4;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct ParsedDatabase {
    pub title: String,
    pub properties: Value,
    pub rows: Value,
}

#[derive(Clone, Copy)]
struct PropertyHint {
    property_type: &'static str,
}

fn scalar(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::String(s) => Value::String(s.clone()),
                    other => Value::String(other.to_string()),
                })
                .collect(),
        ),
        Value::Object(_) => Value::String(value.to_string()),
    }
}

/// A hand-rolled RFC 4180-ish CSV tokenizer mirroring parseCsv() in database-import.ts
/// character-for-character: quoted fields, doubled-quote escaping, and rows are skipped
/// only when every cell in them is empty.
fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut quote_closed = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if quoted {
            if ch == '"' && chars.get(index + 1) == Some(&'"') {
                field.push('"');
                index += 1;
            } else if ch == '"' {
                quoted = false;
                quote_closed = true;
            } else {
                field.push(ch);
            }
        } else if quote_closed && ch == ',' {
            row.push(std::mem::take(&mut field));
            quote_closed = false;
        } else if quote_closed && (ch == '\n' || ch == '\r') {
            if ch == '\r' && chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            row.push(std::mem::take(&mut field));
            quote_closed = false;
            if row.iter().any(|cell| !cell.is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else if quote_closed && ch.is_whitespace() {
            // skip
        } else if quote_closed {
            return Err("CSV contains characters after a quoted field".into());
        } else if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == '"' {
            return Err("CSV contains an unexpected quote".into());
        } else if ch == ',' {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            row.push(std::mem::take(&mut field));
            if row.iter().any(|cell| !cell.is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
        } else {
            field.push(ch);
        }
        index += 1;
    }
    if quoted {
        return Err("CSV contains an unclosed quoted field".into());
    }
    row.push(field);
    if row.iter().any(|cell| !cell.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}

// Mirrors `/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/` exactly (used only for infer_type's column-type
// heuristic; parse_typed_value's actual conversion uses the more permissive is_finite_number,
// matching database-import.ts's own split between a strict regex for inference and plain
// `Number()` coercion for conversion).
fn looks_like_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    if bytes.first() == Some(&b'-') {
        i += 1;
    }
    let int_start = i;
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return false;
    }
    if bytes[i] == b'0' {
        i += 1;
    } else {
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == int_start {
        return false;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac_start {
            return false;
        }
    }
    i == bytes.len()
}

// A deliberately permissive stand-in for `Number.isFinite(Date.parse(value))`: the regex
// below already requires a YYYY-MM-DD prefix, so this only needs to reject clearly
// impossible calendar dates (month 13, Feb 30, ...) — good enough for a type-inference
// heuristic, not a claim of full ISO-8601/RFC-2822 parity with V8's Date.parse.
fn looks_like_parseable_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return false;
    }
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(&value[0..4]) || &value[4..5] != "-" || !digits(&value[5..7]) || &value[7..8] != "-" || !digits(&value[8..10]) {
        return false;
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let year: i32 = value[0..4].parse().unwrap_or(0);
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if day == 0 || day > days_in_month[(month - 1) as usize] {
        return false;
    }
    value.len() == 10 || matches!(value.as_bytes().get(10), Some(b'T') | Some(b' '))
}

fn looks_like_http_url(value: &str) -> bool {
    value
        .split_once("://")
        .is_some_and(|(scheme, rest)| (scheme == "http" || scheme == "https") && !rest.is_empty())
}

fn infer_type(values: &[Value]) -> &'static str {
    let present: Vec<&Value> = values
        .iter()
        .filter(|v| !matches!(v, Value::Null) && *v != &json!(""))
        .collect();
    if present.is_empty() {
        return "text";
    }
    let as_text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    if present.iter().all(|v| {
        matches!(v, Value::Bool(_))
            || matches!(as_text(v).to_lowercase().as_str(), "true" | "false" | "yes" | "no" | "checked" | "unchecked")
    }) {
        return "checkbox";
    }
    if present.iter().all(|v| matches!(v, Value::Number(_)) || looks_like_number(&as_text(v))) {
        return "number";
    }
    if present.iter().all(|v| looks_like_parseable_date(&as_text(v))) {
        return "date";
    }
    if present.iter().all(|v| looks_like_http_url(&as_text(v))) {
        return "url";
    }
    "text"
}

fn parse_typed_value(value: &Value, property_type: &str) -> Value {
    if matches!(value, Value::Null) || value == &json!("") {
        return Value::Null;
    }
    if property_type == "number" {
        let text = match value {
            Value::Number(n) => return json!(n),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        return match text.parse::<f64>() {
            Ok(n) if n.is_finite() => json!(n),
            _ => json!(text),
        };
    }
    if property_type == "checkbox" {
        if let Value::Bool(b) = value {
            return json!(*b);
        }
        let text = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let lower = text.to_lowercase();
        if ["true", "yes", "1", "checked"].contains(&lower.as_str()) {
            return json!(true);
        }
        if ["false", "no", "0", "unchecked"].contains(&lower.as_str()) {
            return json!(false);
        }
    }
    if property_type == "multi_select" {
        if let Value::String(s) = value {
            return json!(s.split(',').map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>());
        }
    }
    scalar(value)
}

// `Array.isArray(value) ? value : value == null ? [] : [value]`, then filtered to keep
// only non-empty strings — a bare number/bool/object value gets wrapped and then dropped
// entirely, never stringified.
fn generic_option_candidates(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn make_database(
    title: &str,
    names: &[String],
    source_rows: &[serde_json::Map<String, Value>],
    hints: &HashMap<String, PropertyHint>,
) -> Result<ParsedDatabase, String> {
    if names.is_empty() {
        return Err("Data has no columns".into());
    }
    let property_names: Vec<String> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                format!("Property {}", i + 1)
            } else {
                trimmed.to_string()
            }
        })
        .collect();
    let mut unique = HashSet::new();
    for name in &property_names {
        if !unique.insert(name.clone()) {
            return Err(format!("Duplicate column name: {name}"));
        }
    }
    let hinted_title_index = property_names
        .iter()
        .position(|name| hints.get(name).is_some_and(|h| h.property_type == "title"));
    let matched_title_index = property_names
        .iter()
        .position(|name| name.eq_ignore_ascii_case("name") || name.eq_ignore_ascii_case("title"));
    let title_index = hinted_title_index.or(matched_title_index).unwrap_or(0);

    let mut properties = Vec::new();
    for (index, name) in property_names.iter().enumerate() {
        let hint_type = hints.get(name).map(|h| h.property_type);
        let property_type = if index == title_index {
            "title"
        } else {
            hint_type.unwrap_or_else(|| {
                let values: Vec<Value> = source_rows
                    .iter()
                    .map(|row| row.get(name).cloned().unwrap_or(Value::Null))
                    .collect();
                infer_type(&values)
            })
        };
        let mut property = json!({ "id": random_uuid_v4(), "name": name, "type": property_type });
        if matches!(hint_type, Some("select") | Some("status") | Some("multi_select")) {
            let mut options = Vec::new();
            let mut seen = HashSet::new();
            for row in source_rows {
                let value = row.get(name).cloned().unwrap_or(Value::Null);
                // TS only takes the comma-split path when the hint is multi_select *and* the
                // value is actually a string (the CSV case); a multi_select value already
                // normalized to an array (e.g. by notionValue()) falls through to the same
                // generic `Array.isArray(value) ? value : value == null ? [] : [value]`
                // branch every other hint type uses, then both branches are filtered down
                // to non-empty strings at the end.
                let candidates: Vec<String> = if hint_type == Some("multi_select") {
                    if let Value::String(s) = &value {
                        s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
                    } else {
                        generic_option_candidates(&value)
                    }
                } else {
                    generic_option_candidates(&value)
                };
                for candidate in candidates {
                    if !candidate.is_empty() && seen.insert(candidate.clone()) {
                        options.push(candidate);
                    }
                }
            }
            property["options"] = json!(options);
        }
        properties.push(property);
    }

    let now = crate::mutation::now_ms();
    let rows: Vec<Value> = source_rows
        .iter()
        .map(|source| {
            let mut values = serde_json::Map::new();
            for property in &properties {
                let name = property["name"].as_str().unwrap();
                let property_type = property["type"].as_str().unwrap();
                let value = source.get(name).cloned().unwrap_or(Value::Null);
                let final_value = if property_type == "title" {
                    match &value {
                        Value::Null => json!(""),
                        Value::String(s) => json!(s),
                        other => json!(other.to_string()),
                    }
                } else {
                    parse_typed_value(&value, property_type)
                };
                values.insert(property["id"].as_str().unwrap().to_string(), final_value);
            }
            json!({ "id": random_uuid_v4(), "values": values, "createdAt": now, "updatedAt": now })
        })
        .collect();

    Ok(ParsedDatabase { title: title.to_string(), properties: Value::Array(properties), rows: Value::Array(rows) })
}

pub fn parse_csv_database(text: &str, title: &str) -> Result<ParsedDatabase, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let matrix = parse_csv(text)?;
    if matrix.is_empty() {
        return Err("CSV is empty".into());
    }
    let headers: Vec<String> = matrix[0].iter().map(|h| h.trim().to_string()).collect();
    if headers.iter().any(|h| h.is_empty()) {
        return Err("CSV has an empty column name".into());
    }
    let mut source_rows = Vec::new();
    for line in &matrix[1..] {
        if line.len() != headers.len() {
            return Err(format!("CSV row has {} columns; expected {}", line.len(), headers.len()));
        }
        let mut source = serde_json::Map::new();
        for (header, cell) in headers.iter().zip(line.iter()) {
            source.insert(header.clone(), json!(cell));
        }
        source_rows.push(source);
    }
    let mut hints = HashMap::new();
    for header in &headers {
        let lower = header.to_lowercase();
        let hint_type = match lower.as_str() {
            "tags" | "labels" | "categories" => Some("multi_select"),
            "status" | "priority" | "category" | "type" => Some("select"),
            "url" | "website" | "link" => Some("url"),
            "email" | "e-mail" => Some("email"),
            "phone" | "phone number" => Some("phone"),
            _ => None,
        };
        if let Some(property_type) = hint_type {
            hints.insert(header.clone(), PropertyHint { property_type });
        }
    }
    make_database(title, &headers, &source_rows, &hints)
}

fn notion_value(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let rich_text_join = |items: &[Value]| -> String {
        items
            .iter()
            .map(|part| {
                part.as_object()
                    .and_then(|p| {
                        p.get("plain_text")
                            .and_then(Value::as_str)
                            .or_else(|| p.get("text").and_then(|t| t.get("content")).and_then(Value::as_str))
                    })
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    };
    if let Some(Value::Array(title)) = object.get("title") {
        return json!(rich_text_join(title));
    }
    if let Some(Value::Array(rich_text)) = object.get("rich_text") {
        return json!(rich_text_join(rich_text));
    }
    for key in ["select", "status"] {
        if let Some(choice) = object.get(key).and_then(Value::as_object) {
            return choice.get("name").cloned().unwrap_or(Value::Null);
        }
    }
    if let Some(Value::Array(items)) = object.get("multi_select") {
        return json!(items
            .iter()
            .map(|choice| choice
                .as_object()
                .and_then(|c| c.get("name"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| choice.to_string()))
            .collect::<Vec<_>>());
    }
    for key in ["checkbox", "number", "url", "email", "phone_number"] {
        if let Some(v) = object.get(key) {
            return v.clone();
        }
    }
    if let Some(date) = object.get("date").and_then(Value::as_object) {
        return date.get("start").cloned().unwrap_or(Value::Null);
    }
    if let Some(formula) = object.get("formula").and_then(Value::as_object) {
        return formula
            .get("string")
            .or_else(|| formula.get("number"))
            .or_else(|| formula.get("boolean"))
            .cloned()
            .unwrap_or(Value::Null);
    }
    if let Some(Value::Array(relation)) = object.get("relation") {
        return json!(relation
            .iter()
            .map(|item| item.as_object().and_then(|o| o.get("id")).and_then(Value::as_str).unwrap_or("").to_string())
            .collect::<Vec<_>>());
    }
    if let Some(Value::Array(people)) = object.get("people") {
        return json!(people
            .iter()
            .map(|person| person
                .as_object()
                .and_then(|p| p.get("name").or_else(|| p.get("id")))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string())
            .collect::<Vec<_>>());
    }
    if let Some(Value::Array(files)) = object.get("files") {
        return json!(files
            .iter()
            .map(|file| file
                .as_object()
                .and_then(|f| f.get("name").or_else(|| f.get("url")))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string())
            .collect::<Vec<_>>());
    }
    if let Some(v) = object.get("created_time").or_else(|| object.get("last_edited_time")) {
        return v.clone();
    }
    value.clone()
}

fn notion_property_hint(value: &Value) -> Option<PropertyHint> {
    let object = value.as_object()?;
    let type_map: &[(&str, &str)] = &[
        ("title", "title"),
        ("rich_text", "text"),
        ("number", "number"),
        ("checkbox", "checkbox"),
        ("date", "date"),
        ("select", "select"),
        ("multi_select", "multi_select"),
        ("status", "status"),
        ("url", "url"),
        ("email", "email"),
        ("phone_number", "phone"),
        ("created_time", "created_time"),
        ("created_by", "created_by"),
        ("last_edited_time", "last_edited_time"),
        ("last_edited_by", "last_edited_by"),
    ];
    let declared_type = object.get("type").and_then(Value::as_str);
    let inferred = declared_type
        .and_then(|t| type_map.iter().find(|(key, _)| *key == t).map(|(_, v)| *v))
        .or_else(|| matches!(object.get("title"), Some(Value::Array(_))).then_some("title"))
        .or_else(|| matches!(object.get("rich_text"), Some(Value::Array(_))).then_some("text"))
        .or_else(|| object.contains_key("checkbox").then_some("checkbox"))
        .or_else(|| object.contains_key("number").then_some("number"))
        .or_else(|| object.contains_key("date").then_some("date"))
        .or_else(|| object.contains_key("select").then_some("select"))
        .or_else(|| object.contains_key("multi_select").then_some("multi_select"))
        .or_else(|| object.contains_key("status").then_some("status"))
        .or_else(|| object.contains_key("url").then_some("url"))
        .or_else(|| object.contains_key("email").then_some("email"))
        .or_else(|| object.contains_key("phone_number").then_some("phone"));
    inferred.map(|property_type| PropertyHint { property_type })
}

fn normalize_json_row(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let object = value.as_object().ok_or("JSON database rows must be objects")?;
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(object);
    Ok(properties.iter().map(|(k, v)| (k.clone(), notion_value(v))).collect())
}

pub fn parse_json_database(text: &str, title: &str) -> Result<ParsedDatabase, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let parsed: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;

    if parsed.get("format").and_then(Value::as_str) == Some("driftleaf/database-v1") {
        let object = parsed.as_object().unwrap();
        let exported_title = object.get("title").and_then(Value::as_str);
        let properties = object.get("properties").filter(|v| v.is_array());
        let rows = object.get("rows").filter(|v| v.is_array());
        let (Some(exported_title), Some(properties), Some(rows)) = (exported_title, properties, rows) else {
            return Err("Driftleaf database export has an invalid schema".into());
        };
        let final_title = if exported_title.trim().is_empty() { title.to_string() } else { exported_title.trim().to_string() };
        return Ok(ParsedDatabase { title: final_title, properties: properties.clone(), rows: rows.clone() });
    }

    let rows: Vec<Value> = if let Value::Array(items) = &parsed {
        items.clone()
    } else if let Some(object) = parsed.as_object() {
        ["data", "results", "records"]
            .iter()
            .find_map(|key| object.get(*key).filter(|v| v.is_array()).cloned())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_else(|| vec![parsed.clone()])
    } else {
        return Err("JSON must contain an object or an array of objects".into());
    };
    if rows.is_empty() {
        return Err("JSON database has no rows to infer columns from".into());
    }
    let source_rows: Vec<serde_json::Map<String, Value>> =
        rows.iter().map(normalize_json_row).collect::<Result<_, _>>()?;
    let mut names = Vec::new();
    let mut seen_names = HashSet::new();
    for row in &source_rows {
        for key in row.keys() {
            if seen_names.insert(key.clone()) {
                names.push(key.clone());
            }
        }
    }
    let mut hints = HashMap::new();
    for row in &rows {
        let Some(object) = row.as_object() else { continue };
        let properties = object.get("properties").and_then(Value::as_object).unwrap_or(object);
        for (name, value) in properties {
            if hints.contains_key(name) {
                continue;
            }
            if let Some(hint) = notion_property_hint(value) {
                hints.insert(name.clone(), hint);
            }
        }
    }
    make_database(title, &names, &source_rows, &hints)
}
