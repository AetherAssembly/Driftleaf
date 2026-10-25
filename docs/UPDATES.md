# Software Updates

The installed version and update status appear in **Settings → Updates** and
**Settings → About**. A new release can also appear as a banner, including on
the branch unlock screen. Update checks can be disabled in Settings, and
**Check for updates** remains available on demand.

## Current status: manual updates everywhere

As of v0.7.0, no update signing key or manifest feed has been provisioned, so every
build — Windows, macOS, and Linux — reports updates as manual: Driftleaf shows that a
newer release is available and links to it, but doesn't download or install it
automatically. Signed, in-app automatic updates are implemented and ready in the Rust
shell for Windows (and, once code-signed and notarized, macOS), but need a key and
hosted manifest before they turn on. See [Tauri update deployment](TAURI_UPDATES.md)
for exactly what that takes.

## Installing an update

- **Windows installer:** once signed updates are turned on, Driftleaf will be able to
  download an available update after **Download update** is selected, with installation
  beginning after confirmation with **Restart to install**. Until then, download the new
  installer from the releases page and run it.
- **Linux:** Driftleaf reports when a newer release is available and links to
  it. Installation follows the package or AppImage process used for the
  current version.
- **macOS:** unsigned builds report releases and link to the DMG for manual
  installation.

Stable builds check stable releases. Beta builds use the beta release channel;
stable builds do not offer beta releases as updates.

## Network and privacy

Update checks request public release information from GitHub. They do not send
branch contents, note titles, passphrases, or account identifiers. Update
downloads begin only after the user chooses to download or opens the release
link.

Automatic update checks can be turned off in Settings. Manual checks remain
available.
