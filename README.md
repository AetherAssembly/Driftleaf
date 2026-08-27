# Driftleaf

**So your thoughts don't drift.**

A private, simple notes app for your desktop. Your notes stay on your computer - encrypted, organized, and completely yours. No accounts, no cloud, no third-party tracking. Just you and your thoughts.

## Why Driftleaf?

- **Truly private** - All notes are encrypted on your disk. Driftleaf developers never see your data.
- **You own it** - No accounts to create, no cloud lock-in. Your vault is just a folder on your computer.
- **Fast & responsive** - Everything runs locally. No waiting for the cloud or dealing with sync conflicts.
- **Write anywhere** - Markdown support with a live preview so you can format as you write.
- **Keyboard first** - Power users can do everything with keyboard shortcuts. Tab through everything, search instantly, capture thoughts without reaching for the mouse.
- **Accessible** - Built for everyone, with screen reader support and clear keyboard navigation.

## Getting Started

### Download & Install

Get the latest release for your platform:

- **Linux**: [.AppImage, .deb, or .rpm](https://github.com/AetherAssembly/Driftleaf/releases)
- **macOS**: [.dmg or .zip](https://github.com/AetherAssembly/Driftleaf/releases)
- **Windows**: [Installer or portable .exe](https://github.com/AetherAssembly/Driftleaf/releases)

### First Time Using Driftleaf

1. **Create a vault** - This is where all your notes live. Set a strong passphrase you'll remember (there's no password reset).
2. **Create folders** - Organize your notes however you like.
3. **Start writing** - Create notes in markdown. Use the live preview to see formatting as you type.
4. **Search** - Use **Ctrl+K** to quickly find notes by title or content.

### Essential Keyboard Shortcuts

| Shortcut | What it does |
| -------- | ----------- |
| **Ctrl+K** (Cmd+K on Mac) | Open command palette and search |
| **Ctrl+Shift+N** (Cmd+Shift+N on Mac) | Capture a quick note (works even when minimized) |
| **Arrow Keys** | Navigate your notes and folders |
| **Tab** | Move between sections (sidebar, notes, editor) |
| **Escape** | Close search, close modals, back up |

### Accessibility

Driftleaf works great with screen readers and keyboard-only navigation:

- Navigate everything with Tab and arrow keys
- Clear focus indicators on every interactive element
- Full screen reader support
- Focus automatically moves to dialogs and returns when you close them

## Protecting Your Data

### Your Passphrase is Your Security

Driftleaf encrypts everything with your passphrase. There's no way to reset a forgotten passphrase - if you lose it, your notes are gone forever. **Write your passphrase down somewhere safe when you create a vault.**

For more details on security and recovery, see [docs/RECOVERY.md](docs/RECOVERY.md).

### Backing Up Your Vault

Your vault is just a folder on your computer. To back it up:

1. Locate your vault folder (Driftleaf shows you where it is)
2. Copy the entire folder (including the hidden `.driftleaf/` directory)
3. Store the copy on an external drive, another computer, or both

That's it. No export/import needed. When you need to restore, just copy the folder back.

---

## For Developers

### Building from Source

Want to help develop Driftleaf or build it yourself? See the [PLAN](PLAN.md) for the roadmap and current status.

**Setup:**

`@aetherAssembly/ui` is published to GitHub Packages, so you'll need a GitHub personal access token:

```sh
# ~/.npmrc (once, not per-project)
//npm.pkg.github.com/:_authToken=<your-token>
```

Then:

```sh
npm install
npm run dev        # launch the app in development mode
npm run build      # typecheck + build bundles (no packaging)
npm run lint       # run eslint
npm run typecheck  # run tsc --noEmit
```

**Debugging search performance:**

```sh
export DEBUG_SEARCH=1
npm run dev
```

Open DevTools (Ctrl+Shift+I or Cmd+Opt+I) and search for `[search]` in the console. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for details.

**Packaging for distribution:**

```sh
npm run package:appimage      # Linux: AppImage
npm run package:linux         # Linux: AppImage + deb + rpm
npm run package:linux:arm64   # Linux: arm64
npm run package:macos         # macOS: dmg + zip
npm run package:windows       # Windows: installer + portable
```

Each platform has a `:beta` variant for pre-release testing. See the build configs in [`electron-builder/`](electron-builder/).

### Technical Details

- **Stack**: Electron + React 19 + Vite + TypeScript
- **Storage**: Encrypted markdown files (scrypt + AES-256-GCM) per folder-based vault
- **Search**: SQLite FTS5 index, rebuilt on unlock
- **Safety**: Atomic writes + consistency checks on every unlock

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical architecture.

## License

AGPL-3.0-only - see [LICENSE](LICENSE). Matches the license on
[`aether-packages`](https://github.com/AetherAssembly/aether-packages).
