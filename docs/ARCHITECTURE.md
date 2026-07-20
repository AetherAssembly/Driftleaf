# Architecture

## Process layout

Standard Electron three-process split:

- `src/main` — Node-side app logic: window management, vault (file) access
  (`vault.ts`), encryption (`crypto.ts`), the search index (`search.ts`), and
  IPC handlers (`ipc.ts`). Nothing here is exposed directly to the renderer;
  it goes through IPC and the preload bridge.
- `src/preload` — `contextBridge` surface exposed to the renderer as
  `window.driftleaf`, typed by `src/shared/ipc.ts`. Renderer never gets raw
  Node/fs access.
- `src/renderer` — React UI, built with `@aetherAssembly/ui` components
  (`Button`, `Card`, `Input`, `Modal`, `Badge`) rather than bespoke chrome —
  see [UI library](#ui-library) below.
- `src/shared` — types and IPC channel names shared by main and renderer, so
  the two sides can't drift out of sync.

## Vault layout

A **vault** is a folder tree on disk, one directory per Driftleaf "workspace."
Organization is folder-based (not tags) — the on-disk folder structure *is*
the note organization the app shows.

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json        vault metadata: format version, scrypt salt (not the key)
│   ├── canary.enc         known-plaintext blob, used to verify a passphrase on unlock
│   └── manifest.json      plaintext note metadata: {id, title, folderPath, fileName, updatedAt}[]
├── Inbox/
│   └── Grocery list.md.enc
├── Projects/
│   └── Driftleaf/
│       └── Release checklist.md.enc
```

Each note's `.enc` filename is derived from its title (`<title>.md.enc`, with
a " (2)" suffix on a same-folder title collision) rather than an opaque id —
like any other encrypted file, it keeps its name with the extension changed,
so the vault folder is browsable in a normal file manager. `fileName` is
kept in sync with `title` by `renameNote()`/`moveNote()` (see
[Vault resilience](#vault-resilience)); `id` is purely an internal handle
(React keys, search index, IPC references) decoupled from where the file
lives on disk.

The search index is **not** persisted to disk — see [Search](#search).

## Encryption

Notes are encrypted at rest from day one — this is not a bolt-on. Implemented
in `src/main/crypto.ts` and `src/main/vault.ts`:

- One key per vault, AES-256-GCM, in one of two modes (`vault.json`'s `kdf`
  field) — encryption itself is never optional, only the passphrase gate is:
  - `"scrypt"`: key derived from a user passphrase via scrypt
    (`N=2^17, r=8, p=1`, `maxmem=256MB`) and a stored salt. Nothing about the
    key is recoverable without the passphrase.
  - `"none"`: a random key generated at vault creation and stored directly in
    `vault.json` (`keyHex`). No passphrase prompt on unlock. Notes are still
    encrypted at rest — this only removes the *gate*, not the encryption — but
    the key sits next to the ciphertext, so it protects against "someone
    skims your files" but not "someone has access to this device/vault
    folder." For people who don't want a passphrase prompt (see
    `UnlockScreen`'s "Create vault without a passphrase" path).
- Each note file's markdown content is encrypted individually, framed on disk
  as `[iv][authTag][ciphertext]` (`<title>.md.enc`), regardless of which kdf
  mode the vault uses.
- A canary file (`canary.enc`, a known plaintext string encrypted with the
  vault key) lets unlock fail fast with "incorrect passphrase" instead of
  surfacing a raw AES-GCM auth-tag error. Also doubles as a corruption check
  for `"none"`-mode vaults, which have no passphrase to get wrong.

**Resolved:** note titles and folder placement live in a plaintext
`manifest.json` sidecar, not inside the encrypted files. This trades some
metadata privacy (an attacker with disk access can see note titles and the
folder tree, but not content) for a sidebar/search UI that doesn't require
decrypting the whole vault on every render. Content is always encrypted;
only title/folder/timestamp are plaintext.

**Resolved (PLAN.md milestone 7):** no recovery path, by explicit decision —
for `"scrypt"`-mode vaults, a lost passphrase means the vault's note content
is unrecoverable (the manifest sidecar would still list titles, but not
content). `UnlockScreen` gates vault creation with a passphrase behind a
confirmation modal that states this plainly before the vault is created; see
[docs/RECOVERY.md](RECOVERY.md) for the full recovery story.

## Vault resilience

Vault writes are structured so a crash or power loss mid-operation cannot corrupt or
silently lose a note. Two mechanisms, both in `src/main/vault.ts`:

- **Atomic file writes** (`writeFileAtomic`): every write to a `.enc` file or
  `manifest.json` goes to a sibling temp file first, then lands via `rename()`, which
  POSIX and NTFS both guarantee is atomic within a directory. A crash mid-write leaves
  either the old file intact or nothing — never a half-written, unparseable one.
- **Safe operation ordering + self-healing reconciliation**: multi-step operations
  (write note content, *then* update the manifest; rename/move the file on disk, *then*
  update the manifest; or drop a manifest entry, *then* delete the file) are ordered so
  a crash between the two steps only ever produces a disk/manifest mismatch that's
  *safe to have* — a manifest entry pointing at a `<folderPath>/<fileName>` that no
  longer exists, never data loss. `reconcileVault()` runs automatically on every
  `unlockVault()` call, walks the vault directory building the set of
  `(folderPath, fileName)` pairs actually on disk, and fixes up three cases against it:
  - manifest entries whose `(folderPath, fileName)` isn't on disk → dropped (dangling)
  - `.enc` files on disk not claimed by any manifest entry → re-added with a fresh `id`
    and a title recovered straight from the filename (stripping `.md.enc`/`.enc`)
  - notes still on the pre-title-filename scheme (`<id>.enc`, from before this feature
    existed) → opportunistically renamed on disk to `<title>.md.enc`
  Because a crash mid-`renameNote()`/`moveNote()` is just an atomic disk `rename()`
  followed by a manifest write, the two failure cases above are the *only* things that
  can happen — there's no third "stale path" case to reconcile separately anymore. The
  report of what it fixed (`VaultRecoveryReport`) is returned through `vault:unlock`
  and surfaced to the user as a toast in the renderer.
- **Corruption detection on read**: AES-256-GCM's auth tag already fails to verify on
  any bit-flip or truncation of a `.enc` file, so `readNote()` catches that decrypt
  failure and reports it as "Note is corrupted and cannot be decrypted" rather than
  letting a raw crypto error surface — no separate checksum needed, GCM's tag already
  is one.

**Recovery if a vault won't open at all:** if `.driftleaf/vault.json` or `canary.enc`
is missing or unreadable, the vault can't be unlocked — these aren't self-healing since
they hold the key material itself. Restore them from a backup of the `.driftleaf/`
directory. `manifest.json` alone, by contrast, is disposable: delete it and the next
unlock's `reconcileVault()` pass will rebuild it from the `.enc` files it finds on disk
(titles are lost — content is not, since content lives in the `.enc` files, not the
manifest).

## Import

`importFiles()` (`src/main/vault.ts`) imports a batch of `.md` files and/or `.zip`
archives, selected via a native file picker (`vault:pickImportFiles`), into the
currently selected folder:

- **`.md` files** become a note titled after the filename (minus extension), with the
  file's contents as note content.
- **`.zip` archives** (parsed with `adm-zip`, a pure-JS dependency — no native module
  rebuild step, unlike `better-sqlite3`) are walked for every `.md` entry at any depth;
  the archive's internal folder structure is recreated as vault folders (nested)
  under the target folder, and each `.md` entry becomes a note. Non-`.md` entries are
  ignored. Zip entry paths are validated the same way as any other `folderPath`
  (`validateFolderPath`, rejecting `..` and absolute paths) before being used, to rule
  out a zip-slip archive escaping the vault directory.

One bad file or zip entry doesn't abort the batch — failures are collected into a
`skipped` list (shown in the renderer's toast) rather than thrown, so a single
malformed `.md` file in a large zip doesn't lose the rest of the import.

## Search

Local full-text search via SQLite FTS5 (`src/main/search.ts`), indexing note
content.

**Resolved:** the index is `better-sqlite3` opened against `:memory:` and
rebuilt from decrypted content each time a vault is unlocked
(`buildIndex`), then kept in sync incrementally on every write
(`reindexNote`) and delete (`removeFromIndex`). It is never written to disk,
so no encrypted-index format was needed. Trade-off: a large vault pays a
full-decrypt cost once per unlock rather than paying for encrypting/managing
a persistent index; this is the milestone-9 performance pass's problem to
revisit if that cost becomes noticeable at scale.

Search queries are tokenized into quoted-prefix terms
(`"word"*` per word) before being handed to FTS5's `MATCH`, so free-text user
input can't inject FTS5 query syntax (column filters, boolean operators).

## Packaging

Electron packaging config is split by platform rather than one shared
`electron-builder.yml`, mirroring [Before-Its-Gone](https://github.com/AetherAssembly/Before-Its-Gone)'s
build process:

```
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

Each platform has a `:beta` config building under a distinct `appId`/
`productName` (`Driftleaf-Beta`), so a beta build can be installed
side-by-side with a stable one rather than overwriting it. `package.json`'s
`package:*`/`package:*:beta` scripts run `npm run build` (typecheck + Vite
bundle, no packaging) followed by `electron-builder --config
electron-builder/<platform>.yml`; `publish:*` scripts are the same with
`--publish always`, pushing to the `Driftleaf` GitHub release matching the
current version. All of this produces **unsigned** dev builds — see PLAN.md
milestone 14 for code signing/notarization.

## UI library

Driftleaf's renderer is built on `@aetherAssembly/ui` (published to GitHub
Packages, see `.npmrc`), the shared AetherAssembly component library, instead
of bespoke UI primitives. `Button`, `Card`, `Input`, `Modal`, and `Badge`
cover the current screens (unlock flow, sidebar, editor toolbar). It requires
React 19 as a peer dependency, which is why Driftleaf is on React 19 rather
than 18.

App-specific layout (sidebar/editor grid, split-pane preview) is plain CSS in
`src/renderer/app.css`, layered on top of `@aetherAssembly/ui`'s `--ae-*`
design tokens rather than overriding its components' internals.
