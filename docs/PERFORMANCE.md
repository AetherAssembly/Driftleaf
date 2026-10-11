# Search

Search works locally across note titles and content in the currently unlocked
vault. Driftleaf prepares its search index when the vault opens and keeps it
current as notes change. The index exists only in memory; it is cleared when
the vault is locked and is not written to disk.

Search is designed to remain responsive as a vault grows. Actual results and
response times depend on the device, the size of the vault, and the search
phrase. The first search after unlocking may take longer while the index is
being prepared.

Search and graph features use information already decrypted for the open
vault. No note content is sent to a remote search service.

For related details, see [How Driftleaf Keeps Your Data](ARCHITECTURE.md) and
[Vault Recovery](RECOVERY.md).
