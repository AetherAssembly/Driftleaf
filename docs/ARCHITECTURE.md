# How Driftleaf Keeps Your Data

In the app's interface, this private workspace is called a **branch**. The
internal API and storage implementation still use **vault** terminology (for
example, `window.driftleaf.vault`, `vault:*` IPC channels, and the `.driftleaf`
directory inside it). The API and IPC names refer to the branch; `.driftleaf`
is its hidden data directory. This does not mean a Git branch.

Driftleaf stores each branch as a folder on your computer. There is no account
or cloud service holding your notes. Your branch remains available offline,
and you choose where its folder lives.

## Encryption and privacy

Notes, database contents, and branch organization are encrypted while stored.
The branch passphrase protects the encryption key; Driftleaf does not keep a
copy and cannot reset a forgotten passphrase. You can change the passphrase
while the branch is unlocked: the key itself stays the same and is re-sealed
under the new passphrase, so nothing has to be re-encrypted (see
[Branch Recovery](RECOVERY.md#changing-your-passphrase) for what that does and
does not protect against). Note titles, folder names, database details,
attachment names, extensions, and canvas layout are encrypted along with the
content. On disk, encrypted notes and attachments use opaque filenames rather
than their titles.

Images and files added to a note are encrypted the same way and stored beside
the notes. The editor displays only images that are attachments in the branch;
it never loads an image from a web address, so opening a note cannot make a
network request.

Deleting a note or database moves it to Trash for 30 days. It stays encrypted
on disk during that time and is removed afterwards, or sooner if you empty
Trash.

When a branch is unlocked, Driftleaf decrypts the information needed for the
open session. Search and note-link information are kept in memory and cleared
when the branch is locked. They are not saved as a separate, unencrypted index.

Driftleaf does not send branch contents to an account or cloud service. Optional
update checks request public release information from GitHub, and with the
same setting on, Driftleaf reads the project's public announcement feed once
per launch; community
galleries request public release information and assets when opened or
refreshed. Those services receive ordinary network request metadata, but not
your notes or account identity. See [Software Updates](UPDATES.md) and
[Community extensions and templates](COMMUNITY.md).

## Branch files and backups

A branch is a regular folder with a hidden `.driftleaf` directory containing
encrypted notes, databases, and the metadata needed to organize them. A backup
needs the whole branch, including that hidden directory. Copying only visible
note files does not preserve the complete branch.

Driftleaf checks branch files when they are opened and detects encrypted content
that is damaged or incomplete. Some interrupted changes can be recovered
automatically, but lost metadata or a forgotten passphrase cannot be
reconstructed. See [Branch Recovery](RECOVERY.md) for backup and recovery
details.

There is no built-in sync. [Sync, Multiple Devices, and Mobile](SYNC.md)
covers what is and is not safe if you sync the folder yourself.

A branch can be exported at any time as a dated, unencrypted `.zip` archive
containing ordinary Markdown, CSV, JSON, and attachment files that need nothing
from Driftleaf to read.

## Notes, links, and search

Notes use Markdown, rendered inline as you type (a Source mode is available
for editing the raw Markdown directly). Fenced code blocks are syntax
highlighted, and Ctrl/Cmd+F finds and replaces within the open note. Search
covers note titles and content in the unlocked branch, from the sidebar or
from the Ctrl/Cmd+K palette. Links written as `[[Note title]]` render as clickable
links in the editor and connect notes in the graph. A folder path can
distinguish notes with duplicate titles, as in `[[Projects/Driftleaf]]`;
unresolved or ambiguous links remain ordinary text.

The graph and backlinks are derived from the notes currently available in the
unlocked branch. They are not separate copies of note content.

## Databases, canvas, and extensions

Databases support rows, properties, formulas, relations, rollups, and saved
table, board, and calendar views. Database contents and view settings are
encrypted in the branch. CSV and JSON imports become Driftleaf databases; see
[Databases](DATABASES.md) for supported formats and their limitations.

Canvas is a spatial view of references to notes and database views. Its cards
do not duplicate or replace the underlying content, and removing a card does
not delete its target.

JavaScript extensions run in isolated windows and start without permissions.
Each permission is explicit, and database access is separately limited to
selected databases. Extensions can read only the information covered by their
grants; they cannot write notes or databases through the extension interface.
Extensions are still code, so installing one means trusting its source. See
[Extensions](EXTENSIONS.md) for details.

## Updates

The Updates settings show the installed version and available releases.
Windows installer builds support in-app downloads and installation. Linux and
unsigned macOS builds link to releases for manual installation. See
[Software Updates](UPDATES.md).

## Desktop shell and storage backend

Driftleaf ships as a Tauri 2 desktop app. The Rust shell owns native dialogs, window
lifecycle, the global quick-capture shortcut, external-link handling, updates, and the
active storage backend. `src-tauri` links `driftleaf-core` directly; its `Service` owns
the unlocked branch, writer lock, in-memory search index, and renderer-facing commands.
The branch format is unchanged.

The interface remains a React/TypeScript webview. Node.js is used for frontend
development/build tools and the Node-based reference and compatibility tests, but the
desktop app neither bundles a Node runtime nor starts a Node sidecar. The old
`sidecar/index.mjs` is retained only for the test harness and browser-based UI development.
It is not the production backend.
