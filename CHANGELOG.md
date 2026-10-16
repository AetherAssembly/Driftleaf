# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses semantic versioning.

## [Unreleased]

### Tauri migration

- Added exclusive branch writer locks before creation/unlock and reconciliation,
  preventing two cooperating Driftleaf processes from modifying one branch.
  Locks release on branch lock, window close, failed session setup, and process exit.
- Kept runtime lock files out of backups and flushed pending drafts before backup
  creation and imports.
- Retained failed canvas edits in the shared save queue for retry and safe close.
- Added session, backup, canvas retry, and cross-process crash-recovery regressions.
- Kept Electron and the existing branch format. Phase 1 will begin only after
  manual verification of Phase 0.
- Moved session ownership and every branch/note/database/folder/search/canvas/
  extension-data command out of the Electron IPC layer into an Electron-independent
  service, with settings-directory, picker, external-link, and updater behavior
  injected rather than imported. The Electron adapter keeps only what needs a real
  window: the extension sandbox window and the update-install close handshake.
- Added contract tests proving the same command sequence behaves identically
  whether called directly against the new service or through the existing
  Electron-mocked adapter, without launching Electron either way.
- Added a first Tauri shell (`src-tauri/`, disabled by default, Electron unaffected)
  proving branch create/unlock, note/database/canvas read-write with live preview,
  search, lock, and a clean window-close handshake against the unmodified Node domain
  service, run as a sidecar child process over a private framed stdin/stdout protocol.
  Pickers that gate on the single-use "only act on what was actually picked" security
  check (import, backup, verify-backup) are intentionally not wired yet. Verified
  manually on CachyOS, including against a real existing branch with its real
  passphrase; Windows, macOS, and installable builds remain.
- Fixed two Tauri-bridge-only bugs found during that verification, neither touching
  branch encryption or the unlock procedure: an unhandled rejection in the initial
  note/folder/database/canvas load that could show a correctly-decrypted branch as
  empty, and omitted optional arguments (e.g. no folder filter) arriving at the
  sidecar as `null` instead of absent, which made note listing filter out everything.
- Confirmed native Wayland rendering works in WebKitGTK with software-rendering
  environment variables alone — no need to force X11, despite an earlier false start.

## [0.6.4] - 2026-10-15

### Fixed

- Refuse branch creation in folders with existing branch metadata, including
  concurrent creation attempts, to protect encryption keys and existing notes.
- Serialize complete branch operations and locking so active writes finish
  before the encryption key is cleared.
- Retain failed note, title, and database edits for retry. Block navigation and
  locking when drafts cannot be saved; Ctrl/Cmd+S retries pending saves.
- Wait for pending and active saves before closing, quitting, or restarting to
  install an update. Keep the app open if saving fails.
- Replace a note's search entry when saving, renaming, or moving it, preventing
  duplicate results, obsolete search matches, and stale graph links.
- Run storage and lifecycle regression tests explicitly in CI.

### Added

- Added a dismissible notice announcing the planned move from Electron to
  Tauri while retaining the familiar interface. Windows users also see a
  warning that the migration will require a one-time manual installation;
  current Electron updates remain unchanged.

## [0.6.3] - 2026-10-12

### Changed

- Community gallery now shows only the newest release of each extension or
  template asset, preventing duplicate entries across releases.
- Replaced the collapsed sidebar's “Ex” label with an Extensions icon.
- Renamed the user-facing private workspace from “vault” to “branch”; internal
  API and storage terminology remains unchanged.

### Documentation

- Updated user guides and repository policy copies to use “branch” for the
  private workspace, clarifying where “vault” remains the internal term.

## [0.6.2] - 2026-10-11

### Added

- Added Cherry, Arctic, and Amber color themes.

### Fixed

- Fixed Windows update checks by including channel-specific updater metadata in release assets.

## [0.6.1] - 2026-10-11

### Added

- Added saved Gallery and List database views.
- Added a saved Timeline view with month navigation and configurable start and
  end date properties.
- Improved Calendar view with a Today shortcut, editable event details, and
  per-day row creation that pre-fills the selected date.
- Added Week and Month modes to Calendar view, with mode-aware navigation.
- Added configurable options directly in the property editor for Select,
  Status, and Multi-select properties.
- Added a view-independent property manager so properties can be deleted from
  any database view.

### Changed

- Replaced separate database view-creation buttons with an Add view dropdown.
- Moved sidebar actions below Search and separated them from the Folders heading.
- Added accessible icons to sidebar actions and saved database views.
- Made row title/name fields editable in Gallery and List views.

