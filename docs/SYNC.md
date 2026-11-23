# Sync, Multiple Devices, and Mobile

Driftleaf has no built-in sync and no mobile app. A branch is one encrypted
folder on one computer, and nothing in the app sends it anywhere. This page
explains what that means in practice and what does and does not work if you
move or sync the folder yourself.

## Is there sync?

No. There is no Driftleaf account and no Driftleaf server, so there is nothing
to sync through. End-to-end encrypted sync is on the roadmap as an optional,
off-by-default feature; it has not been started and has no date.

## Is there a mobile app?

No. Driftleaf runs on Linux, macOS, and Windows.

## Can I keep a branch in Syncthing, Dropbox, iCloud Drive, a NAS, or similar?

You can, and everything those tools see is ciphertext: note contents, titles,
folder names, display names, custom greetings, database contents, and
attachments are all encrypted before they reach disk. The file-sync provider
learns only how many notes and attachments you have, roughly how large each is,
and when they change.

It is not a supported or tested configuration, though, and it is only safe if
you follow one rule:

**Only ever have the branch open on one device at a time, and let the sync
finish completely before you open it on another.**

The reason is how a branch is stored. Every note is its own file, but the
index of the whole branch (titles, folders, Trash, attachment names, and
personalization) is a single encrypted file, `.driftleaf/manifest.enc`, that is
rewritten on every change. If two devices change the branch before syncing with
each other, the sync tool sees two different versions of that one file. It will
keep one and either discard the other or save it as a "conflicted copy".
Driftleaf cannot merge the two.

What happens then:

- Note contents are not lost. Each note is a separate encrypted file, and the
  next unlock re-adds any note file the surviving index does not list. Those
  notes come back titled **Recovered note** in the top-level folder, because
  their titles and folders lived in the index that lost.
- Titles, folder placement, display name, custom greetings, Trash contents,
  canvas layout, and extension grants from the losing device are gone.
- Databases that only the losing index knew about are not re-added
  automatically. The health check reports them as unindexed files.

Practical advice if you do this anyway:

- Lock the branch (or quit Driftleaf) before leaving a device, and wait for the
  sync tool to report that it is up to date before unlocking elsewhere.
- Exclude `.driftleaf-writer.sqlite` (and any `-journal`, `-wal`, or `-shm`
  file next to it) from sync. It is a lock file that stops two copies of
  Driftleaf on the *same* computer from opening one branch at once. It holds no
  note data, it is excluded from Driftleaf's own backups, and it does not stop
  another computer from opening a synced copy.
- Turn on file versioning in the sync tool so an overwritten
  `manifest.enc` can be brought back.
- Keep making real backups from **Settings → Branch → Diagnostics & Branch
  Health → Create backup**. A sync tool copies mistakes and corruption as
  faithfully as it copies everything else.

## What is the supported way to use Driftleaf on a second computer?

Move a copy by hand: create a backup on the first computer, copy the backup
folder to the second, and open it there. Treat the two as separate branches
from then on, or always carry the whole folder across in one direction.

## I changed my passphrase. What about my other copies?

Changing the passphrase rewrites one small file in the branch
(`.driftleaf/vault.json`). Any other copy of the branch, including backups
and copies on other devices that have not synced yet, still opens with the old
passphrase until that file reaches it. See
[Branch Recovery](RECOVERY.md#changing-your-passphrase).

## How do I get my notes out?

**Settings → Branch → Diagnostics & Branch Health → Export unencrypted copy**
writes a dated `.zip` containing every note as a Markdown file, every database
as CSV and JSON, and every attachment as an ordinary file. Standard ZIP tools
can open it, and its contents need nothing from Driftleaf to read. The archive
is unencrypted.
