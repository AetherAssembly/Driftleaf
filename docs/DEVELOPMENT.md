# Development Guide

Everything you need to build, test, and package Driftleaf locally.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Building Packages](#building-packages)
- [Platform-Specific Requirements](#platform-specific-requirements)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Base Requirements

| Tool | Version | Required For |
| ---- | ------- | ------------ |
| Node.js | v18+ (v20 recommended) | The bundled sidecar backend and all build scripts |
| npm | v8+ | All builds |
| Rust toolchain (`cargo`, `rustc`) | stable | Building/running the Tauri shell |
| WebKitGTK + GTK3 dev packages (Linux) | — | `webkit2gtk-4.1`, `javascriptcoregtk-4.1`, `gtk+-3.0` and their `-devel`/`-dev` packages, by whatever name your distro uses |

### Important Notice

> Installing build tools, package manager dependencies, or third-party packages can modify your system, add services, change package versions, and in some cases break software already installed on your machine. Only install packages you understand and trust, and use the commands in this guide at your own risk.
>
> AetherAssembly and its contributors are not responsible for any system breakage, dependency conflicts, data loss, or other issues caused by following these instructions or installing packages from external sources.

### Platform-Specific Build Tools

#### **Arch Linux**

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg rust
```

#### **Debian/Ubuntu**

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential
```

#### **Fedora/RHEL/CentOS**

```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel rpm-build
```

#### **openSUSE**

```bash
sudo zypper install webkit2gtk3-devel gtk3-devel libappindicator3-devel librsvg-devel
```

Install Rust itself from [rustup.rs](https://rustup.rs/) on any platform, including Windows and macOS.

> **AppImage Exception:** Most Linux dependencies are bundled inside the AppImage. However, FUSE3 may be required at runtime on some distributions (`sudo apt install libfuse2` for legacy support).

---

## Local Development

### Initial Setup for Linux

```sh
# GitHub Packages auth (one-time setup)
echo "//npm.pkg.github.com/:_authToken=<your-token>" >> ~/.npmrc

# Install dependencies
npm install

# Launch the Tauri shell in dev mode
npx tauri dev
```

### Initial Setup for Windows

### 1. Open your User Folder

1. Press **`Windows Key + R`** to open the Run dialog.
2. Type `%userprofile%` and press **Enter**.
   *(This opens your user folder, like `C:\Users\YourName`)*.

### 2. Create the `.npmrc` file

1. Inside that folder, right-click and select **New > Text Document**.
2. Name the file exactly: **`.npmrc`**
3. **Important:** Windows might add `.txt` to the end. You need to make sure the final name is `.npmrc`, not `.npmrc.txt`.
   * If you can't see file extensions: In File Explorer, click **View** at the top, and check the box for **File name extensions**. Then rename the file to remove the `.txt`.
   * Alternatively, when saving, select "All Files" as the file type and name it `.npmrc`.

   <details>
   <summary>Show example</summary>

   ![Windows .npmrc example](./screenshots/npmrc-example.png)

   </details>

### 3. Add the content

1. Right-click the newly created `.npmrc` file and choose **Open with > Notepad**.
2. Paste the following line inside:

   ```text
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN
   ```

3. Replace `YOUR_TOKEN` with your actual GitHub Personal Access Token (PAT).
   *(Make sure the token has the `read:packages` scope enabled, as the image notes).*
4. **Save** the file and close Notepad.

> In-Depth `aether-packages` installation notes are available in the [repo](https://github.com/AetherAssembly/aether-packages) and on the [wiki](https://wiki.aetherassembly.org/aether-packages/).

### 4. Verify and use

1. Open a new **PowerShell** or **CMD** window.
2. Run `npm install` again. It should now use the token in that file to authenticate with GitHub Packages.

**⚠️ Note: Never commit this `.npmrc` file to a public Git repository, as it contains your secret token!**

### Common Commands

| Command | Description |
| ------- | ----------- |
| `npx tauri dev` | Launch the full app (Rust shell + sidecar backend) in development mode |
| `npm run dev` | Launch just the renderer's dev server (for quick UI iteration; no backend) |
| `npm run build` | Typecheck + build the renderer bundle (no packaging) |
| `npm run lint` | Run ESLint checks |
| `npm run typecheck` | Run TypeScript compiler without emitting |
| `npm test` | Run the sidecar/storage/service regression suite |
| `npm run test:rust-compat` | Run `crates/driftleaf-core`'s Node↔Rust compatibility suite |
| `node scripts/tests/data-loss.js` | Run vault, database, and recovery integration tests |

### Debugging Search Performance

```sh
export DEBUG_SEARCH=1
npx tauri dev
```

Open the WebView's devtools (right-click → Inspect, where supported) and search for
`[search]` in the console output.

---

## Building Packages

```sh
npm run package:tauri                        # this platform's native targets (deb+rpm on Linux)
npm run package:tauri -- --bundles appimage   # Linux: AppImage only
npm run package:tauri -- --bundles dmg        # macOS: dmg
npm run package:tauri -- --bundles nsis       # Windows: installer
```

Artifacts land under `src-tauri/target/release/bundle/<format>/`. The app's identity for
these release builds comes from `src-tauri/tauri.release.conf.json` (merged over the base
`src-tauri/tauri.conf.json`); `npm run stage:tauri` (run automatically as part of the
release build) downloads a checksum-pinned Node runtime and copies in the sidecar backend
rather than using your own Node installation at runtime.

Signed auto-updates are off by default for this release — see
[docs/UPDATES.md](UPDATES.md) for current status.

### Versioning during development

```sh
node scripts/tauri/version.mjs 0.7.1
```

Syncs `package.json`/`package-lock.json`/`src-tauri/tauri.conf.json`/`Cargo.toml`/
`Cargo.lock`/the RPM spec to one version number, without invoking `npm version` or
creating a commit or tag — useful for rolling development checkpoints between releases.
Add the checkpoint's changes to `[Unreleased]` in `CHANGELOG.md` and the RPM spec's own
changelog. The tag-triggered `release.yml` workflow uses the same script (with
`--allow-same`) to set the real release version before packaging.

On Linux, if a built app's window opens but stays blank (GBM/DMA-BUF buffer allocation
failures in the terminal output — a known WebKitGTK compositing gap with some GPU drivers,
most documented with NVIDIA's proprietary driver), set these before launching:

```sh
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 npx tauri dev
```

These variables allowed native Wayland rendering on a tested CachyOS/NVIDIA system without
forcing X11. They are a workaround to test on affected hardware, not a default for every
Linux system.

---

## Platform-Specific Requirements

### Runtime Dependencies (Declared in Package Metadata)

These are automatically added to your package's dependency list but good to know for testing:

| Component | Debian/Ubuntu | Fedora/RPM | Arch |
| --------- | ------------- | ---------- | ---- |
| WebKitGTK | `libwebkit2gtk-4.1-0` | `webkit2gtk4.1` | `webkit2gtk-4.1` |
| GTK3 | `libgtk-3-0` | `gtk3` | `gtk3` |
| App Indicators | `libappindicator3-1` | `libappindicator-gtk3` | `libappindicator-gtk3` |

> **AppImage Exception:** Most dependencies are bundled inside the AppImage. However, FUSE3 may be required at runtime on some distributions (`sudo apt install libfuse2` for legacy support).

---

## Troubleshooting

### Common Issues

#### **"Permission denied" on AppImage**

```bash
chmod +x "Driftleaf_*.AppImage"
"./Driftleaf_<version>_amd64.AppImage"
```

#### **Window opens but stays blank on Linux**

See the WebKitGTK compositing workaround above.

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -am 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

See [CONTRIBUTING.md](../CONTRIBUTING.md) for full guidelines.

---

## Resources

- [Tauri Docs](https://v2.tauri.app/)
- [React Docs](https://react.dev/)
- [Vite Docs](https://vitejs.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
