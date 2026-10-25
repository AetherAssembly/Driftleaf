# Data Loss Testing Suite

Test suite for verifying Driftleaf's data loss safeguards across branch operations.
In this developer documentation, "vault" names the internal API/module and the
on-disk format for a user-facing branch.

## Tests

### `data-loss-integration.mjs`

Integration tests using the actual vault module. Verifies end-to-end crash
safety, encrypted metadata, legacy migration, extension persistence, database
property/formula behavior, database import/export, and backup restoration.
It also checks community template ZIP imports into their dedicated encrypted
vault folder.

**Tests:**

- Vault creation creates required files
- Manifest metadata is encrypted at rest
- Atomic writes leave no temp files
- Notes are encrypted on disk
- Wrong passphrase fails
- Correct passphrase unlocks vault
- Note write/read roundtrip preserves content
- Manifest persists across unlocks
- Folder operations persist
- Corrupted notes are detected
- Legacy plaintext manifests and named note paths migrate to encrypted metadata and opaque note IDs
- Extension source and permissions remain encrypted
- Multiple database properties and calculated formula results persist
- Driftleaf JSON export/import preserves formulas, rows, and saved views
- CSV exports correctly quote values and import calculated results
- Vault backups verify and restore encrypted database contents
- Community template archives import Markdown into their vault subfolder

**Run:**

```bash
npm test
```

## When to Run

Run these tests:

- Before pushing any changes to vault.ts, crypto.ts, or manifest handling
- After implementing new vault features (folders, imports, etc.)
- When adding new file operations or encryption changes
- After any filesystem-related refactors

## Test Coverage

These tests verify:

1. **Atomic writes** - temp files don't leak
2. **Crash safety** - operation ordering prevents data loss
3. **Reconciliation** - vault recovers orphaned encrypted files where possible
4. **Encryption** - notes are always encrypted on disk
5. **Corruption detection** - AES-GCM auth tags catch bit-flips
6. **Passphrase verification** - wrong passphrases fail immediately
7. **Persistence** - encrypted manifest changes survive unlocks

See [docs/DATA_LOSS_TESTING.md](../../docs/DATA_LOSS_TESTING.md) for a user-facing overview of vault integrity and recovery limits.

## Save and lifecycle regressions

`regressions.mjs` also verifies exclusive branch creation, the actual IPC
write/lock ordering, failed-draft retries, in-flight close flushing, close sender
validation, and search/graph replacement. It runs production TypeScript modules
with a mocked Electron transport and Node SQLite FTS5 (the packaged SQLite addon
is rebuilt for Electron, not the CI Node runtime). No personal branches are used.

Phase 0 also tests separate-session writer exclusion, releasing locks after
failed unlock/setup, cross-process lock recovery after forced termination,
backup exclusion of runtime lock files, and canvas draft retry. SQLite lock
semantics are exercised against real files, including a separate Node process.


## Tauri Phase 2 sidecar and protocol

`npm run test:sidecar` (also part of `npm test`) launches the real Node sidecar with
isolated temporary settings and branches. It checks encrypted note/search/backup
round trips, writer exclusion, framed concurrent requests, denial of internal and
prototype methods, and termination on malformed input. It also enables search
debugging to verify that logs cannot corrupt protocol stdout or reveal the search
canary. It needs permission to spawn child Node processes.

`cargo test --manifest-path src-tauri/Cargo.toml` checks the Rust renderer allowlist
and protocol size/truncation handling. Neither suite launches a Tauri window;
native dialogs and close/save behavior still require manual preview testing.


Phase 3 extension regressions exercise the shared authorization backend against
real encrypted branches, including grant revocation ordering, stale session
contexts, removal, unknown senders, and filtered database relations/rollups and
row values. Native extension-window isolation still needs host-specific testing.


## Rust compatibility checkpoint

`npm run test:rust-compat` builds the isolated `crates/driftleaf-core` examples and
runs fixed crypto vectors plus bidirectional Node/Rust encryption, real read-only
branch comparisons (including legacy paths), native note/folder mutation (create,
write, rename, delete, create folder) with a simulated-crash orphan-recovery
fixture, native database/canvas/extension mutation and folder rename/move/delete
(including the relation-delete guards and row-delete relation cascade), branch
backup creation and the verify-backup health check, CSV/Notion-JSON database
import parsing, file/zip/template import orchestration (including a zip-slip
guard), the formula evaluator (arithmetic/comparisons/logic/dates/~25 built-in
functions), database export (CSV/JSON, including formula columns and cycle
detection), FTS5 search with the wikilink note graph, and SQLite lock
interoperability. Lock tests cover both exclusion directions and normal/forced
process exit. All data and passphrases are disposable test fixtures. This suite
proves storage-logic compatibility; it does not switch the application's active
storage engine, which still runs through `sidecar/index.mjs`.

To test packaged backend resources, set `DRIFTLEAF_TEST_BACKEND` to an extracted
package's `backend` directory and run `sidecar.mjs` using that directory's bundled
`node` executable. The four tests then use the packaged runtime and sources.
The full JavaScript suite currently contains 38 tests; the Tauri shell has 10 Rust
unit tests. See the migration log for limits of GUI and platform validation.
