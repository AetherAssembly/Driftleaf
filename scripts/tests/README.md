# Data Loss Testing Suite

Test suite for verifying Driftleaf's data loss safeguards across vault operations.

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
node scripts/tests/data-loss.js
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

See [docs/DATA_LOSS_TESTING.md](../docs/DATA_LOSS_TESTING.md) for full technical details on each safeguard.
