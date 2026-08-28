# Installing Driftleaf

Driftleaf releases are published on the [GitHub Releases page](https://github.com/AetherAssembly/Driftleaf/releases).
Stable releases are recommended for everyday use. Beta releases are available from the
same page for testing.

## Linux

### Debian, Ubuntu, and Raspberry Pi OS

#### Add the Driftleaf apt repository

Import the signing key and add the repository:

```sh
curl -fsSL https://apt.aetherassembly.org/driftleaf/driftleaf.gpg.pub | \
	sudo gpg --dearmor -o /usr/share/keyrings/driftleaf.gpg

echo "deb [signed-by=/usr/share/keyrings/driftleaf.gpg] https://apt.aetherassembly.org/driftleaf stable main" | \
	sudo tee /etc/apt/sources.list.d/driftleaf.list
```

Update the package index and confirm that apt can see Driftleaf:

```sh
sudo apt update
apt-cache policy driftleaf
```

Install Driftleaf:

```sh
sudo apt install driftleaf
```

To update an existing installation later:

```sh
sudo apt update
sudo apt upgrade driftleaf
```

The release workflow currently documents the update command, but does not publish the
repository URL or signing-key setup. Use the repository setup instructions provided with
the apt repository before running these commands.

You can also download the matching `.deb` from the GitHub release and install it with:

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

sudo zypper refresh && sudo zypper install driftleaf

```

### AppImage

Download the AppImage for your architecture from the release page. For x64, use the
asset ending in `x86_64.AppImage`; for ARM64, use `arm64.AppImage`.

Make it executable and launch it:

```sh
chmod +x driftleaf-<version>-x86_64.AppImage
./driftleaf-<version>-x86_64.AppImage
```

The release workflow also mentions Arch Linux. No Arch package is published by the
workflow, so use the matching AppImage there.

### Verify a download

Release notes include a SHA256 checksum for each uploaded artifact. Verify a downloaded
file from its containing directory with:

```sh
sha256sum driftleaf-<version>-x86_64.AppImage
```

Compare the result with the checksum shown in the release notes.

## macOS

Download the DMG from the release page, open it, and drag Driftleaf to Applications.
The macOS packaging command also creates a ZIP artifact, but the current release workflow
uploads the DMG to GitHub Releases.

The app is not notarized. If macOS reports that the app is damaged or refuses to open
it after installation, remove the quarantine flag:

```sh
xattr -d com.apple.quarantine "/Applications/Driftleaf.app"
```

Then open Driftleaf from Applications.

## Windows

The release provides two Windows options:

- **Installer:** download the `setup.exe` asset and run it.
- **Portable:** download the `portable.exe` asset and run it from any folder.

Windows SmartScreen may warn because the application is not code-signed. If you trust the
download, select **More info**, then **Run anyway**.

## Beta releases

Beta releases are marked as prereleases on GitHub and use separate beta package names on
Linux. Install them only when testing a release candidate or reporting a bug. Stable
releases remain available at the [latest release](https://github.com/AetherAssembly/Driftleaf/releases/latest).

Eventually there will be a Driftleaf Beta COPR/OBS/APT Repo, just as there is for Before It's Gone