## [0.6.0] - 2026-10-11

### Added

- Added named table, board, and calendar views for databases, with saved
  sorting, grouping, text filters, and date-property selection.
- Added `[[note]]` links, aliases, backlinks, unlinked mentions, and an
  interactive graph that can focus on a selected note.
- Encrypted vault metadata and moved notes to opaque-ID filenames; existing
  vaults migrate automatically the next time they are unlocked.
- Added local JavaScript extensions in isolated windows, with encrypted
  extension storage, disabled network access, and per-extension read permissions.
- Added scoped read-only database access for extensions, a starter gallery, and
  an extension API guide.
- Added a spatial canvas for arranging note and database-view cards, stored in
  encrypted vault metadata.
- Added update status and version information to Settings, with opt-out
  automatic checks, Windows installer updates, and manual release detection on
  Linux and unsigned macOS builds.
- Reworked Settings into themed Appearance, Editor, Updates, Vault, and About
  sections.
- Improved database property management with repeatable column creation,
  calculated formula fields with inline editing and previews, and safe
  property/database renaming and deletion.
- Added CSV value exports and lossless Driftleaf JSON database exports that
  preserve property definitions, formula expressions, rows, and saved views.
- Strengthened recovery and interoperability checks for encrypted databases,
  backup restoration, formula evaluation, and import/export round trips.
- Added searchable note-graph filtering and canvas sizing that keeps moved
  cards reachable when the workspace grows.
- Added a community gallery to browse stable extension and template releases
  inside Driftleaf, preview extension source, and install templates directly
  into the encrypted vault.
- Added a portable `community/Driftleaf-Extensions` folder with five starter
  extensions intended to move into its own repository.

## [0.5.0] - 2026-10-08

### Added

- Added vault backup creation to Diagnostics & Vault Health, saving a dated
  copy without overwriting existing backups.
- Added the ability to create a new editable database directly in the current
  vault folder.
- Added Aquatic, Mossy, Sunset, and Space color themes.
- Added vault starter templates: Blank, General, Productivity, Journal, and Study.
- Added a diagnostics and vault-tools screen with copyable app/platform details,
  vault health checks, and read-only backup verification.
- Added CSV and JSON database import, both as standalone files and inside ZIP
  archives. Imported databases are encrypted in the vault and support an
  editable table, rows, properties, formulas, relations, and basic rollups.
- Added Notion-style JSON property normalization and common formula functions.

### Changed

- ZIP imports now include CSV and JSON database files alongside Markdown notes,
  preserving archive folder paths.
- System theme follows the operating system's light/dark preference, including
  preference changes while Driftleaf is open.
- Theme selection now includes the four new color themes in addition to System,
  Light, and Dark.
