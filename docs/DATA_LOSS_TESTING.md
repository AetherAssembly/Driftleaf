# Branch Integrity

The app calls a user's private workspace a **branch**. In technical
descriptions of the encrypted on-disk format and internal APIs, it is still
called a **vault**.

Driftleaf encrypts notes and databases individually and verifies their
integrity when they are opened. Damaged or incomplete encrypted content is
reported rather than silently shown as valid data. Branch metadata and note
files are also written in a way that protects against partially written files
after an interruption.

When a branch opens, Driftleaf compares its encrypted index with the files on
disk. It can recover some unindexed note files, but their original titles and
folders may not be available because those details are encrypted separately.
Database files that are no longer listed in the branch index are not
automatically restored.

These safeguards cannot recover a forgotten passphrase or missing encrypted
metadata. Backups are the reliable way to protect against device failure,
deletion, or damage to important branch files. A full branch backup includes the
hidden `.driftleaf` directory as well as the visible branch folder.

Backup creation, verification, and branch health checks are available in
**Settings → Diagnostics & Branch Health**. For recovery scenarios and
restoration details, see [Branch Recovery](RECOVERY.md).
