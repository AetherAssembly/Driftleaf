# Contributing to Driftleaf

Thank you for your interest in contributing! Driftleaf is an open-source project focused on local-first, encrypted note-taking.

## Code of Conduct

Please read our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing. We expect all contributors to uphold these standards.

## Getting Started

### Prerequisites

- Node.js 22 (matches CI)
- npm
- Rust (stable toolchain) and platform build dependencies for Tauri — see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
- Git
- (For `npm install`) A GitHub Personal Access Token with `read:packages` scope to install `@aetherAssembly/ui` from GitHub Packages

### Local Setup

```bash
# Clone the repo
git clone https://github.com/AetherAssembly/Driftleaf.git
cd Driftleaf

# Set up GitHub Packages auth (one time)
echo "//npm.pkg.github.com/:_authToken=<your-token>" >> ~/.npmrc

# Install dependencies
npm install

# Start dev mode (full Tauri app; requires the Rust toolchain)
npm run tauri:dev
```

### Development Commands

```bash
npm run dev          # Vite dev server only, renderer in a regular browser tab
npm run tauri:dev    # Launch the full Tauri app (native shell + renderer) in dev mode
npm run build        # Typecheck + build the renderer bundle (no native packaging)
npm run typecheck    # Run tsc --noEmit
npm run lint         # Run eslint
npm run package:tauri -- --bundles <deb,rpm,appimage,dmg,nsis>  # Package for a platform
```

## What Can You Contribute?

### Bugs

- Data loss bugs (highest priority) - see [docs/DATA_LOSS_TESTING.md](../docs/DATA_LOSS_TESTING.md)
- Crashes or hangs
- Incorrect behavior
- UX issues

### Features

- Check open issues and discussions for planned work
- Always open an issue first to discuss ideas

### Documentation

- README improvements
- Architecture docs
- JSDoc comments
- Test coverage

### Performance

- Vault unlock/index build speed
- Search latency
- Memory usage

## Making Changes

### Branch Naming

- `fix/short-description` - Bug fixes
- `feat/short-description` - New features
- `docs/short-description` - Documentation
- `perf/short-description` - Performance improvements
- `test/short-description` - Tests

### Commit Messages

Follow conventional commits where possible:

```bash
fix: Correct XYZ behavior
feat: Add support for XYZ
docs: Update README for XYZ
test: Add tests for XYZ
refactor: Simplify XYZ
```

### Critical Areas

These changes require extra care:

1. **Branch encryption, decryption, or storage** (`src/main/vault.ts`, `src/main/crypto.ts`,
   and the Rust storage-engine port in `crates/driftleaf-core/src/`)
   - Run `scripts/tests/data-loss.js` before submitting
   - Include test coverage for any new file operations
   - Explain crash-safety guarantees in your PR; writes must be atomic *and* fsynced, not
     just atomic — see `writeFileAtomic` in `src/main/vault.ts`

2. **Search index** (`src/main/search.ts`, `crates/driftleaf-core/src/search.rs`)
   - Ensure the index stays in sync with branch state
   - Test with large branches (use `scripts/generateTestVault.ts`)

3. **Command contract between the renderer, the Tauri shell, and the sidecar**
   (`src/shared/ipc.ts`, `src/tauri-bridge/`, `src-tauri/src/main.rs`, `sidecar/`)
   - Error handling is critical
   - Friendly error messages for user-facing failures

4. **Extensions and external boundaries** (`src/main/extension-access.ts`,
   `src-tauri/src/extensions.rs`)
   - Keep extension command access read-only and permission-checked
   - Do not expose the regular renderer API to extension windows
   - Test grant revocation and database allowlists

5. **Updates and packaging** (`src-tauri/src/updates.rs`, `src-tauri/tauri*.conf.json`,
   `build/`, `.github/workflows/release.yml`, `.github/workflows/tauri-release.yml`)
   - Preserve updater manifest generation (see `docs/TAURI_UPDATES.md`)
   - Do not enable automatic updates for a platform until signing is configured for it
   - Linux and unsigned macOS stay manual-download-only; see `docs/UPDATES.md`

### Testing

- New features should include tests
- Data loss fixes must pass `scripts/tests/data-loss.js`
- Integration tests are in `scripts/tests/`
- For vault changes, use `scripts/generateTestVault.ts` to create a test vault

## Submitting a Pull Request

1. **Fork and branch** off the appropriate base (usually `dev` for features, `main` for hotfixes)
2. **Make your changes** following the code style
3. **Run tests** locally:

   ```bash
   npm run typecheck
   npm run lint
   npm run build
   npm test                                   # data-loss, service/lock regressions, sidecar
   cargo test --manifest-path src-tauri/Cargo.toml --offline          # Tauri shell
   cargo test --manifest-path crates/driftleaf-core/Cargo.toml --offline  # storage-engine port
   npm run package:tauri -- --bundles nsis    # when changing Windows packaging/update behavior
   ```

4. **Open a PR** using the PR template (it appears automatically)
5. **Wait for review** - we'll provide feedback or suggestions

### PR Review Focus

- **Data safety** - Does this risk losing user data?
- **Crash safety** - Will a crash leave the vault in an inconsistent state?
- **Performance** - Does this slow down critical paths?
- **UX** - Is the user experience clear?
- **Code clarity** - Is the intent obvious?
- **Privacy and permission boundaries** - Does this send metadata externally or broaden an extension grant?

## Code Style

Driftleaf uses:

- **TypeScript** for type safety
- **ESLint** for linting (run `npm run lint`)
- **Prettier** for formatting (via ESLint)
- **React hooks** over class components

Key patterns:

- Error handling is explicit (no silent failures)
- Filesystem operations are atomic, fsynced, and recoverable
- Crypto operations are logged only on DEBUG_SEARCH=1
- IPC handlers translate raw fs errors to friendly messages

## Project Documentation

If your change affects users, update:

- [README.md](../README.md) - If it's user-facing
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - If it changes internals
- [docs/UPDATES.md](../docs/UPDATES.md) - If it changes update checks, artifacts, or signing
- [docs/EXTENSIONS.md](../docs/EXTENSIONS.md) - If it changes the extension API or grants
- JSDoc comments on exported functions

## Licensing

By contributing, you agree that your code will be licensed under [AGPL-3.0-only](../LICENSE). Matches the license on [`aether-packages`](https://github.com/AetherAssembly/aether-packages).

## Questions?

- Check [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how things work
- Check open issues and discussions for what's coming
- Open a discussion or ask in an issue

Thank you for contributing to Driftleaf! 🍃
