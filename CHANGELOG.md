# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses semantic versioning.

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
