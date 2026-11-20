# Driftleaf Rust storage backend

`driftleaf-core` is the active storage backend used by the Tauri desktop app. The Tauri
shell links this crate directly and calls its `Service` on a blocking worker thread; it
does not launch the Node reference service or bundle a Node runtime.

The crate owns branch creation, unlock/reconciliation, encryption, note and folder
mutations, databases and formulas, attachments, Trash, import/export, backups, SQLite
writer locking, and the in-memory search index and note graph. The existing on-disk branch
format is retained for compatibility.

The Node implementation under `src/main/` and `sidecar/` remains as a development
reference for compatibility/regression scripts and the browser UI harness. It is not part
of the production Tauri backend.

Run the backend tests from the repository root:

```sh
cargo test --manifest-path crates/driftleaf-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:rust-compat
```

The compatibility examples and fixtures use disposable test data. Do not point them at a
personal branch.
