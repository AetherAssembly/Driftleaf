# Tauri migration checkpoints

Work branch: `development`. Record changes under `[Unreleased]` in `CHANGELOG.md`.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Stabilize data handling and exclusive writers | Implemented |
| 1 | Separate domain service and desktop adapters | Implemented |
| 2 | Prove Tauri shell with the existing interface | Not started |
| 3 | Extension isolation, packaging, and updates | Not started |
| 4 | Rust backend with branch-format compatibility | Not started |
| 5 | Beta validation and rollout | Not started |

## Phase 0 verification

The 0.6.4 data-loss fixes remain in place. This phase adds exclusive writer
protection, draft flushing before backups/imports, and retryable canvas saves.
The runtime is still Electron; branch encryption and content formats are unchanged.

Use a disposable branch or a copy. For the multiple-instance check, **both
instances must run this development build**: older releases do not participate
in the writer-lock protocol. Run `npm run dev` from two terminals, or launch
two copies of a development build. Never test against a personal active branch.

1. Open the same branch in both instances. The second must explain that the
   branch is already open. Lock the first, then retry the second: it must open.
2. Close an unlocked instance normally and reopen its branch in the other
   instance. Repeat using a forced process termination on disposable data:
   reopening must work without manually deleting any lock file.
3. Enter a wrong passphrase, then retry the correct one. A failed unlock must
   not leave the branch reserved.
4. Set autosave to five seconds. Edit a note and immediately create a backup.
   Open the backup as a separate branch and verify the latest text is present.
5. Move a canvas card, immediately lock or close, then reopen. Verify its
   position. Confirm note text, titles, and database cells still survive the
   same immediate-lock/close test from 0.6.4.
6. Optional failure injection on a disposable branch: temporarily deny writes
   to its `.driftleaf` contents, move a card or edit a note, and attempt to lock.
   The app must retain the draft and stay open. Restore write permissions and
   press Ctrl/Cmd+S, then lock/reopen and verify the edit.

The hidden `.driftleaf-writer.sqlite` file contains no branch content. It must
remain at a stable path while processes are running; do not delete it to bypass
an active lock. SQLite's OS lock releases on process exit. In-app backups exclude
this runtime file and its journal sidecars. Local-filesystem locking is tested;
network/shared-filesystem behavior is not yet qualified.

Automated checks: `npm test` (17 storage tests and 12 regression tests),
`npm run build` (including typecheck), `npm run lint`, and `git diff --check`.
Cross-platform GUI/installer checks remain manual.

## Phase 1 verification

Session ownership, the save/lock op queue, and every branch/note/database/folder/search/
canvas/extension-data command moved out of `src/main/ipc.ts` into an Electron-independent
service (`src/main/service.ts`). The service never imports `electron`; it receives settings-
directory, picker, external-link, and updater behavior through an injected `ServiceHost`
(`src/main/service-host.ts`). The real implementation of that host
(`src/main/electron-host.ts`) wires it to actual dialogs, `app.getPath`, `shell.openExternal`,
and the existing `electron-updater`-based `updates.ts`. `src/main/index.ts` is now the
composition root that builds the host and service once and injects them into
`registerIpcHandlers`.

`src/main/ipc.ts` keeps only what is genuinely Electron/window-bound: opening the sandboxed
extension `BrowserWindow`, the extension-context map keyed by `webContents` id (inherently
tied to a live sender identity), and the update-install close/relaunch handshake. Those
handlers share the service's op queue and error translation through
`service.__internal.runSerializedCommand` instead of duplicating either.

Single-use picker allowlisting (backup destination/directory, import file paths) and the
settings-patch-on-unlock write both moved into the service unchanged, so the security and
save-ordering guarantees from Phase 0 apply identically regardless of which adapter is
calling. The session now carries an explicit, inspectable generation counter
(`service.__internal.generation()`); not load-bearing yet (the op queue already totally
orders every command against lock), but it gives later phases — a sidecar, extensions as a
separate command source — something to assert sessions against instead of only "is a vault
currently present."

**Gate:** `scripts/tests/regressions.mjs` adds two contract tests
(`service contract: ...`) that run the identical create/hasPassphrase/write/read/lock/
post-lock-rejection sequence twice: once calling `createDriftleafService` directly with a
fake host (no Electron at all), and once through the existing Electron-mocked `ipc.ts`
adapter. Both pass with the same assertions. `extensions.run` and `updates.install` are
intentionally excluded from the service (window-bound, same reasoning as Phase 3's scope)
and stay Electron-only special cases in `ipc.ts`.

Automated checks: `npm test` (17 storage tests, 14 regression tests — 2 new contract
tests), `npm run typecheck`, `npm run lint`, `npm run build`. No behavior change is intended
for the packaged app; this phase only moved where the logic lives.
