# Driftleaf — Project Plan

## Core idea

A note-taking app that's genuinely local-first and encrypted, not "local
storage with a cloud backup you can technically disable." Optional sync
happens over your own network or your own server, never a third-party
account.

## Confirmed decisions

- **Stack:** Electron + React 19 + Vite + TypeScript
- **UI components:** [`@aetherAssembly/ui`](https://github.com/AetherAssembly/aether-packages)
  (GitHub Packages) — `Button`, `Card`, `Input`, `Modal`, `Badge` — rather than
  bespoke components; app-specific layout is plain CSS on top of its `--ae-*` tokens
- **Organization:** folders (filesystem-mirrored hierarchy), not tags
- **Encryption:** at-rest, from day one — scrypt → AES-256-GCM per vault, plaintext
  `manifest.json` sidecar for titles/folders so the tree renders without a full decrypt
- **Search:** SQLite FTS5, in-memory only, rebuilt on unlock and kept in sync on writes

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how these fit together on disk.

## Release phases

Rough version mapping: **Alpha** = 0.1–0.4 (core loop works, rough edges
expected), **Beta** = 0.5–0.8 (feature-complete for v1, hardening and real
daily-use testing), **RC** = 0.9.x (no known blockers, packaging is final,
only regression fixes land), **1.0** = first stable release. Each phase's
milestones are checked off in order; don't start a milestone in a later
phase before its dependencies above it are done.

### Alpha — core loop

- [x] **0. Scaffold** — Electron/React/Vite project boots, docs in place
- [x] **1. Vault + encryption** — passphrase-derived key, unlock flow, encrypted
      note read/write, folder-based file CRUD (`src/main/vault.ts`, `src/main/crypto.ts`);
      verified end-to-end (create/unlock/wrong-passphrase/read/write/rename/delete)
- [x] **2. Editor** — markdown textarea + live preview (`marked` + `dompurify`),
      toggleable preview pane, autosaves 500ms after typing stops
- [x] **3. Search** — in-memory SQLite FTS5 index (`src/main/search.ts`), rebuilt on
      unlock, kept in sync on note write/create/rename/delete, sanitized query input
- [ ] **4. Folder organization UI** — sidebar has folder list + create-folder and
      select-folder (done); still missing: move note between folders, rename/delete
      folder, nested-tree indentation (currently a flat list of full paths)
- [ ] **5. Packaging (dev builds)** — electron-builder unsigned builds for
      Linux/macOS/Windows, good enough for the developers

### Beta — feature-complete, hardening

- [ ] **6. Vault resilience** — atomic writes (no half-written notes on crash/power
      loss), corruption detection, a documented recovery path if a vault won't open
- [ ] **7. Passphrase recovery story** — explicit decision + UX for "forgot passphrase"
      (recovery key export, or an explicit no-recovery warning shown at vault creation)
- [ ] **8. Cross-platform pass** — exercise the app on Linux, macOS, and Windows;
      fix platform-specific path/keychain/window-chrome issues
- [ ] **9. Performance pass** — vault with 1,000+ notes: startup time, search
      latency, editor responsiveness all stay usable
- [ ] **10. Pick and build 2–3 stretch features for v1** — see list below;
      choose the ones that most reinforce the "local-first, yours" pitch
      (quick-capture hotkey, command palette, and daily notes are the likely picks)
- [ ] **11. Error handling + empty/edge states** — first-run flow, empty vault,
      empty folder, search-with-no-results, disk-full-on-save, all handled visibly
- [ ] **12. In-app docs** — first-run walkthrough or a bundled help note explaining
      the encryption/passphrase model, since there's no cloud support to fall back on

### RC — stabilize and ship

- [ ] **13. Security review of the crypto module** — self-review at minimum
      (key derivation params, IV/nonce reuse, memory hygiene for the key);
      external review if the vault format is going to be relied on
- [ ] **14. Signed, notarized release builds** — code signing for macOS/Windows,
      reproducible Linux packages (AppImage + at least one of deb/rpm)
- [ ] **15. Update mechanism decision** — either wire up an update checker or
      explicitly document manual-update-only for v1 (must be a decision, not
      an omission)
- [ ] **16. Data-loss bug bash** — dedicated pass hunting specifically for bugs
      that could lose or corrupt a user's notes; these are the only
      release-blocking class of bug for an RC
- [ ] **17. Freeze** — RC branch cut, only regression fixes land; anything else
      gets deferred to the next release
- [ ] **18. Release checklist verified** — see below

### 1.0

- [ ] **19. Ship it** — tag release, publish builds, update README status line

## RC exit checklist

Before tagging an RC build, confirm all of:

- [ ] No known bug can silently lose or corrupt a note
- [ ] Vault open/unlock/search/save all work on a cold install on each target OS
- [ ] Passphrase-loss behavior is documented and matches what the UI actually does
- [ ] `npm run build` produces a signed artifact on macOS/Windows (or the
      decision to ship unsigned is explicit and documented)
- [ ] PLAN.md and README status line reflect reality

## Stretch features (post-v0.1, unordered)

- Self-hosted sync between your own devices (similar to how apt.aetherassembly.org
  serves your Pi)
- End-to-end encrypted sync if a server component gets added later
- Backlinks/graph view
- Flashcard export (possible tie-in with MindTab)
- Daily notes/journal mode
- Templates for recurring note types (meeting notes, project logs)
- Version history per note, local diffs, no cloud service needed
- Quick-capture from a global hotkey
- Command palette for keyboard-first navigation
- Pinned/favorite notes
- Split-pane view
- Export to PDF / standalone HTML
- Attachments stored alongside the note in the vault folder
- Vim/Emacs editor keybinding mode
- Read-only "publish" mode: render a note or folder as a static site
- Search filters beyond full-text: by tag, date modified, folder
- Optional CLI companion for creating/grepping notes from the terminal

## Open questions

- Any interest in eventually linking this to MindTab, since they share a
  "note-ish" surface?

Resolved: encrypted-file layout and FTS5 index storage — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#encryption) and
[#search](docs/ARCHITECTURE.md#search).
