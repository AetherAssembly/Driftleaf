# Vault Integrity and Recovery Checks

## Summary

The integration suite exercises encrypted storage, crash-safe writes, migration,
corruption detection, and vault recovery. Recovery is intentionally explicit
about its limits: if the encrypted manifest is lost, opaque note filenames do
not reveal the original titles or folders.

## Verified Safeguards

### 1. Atomic Writes (temp-file + rename)

**Location:** `src/main/vault.ts` — `writeFileAtomic()`

**Mechanism:**

- All file writes go to a sibling temp file: `.{filename}.tmp-{uuid}`
- After successful write, temp file is atomically renamed to final location
- POSIX and NTFS guarantee atomic renames within the same directory
- **Crash safety:** a crash leaves either the old file (intact) or nothing — never a half-written file

**Protected operations:**

- `createNote()` — encrypted note content written before manifest update
- `writeNote()` — encrypted note content written before manifest update
- `renameNote()` — file renamed before manifest update
- `writeManifest()` — all manifest updates use atomic writes
- `writeFileAtomic()` — canary writes use atomic writes

### 2. Crash-Safe Operation Ordering

**Pattern:** disk changes before manifest updates.

| Operation | File write order | Crash outcome |
| --- | --- | --- |
| Create note | Write opaque-ID `.enc` file → update encrypted manifest | A crash between writes leaves an orphan recovered as `Recovered note`; its title/folder metadata is unavailable |
| Write note | Atomically replace `.enc` file → update `updatedAt` in manifest | Content remains complete; the timestamp may be stale |
| Rename or move | Update encrypted manifest (note file path is unchanged) | A crash leaves either the previous or updated metadata |
| Delete note | Remove manifest entry → delete `.enc` file | A crash between steps may recover the orphaned content with placeholder metadata |
| Delete folder | Update manifest → delete note files | A crash may recover removed note files with placeholder metadata |

Atomic manifest and content writes avoid partial files. Orphan recovery can
preserve ciphertext, but cannot recreate metadata removed from the manifest.

### 3. Vault Reconciliation on Every Unlock

**Location:** `src/main/vault.ts` — `reconcileVault()`

**What happens automatically:**

- `reconcileVault()` runs on every `unlockVault()` call
- Scans all `.enc` files on disk via `scanEncFiles()`
- Cross-checks against manifest entries
- Self-heals three classes of issues:

| Issue | Detection | Recovery |
| --- | --- | --- |
| **Dangling manifest entry** | Manifest entry has no `.enc` file on disk | Entry removed from manifest |
| **Opaque-ID orphan** | `.driftleaf/notes/<note-id>.enc` has no manifest entry | Recovered as an untitled `Recovered note`; original title/folder cannot be derived from its opaque ID |
| **Legacy note file** | Manifest entry points to its old named path | Moved to `.driftleaf/notes/<note-id>.enc`; empty legacy folders are pruned |

**Report:** `VaultRecoveryReport` tracks what was healed and is surfaced after unlock.

### 4. AES-GCM Authentication Tag

**Location:** `src/main/crypto.ts` — `encrypt()` / `decrypt()`

**Mechanism:**

- Every note uses AES-256-GCM with a 12-byte IV and 16-byte authentication tag
- Tag is verified on every decrypt via `decipher.setAuthTag()`
- Authentication failure = automatic detection of corruption

**Result:** any bit-flip, truncation, or tampering is caught at read time. Corrupted notes are reported as corrupted rather than silently failing.

### 5. Encrypted Manifest

**Location:** `src/main/vault.ts` — `.driftleaf/manifest.enc`

The manifest (note titles, folder paths, timestamps, database titles, and
extension source/permissions) is encrypted with the vault key and written
atomically. Note ciphertext is stored under `.driftleaf/notes/<note-id>.enc`;
titles are not present in note filenames. The legacy plaintext `manifest.json`
is accepted only during migration and removed after a successful unlock writes
the encrypted manifest.

If the encrypted manifest is missing or corrupt, do not delete it or create a
new vault over it. Restore the `.driftleaf/` directory from a backup; opaque
note files do not contain enough information to reconstruct their original
titles or folders.

### 6. Canary File Integrity Check

**Location:** `src/main/vault.ts` — `unlockVault()` and `createVault()`

**Mechanism:**

- Encrypted placeholder `"driftleaf-vault-v1"` stored in `.driftleaf/canary.enc`
- On unlock, canary is decrypted and verified
- Detects wrong passphrase (decrypt fails) or data corruption (plaintext mismatch)
- If canary fails, vault does not open (user sees "incorrect passphrase" or corruption error)

### 7. Folder-Based Virtual Paths

**Location:** `src/main/vault.ts` — folder path handling

**Safety:**

- Folder paths use virtual `/`-separated format, resolved via `path.join()`
- Windows path separators (`\`) normalized by Node's path module
- `validateFolderPath()` prevents path traversal (`..` or absolute paths)
- Folder paths are virtual metadata; note files are stored separately under
  `.driftleaf/notes/`
- Reconciliation scans legacy named files and opaque-ID note files without
  deleting nonempty legacy folders or unrelated files

## Running the Integration Checks

Run the vault integration suite (including encrypted metadata, opaque paths,
legacy migration, and encrypted extension persistence) with:

```bash
node scripts/tests/data-loss.js
```

This invokes the TypeScript-backed integration suite using the repository's
loader and Node's type-stripping support.

## Test Scenarios Verified

### Scenario 1: Crash during note creation or write

- Atomic replacement prevents partial ciphertext.
- A newly created note whose manifest write did not finish is recovered as
  `Recovered note`; its original title and folder are not derivable from its ID.
- An existing note keeps its encrypted content; only its update timestamp might
  be stale.

### Scenario 2: Crash during note rename or move

- Note content stays at its opaque-ID path.
- The atomic encrypted manifest contains either the old or new title/folder.

### Scenario 3: Crash during folder delete

- The manifest is updated before note ciphertext is deleted.
- Files left by an interrupted delete can be recovered as `Recovered note`
  entries, without their previous title/folder metadata.

### Scenario 4: Corrupt `.enc` file

- Bit-flip or truncation on disk
- **Detection:** AES-GCM auth tag fails on decrypt
- **UX:** user sees "Note is corrupted and cannot be decrypted" (not silent failure)

### Scenario 5: Wrong passphrase

- Canary decrypt fails
- **UX:** user sees "Incorrect passphrase" immediately

## Known Limitations

1. **No transaction log** — relies on atomic writes + reconciliation rather than a journal
2. **Orphan recovery cannot restore metadata** — opaque filenames preserve note content, not title or folder placement
3. **No backup before delete** — delete is immediate; maintain backups for recovery
4. **Unsigned builds** — binaries not code-signed for macOS/Windows
   - Addressed in Milestone 14 (post-v0.2)
5. **Passphrase reset impossible** — no "forgot password" feature
   - By design: documented in README and in-app

## Conclusion

Driftleaf's integrity safeguards are multi-layered:

1. **Atomic writes** prevent half-written files
2. **Safe operation ordering** ensures only orphans or stale metadata survive crashes
3. **Reconciliation on unlock** recovers orphaned ciphertext where possible
4. **AES-GCM authentication** detects corruption
5. **Passphrase verification** prevents wrong-key decryption

Corruption is surfaced, and recoverable orphan ciphertext is not discarded
silently. Restore a complete backup if encrypted metadata is missing or
corrupt; note names and locations cannot be reconstructed from opaque files.
