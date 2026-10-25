//! Ports evaluateFormula() from src/shared/formula.ts: a tokenizer plus a recursive-
//! descent parser/evaluator for the small expression language used by "formula" database
//! properties. `FormulaValue` (string | number | boolean | null | FormulaValue[]) is
//! represented as `serde_json::Value` directly, matching the rest of this crate's posture
//! — object values are never produced and never expected as input.
//!
//! Date functions are UTC-only; see date.rs's module comment for why that's a deliberate,
//! documented divergence from the reference implementation's local-timezone Date methods,
//! acceptable here because this only affects computed values at CSV/JSON export time,
//! never stored branch data.
use crate::date;
use serde_json::{json, Value};

#[derive(Clone, Debug)]
enum Token {
    Number(f64),
    Str(String),
    Identifier(String),
    Operator(String),
    Punct(char),
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_whitespace() {
            index += 1;
        } else if ch == '"' {
            let mut value = String::new();
            index += 1;
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    let next = chars[index + 1];
                    value.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                    index += 2;
                } else if chars[index] == '"' {
                    closed = true;
                    index += 1;
                    break;
                } else {
                    value.push(chars[index]);
                    index += 1;
                }
            }
            if !closed {
                return Err("Formula has an unclosed string".into());
            }
            tokens.push(Token::Str(value));
        } else if ch.is_ascii_digit() || (ch == '.' && chars.get(index + 1).is_some_and(char::is_ascii_digit)) {
            let start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            if chars.get(index) == Some(&'.') {
                index += 1;
                while index < chars.len() && chars[index].is_ascii_digit() {
                    index += 1;
                }
            }
            if matches!(chars.get(index), Some('e') | Some('E')) {
                let mut lookahead = index + 1;
                if matches!(chars.get(lookahead), Some('+') | Some('-')) {
                    lookahead += 1;
                }
                if chars.get(lookahead).is_some_and(char::is_ascii_digit) {
                    index = lookahead;
                    while index < chars.len() && chars[index].is_ascii_digit() {
                        index += 1;
                    }
                }
            }
            let text: String = chars[start..index].iter().collect();
            tokens.push(Token::Number(text.parse().map_err(|_| "Formula has an invalid number".to_string())?));
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let start = index;
            while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            tokens.push(Token::Identifier(chars[start..index].iter().collect()));
        } else {
            let two: String = chars[index..(index + 2).min(chars.len())].iter().collect();
            if ["==", "!=", ">=", "<=", "&&", "||"].contains(&two.as_str()) {
                tokens.push(Token::Operator(two));
                index += 2;
            } else if "+-*/%><!".contains(ch) {
                tokens.push(Token::Operator(ch.to_string()));
                index += 1;
            } else if "(),".contains(ch) {
                tokens.push(Token::Punct(ch));
                index += 1;
            } else {
                return Err(format!("Formula contains an unsupported character: {ch}"));
            }
        }
    }
    Ok(tokens)
}

fn js_like_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(|v| v as f64);
    }
    trimmed.parse::<f64>().ok()
}

fn numeric(value: &Value) -> Result<f64, String> {
    match value {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Null => Ok(0.0),
        _ => {
            let rendered = text(value);
            js_like_number(&rendered).ok_or_else(|| format!("Cannot convert \"{rendered}\" to a number"))
        }
    }
}

fn number_to_js_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

// Also used by database_export.rs, which needs the exact same string coercion for
// non-formula cell values (asText() in database-export.ts is the same coercion).
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Array(items) => items.iter().map(text).collect::<Vec<_>>().join(", "),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_js_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Object(_) => String::new(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Null | Value::Object(_) => false,
    }
}

fn date_value(value: &Value) -> Result<i64, String> {
    date::parse_iso(&text(value)).ok_or_else(|| "Formula expected a valid date".to_string())
}

fn unit_milliseconds(unit: &str) -> Result<i64, String> {
    let lower = unit.to_lowercase();
    let normalized = lower.strip_suffix('s').unwrap_or(&lower);
    match normalized {
        "millisecond" => Ok(1),
        "second" => Ok(1000),
        "minute" => Ok(60_000),
        "hour" => Ok(3_600_000),
        "day" => Ok(86_400_000),
        "week" => Ok(604_800_000),
        _ => Err(format!("Unsupported date unit: {unit}")),
    }
}

fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}

