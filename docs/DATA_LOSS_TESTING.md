# Vault Integrity

Driftleaf encrypts notes and databases individually and verifies their
integrity when they are opened. Damaged or incomplete encrypted content is
reported rather than silently shown as valid data. Vault metadata and note
files are also written in a way that protects against partially written files
after an interruption.

When a vault opens, Driftleaf compares its encrypted index with the files on
disk. It can recover some unindexed note files, but their original titles and
folders may not be available because those details are encrypted separately.
Database files that are no longer listed in the vault index are not
automatically restored.

These safeguards cannot recover a forgotten passphrase or missing encrypted
metadata. Backups are the reliable way to protect against device failure,
deletion, or damage to important vault files. A full vault backup includes the
hidden `.driftleaf` directory as well as the visible vault folder.

Backup creation, verification, and vault health checks are available in
**Settings → Diagnostics & Vault Health**. For recovery scenarios and
restoration details, see [Vault Recovery](RECOVERY.md).
