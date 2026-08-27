# Data Loss Testing Suite

Test suite for verifying Driftleaf's data loss safeguards across vault operations.

## Tests

### `data-loss.js`

Quick sanity checks for vault structure and file safety. Runs without requiring a built vault module.

**Tests:**

- Atomic write cleanup (no temp files left after operations)
- Manifest atomicity (manifest is valid JSON)
- Config integrity (vault.json has required fields)
- Orphan file checks (no orphaned .enc files)
- Canary validation (canary.enc exists and is properly sized)

**Run:**

```bash
node scripts/tests/data-loss.js
```

### `data-loss-integration.mjs`

Integration tests using the actual built vault module. Verifies end-to-end crash safety and data integrity.

**Tests:**

- Vault creation creates required files
- Manifest JSON structure is valid
- Atomic writes leave no temp files
- Notes are encrypted on disk
- Wrong passphrase fails
- Correct passphrase unlocks vault
- Note write/read roundtrip preserves content
- Manifest persists across unlocks
- Folder operations persist
- Corrupted notes are detected

**Run:**

```bash
npm run build
node scripts/tests/data-loss-integration.mjs
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
3. **Reconciliation** - vault self-heals on unlock
4. **Encryption** - notes are always encrypted on disk
5. **Corruption detection** - AES-GCM auth tags catch bit-flips
6. **Passphrase verification** - wrong passphrases fail immediately
7. **Persistence** - manifest changes survive restarts

See [docs/DATA_LOSS_TESTING.md](../docs/DATA_LOSS_TESTING.md) for full technical details on each safeguard.
