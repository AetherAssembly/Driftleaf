# Driftleaf Rust compatibility core

Development checkpoint: 0.6.10. This crate is **not the application's active backend**.
The Tauri preview still bundles the existing Node domain service.

Implemented and tested:

- scrypt N=131072, r=8, p=1 with exact UTF-8 passphrase bytes and 16-byte salt;
- AES-256-GCM using the existing nonce/tag/ciphertext framing and zeroized keys;
- read-only current and legacy manifest/note parsing and raw database reads;
- SQLite exclusive writer locks interoperable with Node, including crash release.

Run `npm run test:rust-compat` from the repository root. Fixtures contain only
public test data. The example binaries are stdin-driven compatibility harnesses,
not production commands; do not point them at a live personal branch.

Still required before backend replacement: complete manifest/data validation,
atomic mutations and reconciliation, backup/import/export, database behavior,
in-memory search, integration into the desktop session lifecycle, and fault tests.
Do not wire partial native writers into the app or remove the reference backend
until those compatibility gates are satisfied.
