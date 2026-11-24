# Branch Recovery

The app calls a user's private workspace a **branch**. The internal API and
encrypted on-disk format continue to use **vault** terminology; for example,
the `window.driftleaf.vault` API refers to the branch, while `.driftleaf` is its
hidden data directory.

This guide covers branch files, backups, and recovery limits. Driftleaf handles
some interrupted changes automatically; the [branch integrity overview](DATA_LOSS_TESTING.md)
describes how those safeguards work.

## Branch File Structure

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json     format version + scrypt salt, plus the encryption key sealed
│   │                  under your passphrase once the passphrase has been changed
│   │                  (or the raw key, for legacy passphrase-less branches)
│   ├── canary.enc      known-plaintext blob used to check a passphrase on unlock
│   ├── manifest.enc    encrypted index of note, folder, database, attachment,
│   │                  Trash, and personalization metadata
│   ├── notes/
│   │   └── <note-id>.enc  encrypted note content under an opaque filename
│   ├── attachments/
│   │   └── <attachment-id>.enc  an encrypted image or file added to a note
│   └── <database-id>.db.enc  encrypted database schema and rows
```

Notes, database contents, and metadata (titles, folder paths, IDs, and timestamps)
are encrypted. Database payloads include property definitions, formulas, rows,
and saved views. Note ciphertext uses opaque ID filenames under `.driftleaf/notes/`;
folders are private branch organization and are not represented by named disk
directories. Existing branches migrate their plaintext manifest and legacy note
files on successful unlock. Empty legacy folders are removed; directories
containing unrelated files are left untouched.

## "My Branch Won't Open"

1. **Wrong passphrase** — the app tells you this directly; retry carefully. There's no passphrase reset (see below).
2. **`vault.json` or `canary.enc` missing/corrupted** — these hold the key material and salt; they can't be reconstructed. Restore the `.driftleaf/` folder from a backup. Without a backup, the branch's notes aren't recoverable — this is the tradeoff of encryption with no server-side escrow.
3. **`manifest.enc` missing/corrupted** — note titles/folders, database metadata, and branch personalization cannot be reconstructed from opaque IDs alone. The encrypted note/database files may remain on disk but will be unavailable. Restore `manifest.enc` or the whole `.driftleaf/` directory from a backup.

## "I Deleted Something by Mistake"

Deleting a note, a database, or a folder moves the notes and databases involved
to **Trash** (in the sidebar). Nothing is removed from disk at that point: the
encrypted file stays exactly where it was and only the branch index changes.

- **Restore** puts an item back in the folder it came from, recreating that
  folder if it has since been deleted. Restoring a database also restores any
  other trashed database it links to through a relation.
- Items are removed for good 30 days after they were deleted, the next time the
  branch is unlocked. **Delete forever** and **Empty Trash** remove them
  immediately. After that, only a backup can bring them back.
- A database that another database in Trash still links to cannot be deleted
  or purged on its own; restore or permanently delete the linking one first.
- Deleting a database *row* is immediate and does not go to Trash.
- Trash travels with the branch, so backups include it.

If the same branch is later opened with a Driftleaf release from before Trash
existed (0.7.2 or earlier), that older version does not know those files are
in Trash and will bring them back as live notes named "Recovered note". No
content is lost, and a current release restores their real titles on the next
unlock.

## "A Note Won't Open" / "This Note Is Corrupted"

AES-GCM authenticates ciphertext, so any bit-flip or truncation of a `.enc` file is detected on read rather than silently returning garbage. If you see this error:

- Check whether you have a backup of the branch folder from before the corruption, and restore just that note's `<note-id>.enc` file from `.driftleaf/notes/`.
- If not, the note's content is unrecoverable, but it won't affect any other note — corruption is detected per-file, not branch-wide.

## Crash / Power Loss Mid-Save

Driftleaf writes are structured to avoid this class of problem:

- Every file write (note content, manifest) goes to a temp file and lands via an atomic rename, so a crash mid-write can't leave a half-written file. The temp file (and, on Linux/macOS, its directory) is also fsynced before the rename, so the write isn't just atomic but actually reaches disk before it's considered done — not left sitting in the OS page cache for a power loss to erase.
- Every unlock runs a reconciliation pass that cross-checks the manifest against what's actually on disk and repairs mismatches automatically: orphaned files (on disk, not in the manifest) get re-added using their filename as the title, and stale manifest entries (pointing at a file that no longer exists — e.g. from a crash mid-rename or mid-move) get dropped. You'll see a toast summarizing what, if anything, it fixed.

Most interrupted saves are handled automatically when the branch is next
opened. A note affected during a rename or move may reappear as a recovered
note; its contents remain intact, though its original title or folder may not
be available. The [branch integrity overview](DATA_LOSS_TESTING.md) explains
which situations can be recovered automatically.

## Changing Your Passphrase

**Settings → Branch → Change passphrase** asks for the current passphrase and a
new one. You need the branch unlocked and you need to know the current
passphrase; this is not a reset.

What it does: your notes are encrypted with a random-looking 256-bit key. On a
new branch that key is computed directly from your passphrase. The first time
you change the passphrase, Driftleaf keeps the same key but stores it in
`.driftleaf/vault.json` sealed (AES-256-GCM) under a second key computed from
the new passphrase. Unlocking then means: compute the second key from what you
typed, open the seal, and use what is inside. Changing the passphrase again
just makes a new seal.

What follows from that:

- It is fast and safe to interrupt. One small file is replaced in a single
  atomic step, after Driftleaf has checked that the new file really opens. No
  note, database, or attachment is rewritten. If anything fails, the branch
  still opens with the old passphrase.
- **Backups and other copies keep the passphrase they were made with.** Make a
  fresh backup after changing it, and remember which passphrase goes with
  which older backup.
- **It does not lock out someone who already has both the old passphrase and
  an older copy of the branch.** The underlying key did not change, so that
  older copy still opens with the old passphrase. If you think both were
  exposed, create a new branch, move your notes into it (export and import, or
  copy them across), and delete the old one.
- A branch whose passphrase has been changed cannot be opened by Driftleaf
  0.7.2 or earlier, which will report "Incorrect passphrase". Update the app on
  every computer that uses the branch.

## Passphrase Recovery

Driftleaf does not store the passphrase or a recoverable copy of the key. A
forgotten passphrase cannot be reset, and the encrypted branch cannot be opened
without it.

Because Driftleaf cannot reset a forgotten passphrase, keeping it in a
password manager or another secure place helps preserve access to the branch.
A separate backup protects against device failure.

## Backing Up Your Branch

Create a copy from **Settings → Diagnostics & Branch Health → Create backup**. Choose a destination outside the branch; Driftleaf creates a uniquely named, dated folder there and does not overwrite existing backups. The copy includes the hidden `.driftleaf/` directory. Keep the destination on a different drive or device for protection against device failure.

After copying, verify the backup from **Settings → Diagnostics & Branch Health → Choose backup folder**. Driftleaf checks the backup's key-check file, manifest, encrypted note files, and encrypted databases. Enter the passphrase if the backup uses one. Verification is read-only: it does not unlock the backup as the active branch, reconcile its files, or change it. For a full restore, copy the verified backup folder back to its intended location and open that folder in Driftleaf.

The same Settings screen can run a health check on the currently open branch. It checks branch metadata, manifest consistency, encrypted note and database integrity, recoverable unindexed files, leftover temporary writes, and search-index coverage. It reports issues without attempting repairs; unlock-time reconciliation repairs supported note manifest/file mismatches. Database files missing from the manifest are reported as unindexed but are not automatically recovered.

**Copy Diagnostics** in that screen copies the Driftleaf version, operating system and version, architecture, backend runtime, and active theme. On non-Windows systems, it also includes display-server and desktop/compositor fields. It does not include branch paths, note contents, or passphrases.

The branch is just a folder — a backup can also be made manually by copying `my-vault/` (including the hidden `.driftleaf/` directory) to an external drive or another machine.

## Attachments

Images and files added to a note are encrypted with the same key as your notes
and stored under `.driftleaf/attachments/`. A note refers to one by ID
(`attachment:<id>`), so the bytes are never inside the note itself. Each
attachment can be at most 25 MB.

Removing the image or link from a note does not delete the attachment, and
neither does deleting the note. **Diagnostics & Branch Health → Remove unused
attachments** deletes attachments that no note refers to. It counts notes in
Trash as still referring, never touches anything added in the last 24 hours,
and refuses to run if any note cannot be read, because it could not then tell
what is really unused.

Use **Diagnostics & Branch Health → Manage attachments** to browse the
attachments in a separate screen, preview supported images, and remove chosen
items. Removing an attachment can leave a broken link in any note that still
uses it; the unused-attachments cleanup avoids that by removing only unreferenced
items.

If an attachment's file is missing or damaged, the note still opens and shows
a placeholder where the attachment was. Restore that
`.driftleaf/attachments/<id>.enc` file from a backup to get it back.

## Getting Your Notes Out

**Diagnostics & Branch Health → Export unencrypted copy** writes the whole
branch as a dated `.zip` archive in a folder you choose: each note is a
Markdown file in its folder, each database is both CSV and JSON, and each
attachment is under `attachments/` with the notes' links rewritten to point
at it. Items in Trash are not exported. Standard ZIP tools can open the
archive, and nothing inside needs Driftleaf to read it. **The export is not
encrypted**, so keep it somewhere you trust.

## Imported Databases

Databases created in Driftleaf or imported from CSV and JSON are encrypted and stored inside `.driftleaf/`. Include the entire `.driftleaf/` directory when backing up; copying only the visible note folders will omit database data and its index. For supported import formats, editing, formulas, and known Notion-export limitations, see [DATABASES.md](DATABASES.md).
