# Vault Recovery

What each vault file is for, and what to do if something goes wrong. See also
[ARCHITECTURE.md](ARCHITECTURE.md#vault-resilience) for how the app avoids
getting into a bad state in the first place.

## Vault file structure

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json     format version + scrypt salt (or the raw key, for
│   │                  passphrase-less vaults) — never the derived key itself
│   ├── canary.enc      known-plaintext blob used to check a passphrase on unlock
│   └── manifest.json   plaintext index: note id, title, folder, updated time
├── <folder>/
│   └── <title>.md.enc  one file per note, AES-256-GCM encrypted content, named
│                        after the note's title (like any other encrypted file
│                        keeps its name with the extension changed) — a note
│                        titled "Meeting notes" is stored as "Meeting notes.md.enc"
```

Only `.enc` file *content* is encrypted. Titles, folder placement, and
timestamps live in the plaintext `manifest.json` sidecar so the sidebar can
render without a full decrypt — the filename is cosmetic (for browsing the
vault folder in a normal file manager) and is not the source of truth; the
manifest is. If a note's title collides with another note already in the
same folder, its filename gets a " (2)", " (3)", ... suffix. Vaults created
before this scheme existed keep their original `<note-id>.enc` filenames
until the note is next renamed, or until the next unlock's reconciliation
pass (below) opportunistically migrates them.

## "My vault won't open"

1. **Wrong passphrase** — the app tells you this directly; retry carefully.
   There is no passphrase reset (see below).
2. **`vault.json` or `canary.enc` missing/corrupted** — these hold the key
   material and salt; they can't be reconstructed. Restore the `.driftleaf/`
   folder from a backup. Without a backup, the vault's notes are not
   recoverable — this is the tradeoff of encryption with no server-side
   escrow.
3. **`manifest.json` missing/corrupted** — this is disposable. Delete it (or
   just the `.driftleaf/manifest.json` file) and unlock again with the
   correct passphrase; the app rebuilds the index from whatever `.enc` files
   it finds on disk. Note titles are lost (they only lived in the manifest),
   note content is not.

## "A note won't open" / "This note is corrupted"

AES-GCM authenticates ciphertext, so any bit-flip or truncation of a `.enc`
file is detected on read rather than silently returning garbage. If you see
this error:

- Check whether you have a backup of the vault folder from before the
  corruption and restore just that one `<title>.md.enc` file.
- If not, the note's content is unrecoverable, but it won't affect any other
  note — corruption is detected per-file, not vault-wide.

## Crash / power loss mid-save

Driftleaf writes are structured to avoid this class of problem:

- Every file write (note content, manifest) goes to a temp file and lands via
  an atomic rename, so a crash mid-write can't leave a half-written file.
- Every unlock runs a reconciliation pass that cross-checks the manifest
  against what's actually on disk and repairs mismatches automatically:
  orphaned files (on disk, not in the manifest) get re-added using their
  filename as the title, and stale manifest entries (pointing at a file
  that no longer exists — e.g. from a crash mid-rename or mid-move) get
  dropped. You'll see a toast summarizing what, if anything, it fixed.

You shouldn't need to do anything manually for this case. If a crash happens
in the narrow window during a rename or move, the note may resurface with a
new internal id after the next unlock (since its old manifest entry was
dropped as stale and the file was picked back up as "recovered") — its
title and content are unaffected, since the filename already reflects the
title. Check `docs/ARCHITECTURE.md` for exactly what the reconciliation pass
checks.

## Passphrase recovery

There isn't one, by design — the passphrase (or the derived key) is never
stored anywhere, including by Driftleaf's developers. If you lose it, the
vault's note *content* is not recoverable; only the plaintext manifest
(titles, folder names) survives.

**Recommendation:** write your passphrase down somewhere durable (a password
manager, a physical note in a safe place) at vault creation, and keep a
backup of the vault folder somewhere separate from this device.

## Backing up your vault

The vault is just a folder — copy `my-vault/` (including the hidden
`.driftleaf/` directory) to an external drive or another machine. There's no
special export/import step; the folder is the vault.
