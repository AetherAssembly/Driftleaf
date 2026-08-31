# Contributing to Driftleaf

Thank you for your interest in contributing! Driftleaf is an open-source project focused on local-first, encrypted note-taking.

## Code of Conduct

Please read our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing. We expect all contributors to uphold these standards.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Git
- (For releases) A GitHub Personal Access Token with `read:packages` scope to install `@aetherAssembly/ui` from GitHub Packages

### Local Setup

```bash
# Clone the repo
git clone https://github.com/AetherAssembly/Driftleaf.git
cd Driftleaf

# Set up GitHub Packages auth (one time)
echo "//npm.pkg.github.com/:_authToken=<your-token>" >> ~/.npmrc

# Install dependencies
npm install

# Start dev mode
npm run dev
```

### Development Commands

```bash
npm run dev          # Launch Electron app in dev mode
npm run build        # Typecheck + build bundles (no packaging)
npm run typecheck    # Run tsc --noEmit
npm run lint         # Run eslint
npm run package:*    # Package for a specific platform (see package.json)
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

1. **Vault encryption, decryption, or storage** (`src/main/vault.ts`, `src/main/crypto.ts`)
   - Run `scripts/tests/data-loss.js` before submitting
   - Include test coverage for any new file operations
   - Explain crash-safety guarantees in your PR

2. **Search index** (`src/main/search.ts`)
   - Ensure index stays in sync with vault state
   - Test with large vaults (use `scripts/generateTestVault.ts`)

3. **IPC handlers** (`src/main/ipc.ts`)
   - Error handling is critical
   - Friendly error messages for user-facing failures

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
   scripts/tests/data-loss.js  # if vault-related
   ```

4. **Open a PR** using the PR template (it appears automatically)
5. **Wait for review** - we'll provide feedback or suggestions

### PR Review Focus

- **Data safety** - Does this risk losing user data?
- **Crash safety** - Will a crash leave the vault in an inconsistent state?
- **Performance** - Does this slow down critical paths?
- **UX** - Is the user experience clear?
- **Code clarity** - Is the intent obvious?

## Code Style

Driftleaf uses:

- **TypeScript** for type safety
- **ESLint** for linting (run `npm run lint`)
- **Prettier** for formatting (via ESLint)
- **React hooks** over class components

Key patterns:

- Error handling is explicit (no silent failures)
- Filesystem operations are atomic or recoverable
- Crypto operations are logged only on DEBUG_SEARCH=1
- IPC handlers translate raw fs errors to friendly messages

## Project Documentation

If your change affects users, update:

- [README.md](../README.md) - If it's user-facing
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - If it changes internals
- JSDoc comments on exported functions

## Licensing

By contributing, you agree that your code will be licensed under [AGPL-3.0-only](../LICENSE). Matches the license on [`aether-packages`](https://github.com/AetherAssembly/aether-packages).

## Questions?

- Check [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how things work
- Check open issues and discussions for what's coming
- Open a discussion or ask in an issue

Thank you for contributing to Driftleaf! 🍃
