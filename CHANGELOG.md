# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses semantic versioning.

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
