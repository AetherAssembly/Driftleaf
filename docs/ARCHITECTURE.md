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
│   └── manifest.json      plaintext note metadata: {id, title, folderPath, updatedAt}[]
├── Inbox/
│   └── <id>.enc
├── Projects/
│   └── Driftleaf/
│       └── <id>.enc
```

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
  as `[iv][authTag][ciphertext]` (`<id>.enc`), regardless of which kdf mode
  the vault uses.
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

**Known gap (tracked in PLAN.md milestone 7):** for `"scrypt"`-mode vaults
there is still no passphrase-recovery path — a lost passphrase means the
vault's note content is unrecoverable (the manifest sidecar would still list
titles, but not content). This needs an explicit decision (recovery key
export vs. an explicit no-recovery warning, which the create-vault UI already
shows) before beta.

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
