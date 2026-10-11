# Vault Recovery

An overview of vault files, backups, and recovery limits. Driftleaf handles
some interrupted changes automatically; the [vault integrity overview](DATA_LOSS_TESTING.md)
describes how those safeguards work.

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
are encrypted. Database payloads include property definitions, formulas, rows,
and saved views. Note ciphertext uses opaque ID filenames under `.driftleaf/notes/`;
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

Most interrupted saves are handled automatically when the vault is next
unlocked. A note affected during a rename or move may reappear as a recovered
note; its contents remain intact, though its original title or folder may not
be available. The [vault integrity overview](DATA_LOSS_TESTING.md) explains
which situations can be recovered automatically.

## Passphrase Recovery

Driftleaf does not store the passphrase or a recoverable copy of the key. A
forgotten passphrase cannot be reset, and the encrypted vault cannot be opened
without it.

Because Driftleaf cannot reset a forgotten passphrase, keeping it in a
password manager or another secure place helps preserve access to the vault.
A separate backup protects against device failure.

## Backing Up Your Vault

Create a copy from **Settings → Diagnostics & Vault Health → Create backup**. Choose a destination outside the vault; Driftleaf creates a uniquely named, dated folder there and does not overwrite existing backups. The copy includes the hidden `.driftleaf/` directory. Keep the destination on a different drive or device for protection against device failure.

After copying, verify the backup from **Settings → Diagnostics & Vault Health → Choose backup folder**. Driftleaf checks the backup's key-check file, manifest, encrypted note files, and encrypted databases. Enter the passphrase if the backup uses one. Verification is read-only: it does not unlock the backup as the active vault, reconcile its files, or change it. For a full restore, copy the verified backup folder back to its intended location and open that folder in Driftleaf.

The same Settings screen can run a health check on the currently open vault. It checks vault metadata, manifest consistency, encrypted note and database integrity, recoverable unindexed files, leftover temporary writes, and search-index coverage. It reports issues without attempting repairs; unlock-time reconciliation repairs supported note manifest/file mismatches. Database files missing from the manifest are reported as unindexed but are not automatically recovered.

**Copy Diagnostics** in that screen copies app/platform and display-session details plus the active theme. It does not include vault paths, note contents, or passphrases.

The vault is just a folder — a backup can also be made manually by copying `my-vault/` (including the hidden `.driftleaf/` directory) to an external drive or another machine.

## Imported Databases

Databases created in Driftleaf or imported from CSV and JSON are encrypted and stored inside `.driftleaf/`. Include the entire `.driftleaf/` directory when backing up; copying only the visible note folders will omit database data and its index. For supported import formats, editing, formulas, and known Notion-export limitations, see [DATABASES.md](DATABASES.md).
