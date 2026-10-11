# How Driftleaf Keeps Your Data

Driftleaf stores each vault as a folder on your computer. There is no account
or cloud service holding your notes. Your vault remains available offline, and
you choose where its folder lives.

## Encryption and privacy

Notes, database contents, and vault organization are encrypted while stored.
The vault passphrase protects the encryption key; Driftleaf does not keep a
copy and cannot reset a forgotten passphrase. Note titles, folder names,
database details, extensions, and canvas layout are encrypted along with the
content. On disk, encrypted notes use opaque filenames rather than their
titles.

When a vault is unlocked, Driftleaf decrypts the information needed for the
open session. Search and note-link information are kept in memory and cleared
when the vault is locked. They are not saved as a separate, unencrypted index.

Driftleaf does not send vault contents to an account or cloud service. Optional
update checks request public release information from GitHub; community
galleries request public release information and assets when opened or
refreshed. Those services receive ordinary network request metadata, but not
your notes or account identity. See [Software Updates](UPDATES.md) and
[Community extensions and templates](COMMUNITY.md).

## Vault files and backups

A vault is a regular folder with a hidden `.driftleaf` directory containing
encrypted notes, databases, and the metadata needed to organize them. A backup
needs the whole vault, including that hidden directory. Copying only visible
note files does not preserve the complete vault.

Driftleaf checks vault files when they are opened and detects encrypted content
that is damaged or incomplete. Some interrupted changes can be recovered
automatically, but lost metadata or a forgotten passphrase cannot be
reconstructed. See [Vault Recovery](RECOVERY.md) for backup and recovery
details.

## Notes, links, and search

Notes use Markdown and include a live preview. Search covers note titles and
content in the unlocked vault. Links written as
`[[Note title]]` appear in previews and connect notes in the graph. A folder
path can distinguish notes with duplicate titles, as in
`[[Projects/Driftleaf]]`; unresolved or ambiguous links remain ordinary text.

The graph and backlinks are derived from the notes currently available in the
unlocked vault. They are not separate copies of note content.

## Databases, canvas, and extensions

Databases support rows, properties, formulas, relations, rollups, and saved
table, board, and calendar views. Database contents and view settings are
encrypted in the vault. CSV and JSON imports become Driftleaf databases; see
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