fn call_function(name: &str, args: &[Value]) -> Result<Value, String> {
    let first = arg(args, 0);
    match name.to_lowercase().as_str() {
        "if" => {
            if args.len() != 3 {
                return Err("if() expects three arguments".into());
            }
            Ok(if truthy(&args[0]) { args[1].clone() } else { args[2].clone() })
        }
        "ifs" => {
            let mut index = 0;
            while index + 1 < args.len() {
                if truthy(&args[index]) {
                    return Ok(args[index + 1].clone());
                }
                index += 2;
            }
            Ok(if args.len() % 2 == 1 { args[args.len() - 1].clone() } else { Value::Null })
        }
        "and" => Ok(json!(args.iter().all(truthy))),
        "or" => Ok(json!(args.iter().any(truthy))),
        "not" => Ok(json!(!truthy(&first))),
        "empty" => Ok(json!(matches!(&first, Value::Null) || first == json!("") || matches!(&first, Value::Array(items) if items.is_empty()))),
        "length" => Ok(match &first {
            Value::Array(items) => json!(items.len()),
            _ => json!(text(&first).chars().count()),
        }),
        "contains" => {
            let needle = arg(args, 1);
            Ok(match &first {
                Value::Array(items) => json!(items.iter().any(|item| text(item) == text(&needle))),
                _ => json!(text(&first).contains(&text(&needle))),
            })
        }
        "startswith" => Ok(json!(text(&first).starts_with(&text(&arg(args, 1))))),
        "endswith" => Ok(json!(text(&first).ends_with(&text(&arg(args, 1))))),
        "replace" => Ok(json!(text(&first).replacen(&text(&arg(args, 1)), &text(&arg(args, 2)), 1))),
        "replaceall" => Ok(json!(text(&first).replace(&text(&arg(args, 1)), &text(&arg(args, 2))))),
        "lower" => Ok(json!(text(&first).to_lowercase())),
        "upper" => Ok(json!(text(&first).to_uppercase())),
        "trim" => Ok(json!(text(&first).trim())),
        "abs" => Ok(json!(numeric(&first)?.abs())),
        "ceil" => Ok(json!(numeric(&first)?.ceil())),
        "floor" => Ok(json!(numeric(&first)?.floor())),
        "round" => {
            let places = numeric(&arg(args, 1))?.trunc().clamp(0.0, 12.0);
            let scale = 10f64.powf(places);
            Ok(json!((numeric(&first)? * scale).round() / scale))
        }
        "min" => {
            if args.is_empty() {
                return Ok(Value::Null);
            }
            let mut best = f64::INFINITY;
            for value in args {
                best = best.min(numeric(value)?);
            }
            Ok(json!(best))
        }
        "max" => {
            if args.is_empty() {
                return Ok(Value::Null);
            }
            let mut best = f64::NEG_INFINITY;
            for value in args {
                best = best.max(numeric(value)?);
            }
            Ok(json!(best))
        }
        "sum" => {
            let mut total = 0.0;
            for value in args {
                total += numeric(value)?;
            }
            Ok(json!(total))
        }
        "average" => {
            if args.is_empty() {
                return Ok(Value::Null);
            }
            let mut total = 0.0;
            for value in args {
                total += numeric(value)?;
            }
            Ok(json!(total / args.len() as f64))
        }
        "mod" => {
            let divisor = numeric(&arg(args, 1))?;
            if divisor == 0.0 {
                return Err("mod() cannot divide by zero".into());
            }
            Ok(json!(numeric(&first)? % divisor))
        }
        "pow" => Ok(json!(numeric(&first)?.powf(numeric(&arg(args, 1))?))),
        "sqrt" => Ok(json!(numeric(&first)?.sqrt())),
        "sign" => {
            let n = numeric(&first)?;
            // f64::signum() returns ±1.0 even for ±0.0; Math.sign(0) === 0 in JS.
            Ok(json!(if n > 0.0 { 1.0 } else if n < 0.0 { -1.0 } else { n }))
        }
        "join" => Ok(match &first {
            Value::Array(items) => json!(items.iter().map(text).collect::<Vec<_>>().join(&text(&arg(args, 1)))),
            _ => json!(text(&first)),
        }),
        "slice" => {
            let chars: Vec<char> = text(&first).chars().collect();
            let len = chars.len() as i64;
            let resolve = |n: i64| -> usize { (if n < 0 { (len + n).max(0) } else { n.min(len) }) as usize };
            let start = resolve(numeric(&arg(args, 1))? as i64);
            let end = if args.len() > 2 { resolve(numeric(&arg(args, 2))? as i64) } else { len as usize };
            Ok(json!(if start < end { chars[start..end].iter().collect::<String>() } else { String::new() }))
        }
        "concat" => Ok(json!(args.iter().map(text).collect::<Vec<_>>().join(""))),
        "tonumber" => Ok(json!(numeric(&first)?)),
        "tostring" | "format" => Ok(json!(text(&first))),
        "now" => Ok(json!(date::to_iso_string(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
        ))),
        "today" => Ok(json!(date::to_iso_string(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
        )[..10].to_string())),
        "dateadd" | "datesubtract" => {
            let millis = date_value(&first)?;
            let amount = numeric(&arg(args, 1))?;
            let unit_text = text(&arg(args, 2)).to_lowercase();
            let unit_text = if unit_text.is_empty() { "day".to_string() } else { unit_text };
            let unit = unit_text.strip_suffix('s').unwrap_or(&unit_text).to_string();
            let direction = if name.eq_ignore_ascii_case("dateadd") { 1.0 } else { -1.0 };
            let (y, m, d, hh, mm, ss, ms) = date::millis_to_parts(millis);
            let result = if matches!(unit.as_str(), "month" | "quarter" | "year") {
                let months_per_unit = match unit.as_str() { "year" => 12.0, "quarter" => 3.0, _ => 1.0 };
                let months = (amount * months_per_unit * direction) as i64;
                let (new_year, new_month) = date::add_months(y, m, months);
                let clamped_day = d.min(date::days_in_month(new_year, new_month));
                date::parts_to_millis(new_year, new_month, clamped_day, hh, mm, ss, ms)
            } else {
                millis + (amount * unit_milliseconds(&unit)? as f64 * direction) as i64
            };
            Ok(json!(date::to_iso_string(result)))
        }
        "datebetween" => {
            let start = date_value(&first)?;
            let end = date_value(&arg(args, 1))?;
            let unit_text = text(&arg(args, 2)).to_lowercase();
            let unit_text = if unit_text.is_empty() { "day".to_string() } else { unit_text };
            let unit = unit_text.strip_suffix('s').unwrap_or(&unit_text).to_string();
            let (sy, sm, _, _, _, _, _) = date::millis_to_parts(start);
            let (ey, em, _, _, _, _, _) = date::millis_to_parts(end);
            Ok(json!(match unit.as_str() {
                "month" => (ey - sy) * 12 + em as i64 - sm as i64,
                "quarter" => ((ey - sy) * 12 + em as i64 - sm as i64) / 3,
                "year" => ey - sy,
                _ => (end - start) / unit_milliseconds(&unit)?,
            }))
        }
        "datestart" | "dateend" => Ok(json!(date::to_iso_string(date_value(&first)?)[..10].to_string())),
        "formatdate" => {
            let (y, m, d, hh, mm, _, _) = date::millis_to_parts(date_value(&first)?);
            let format_text = text(&arg(args, 1));
            let format_text = if format_text.is_empty() { "YYYY-MM-DD".to_string() } else { format_text };
            let pad = |n: i64| format!("{n:02}");
            Ok(json!(format_text
                .replace("YYYY", &format!("{y:04}"))
                .replace("MM", &pad(m as i64))
                .replace("DD", &pad(d as i64))
                .replace("HH", &pad(hh))
                .replace("mm", &pad(mm))))
        }
        other => Err(format!("Unsupported formula function: {other}")),
    }
}

