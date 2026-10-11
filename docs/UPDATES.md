# Software Updates

The installed version and update status appear in **Settings → Updates** and
**Settings → About**. A new release can also appear as a banner, including on
the vault unlock screen. Update checks can be disabled in Settings, and
**Check for updates** remains available on demand.

## Installing an update

- **Windows installer:** Driftleaf can download an available update after
  **Download update** is selected. Installation begins after confirmation with
  **Restart to install**. The portable Windows version links to the installer
  for manual updating.
- **Linux:** Driftleaf reports when a newer release is available and links to
  it. Installation follows the package or AppImage process used for the
  current version.
- **macOS:** unsigned builds report releases and link to the DMG for manual
  installation.

Stable builds check stable releases. Beta builds use the beta release channel;
stable builds do not offer beta releases as updates.

## Network and privacy

Update checks request public release information from GitHub. They do not send
vault contents, note titles, passphrases, or account identifiers. Update
downloads begin only after the user chooses to download or opens the release
link.

Automatic update checks can be turned off in Settings. Manual checks remain
available.
