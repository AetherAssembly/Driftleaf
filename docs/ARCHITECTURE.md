# Architecture

## Process Layout

Standard Electron three-process split:

- **`src/main`** — Node-side app logic (window management, vault file access, encryption, search index, IPC handlers). Nothing here talks directly to the renderer — everything goes through IPC and the preload bridge.
- **`src/preload`** — the `contextBridge` surface exposed to the renderer as `window.driftleaf`, typed by `src/shared/ipc.ts`. The renderer never gets raw Node/fs access.
- **`src/renderer`** — React UI built with `@aetherAssembly/ui` components (`Button`, `Card`, `Input`, `Modal`, `Badge`) rather than bespoke chrome. See [UI Library](#ui-library) below.
- **`src/shared`** — types and IPC channel names shared by main and renderer, so the two sides can't drift out of sync.
- **`src/main/updates.ts`** — platform-aware update checks. Windows installer builds use `electron-updater`; Linux and unsigned macOS builds check GitHub releases and offer manual downloads.

## Vault Layout

A **vault** is a folder on disk — one directory per Driftleaf workspace. Organization is folder-based (not tags), but folder names are stored only in the encrypted manifest and are not mirrored as note directories on disk.

```bash
my-vault/
├── .driftleaf/
│   ├── vault.json        vault metadata: format version, scrypt salt (not the key)
│   ├── canary.enc        known-plaintext blob, used to verify a passphrase on unlock
│   ├── manifest.enc      encrypted note, folder, and database metadata
│   ├── notes/
│   │   └── <note-id>.enc  encrypted note content with an opaque filename
│   └── <database-id>.db.enc  encrypted database schema, rows, and views
```

Note titles, folder placement, database titles, IDs, timestamps, extension
code/permissions, and canvas layout are encrypted in `manifest.enc`. Note
ciphertext is stored under `.driftleaf/notes/` using opaque note IDs; folder
organization does not create named directories on disk. Canvas cards reference
existing notes or databases and are removed when a target is deleted.
Database properties, rows, and saved views are encrypted together in
`.driftleaf/<database-id>.db.enc`. The encrypted manifest is decrypted only after
the passphrase check and kept in memory while the vault is unlocked.

The search index is **not** persisted to disk. See [Search](#search) below.

## Encryption

Notes and database contents are encrypted at rest — this is not a bolt-on. Implemented in `src/main/crypto.ts` and `src/main/vault.ts`:

- One key per vault, AES-256-GCM, in one of two modes (`vault.json`'s `kdf` field). Encryption itself is never optional — only the passphrase gate varies:
  - **`"scrypt"`** — key derived from a user passphrase via scrypt (`N=2^17, r=8, p=1`, `maxmem=256MB`) and a stored salt. Nothing about the key is recoverable without the passphrase.
  - **Legacy `"none"`** — old vaults can still be opened with an empty passphrase for compatibility, but Driftleaf no longer creates new vaults in this mode. A key stored directly in `vault.json` (`keyHex`) means any attacker with vault access can decrypt the contents, so this path is intentionally disabled for new vault creation.
- Each note's markdown content and the manifest/database payloads are encrypted individually, framed on disk as `[iv][authTag][ciphertext]`, regardless of which kdf mode the vault uses.
- Database schema, rows, and view definitions are encrypted as one payload per database (`.driftleaf/<database-id>.db.enc`).
- A canary file (`canary.enc`, a known plaintext string encrypted with the vault key) lets unlock fail fast with "incorrect passphrase" instead of surfacing a raw AES-GCM auth-tag error. Also doubles as a corruption check for `"none"`-mode vaults, which have no passphrase to get wrong.

### Design Decisions

- **Encrypted manifest:** note titles, database titles, IDs, timestamps, and folder placement are protected in `manifest.enc`; opaque note filenames avoid revealing titles via the filesystem. Legacy plaintext manifests are encrypted on the next successful unlock, and legacy note files are moved to opaque-ID paths. Empty legacy folders are removed without deleting unrelated files.
- **No recovery path** (explicit decision, not an oversight): for `"scrypt"`-mode vaults, a lost passphrase means the note content is unrecoverable (the manifest would still list titles, but not content). `UnlockScreen` gates vault creation with a confirmation modal stating this plainly before the vault is created. See [RECOVERY.md](RECOVERY.md) for the full story.

## Vault Resilience

Vault writes are structured so a crash or power loss mid-operation can't corrupt or silently lose a note. Three mechanisms, all in `src/main/vault.ts`:

- **Atomic file writes** (`writeFileAtomic`): every write to a `.enc` file goes to a sibling temp file first, then lands via `rename()`, which POSIX and NTFS both guarantee is atomic within a directory. A crash mid-write leaves either the old file intact or nothing — never a half-written, unparseable one.

- **Safe operation ordering + self-healing reconciliation**: multi-step operations (write note content → update encrypted manifest; drop manifest entry → delete file) are ordered so a crash between the two steps leaves at worst unindexed ciphertext, never a manifest entry pointing at a file that no longer exists. `reconcileVault()` runs automatically on every `unlockVault()` call and migrates legacy named note files to opaque ID paths:
  - Manifest entries whose file isn't on disk → dropped (dangling)
  - Unclaimed legacy `.enc` files can still be recovered by filename
  - Legacy note ciphertext is moved under `.driftleaf/notes/<note-id>.enc`

  The report of migrated/recovered/removed entries (`VaultRecoveryReport`) is returned through `vault:unlock` and surfaced as a toast in the renderer.

- **Corruption detection on read**: AES-256-GCM's auth tag already fails on any bit-flip or truncation of a `.enc` file, so `readNote()` catches that decrypt failure and reports "Note is corrupted and cannot be decrypted" instead of letting a raw crypto error surface.

### If Your Vault Won't Open at All

If `.driftleaf/vault.json`, `canary.enc`, or `manifest.enc` is missing or unreadable, the vault can't be unlocked — these hold key material and metadata and aren't self-healing. Restore the entire `.driftleaf/` directory from a backup. Since note titles and folders are encrypted, note files cannot be re-indexed with their original metadata if the manifest is lost.

## Import

`importFiles()` (`src/main/vault.ts`) imports a batch of Markdown notes and databases into the currently selected folder:

- **`.md` files** become notes titled after the filename (minus extension), with the file's contents as note content.
- **`.csv` files** become databases. Column names become properties, common types are inferred, and common headers such as tags, status, URL, email, and phone receive type hints.
- **`.json` files** become databases from an array of objects or a top-level `data`, `results`, or `records` array. Notion-style exported property values and common type hints are normalized where supported.
- **`.zip` archives** (parsed with `adm-zip`, a pure-JS dependency — no native module rebuild step) are walked for `.md`, `.csv`, and `.json` entries at any depth. The archive's internal folder structure is recreated under the target folder. Other entry types are ignored. Zip paths reject traversal and absolute paths to prevent zip-slip. Archives are limited to 20,000 entries and imported entries to 20 MiB each.

Database tables support editable rows and properties, formula properties, relations to other Driftleaf databases, and basic rollups. Notion CSV exports do not include formula definitions, and formulas/relations are not guaranteed to transfer from JSON exports; formulas can be recreated in Driftleaf and relations between imported databases must be set up manually. Formula evaluation is a safe, limited implementation rather than full Notion formula-language compatibility.

One bad file or archive entry doesn't abort the batch — failures are reported as skipped items so a single malformed file doesn't lose the rest of the import. See [DATABASES.md](DATABASES.md) for user-facing import, editing, formula, and relation details.

## Search

Local full-text search via SQLite FTS5 (`src/main/search.ts`), indexing note content.

The index is `better-sqlite3` opened against `:memory:` and rebuilt from decrypted content each time a vault is unlocked (`buildIndex`), then kept in sync incrementally on every write (`reindexNote`) and delete (`removeFromIndex`). It is never written to disk, so no encrypted-index format was needed.

**Performance (v0.2.0):** the build process uses parallel decryption (via `Promise.all()`) and transaction wrapping for batch inserts, with timing instrumentation available. Enable performance logging with `DEBUG_SEARCH=1` before running `npm run dev`, then open Electron DevTools (Ctrl+Shift+I) to see detailed timing breakdowns. See [PERFORMANCE.md](PERFORMANCE.md) for benchmarking methodology and baseline metrics.

Search queries are tokenized into quoted-prefix terms (`"word"*` per word) before being handed to FTS5's `MATCH`, so free-text user input can't inject FTS5 query syntax (column filters, boolean operators).

## Linked Notes and Graph

Wiki-style links use `[[Note title]]` or `[[Note title|alias]]`. A folder path
can disambiguate duplicate titles, for example `[[Projects/Driftleaf]]`. Only a
unique title or exact folder/title path resolves; unresolved and ambiguous
references remain plain text in the preview and do not create graph edges.
References inside inline or fenced code are ignored.

Backlinks and the graph are derived from the note content already held by the
unlocked, in-memory FTS index. The `notes:graph` IPC handler returns only note
metadata and resolved note-ID edges; content is not copied into a separate
plaintext index or written to disk. The graph therefore excludes notes that
could not be decrypted while the search index was built, and is cleared when
the vault is locked.

The graph can be filtered to the selected note and its neighbors. Unlinked
mentions are derived from the same in-memory index and are not persisted.

## Extensions

JavaScript extensions are imported through the native file picker and stored
inside the encrypted manifest. Extensions run in separate sandboxed
`BrowserWindow`s with context isolation, no Node integration, a unique session,
and a restrictive Content Security Policy that disables network access and
external resources. Their dedicated preload exposes only scoped read APIs.
The main process checks extension identity and encrypted permission grants on
every request. Database access requires both a capability and selected
database IDs; relation fields and rollups that would expose an ungranted
database are filtered. Permissions are off by default and revoked immediately
when changed or when an extension is removed. See [EXTENSIONS.md](EXTENSIONS.md)
for the API and limitations.

## Updates

Windows NSIS builds use `electron-updater` and require explicit user action to
download/install. Windows portable builds, Linux, and unsigned macOS builds
check public GitHub release metadata and offer manual downloads. macOS
automatic installation is build-time gated and should only be enabled after
signing and notarization are configured. Automatic checks can be disabled in
Settings. See [UPDATES.md](UPDATES.md).

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

Each platform has a `:beta` config building under a distinct `appId` / `productName` (`Driftleaf-Beta`), so a beta build can be installed side-by-side with a stable one. `package.json`'s `package:*` / `package:*:beta` scripts run `npm run build` (typecheck + Vite bundle, no packaging) followed by `electron-builder --config electron-builder/<platform>.yml`. The release workflow sets the app version from its release tag before building, then uploads distributables and updater metadata to the draft GitHub release. Signing and notarization are optional release secrets; macOS automatic installation remains off unless `DRIFTLEAF_MAC_AUTO_UPDATE` is explicitly enabled. See [UPDATES.md](UPDATES.md).

## UI Library

Driftleaf's renderer is built on `@aetherAssembly/ui` (published to GitHub Packages, see `.npmrc`), the shared AetherAssembly component library, instead of bespoke UI primitives. `Button`, `Card`, `Input`, `Modal`, and `Badge` cover the current screens (unlock flow, sidebar, editor toolbar). It requires React 19 as a peer dependency, which is why Driftleaf is on React 19 rather than 18.

App-specific layout (sidebar/editor grid, split-pane preview) is plain CSS in `src/renderer/app.css`, layered on top of `@aetherAssembly/ui`'s `--ae-*` design tokens rather than overriding its components' internals.