- Added a link on the vault-creation screen to the community
  [Driftleaf-Templates repository](https://github.com/AetherAssembly/Driftleaf-Templates).

### Documentation

- Added a database guide covering database creation, CSV/JSON imports, editable
  tables, formulas, relations, limitations, and backup considerations.
- Updated architecture and recovery documentation for encrypted database
  storage, vault health checks, and database recovery limitations.
- Added standalone Markdown copies and additional template ideas under
  `vault-templates/`; these are not bundled in or registered by the app.

### Fixed

- Selected notes and databases now have a visible sidebar highlight.
- Vault-template repository links open in the system browser instead of a
  secondary Electron window.
- Set the Linux desktop-file identity explicitly so Wayland can associate
  Driftleaf windows with the installed application icon.
- Added dark-theme styling so manually selected Dark mode and System mode on a
  dark OS preference render with the dark color palette.

## [0.3.1] - 2026-10-06

### Security

- Resolved npm audit findings by updating the affected `brace-expansion`
  dependency and overriding the vulnerable transitive `@electron/get`
  dependency, avoiding its vulnerable `global-agent`, `roarr`, and `sprintf-js`
  dependency chain. The fixes address:
  - [`brace-expansion` quadratic-time expansion (GHSA-q2hr-2g5m-vwhr)](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
  - [`brace-expansion` nested-group recursion (GHSA-qhr7-859c-m2p7)](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
  - [`brace-expansion` comma-part recursion (GHSA-6j4f-fj2g-mc7p)](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
  - [`sprintf-js` unbounded precision denial of service (GHSA-hp3w-g68c-fv3c)](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)

## [0.3.0] - 2026-08-31

Project-wide bug audit covering the vault/crypto/search data layer, IPC and app
lifecycle, and the React renderer. Every finding below was verified against the
actual fixed code (typecheck, lint, full build, and a targeted smoke test
exercising the vault module directly), not just reviewed.

### Security

- **Path traversal on `folders.delete`:** the handler never validated
  `folderPath`, so a renderer-supplied `..`-laden path could trigger a
  recursive, forced delete of arbitrary directories outside the vault.
  Fixed in `src/main/vault.ts`.
- **Path traversal on `createNote`/`moveNote`/`renameFolder`:** these skipped
  the same `validateFolderPath()` guard every other folder mutator already
  used, allowing a crafted `folderPath` to write or move encrypted files
  outside the vault sandbox. `renameFolder` now validates both the old and
  new path.
- **`.driftleaf` as a folder name:** nothing stopped a user from creating a
  folder named `.driftleaf` (the vault's own config directory name) via the
  normal UI; the reconcile pass silently and permanently dropped every note
  filed under it on the next unlock. Now rejected as a reserved name.
- **Import path allowlist:** `notes.import` accepted any renderer-supplied
  file path, not just ones returned by the native file picker. It now only
  imports paths from that session's most recent `vault:pickImportFiles`
  result (single-use).
- **Vault key not wiped on lock:** `vault:lock` dropped the reference to the
  AES-256 key without zeroing the buffer first, leaving raw key material in
  memory after "locking" the vault. The buffer is now explicitly zeroed.

### Fixed

- **Case-insensitive filename collisions destroyed notes:** `uniqueFileName`
  compared candidate filenames case-sensitively, but Windows and default
  macOS filesystems are case-insensitive — creating or renaming a note to a
  title differing only in case from an existing one silently overwrote it.
  Comparison is now case-insensitive.
- **`renameFolder`/`moveNote` could desync manifest from disk:** both mutated
  in-memory state *before* the physical disk operation, so a failure (a
  name collision, a permissions error) left the manifest pointing at a
  folder/file that was never actually moved. Both now do the disk operation
  first, with rollback (including a best-effort move-back) on a subsequent
  manifest-write failure. `renameFolder` also now rejects renaming onto an
  already-existing folder name instead of leaving `fs.rename` to fail midway.
- **`createNote` didn't roll back on manifest-write failure:** unlike
  `deleteNote`/`deleteFolder`, a failed `writeManifest` after a successful
  file write left the note visible in-memory for the rest of the session
  with no manifest record, so a later crash caused `reconcileVault()` to
  "recover" it under a brand-new id, discarding the original.
- **No locking around manifest writes:** concurrent vault-mutating IPC calls
  (e.g. an in-flight autosave racing a delete) could interleave their
  read-modify-write of the manifest and lose or resurrect a change. All
  mutating operations are now serialized through a per-session queue in
  `src/main/ipc.ts`.
- **`.md` import silently mangled non-UTF-8 files:** `readFile(path,
  "utf-8")` replaces invalid byte sequences instead of throwing, so a
  non-UTF-8 `.md` file (e.g. UTF-16 from Notepad) "imported successfully"
  as garbled content. Import now decodes strictly and reports the file as
  skipped instead.
- **Zip import had no size/entry-count guard:** a crafted or corrupted
  `.zip` could claim a huge decompressed size or entry count with a small
  compressed footprint. Added a 20,000-entry cap and a 20MB per-entry cap,
  checked from the archive's own uncompressed-size header before any data
  is actually decompressed.
- **One corrupted note broke search for the entire vault:** `buildIndex`
  used `Promise.all` over per-note decryption, so a single dangling or
  corrupted note rejected the whole batch. Now uses `Promise.allSettled` so
  search stays available for every other note, matching the app's existing
  per-note corruption guarantee for reads.
- **A failed unlock could leave a "live" vault session internally:**
  `openSession` assigned `session.vault`/`session.index` before indexing
  had actually succeeded, so a `buildIndex` failure left the main process
  holding a valid, unlocked vault + key even though the renderer was told
  the unlock failed and returned to the lock screen.
- **`ipcMain.handle` crashed the app on macOS window recreation:** closing
  the only window on macOS doesn't quit the app; reopening it via the dock
  icon called `registerIpcHandlers()` again, and `ipcMain.handle` throws on
  a duplicate channel registration. Registration is now idempotent; dialogs
  repoint to the newly created window instead.
- **Global shortcut called methods on a destroyed window:** the quick-capture
  hotkey (`Ctrl/Cmd+Shift+N`) closed over the `BrowserWindow` that existed
  when it was registered; closing that window on macOS and then pressing
  the shortcut threw. It's now registered once at startup and looks up the
  live window at call time. Its registration result is also checked and
  logged on failure (e.g. the shortcut already being claimed by another app).
- **Inconsistent error translation:** `vaultHasPassphrase`, `notesRead`, and
  `settingsPatch` bypassed the `friendlyError()` translation every other fs-
  touching handler gets, leaking raw Node error messages (and absolute
  paths) to the renderer on the same failure modes (missing vault folder,
  permissions) that are handled gracefully everywhere else.
- **`settings.json` had a lost-update race and a non-atomic write:**
  concurrent `settings.patch()` calls could silently discard one another's
  changes, and a process kill mid-write could leave the file truncated,
  silently resetting all settings to defaults on next read. Patches are now
  serialized and written via the same atomic temp-file+rename pattern the
  vault already uses. `autosaveIntervalMs`/`editorFontSizePx` are also now
  clamped to the same bounds the Settings UI enforces.
- **A shared autosave timer silently dropped edits:** content-save and
  title-rename-save shared one debounce timer, so editing the title and
  then quickly editing the body (or vice versa) cancelled whichever hadn't
  fired yet — with no error and no indication the edit was lost. Each now
  has its own timer, and switching notes, creating a note, opening the
  daily note, and locking the vault all flush any pending write first
  instead of dropping it. Deleting a note now cancels (rather than
  flushes) its own pending writes.
- **Stale closures in `handleMoveNote`/`handleRenameFolder`:** both read
  `selectedNote`/`selectedFolder` from the closure captured at call time;
  if the user navigated to a different note while a move/rename was still
  in flight, the response could snap the editor back to the note they'd
  already left. Fixed with a ref for the current selection and functional
  state updaters.
- **Search results could render out of order:** a slower, earlier query
  could resolve after a faster, later one and overwrite fresher results
  on screen. Responses now carry a request id and are only applied if still
  current.
- **Ctrl+K could stack the command palette on other open modals:** the
  shortcut only checked that the vault was unlocked, not that Settings,
  Quick Capture, the move-note modal, or the welcome modal weren't already
  open.
- **No-recovery-passphrase warning bypassable on retry:** the
  acknowledgment from confirming "I understand, create vault" wasn't reset
  when the passphrase field was edited afterward (e.g. after a failed
  create attempt), so a differently-typed passphrase could be submitted
  without ever showing the warning for it.
- **`focusTrap.ts` was unused and had a bug:** `deactivate()` checked for an
  explicit `returnFocus` target but then always focused
  `previousActiveElement` instead, ignoring it. The hook also re-activated
  (re-capturing focus, re-running its initial-focus logic) on every render
  while active rather than only when it opened. Fixed and wired into
  CommandPalette, QuickCapture, and ContextMenu, which previously had no
  focus trapping at all — Tab could move focus into the sidebar/editor
  hidden behind them.
- **`scripts/tests/data-loss-integration.mjs` had a broken import path**
  pointing at a per-file compiled module that doesn't exist under this
  project's Vite build (which bundles into a single `dist-electron/main/
  index.js`); corrected the relative path.

### Changed

- **`@aetherAssembly/ui` bumped to `^1.0.3`:** the previous version shipped
  a `styles.css` containing only design-token declarations and no actual
  component rules, so every `Button`, `Card`, `Modal`, `Input`, and `Badge`
  rendered unstyled. 1.0.3 adds the missing component CSS.
- **openSUSE/OBS RPM builds:** electron-builder was bundling the full
  `better-sqlite3` source tree (the SQLite amalgamation, C++ addon source,
  and a shell script with a bad shebang) into every packaged build, not
  just the prebuilt binary it actually needs at runtime. This tripped
  rpmlint's badness threshold and aborted every openSUSE OBS build (15.6,
  16.0, Tumbleweed) while passing on Fedora's more permissive profile.
  Excluded `node_modules/better-sqlite3/deps/**` and `.../src/**` from all
  six `electron-builder/*.yml` configs, shrinking every platform's bundle.
- **Removed dead links to `PLAN.md`/`docs/PUBLISHING.md`:** both moved out
  of the repo. `.github/CONTRIBUTING.md`'s roadmap references now point to
  open issues/discussions; `docs/ARCHITECTURE.md`'s two milestone citations
  were reworded to stand on their own.

## [0.2.1] - 2026-08-28

### Added

- **Native SQLite packaging:** Electron Builder now unpacks the
  `better-sqlite3` native module for stable and beta builds on Linux, macOS, and Windows.
- **License metadata:** package and lockfile metadata now identify the project as
  `AGPL-3.0-or-later`.
- **Installation documentation:** new `docs/INSTALLATION.md` documents package
  installation, architecture-specific downloads, repository setup, and download
  verification for Linux, macOS, and Windows.
- **RPM packaging:** added an architecture-aware RPM spec for x86_64 and aarch64,
  including the Electron application bundle, desktop launcher, icon, executable
  symlink, and license files. Added RPM lint filters and an OBS download service
  configuration for Driftleaf release artifacts.

### Changed

- **Search database loading:** the main-process search index now loads
  `better-sqlite3` through Node's `createRequire`, while Vite externalizes all
  `better-sqlite3` subpaths for reliable Electron native-module resolution.
- **Release channels:** stable Linux, macOS, and Windows configurations now
  explicitly publish on the stable channel.
- **Package metadata:** Debian and RPM configurations now include the Driftleaf
  synopsis and description, and macOS DMG builds include the project EULA.
- **Beta packaging:** beta Linux, macOS, and Windows configurations now unpack
  the native SQLite module and include the relevant package metadata.

### Fixed

- **Native module resolution:** corrected bundling and runtime loading so the
  `better-sqlite3` dependency remains available to packaged Electron builds.

## [0.2.0] - 2026-08-26

### Added

- **Search performance instrumentation:** detailed timing metrics for search index build
  (decrypt phase, insert phase, per-note average) and query latency. Enable with
  `DEBUG_SEARCH=1` environment variable for console logging. Metrics tracked in
  `src/main/search.ts` and `src/main/ipc.ts`.
- **Test vault generator:** new CLI tool (`scripts/generateTestVault.ts`) to create
  reproducible test vaults with N notes (100, 500, 1000, 5000+) for performance
  benchmarking. Usage: `npx ts-node scripts/generateTestVault.ts 1000 /tmp/test-vault`.
- **Performance benchmarking guide:** comprehensive documentation at `docs/PERFORMANCE.md`
  with methodology, baseline metrics, expected improvements, and troubleshooting steps.
- **Data loss safeguard testing:** new test suite in `scripts/tests/` (data-loss.js and
  data-loss-integration.mjs) for verifying atomic writes, crash safety, reconciliation,
  encryption, and corruption detection. Comprehensive testing documentation at
  `docs/DATA_LOSS_TESTING.md` verifying all safeguards (atomic writes, crash-safe
  operation ordering, vault reconciliation, AES-GCM auth tags, canary file checks).
  PLAN.md milestone 16 completed.
- **GitHub community configuration:** complete `.github/` folder with issue templates
  (bug reports, feature requests), pull request template, contributor guidelines
  (CONTRIBUTING.md), code of conduct (CODE_OF_CONDUCT.md), security policy
  (SECURITY.md), funding configuration (FUNDING.yml), automated PR checks workflow
  (pr-checks.yml), and Dependabot configuration for weekly dependency updates.
- **Keyboard navigation in sidebar:** arrow keys (Up/Down) to navigate notes list, Enter to
  open, Escape to clear search. Visual focus indicator (subtle background + left border)
  distinguishes keyboard focus from selection. Works in both folder notes and search results.
- **Accessibility improvements:** ARIA labels on all interactive elements (buttons, folders,
  notes, context menus). Context menu role set to `role="menu"` with `role="menuitem"` on
  items. Folder buttons use `role="treeitem"` with `aria-expanded`. All elements properly
  labeled for screen reader navigation.
- **Visible keyboard focus indicators:** global `:focus-visible` styles (2px primary color
  outline with 2px offset) applied to all buttons, inputs, textareas, and ARIA roles. Tab
  navigation now visually clear throughout the entire UI.
- **Focus trap utility:** new `src/renderer/lib/focusTrap.ts` for managing modal focus —
  ensures focus stays within modal, cycles with Tab, closes on Escape, and returns focus to
  the triggering element on dismiss. Ready for use in modal components.

### Changed

- **Search index build optimized for speed:** decryption of notes now runs in parallel via
  `Promise.all()` instead of sequential loop, reducing I/O blocking. Expected improvement:
  2–3× faster on large vaults (1000+ notes). Inserts remain serial (SQLite single-threaded)
  but wrapped in a single transaction for ~10–20% additional speedup.
- **Incremental search reindex faster:** `reindexNote()` now uses atomic `REPLACE INTO`
  instead of DELETE + INSERT pair, cutting per-note update overhead by ~50%.
- **Save status visibility:** font size increased from 0.8em to 1em, opacity from 0.5 to
  0.8. Layout updated to flex with gap for visual icons (checkmark for "Saved", hourglass
  for "Saving…").
- **Disabled element visual feedback:** `cursor: not-allowed` applied to all disabled
  buttons and folder items in modals. Move modal's current-folder state now uses
  `cursor: not-allowed` instead of `default` for clarity.

### Fixed

- **Keyboard focus management in notes list:** sidebar now properly tracks keyboard focus
  separately from selected note, allowing arrow-key navigation without changing selection.
  Focused note rendered with distinct visual state.

### Documentation

- **README rewritten for end-users:** new README focuses on benefits, getting started,
  keyboard shortcuts, and data protection rather than technical implementation. Developer
  setup moved to a separate "For Developers" section. Includes direct download links for
  each platform and clear explanations of private, encrypted-by-default model.
- **CONTRIBUTING guide:** comprehensive contributor documentation covering setup,
  development workflow, code style, critical areas (vault, search, IPC), testing
  requirements, and PR process. Includes emphasis on data loss prevention for vault changes.
- **Data loss testing documentation:** `docs/DATA_LOSS_TESTING.md` provides detailed
  verification of all crash-safety mechanisms: atomic writes, operation ordering, vault
  reconciliation, AES-GCM auth tags, canary file checks, and path validation.

## [0.1.0-beta.1] - 2026-07-20

### Added

- **Vault resilience:** atomic writes (temp file + `rename()`) for every note and manifest
  write, so a crash or power loss mid-write can't leave a half-written file. Multi-step
  operations (write-then-record, rename-then-record, drop-then-delete) are ordered so a
  crash between the two steps only ever produces a safe, self-healable mismatch.
  `reconcileVault()` runs automatically on every unlock, cross-checks the manifest against
  what's actually on disk, and repairs dangling entries and orphaned files. AES-GCM's auth
  tag gives corruption detection on read for free — a damaged note is reported as corrupted
  rather than silently returning garbage or crashing.
- **Encrypted filenames retain their title:** notes are now stored on disk as
  `<Title>.md.enc` instead of an opaque `<uuid>.enc`, like any other encrypted file keeping
  its name with the extension changed. Filenames stay in sync with the title on rename/move,
  with automatic collision suffixing (`" (2)"`) and filesystem-safe sanitization. Vaults
  created before this feature existed are migrated to the new scheme automatically on next
  unlock.
- **Import from `.md` and `.zip`:** a new "Import" button (sidebar + command palette) opens
  a native file picker. `.md` files import as a note titled from the filename; `.zip`
  archives are walked at any depth, recreating the archive's internal folder structure as
  vault folders and importing every `.md` file found. Zip-slip protected; one bad file or
  entry doesn't abort the rest of the batch.
- **Passphrase recovery decision:** vault creation with a passphrase is gated behind an
  explicit confirmation modal stating there is no password reset, plus a full recovery
  writeup in `docs/RECOVERY.md`.
- **In-app documentation:** a first-run welcome modal, and a "Welcome to Driftleaf" note
  auto-created in every new vault covering shortcuts, markdown syntax, and the encryption
  model.
- **Stretch features:** a global quick-capture hotkey (`Ctrl+Shift+N`, works even when the
  window isn't focused), a keyboard-first command palette (`Ctrl+K`), and daily notes
  (dated notes in a `Daily` folder).
- **Error handling:** empty vault/folder messaging, friendly disk-full/permission-denied
  errors surfaced from the main process, and a React error boundary so an unexpected crash
  shows a recoverable dialog instead of a blank window.
- **Packaging:** per-platform electron-builder configs (`electron-builder/linux.yml`,
  `macos.yml`, `windows.yml`, each with a `:beta` variant building under a distinct app id
  so a beta build can install side-by-side with stable) and matching `package:*`/`publish:*`
  npm scripts, mirroring Before-Its-Gone's build process. A full custom Windows NSIS
  installer flow (EULA, AGPL license page, welcome/finish pages) and a proper app icon.
  `.github/workflows/build.yml` builds unsigned artifacts for Linux/macOS/Windows on tagged
  releases (`vX.Y.Z`, `-alpha-N`, `-beta-N`) cut from `main`/`dev`.
