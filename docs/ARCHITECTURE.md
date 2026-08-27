# Architecture

## Process Layout

Standard Electron three-process split:

- **`src/main`** — Node-side app logic (window management, vault file access, encryption, search index, IPC handlers). Nothing here talks directly to the renderer — everything goes through IPC and the preload bridge.
- **`src/preload`** — the `contextBridge` surface exposed to the renderer as `window.driftleaf`, typed by `src/shared/ipc.ts`. The renderer never gets raw Node/fs access.
- **`src/renderer`** — React UI built with `@aetherAssembly/ui` components (`Button`, `Card`, `Input`, `Modal`, `Badge`) rather than bespoke chrome. See [UI Library](#ui-library) below.
- **`src/shared`** — types and IPC channel names shared by main and renderer, so the two sides can't drift out of sync.

## Vault Layout

A **vault** is a folder tree on disk — one directory per Driftleaf workspace. Organization is folder-based (not tags). The on-disk folder structure *is* the note organization the app shows.

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json        vault metadata: format version, scrypt salt (not the key)
│   ├── canary.enc        known-plaintext blob, used to verify a passphrase on unlock
│   └── manifest.json     plaintext note metadata: {id, title, folderPath, fileName, updatedAt}[]
├── Inbox/
│   └── Grocery list.md.enc
├── Projects/
│   └── Driftleaf/
│       └── Release checklist.md.enc
```

Each note's `.enc` filename is derived from its title (`<title>.md.enc`, with a " (2)" suffix on a same-folder title collision). Like any encrypted file, it keeps its name with the extension changed, so the vault folder is browsable in a normal file manager. `fileName` stays in sync with `title` via `renameNote()` / `moveNote()` (see [Vault Resilience](#vault-resilience)). The `id` is purely an internal handle (React keys, search index, IPC references) — decoupled from where the file lives on disk.

The search index is **not** persisted to disk. See [Search](#search) below.

## Encryption

Notes are encrypted at rest from day one — this is not a bolt-on. Implemented in `src/main/crypto.ts` and `src/main/vault.ts`:

- One key per vault, AES-256-GCM, in one of two modes (`vault.json`'s `kdf` field). Encryption itself is never optional — only the passphrase gate varies:
  - **`"scrypt"`** — key derived from a user passphrase via scrypt (`N=2^17, r=8, p=1`, `maxmem=256MB`) and a stored salt. Nothing about the key is recoverable without the passphrase.
  - **`"none"`** — a random key generated at vault creation and stored directly in `vault.json` (`keyHex`). No passphrase prompt on unlock. Notes are still encrypted at rest — this only removes the *gate*, not the encryption. But the key sits next to the ciphertext, so it protects against "someone skims your files" but not "someone has access to this device." For people who don't want a passphrase prompt (see `UnlockScreen`'s "Create vault without a passphrase" path).
- Each note file's markdown content is encrypted individually, framed on disk as `[iv][authTag][ciphertext]` (`<title>.md.enc`), regardless of which kdf mode the vault uses.
- A canary file (`canary.enc`, a known plaintext string encrypted with the vault key) lets unlock fail fast with "incorrect passphrase" instead of surfacing a raw AES-GCM auth-tag error. Also doubles as a corruption check for `"none"`-mode vaults, which have no passphrase to get wrong.

### Design Decisions

- **Plaintext manifest sidecar:** note titles and folder placement live in `manifest.json`, not inside the encrypted files. This trades some metadata privacy (an attacker with disk access can see titles and the folder tree, but not content) for a sidebar/search UI that doesn't require decrypting the whole vault on every render. Content is always encrypted; only title/folder/timestamp are plaintext.
- **No recovery path** (PLAN.md milestone 7, explicit decision): for `"scrypt"`-mode vaults, a lost passphrase means the note content is unrecoverable (the manifest would still list titles, but not content). `UnlockScreen` gates vault creation with a confirmation modal stating this plainly before the vault is created. See [RECOVERY.md](RECOVERY.md) for the full story.

## Vault Resilience

Vault writes are structured so a crash or power loss mid-operation can't corrupt or silently lose a note. Three mechanisms, all in `src/main/vault.ts`:

- **Atomic file writes** (`writeFileAtomic`): every write to a `.enc` file or `manifest.json` goes to a sibling temp file first, then lands via `rename()`, which POSIX and NTFS both guarantee is atomic within a directory. A crash mid-write leaves either the old file intact or nothing — never a half-written, unparseable one.

- **Safe operation ordering + self-healing reconciliation**: multi-step operations (write note content → update manifest; rename/move file → update manifest; drop manifest entry → delete file) are ordered so a crash between the two steps only ever produces a *safe* mismatch — a manifest entry pointing at a file that no longer exists, never data loss. `reconcileVault()` runs automatically on every `unlockVault()` call, walks the vault directory building the set of `(folderPath, fileName)` pairs actually on disk, and fixes up three cases:
  - Manifest entries whose file isn't on disk → dropped (dangling)
  - `.enc` files on disk not claimed by any manifest entry → re-added with a fresh `id` and a title recovered from the filename
  - Notes still on the pre-title-filename scheme (`<id>.enc`) → renamed on disk to `<title>.md.enc`

  Because a crash mid-`renameNote()`/`moveNote()` is just an atomic disk rename followed by a manifest write, those two cases are the *only* things that can happen. The report of what it fixed (`VaultRecoveryReport`) is returned through `vault:unlock` and surfaced as a toast in the renderer.

- **Corruption detection on read**: AES-256-GCM's auth tag already fails on any bit-flip or truncation of a `.enc` file, so `readNote()` catches that decrypt failure and reports "Note is corrupted and cannot be decrypted" instead of letting a raw crypto error surface.

### If Your Vault Won't Open at All

If `.driftleaf/vault.json` or `canary.enc` is missing or unreadable, the vault can't be unlocked — these hold key material and aren't self-healing. Restore them from a backup of the `.driftleaf/` directory. `manifest.json` alone, by contrast, is disposable: delete it and the next unlock's `reconcileVault()` pass will rebuild it from the `.enc` files it finds on disk (titles are lost, content is not).

## Import

`importFiles()` (`src/main/vault.ts`) imports a batch of `.md` files and/or `.zip` archives into the currently selected folder:

- **`.md` files** become a note titled after the filename (minus extension), with the file's contents as note content.
- **`.zip` archives** (parsed with `adm-zip`, a pure-JS dependency — no native module rebuild step) are walked for every `.md` entry at any depth. The archive's internal folder structure is recreated as nested vault folders under the target folder, and each `.md` entry becomes a note. Non-`.md` entries are ignored. Zip entry paths are validated the same way as any other `folderPath` (rejecting `..` and absolute paths) to rule out zip-slip.

One bad file or zip entry doesn't abort the batch — failures are collected into a `skipped` list (shown in the renderer's toast) rather than thrown, so a single malformed `.md` file in a large zip doesn't lose the rest of the import.

## Search

Local full-text search via SQLite FTS5 (`src/main/search.ts`), indexing note content.

The index is `better-sqlite3` opened against `:memory:` and rebuilt from decrypted content each time a vault is unlocked (`buildIndex`), then kept in sync incrementally on every write (`reindexNote`) and delete (`removeFromIndex`). It is never written to disk, so no encrypted-index format was needed.

**Performance (v0.2.0):** the build process uses parallel decryption (via `Promise.all()`) and transaction wrapping for batch inserts, with timing instrumentation available. Enable performance logging with `DEBUG_SEARCH=1` before running `npm run dev`, then open Electron DevTools (Ctrl+Shift+I) to see detailed timing breakdowns. See [PERFORMANCE.md](PERFORMANCE.md) for benchmarking methodology and baseline metrics.

Search queries are tokenized into quoted-prefix terms (`"word"*` per word) before being handed to FTS5's `MATCH`, so free-text user input can't inject FTS5 query syntax (column filters, boolean operators).

## Packaging

Electron packaging config is split by platform rather than one shared `electron-builder.yml`, mirroring [Before-Its-Gone](https://github.com/AetherAssembly/Before-Its-Gone)'s build process:

```bash
electron-builder/
├── linux.yml         linux.beta.yml    AppImage + deb + rpm
├── macos.yml         macos.beta.yml    dmg + zip
└── windows.yml       windows.beta.yml  nsis installer + portable
build/                                  electron-builder buildResources
├── icon.png / icon.svg                 app icon (1024×1024 source; electron-builder
│                                        derives .icns/.ico from the PNG)
├── agpl.txt                            full AGPL-3.0 text (copy of repo LICENSE),
│                                        shown as the second Windows license page
├── pre-install.txt / post-install.txt  Windows installer welcome/finish page text
└── installer.nsh                       custom NSIS macros wiring the above into the
                                         installer flow (welcome/license/finish pages)
assets/
├── eula.rtf                            Windows installer EULA (first license page)
└── installer-sidebar.png / .svg        164×314 NSIS welcome/finish page sidebar image
```

Each platform has a `:beta` config building under a distinct `appId` / `productName` (`Driftleaf-Beta`), so a beta build can be installed side-by-side with a stable one. `package.json`'s `package:*` / `package:*:beta` scripts run `npm run build` (typecheck + Vite bundle, no packaging) followed by `electron-builder --config electron-builder/<platform>.yml`; `publish:*` scripts are the same with `--publish always`, pushing to the `Driftleaf` GitHub release matching the current version. All of this produces **unsigned** dev builds — see PLAN.md milestone 14 for code signing/notarization.

## UI Library

Driftleaf's renderer is built on `@aetherAssembly/ui` (published to GitHub Packages, see `.npmrc`), the shared AetherAssembly component library, instead of bespoke UI primitives. `Button`, `Card`, `Input`, `Modal`, and `Badge` cover the current screens (unlock flow, sidebar, editor toolbar). It requires React 19 as a peer dependency, which is why Driftleaf is on React 19 rather than 18.

App-specific layout (sidebar/editor grid, split-pane preview) is plain CSS in `src/renderer/app.css`, layered on top of `@aetherAssembly/ui`'s `--ae-*` design tokens rather than overriding its components' internals.
