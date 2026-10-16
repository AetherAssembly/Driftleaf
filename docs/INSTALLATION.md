# Installing Driftleaf

Driftleaf releases are published on the [GitHub Releases page](https://github.com/AetherAssembly/Driftleaf/releases).
Stable releases are recommended for everyday use. Beta releases are available from the
same page for testing.

## Linux

### Debian, Ubuntu, and Raspberry Pi OS

#### Stable APT repository (recommended)

The signing-key fingerprint must be `32B72F22E77E21F510B31849A7B44812A39EEB9C`. Both applications use this key. The repository supports **amd64** and **arm64**, including 64-bit Raspberry Pi OS; 32-bit armhf is not supported.

Only stable releases are published to APT. New stable releases may take up to 12 hours to appear. Beta releases are available directly from GitHub; there is no beta APT channel.

```sh
sudo apt update
sudo apt install ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.aetherassembly.org/before-its-gone/apt-repo-public.asc -o /tmp/aetherassembly-apt-public.asc
gpg --show-keys --with-fingerprint /tmp/aetherassembly-apt-public.asc

# Confirm the fingerprint below before continuing.
sudo install -m 0644 /tmp/aetherassembly-apt-public.asc /etc/apt/keyrings/aetherassembly.asc
echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/aetherassembly.asc] https://apt.aetherassembly.org/driftleaf stable main" \
  | sudo tee /etc/apt/sources.list.d/driftleaf.list >/dev/null
rm /tmp/aetherassembly-apt-public.asc
sudo apt update
sudo apt install driftleaf
```

To update later:

```sh
sudo apt update
sudo apt install --only-upgrade driftleaf
```

If you previously configured the old AetherAssembly repository, remove its obsolete source entry (including any beta entry) before adding the new one. Do not remove other applications' source entries.

#### Manual Debian package

Download the matching stable `.deb` from GitHub Releases, then install it with:

```sh
sudo apt install ./driftleaf-<version>-amd64.deb
# For ARM64, use the asset ending in arm64.deb instead.
```

### Fedora, RHEL, CentOS Stream, Rocky Linux, and AlmaLinux

Enable the Driftleaf COPR repository:

```sh

sudo dnf copr enable aster1630/driftleaf

# then install
sudo dnf install driftleaf

```

You can alternatively download the matching `.rpm` from the release page and install it:

```sh
sudo dnf install ./driftleaf-<version>-x86_64.rpm
```

For ARM64 systems, use the asset ending in `aarch64.rpm`.

### openSUSE

With the Driftleaf OBS repository configured:

```sh

sudo zypper addrepo https://download.opensuse.org/repositories/home:aster1630/openSUSE_Tumbleweed/home:aster1630.repo

sudo zypper refresh

sudo zypper install driftleaf

```

### AppImage

Download the AppImage for your architecture from the release page. For x64, use the
asset ending in `x86_64.AppImage`; for ARM64, use `arm64.AppImage`.

Make it executable and launch it:

```sh
chmod +x driftleaf-<version>-x86_64.AppImage
./driftleaf-<version>-x86_64.AppImage
```

The AppImage is also available for Arch Linux.

### Verify a download

Release notes include a SHA256 checksum for each uploaded artifact. Verify a downloaded
file from its containing directory with:

```sh
sha256sum driftleaf-<version>-x86_64.AppImage
```

Compare the result with the checksum shown in the release notes.

## macOS

Download the DMG from the release page, open it, and drag Driftleaf to Applications.
The published macOS download is a DMG. The app is unsigned and not notarized,
so macOS may block it from opening. In that case, removing its quarantine flag
allows it to open:

```sh
xattr -d com.apple.quarantine "/Applications/Driftleaf.app"
```

## Windows

The release provides two Windows options:

- **Installer:** download the `setup.exe` asset and run it.
- **Portable:** download the `portable.exe` asset and run it from any folder.

Windows SmartScreen may warn because the application is not code-signed. If you trust the
download, select **More info**, then **Run anyway**.

## Beta releases

Beta releases are marked as prereleases on GitHub and use separate beta package
names on Linux. They contain in-progress changes and are intended for
evaluation before a stable release. Stable releases remain available at the
[latest release](https://github.com/AetherAssembly/Driftleaf/releases/latest).