struct Parser<'a> {
    tokens: Vec<Token>,
    cursor: usize,
    property: &'a dyn Fn(&str) -> Result<Value, String>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }

    fn consume(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.cursor).cloned();
        if token.is_some() {
            self.cursor += 1;
        }
        token
    }

    fn is_operator(&self, values: &[&str]) -> bool {
        matches!(self.peek(), Some(Token::Operator(op)) if values.contains(&op.as_str()))
    }

    fn match_punct(&mut self, value: char) -> bool {
        if matches!(self.peek(), Some(Token::Punct(p)) if *p == value) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    // Deliberately checks the token's *type* as well as its text — unlike formula.ts's
    // generic `match(value)`, which compares only `.value` and so misreads a bare string
    // literal equal to "-"/"+" as the unary operator (see formula-interop.mjs's dedicated
    // test for the resulting real bug: `unary()` then recurses looking for an operand,
    // finds none, and reports "Formula is incomplete" instead of returning the string).
    // Rust's distinct Token variants make that ambiguity impossible by construction.
    fn match_operator(&mut self, value: &str) -> bool {
        if matches!(self.peek(), Some(Token::Operator(op)) if op == value) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn skip_to_delimiter(&mut self, delimiter: char) {
        let mut depth = 0;
        while let Some(token) = self.peek() {
            match token {
                Token::Punct('(') => depth += 1,
                Token::Punct(')') => {
                    if depth == 0 {
                        return;
                    }
                    depth -= 1;
                }
                Token::Punct(p) if *p == delimiter && depth == 0 => return,
                _ => {}
            }
            self.cursor += 1;
        }
    }

    fn primary(&mut self) -> Result<Value, String> {
        let token = self.consume().ok_or("Formula is incomplete")?;
        match token {
            Token::Number(n) => Ok(json!(n)),
            Token::Str(s) => Ok(json!(s)),
            Token::Operator(ref op) if op == "!" => Ok(json!(!truthy(&self.unary()?))),
            Token::Punct('(') => {
                let value = self.logical_or()?;
                if !self.match_punct(')') {
                    return Err("Formula is missing a closing parenthesis".into());
                }
                Ok(value)
            }
            Token::Identifier(name) => {
                let lower = name.to_lowercase();
                if lower == "true" {
                    return Ok(json!(true));
                }
                if lower == "false" {
                    return Ok(json!(false));
                }
                if lower == "null" {
                    return Ok(Value::Null);
                }
                if !self.match_punct('(') {
                    return Err(format!("Unknown formula name: {name}"));
                }
                if lower == "if" {
                    let condition = self.logical_or()?;
                    if !self.match_punct(',') {
                        return Err("if() expects three arguments".into());
                    }
                    if truthy(&condition) {
                        let result = self.logical_or()?;
                        if !self.match_punct(',') {
                            return Err("if() expects three arguments".into());
                        }
                        self.skip_to_delimiter(')');
                        if !self.match_punct(')') {
                            return Err("if() is missing a closing parenthesis".into());
                        }
                        return Ok(result);
                    }
                    self.skip_to_delimiter(',');
                    if !self.match_punct(',') {
                        return Err("if() expects three arguments".into());
                    }
                    let result = self.logical_or()?;
                    if !self.match_punct(')') {
                        return Err("if() expects three arguments".into());
                    }
                    return Ok(result);
                }
                let mut args = Vec::new();
                if !self.match_punct(')') {
                    loop {
                        args.push(self.logical_or()?);
                        if !self.match_punct(',') {
                            break;
                        }
                    }
                    if !self.match_punct(')') {
                        return Err(format!("Function \"{name}\" is missing a closing parenthesis"));
                    }
                }
                if lower == "prop" {
                    let Some(Value::String(prop_name)) = args.first() else {
                        return Err("prop() expects one quoted property name".into());
                    };
                    if args.len() != 1 {
                        return Err("prop() expects one quoted property name".into());
                    }
                    return (self.property)(prop_name);
                }
                call_function(&name, &args)
            }
            Token::Punct(p) => Err(format!("Formula has an unexpected token: {p}")),
            Token::Operator(op) => Err(format!("Formula has an unexpected token: {op}")),
        }
    }

    fn unary(&mut self) -> Result<Value, String> {
        if self.match_operator("-") {
            return Ok(json!(-numeric(&self.unary()?)?));
        }
        if self.match_operator("+") {
            return Ok(json!(numeric(&self.unary()?)?));
        }
        self.primary()
    }

    fn multiplicative(&mut self) -> Result<Value, String> {
        let mut left = self.unary()?;
        while self.is_operator(&["*", "/", "%"]) {
            let Some(Token::Operator(operator)) = self.consume() else { unreachable!() };
            let right = self.unary()?;
            left = match operator.as_str() {
                "*" => json!(numeric(&left)? * numeric(&right)?),
                "/" => {
                    let divisor = numeric(&right)?;
                    if divisor == 0.0 {
                        return Err("Formula cannot divide by zero".into());
                    }
                    json!(numeric(&left)? / divisor)
                }
                _ => json!(numeric(&left)? % numeric(&right)?),
            };
        }
        Ok(left)
    }

    fn additive(&mut self) -> Result<Value, String> {
        let mut left = self.multiplicative()?;
        while self.is_operator(&["+", "-"]) {
            let Some(Token::Operator(operator)) = self.consume() else { unreachable!() };
            let right = self.multiplicative()?;
            left = if operator == "-" {
                json!(numeric(&left)? - numeric(&right)?)
            } else if matches!(left, Value::Number(_)) && matches!(right, Value::Number(_)) {
                json!(numeric(&left)? + numeric(&right)?)
            } else {
                json!(format!("{}{}", text(&left), text(&right)))
            };
        }
        Ok(left)
    }

    fn comparison(&mut self) -> Result<Value, String> {
        let mut left = self.additive()?;
        while self.is_operator(&["==", "!=", ">", "<", ">=", "<="]) {
            let Some(Token::Operator(operator)) = self.consume() else { unreachable!() };
            let right = self.additive()?;
            let numeric_comparison = matches!(left, Value::Number(_)) && matches!(right, Value::Number(_));
            let comparison = if numeric_comparison {
                numeric(&left)? - numeric(&right)?
            } else {
                locale_compare(&text(&left), &text(&right))
            };
            left = json!(match operator.as_str() {
                "==" => comparison == 0.0,
                "!=" => comparison != 0.0,
                ">" => comparison > 0.0,
                "<" => comparison < 0.0,
                ">=" => comparison >= 0.0,
                _ => comparison <= 0.0,
            });
        }
        Ok(left)
    }

    fn logical_and(&mut self) -> Result<Value, String> {
        let mut left = self.comparison()?;
        while self.match_operator("&&") {
            let right = self.comparison()?;
            left = json!(truthy(&left) && truthy(&right));
        }
        Ok(left)
    }

    fn logical_or(&mut self) -> Result<Value, String> {
        let mut left = self.logical_and()?;
        while self.match_operator("||") {
            let right = self.logical_and()?;
            left = json!(truthy(&left) || truthy(&right));
        }
        Ok(left)
    }
}

// Approximates `String.prototype.localeCompare(other, undefined, { numeric: true })`:
// digit runs compare by numeric value rather than lexicographically, everything else
// compares ordinally. Not a full Unicode collation implementation.
fn locale_compare(a: &str, b: &str) -> f64 {
    let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (mut i, mut j) = (0, 0);
    while i < ac.len() && j < bc.len() {
        if ac[i].is_ascii_digit() && bc[j].is_ascii_digit() {
            let start_i = i;
            while i < ac.len() && ac[i].is_ascii_digit() {
                i += 1;
            }
            let start_j = j;
            while j < bc.len() && bc[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = ac[start_i..i].iter().collect();
            let nb: String = bc[start_j..j].iter().collect();
            let (na, nb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
            if na.len() != nb.len() {
                return if na.len() < nb.len() { -1.0 } else { 1.0 };
            }
            if na != nb {
                return if na < nb { -1.0 } else { 1.0 };
            }
        } else {
            if ac[i] != bc[j] {
                return if ac[i] < bc[j] { -1.0 } else { 1.0 };
            }
            i += 1;
            j += 1;
        }
    }
    match ac.len().cmp(&bc.len()) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Greater => 1.0,
        std::cmp::Ordering::Equal => 0.0,
    }
}

/// `property` resolves a `prop("Name")` reference to that property's current value for
/// the row being evaluated; callers (database_export.rs) supply one that looks the name
/// up in the row/property list, with cycle detection for formula-referencing-formula.
pub fn evaluate_formula(source: &str, property: &dyn Fn(&str) -> Result<Value, String>) -> Result<Value, String> {
    let tokens = tokenize(source)?;
    let token_count = tokens.len();
    let mut parser = Parser { tokens, cursor: 0, property };
    let result = parser.logical_or()?;
    if parser.cursor != token_count {
        let remaining = parser.peek().map(describe_token).unwrap_or_default();
        return Err(format!("Unexpected formula token: {remaining}"));
    }
    if let Value::Number(n) = &result {
        if !n.as_f64().unwrap_or(f64::NAN).is_finite() {
            return Err("Formula result is not a finite number".into());
        }
    }
    Ok(result)
}

fn describe_token(token: &Token) -> String {
    match token {
        Token::Number(n) => n.to_string(),
        Token::Str(s) => s.clone(),
        Token::Identifier(s) => s.clone(),
        Token::Operator(s) => s.clone(),
        Token::Punct(c) => c.to_string(),
    }
}
