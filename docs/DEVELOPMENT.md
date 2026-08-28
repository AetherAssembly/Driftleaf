# Development Guide

Everything you need to build, test, and package Driftleaf locally.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Building Packages](#building-packages)
- [Platform-Specific Requirements](#platform-specific-requirements)
- [Cross-Architecture Builds](#cross-architecture-builds)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Base Requirements

| Tool | Version | Required For |
| ---- | ------- | ------------ |
| Node.js | v18+ (v20 recommended) | All builds |
| npm | v8+ | All builds |
| Ruby | v2.7+ | `.deb` / `.rpm` packaging |
| QEMU (optional) | Latest | ARM64 cross-compilation |

### Platform-Specific Build Tools

#### **Arch Linux**

```bash
sudo pacman -S --needed ruby gcc make fakeroot dpkg rpm-tools qemu-full virt-manager
```

> **Note:** On Arch, you need both `dpkg` and `rpm-tools` to generate `.deb` and `.rpm` artifacts respectively, even though you're on an RPM-native system.
> If you use CachyOS, follow [their wiki](https://wiki.cachyos.org/virtualization/qemu_and_vmm_setup/) on QEMU installation/setup.

#### **Debian/Ubuntu**

```bash
sudo apt-get install ruby build-essential dpkg-dev rpm qemu-system-arm
```

#### **Fedora/RHEL/CentOS**

```bash
sudo dnf install ruby gcc rpm-build dpkg qemu-system-ARM
```

#### **openSUSE**

```bash
sudo zypper install ruby patterns-devel-base-devel_basis rpm-build dpkg qemu-system-arm
```

---

## Local Development

### Initial Setup

```sh
# GitHub Packages auth (one-time setup)
echo "//npm.pkg.github.com/:_authToken=<your-token>" >> ~/.npmrc

# Install dependencies
npm install

# Launch in development mode
npm run dev
```

### Common Commands

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Launch app in development mode with hot reload |
| `npm run build` | Typecheck + build production bundles (no packaging) |
| `npm run lint` | Run ESLint checks |
| `npm run typecheck` | Run TypeScript compiler without emitting |
| `npm test` | Run test suite |

### Debugging Search Performance

```sh
export DEBUG_SEARCH=1
npm run dev
```

Open DevTools (**Ctrl+Shift+I**) and search for `[search]` in the console output. See [PERFORMANCE.md](PERFORMANCE.md) for optimization details.

---

## Building Packages

### Standard Builds

```sh
# All Linux formats (x86_64 only)
npm run package:linux

# Single format
npm run package:appimage           # Portable AppImage
npm run package:linux              # AppImage + deb + rpm
npm run package:macos              # DMG + ZIP
npm run package:windows            # Installer + portable .exe

# Beta variants
npm run package:linux:beta         # Beta builds for Linux
npm run package:linux:arm64:beta   # Beta ARM64 builds
```

### Output Locations

Artifacts are generated placed in `dist/`:

```bash
release/
├── Driftleaf-0.2.1.AppImage
├── driftleaf_0.2.1_amd64.deb
├── driftleaf-0.2.1-1.x86_64.rpm
└── Driftleaf Setup 0.2.1.exe
```

---

## Platform-Specific Requirements

### Runtime Dependencies (Declared in Package Metadata)

These are automatically added to your package's dependency list but good to know for testing:

| Component | Debian/Ubuntu | Fedora/RPM | Arch |
| --------- | ------------- | ---------- | ---- |
| GTK3 | `libgtk-3-0` | `gtk3` | `gtk3` |
| Notifications | `libnotify4` | `libnotify` | `libnotify` |
| NSS | `libnss3` | `nss` | `nss` |
| Screen Saver | `libxss1` | `libXScrnSaver` | `libxss` |
| X11 Tests | `libxtst6` | `libxtst` | `libxtst` |
| Accessibility | `libatspi2.0-0` | `at-spi2-core` | `at-spi2-core` |
| Secret Storage | `libsecret-1-0` | `libsecret` | `libsecret` |
| App Indicators | `libappindicator3-1` | `libappindicator-gtk3` | `libappindicator-gtk3` |

> **AppImage Exception:** Most dependencies are bundled inside the AppImage. However, FUSE3 may be required at runtime on some distributions (`sudo apt install libfuse2` for legacy support).

---

## Cross-Architecture Builds

### ARM64 Builds from x86_64

Building ARM64 packages without native hardware requires QEMU emulation:

```sh
# Enable QEMU binfmt support (one-time per host)
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

# Build ARM64 packages
npm run package:linux:arm64
```

### Important Notes

| Architecture | Native Support | QEMU Required |
| ------------ | ------------- | ------------- |
| x86_64 | ✅ Yes | ❌ No |
| ARM64 | ✅ On Apple Silicon / ARM servers | ⚠️ From x86_64 |
| ARMv7 | ❌ Rare | ✅ Always via QEMU |

### Alternative: OBS/Copr Hosting

For ongoing ARM64 builds without local hardware, we use remote build systems:

- [**OBS (openSUSE Build Service):**](https://build.opensuse.org/package/show/home:aster1630/Driftleaf)
- [**Copr (Fedora):**](https://copr.fedorainfracloud.org/coprs/aster1630/Driftleaf/)

These handle multi-architecture builds automatically. See [PACKAGING.md](PACKAGING.md) for spec file details.

---

## Troubleshooting

### Common Issues

#### **"Command 'dpkg' not found" (on non-Debian systems)**

```bash
# Arch/Fedora/openSUSE
sudo <package-manager> install dpkg
```

#### **"Command 'fpm' not found"**

Don't worry—electron-builder bundles its own `fpm`. Make sure Ruby is installed on your host system.

#### **"Permission denied" on AppImage**

```bash
chmod +x dist/Driftleaf-*.AppImage
./release/Driftleaf-*.AppImage
```

#### **QEMU errors during ARM64 build**

Make sure binfmt support is active:

```bash
# Check if QEMU is registered
cat /proc/sys/fs/binfmt_misc/qemu-aarch64

# Re-register if missing
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
```

#### **Deb/RPM build fails on directory ownership**

If you see "directories not owned by package" errors, check your `%files` section includes `%dir` declarations for parent directories. See the OBS build logs for details.

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

- [Electron Builder Docs](https://www.electron.build/)
- [Electron Docs](https://www.electronjs.org/docs)
- [React Docs](https://react.dev/)
- [Vite Docs](https://vitejs.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
