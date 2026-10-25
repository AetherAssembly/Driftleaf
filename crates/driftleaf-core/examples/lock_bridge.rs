// Test harness: one root path from stdin, then hold until stdin closes.
use std::io::{self, BufRead, Write};
fn main() -> Result<(), String> {
    let mut input = io::stdin().lock();
    let mut root = String::new();
    input.read_line(&mut root).map_err(|e| e.to_string())?;
    let root: String = serde_json::from_str(root.trim()).map_err(|e| e.to_string())?;
    let _lock = driftleaf_core::locking::BranchLock::acquire(std::path::Path::new(&root))?;
    println!("locked");
    io::stdout().flush().map_err(|e| e.to_string())?;
    let mut end = String::new();
    input.read_line(&mut end).map_err(|e| e.to_string())?;
    Ok(())
}
