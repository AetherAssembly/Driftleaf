// Interoperability harness only; no production IPC or secret command-line arguments.
use std::io::{self, Read};
fn main() -> Result<(), String> {
    let mut request = String::new();
    io::stdin()
        .read_to_string(&mut request)
        .map_err(|e| e.to_string())?;
    let request: serde_json::Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
    let field = |name| {
        request
            .get(name)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("Missing {name}"))
    };
    let salt = hex::decode(field("saltHex")?).map_err(|e| e.to_string())?;
    let key = driftleaf_core::derive_key(field("passphrase")?, &salt)?;
    let bytes = hex::decode(field("dataHex")?).map_err(|e| e.to_string())?;
    let result = match field("operation")? {
        "encrypt" => driftleaf_core::encrypt(&bytes, &key)?,
        "decrypt" => driftleaf_core::decrypt(&bytes, &key)?.to_vec(),
        _ => return Err("Unknown operation".into()),
    };
    println!("{}", hex::encode(result));
    Ok(())
}
