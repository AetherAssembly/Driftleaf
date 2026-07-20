# Driftleaf

So your thoughts don't drift.

A local-first, encrypted-by-default notes app. Notes are markdown, organized
in folders, stored encrypted at rest on your own disk — no third-party
account, no cloud-by-default. Sync (later) will be opt-in and run over your
own network or your own server.

**Status:** core loop works. You can create or unlock a vault, browse/create
folders and notes, move/rename/delete notes and folders, write markdown with
a live preview, and full-text search across the vault — all local, all
encrypted at rest. Vault writes are crash-safe (atomic writes + a self-healing
consistency check on every unlock). Not yet done: signed release builds and
the rest of the [roadmap](PLAN.md).

## Quick start

`@aetherAssembly/ui` is published to GitHub Packages, so `npm install` needs
a GitHub personal access token with `read:packages` scope, even though the
package is public:

```sh
# ~/.npmrc (once, not per-project)
//npm.pkg.github.com/:_authToken=<your-token>
```

Then:

```sh
npm install
npm run dev        # launch the Electron app in dev mode
npm run build      # typecheck + build the renderer/main/preload bundles (no packaging)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Building from source

`npm run build` only typechecks and builds the renderer/main/preload bundles
with Vite — it doesn't package an app. Packaging is a separate step, split by
platform (mirrors [Before-Its-Gone](https://github.com/AetherAssembly/Before-Its-Gone)'s
build process rather than one shared electron-builder config):

```sh
npm run package:appimage      # Linux, AppImage only
npm run package:linux         # Linux: AppImage + deb + rpm
npm run package:linux:arm64   # Linux, arm64
npm run package:macos         # macOS: dmg + zip
npm run package:windows       # Windows: nsis installer + portable
```

Each has a `:beta` variant (`package:linux:beta`, etc.) that builds under a
separate app id/name (`Driftleaf-Beta`, side-installable next to the stable
build) using `electron-builder/<platform>.beta.yml`. All `package:*` scripts
build unsigned artifacts to `release/` and never publish
(`--publish never`); `publish:linux`/`publish:macos`/`publish:windows` are the
same builds with `--publish always`, which pushes to the `Driftleaf` GitHub
release matching the current version — only run those when you mean it.
Config lives in [`electron-builder/`](electron-builder/) (`<platform>.yml` /
`<platform>.beta.yml`); Windows installer assets (EULA, sidebar image,
license, custom NSIS pages) live in [`assets/`](assets/) and
[`build/`](build/). These are dev/unsigned builds — see PLAN.md milestone 14
for signed/notarized release builds.

Tagged pushes (`vX.Y.Z`, `vX.Y.Z-alpha-N`, `vX.Y.Z-beta-N`) on `main` or `dev`
trigger [`.github/workflows/build.yml`](.github/workflows/build.yml), which
runs the matching `package:*`/`package:*:beta` script per OS and uploads the
unsigned artifacts for Linux, macOS, and Windows as workflow artifacts. It
needs a `PACKAGES_TOKEN` repo secret (a PAT with `read:packages`) to install
`@aetherAssembly/ui` in CI.

## Stack

Electron + React 19 + Vite + TypeScript. UI components come from
[`@aetherAssembly/ui`](https://github.com/AetherAssembly/aether-packages)
rather than being built from scratch. Notes are encrypted markdown files
(scrypt → AES-256-GCM) per folder-based vault, with titles/folder placement
kept in a plaintext sidecar so the sidebar can render without decrypting
everything. Local search via an in-memory SQLite FTS5 index, rebuilt on
unlock. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
picture and [PLAN.md](PLAN.md) for what's done vs. next.

## Passphrase recovery

There is no password reset. Your passphrase is never stored anywhere,
including by Driftleaf's developers — if you forget it, the vault's note
*content* is not recoverable. Write it down somewhere safe when you create a
vault. See [docs/RECOVERY.md](docs/RECOVERY.md) for the full story, including
what to do if a vault won't open or a note won't decrypt.

## Backup your vault

A vault is just a folder on disk — copy it (including the hidden
`.driftleaf/` directory) to an external drive or another machine to back it
up. There's no separate export/import step.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Matches the license on
[`aether-packages`](https://github.com/AetherAssembly/aether-packages).
