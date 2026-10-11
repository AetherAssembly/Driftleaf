# Vault Recovery

What each vault file is for, and what to do when something goes wrong. See also [ARCHITECTURE.md](ARCHITECTURE.md#vault-resilience) for how the app avoids getting into a bad state in the first place.

## Vault File Structure

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json     format version + scrypt salt (or the raw key, for
│   │                  passphrase-less vaults) — never the derived key itself
│   ├── canary.enc      known-plaintext blob used to check a passphrase on unlock
│   ├── manifest.enc    encrypted index of note, folder, and database metadata
│   ├── notes/
│   │   └── <note-id>.enc  encrypted note content under an opaque filename
│   └── <database-id>.db.enc  encrypted database schema and rows
```

Notes, database contents, and metadata (titles, folder paths, IDs, and timestamps)
are encrypted. Note ciphertext uses opaque ID filenames under `.driftleaf/notes/`;
folders are private vault organization and are not represented by named disk
directories. Existing vaults migrate their plaintext manifest and legacy note
files on successful unlock. Empty legacy folders are removed; directories
containing unrelated files are left untouched.

## "My Vault Won't Open"

1. **Wrong passphrase** — the app tells you this directly; retry carefully. There's no passphrase reset (see below).
2. **`vault.json` or `canary.enc` missing/corrupted** — these hold the key material and salt; they can't be reconstructed. Restore the `.driftleaf/` folder from a backup. Without a backup, the vault's notes aren't recoverable — this is the tradeoff of encryption with no server-side escrow.
3. **`manifest.enc` missing/corrupted** — note titles/folders and database metadata cannot be reconstructed from opaque IDs alone. The encrypted note/database files may remain on disk but will be unavailable. Restore `manifest.enc` or the whole `.driftleaf/` directory from a backup.

## "A Note Won't Open" / "This Note Is Corrupted"

AES-GCM authenticates ciphertext, so any bit-flip or truncation of a `.enc` file is detected on read rather than silently returning garbage. If you see this error:

- Check whether you have a backup of the vault folder from before the corruption, and restore just that note's `<note-id>.enc` file from `.driftleaf/notes/`.
- If not, the note's content is unrecoverable, but it won't affect any other note — corruption is detected per-file, not vault-wide.

## Crash / Power Loss Mid-Save

Driftleaf writes are structured to avoid this class of problem:

- Every file write (note content, manifest) goes to a temp file and lands via an atomic rename, so a crash mid-write can't leave a half-written file.
- Every unlock runs a reconciliation pass that cross-checks the manifest against what's actually on disk and repairs mismatches automatically: orphaned files (on disk, not in the manifest) get re-added using their filename as the title, and stale manifest entries (pointing at a file that no longer exists — e.g. from a crash mid-rename or mid-move) get dropped. You'll see a toast summarizing what, if anything, it fixed.

You shouldn't need to do anything manually for this case. If a crash happens in the narrow window during a rename or move, the note may resurface with a new internal id after the next unlock (its old manifest entry was dropped as stale, and the file was picked back up as "recovered") — its title and content are unaffected, since the filename already reflects the title. Check [ARCHITECTURE.md](ARCHITECTURE.md#vault-resilience) for exactly what the reconciliation pass checks.

## Passphrase Recovery

None, by design — the passphrase (or the derived key) is never stored anywhere, including by Driftleaf's developers. If you lose it, the vault's encrypted contents and metadata aren't recoverable.

**Recommendation:** write your passphrase down somewhere durable (a password manager, a physical note in a safe place) at vault creation, and keep a backup of the vault folder somewhere separate from this device.

## Backing Up Your Vault

Create a copy from **Settings → Diagnostics & Vault Health → Create backup**. Choose a destination outside the vault; Driftleaf creates a uniquely named, dated folder there and does not overwrite existing backups. The copy includes the hidden `.driftleaf/` directory. Keep the destination on a different drive or device for protection against device failure.

After copying, verify the backup from **Settings → Diagnostics & Vault Health → Choose backup folder**. Driftleaf checks the backup's key-check file, manifest, encrypted note files, and encrypted databases. Enter the passphrase if the backup uses one. Verification is read-only: it does not unlock the backup as the active vault, reconcile its files, or change it.

The same Settings screen can run a health check on the currently open vault. It checks vault metadata, manifest consistency, encrypted note and database integrity, recoverable unindexed files, leftover temporary writes, and search-index coverage. It reports issues without attempting repairs; unlock-time reconciliation repairs supported note manifest/file mismatches. Database files missing from the manifest are reported as unindexed but are not automatically recovered.

**Copy Diagnostics** in that screen copies app/platform and display-session details plus the active theme. It does not include vault paths, note contents, or passphrases.

The vault is just a folder — a backup can also be made manually by copying `my-vault/` (including the hidden `.driftleaf/` directory) to an external drive or another machine.

## Imported Databases

Databases created in Driftleaf or imported from CSV and JSON are encrypted and stored inside `.driftleaf/`. Include the entire `.driftleaf/` directory when backing up; copying only the visible note folders will omit database data and its index. For supported import formats, editing, formulas, and known Notion-export limitations, see [DATABASES.md](DATABASES.md).
