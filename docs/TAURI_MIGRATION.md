# Tauri migration checkpoints

Work branch: `development`. Record changes under `[Unreleased]` in `CHANGELOG.md`.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Stabilize data handling and exclusive writers | Implemented |
| 1 | Separate domain service and desktop adapters | Implemented |
| 2 | Prove Tauri shell with the existing interface | In progress (first slice) |
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

## Phase 2 first slice

Scope: prove the "one complete, safe edit-and-close workflow" milestone the plan calls for,
on CachyOS only — not the full phase gate (no installable builds, no Windows/macOS,
no measured startup/memory/package size; those remain open). Electron is untouched and still
the shipped app; this is a parallel, disabled-by-default shell.

**Architecture.** `src-tauri/` is a minimal Tauri 2 app. Rust owns every OS dialog
(`tauri-plugin-dialog`) and the window close handshake; it does not reimplement branch/session
logic. It spawns `sidecar/index.mjs` — a Node child process running the *unmodified* Phase 1
`service.ts` — and talks to it over a private, length-prefixed JSON request/response protocol
on stdin/stdout (4-byte big-endian length prefix + UTF-8 JSON body, 64MB bound). Only method
names and error messages are ever logged on either side; passphrases travel solely inside
request bodies on that private pipe.

`src/tauri-bridge/index.ts` implements the same `DriftleafApi` contract Electron's preload
does; `src/renderer/main.tsx` installs it as `window.driftleaf` only when nothing has already
(Tauri vs. Electron detection), so every component under `src/renderer/**` is unchanged, per
the plan's "unchanged React interface" requirement. Notes, folders, search, settings,
diagnostics, databases, canvas, and most of extensions (everything except `install` and `run`,
which need a native picker and a sandboxed window respectively) are wired through to the
sidecar. Commands that are genuinely not resolved yet — `notes.import`,
`vault.createBackup`/`verifyBackup` (picker-security-coupled, see below), `databases.export`
(also needs a native save dialog), `extensions.install`/`run`, and the updater — throw a clear
"not yet available in this Tauri preview build" instead of silently no-opping.

**Why pickers split the way they did.** Native dialogs must be shown from Rust — the Node
child has no GUI. Rather than give the sidecar a way to ask Rust to show one (a duplex
protocol) or re-derive the single-use "only import what was actually picked" allowlist in
Rust, this slice sidesteps the question: `vault.pickDirectory` is a Rust-native command
(`pick_directory`, no sidecar round-trip) and the three commands whose security check is
coupled to a prior pick (`notes.import`, `vault.createBackup`, `vault.verifyBackup`) are
simply not wired yet — they aren't needed for create/unlock → edit → search → lock → close.
Resolving this is a prerequisite before those three commands can be enabled.

**Why the sidecar uses `node:sqlite` instead of `better-sqlite3`.** The review flagged
building the SQLite native addon for the sidecar's own Node ABI/OS/architecture as something
to "prove early." Rather than maintain a second native build pinned to a different ABI than
Electron's, `sidecar/index.mjs` loads `search.ts` and `branch-lock.ts` (unmodified source,
via the same vm-sandbox module-loading trick `scripts/tests/regressions.mjs` already uses)
with their native `better-sqlite3` require swapped for a tiny adapter over Node's built-in
`node:sqlite` — the same pattern that test file's `TestDatabase` already proves correct. Zero
native deps for the sidecar; Electron keeps using the real addon unchanged. This is accepted
as transitional: Phase 4 replaces both with a Rust storage implementation.

**Real bugs found and fixed while building this:**
- `main.rs`: `tokio::process::Command::spawn()` and `tokio::spawn()` inside Tauri's `setup()`
  hook panicked ("no reactor running") because `setup()` doesn't run with Tauri's async
  runtime entered on that thread. Fixed by wrapping sidecar startup in
  `tauri::async_runtime::block_on`.
- `sidecar/index.mjs`: errors thrown inside the vm-sandboxed `service.ts` are instances of
  *that sandbox's* `Error`, not the host script's — `instanceof Error` checks outside the
  sandbox are always false for them, silently falling through to `String(error)`, which
  prepends a spurious `"Error: "` onto every message crossing the sidecar boundary. Fixed by
  checking for a string `.message` property instead of using `instanceof`.
- Missing `src-tauri/capabilities/default.json`: Tauri 2 denies all core/plugin APIs by
  default. `@tauri-apps/api/event`'s `listen()` (used for the close handshake) and the dialog
  plugin both failed silently until granted `core:event:default` and `dialog:default`.
- `src/renderer/main.tsx`'s async bootstrap had no `.catch()` — a failure installing the Tauri
  bridge left the page permanently blank with only an unhandled rejection in the console, no
  visible error. Fixed to always render (logging the bridge failure) so a broken bridge is a
  visible, debuggable error instead of a silent blank window.
