# Driftleaf

So your thoughts don't drift.

A local-first, encrypted-by-default notes app. Notes are markdown, organized
in folders, stored encrypted at rest on your own disk — no third-party
account, no cloud-by-default. Sync (later) will be opt-in and run over your
own network or your own server.

**Status:** core loop works. You can create or unlock a vault, browse/create
folders and notes, write markdown with a live preview, and full-text search
across the vault — all local, all encrypted at rest. Not yet done: moving
notes between folders, packaged/signed release builds, and the rest of the
[roadmap](PLAN.md).

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
npm run build      # typecheck, build, and package with electron-builder
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Stack

Electron + React 19 + Vite + TypeScript. UI components come from
[`@aetherAssembly/ui`](https://github.com/AetherAssembly/aether-packages)
rather than being built from scratch. Notes are encrypted markdown files
(scrypt → AES-256-GCM) per folder-based vault, with titles/folder placement
kept in a plaintext sidecar so the sidebar can render without decrypting
everything. Local search via an in-memory SQLite FTS5 index, rebuilt on
unlock. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
picture and [PLAN.md](PLAN.md) for what's done vs. next.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Matches the license on
[`aether-packages`](https://github.com/AetherAssembly/aether-packages).
