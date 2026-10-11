# Software Updates

Update status and the installed version are visible in **Settings → Updates**
and **Settings → About**. A new release also appears as a banner, including on
the vault unlock screen. Automatic checks can be disabled in Settings; **Check
for updates** remains available on demand.

## Platform behavior

- **Windows NSIS installer:** `electron-updater` checks the GitHub release
  channel and downloads an available update only after the user chooses
  **Download update**. The user confirms installation by choosing **Restart
  to install**. The portable Windows build instead offers the NSIS installer
  for manual download.
- **Linux:** checks public GitHub release metadata and flags a newer version.
  The user opens the release asset and installs it using their preferred
  package/AppImage process. Driftleaf does not replace Linux package-manager
  updates.
- **macOS:** checks releases and offers the DMG for manual installation in
  unsigned builds. The release workflow can produce the signed-app updater
  configuration once signing secrets are available. Set repository variable
  `DRIFTLEAF_MAC_AUTO_UPDATE=true` only after code signing and notarization
  have been configured and verified; until then keep it unset.

Automatic update feeds require published GitHub releases with the generated
`latest*.yml` metadata and blockmaps. macOS additionally needs the zip artifact
alongside the DMG. The release workflow uploads these files. Beta builds follow
the beta release channel; stable builds ignore prereleases.

Only release metadata is requested from GitHub. Driftleaf does not send vault
contents, note titles, the passphrase, or an account identifier in update
checks. Update downloads happen only after the user chooses to download (or
opens the manual release link).