- This Linux environment (NVIDIA proprietary driver) needed `WEBKIT_DISABLE_COMPOSITING_MODE=1
  WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1` to get WebKitGTK to actually paint
  — without them the window opened but stayed blank (GBM buffer allocation failures in the
  logs; under native Wayland the same underlying failure surfaces as a fatal protocol error
  that kills the window instead of just failing to paint). This is a known, long-documented
  WebKitGTK-plus-NVIDIA compositing gap (NVIDIA's GBM/EGL implementation negotiates a
  different, more limited set of DRM buffer modifiers than the Mesa-based implementations
  WebKitGTK is mostly tested against), not a bug in this app's code — confirmed by checking
  that other Wayland-native apps on the same GPU (VS Code/Electron, Dolphin/Qt) render fine;
  only WebKitGTK's own internal layer-compositing path is affected. **`GDK_BACKEND=x11` is
  not required** — the three `WEBKIT_*`/`LIBGL_*` variables alone are enough for native
  Wayland to render correctly too; forcing X11 was an unnecessarily blunt first attempt.
  Packaged builds should set these three variables for the bundled binary by default on Linux
  (see Phase 3) rather than asking users to set them; they're harmless on hardware where the
  issue doesn't occur.
- `src/renderer/App.tsx`'s initial load does `Promise.all([notes.listFolders(), notes.list(),
  databases.list(), canvas.read()])` with no per-call error handling — any one rejecting fails
  the whole batch, so a real, successfully-decrypted vault showed 0 notes while folder *names*
  still appeared (`listFolders` happened to be a separate, unaffected call elsewhere). Caused
  by `databases.list`/`canvas.read` being deliberately stubbed as "not supported" in the first
  cut of the bridge — scoped out as not needed for the edit/search/lock workflow, without
  noticing the initial load depends on all four resolving together. Fixed by wiring
  `databases.*` and `canvas.*` (and the rest of `extensions.*` except `install`/`run`) through
  to the sidecar instead, since `service.ts` already implements all of them correctly — only
  the frontend bridge was incomplete.
- `src/tauri-bridge/index.ts`'s `call()` helper forwarded optional omitted arguments (e.g.
  `notes.list()` called with no `folderPath`) as literal `undefined` into an array passed to
  `invoke()`, which JSON-serializes the call to cross into Rust. `JSON.stringify` silently
  turns `undefined` *array elements* into `null` (array properties, unlike object properties,
  can't just be omitted). `vault.ts`'s `listNotes(vault, folderPath?)` checks
  `folderPath === undefined` (strict) to mean "no filter" — receiving `null` instead made it
  filter for a folder literally named `null`, matching no real note and returning an empty
  list, while sibling calls with no optional parameter (like `listFolders()`) were unaffected.
  This is exactly what produced "real folder names, but 0 notes in every one of them" when
  opening a real, correctly-decrypted vault — not a vault-reading or encryption bug. Fixed by
  trimming trailing `undefined` arguments in `call()` before they cross the IPC boundary, so
  an omitted argument reaches the sidecar as an omitted argument (matching a plain JS call,
  and matching how the Electron preload already behaves).

**Verified on this CachyOS box** (manually, via `npx tauri dev`, native Wayland, no
`GDK_BACKEND` override): window opens and renders correctly; a disposable branch
creates/unlocks; creating, writing, and reading a note works with live Markdown preview;
search returns real FTS5 results with snippet highlighting; the native folder-picker dialog
opens and cancels correctly; Lock branch returns to the lock screen; closing the window runs
the flush→lock→close handshake and both the Rust process and the Node sidecar exit cleanly
with no orphaned processes. Also verified against a real, pre-existing production branch
(same one the Electron build has open, same `.driftleaf` metadata on disk, same passphrase):
opening it through "Open an existing branch" with the correct passphrase now correctly shows
all its real notes, folders, and a database — confirming decryption and the full read path
behave identically to Electron once the two bridge bugs above were fixed. No data was written
to that branch during this verification.

**Explicitly not done in this slice:** Windows and macOS are untested (no access to those
platforms from here). No installable build was produced (`tauri build`, code signing,
icons/bundle identity are unaddressed — see Phase 3). `notes.import`,
`vault.createBackup`/`verifyBackup`, `databases.export`, and `extensions.install`/`run` remain
unwired (picker/window-coupled, see above); the updater is unwired. Startup time, memory, and
package size were not measured. IME, screen readers, and keyboard-shortcut parity were not
checked. Verification was against one real vault on one machine — not a substitute for the
broader fixture-based cross-runtime testing Phase 4 calls for.

Automated checks: `cargo check` and `cargo clippy` (clean, no warnings) for `src-tauri/`;
`npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all still pass unchanged for
the Electron app. No automated test exercises the Tauri shell itself yet — this phase's
verification was manual.
