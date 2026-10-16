# Tauri migration checkpoints

Work branch: `development`. Record changes under `[Unreleased]` in `CHANGELOG.md`.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Stabilize data handling and exclusive writers | Implemented |
| 1 | Separate domain service and desktop adapters | Not started |
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
