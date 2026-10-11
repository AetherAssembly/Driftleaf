# Installing Driftleaf

Driftleaf releases are published on the [GitHub Releases page](https://github.com/AetherAssembly/Driftleaf/releases).
Stable releases are recommended for everyday use. Beta releases are available from the
same page for testing.

## Linux

### Debian, Ubuntu, and Raspberry Pi OS

#### Debian package

The Driftleaf APT repository is currently unavailable. Debian, Ubuntu, and
Raspberry Pi OS users can install the `.deb` package from the
[GitHub Releases page](https://github.com/AetherAssembly/Driftleaf/releases):

```sh
sudo apt install ./driftleaf-<version>-amd64.deb
```

For ARM64 systems, use the release asset ending in `arm64.deb`.

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
