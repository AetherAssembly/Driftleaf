# Software Updates

The installed version and update status appear in **Settings → Updates** and
**Settings → About**. A new release can also appear as a banner, including on
the branch unlock screen. Update checks can be disabled in Settings, and
**Check for updates** remains available on demand.

The Windows installer supports unsigned in-app updates: Driftleaf downloads an
available update after **Download update** is selected, with installation beginning
after confirmation with **Restart to install**. The Windows executable is not code-signed.
Unsigned macOS builds do not install updates automatically and require manual installation.

## Installing an update

- **Windows installer:** once signed updates are turned on, Driftleaf will be able to
  download an available update after **Download update** is selected, with installation
  beginning after confirmation with **Restart to install**. Until then, download the new
  installer from the releases page and run it.
- **Linux:** Driftleaf reports when a newer release is available and links to
  it. Installation follows the Linux Distro's update process.
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
