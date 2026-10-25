//! Same SQLite OS lock protocol as src/main/branch-lock.ts, including a stable inode.
use rusqlite::{Connection, ErrorCode};
use std::path::{Path, PathBuf};

pub struct BranchLock {
    pub root: PathBuf,
    _connection: Connection,
}
impl BranchLock {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let connection =
            Connection::open(root.join(".driftleaf-writer.sqlite")).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch("BEGIN EXCLUSIVE")
            .map_err(|error| {
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                ) {
                    "This branch is already open in another Driftleaf window or process".into()
                } else {
                    error.to_string()
                }
            })?;
        Ok(Self {
            root,
            _connection: connection,
        })
    }
}
