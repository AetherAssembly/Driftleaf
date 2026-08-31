%global debug_package %{nil}

Name:           driftleaf
Version:        0.3.0
Release:        1%{?dist}
Summary:        A local-first, encrypted-by-default notes app
License:        AGPL-3.0-or-later
URL:            https://github.com/AetherAssembly/Driftleaf

ExclusiveArch:  x86_64 aarch64
BuildRequires:  cpio
BuildRequires:  rpm
Requires:       hicolor-icon-theme

Source0:        https://github.com/AetherAssembly/Driftleaf/releases/download/v%{version}/driftleaf-%{version}-x86_64.rpm
Source1:        https://github.com/AetherAssembly/Driftleaf/releases/download/v%{version}/driftleaf-%{version}-aarch64.rpm

%description
Driftleaf is a private desktop notes application. Notes remain on the local
computer in an encrypted vault, with Markdown support and fast local search.

%prep
%setup -c -T
mkdir extracted
cd extracted
%ifarch x86_64
rpm2cpio %{SOURCE0} | cpio -idm --quiet
%else
rpm2cpio %{SOURCE1} | cpio -idm --quiet
%endif

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt/Driftleaf
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/1024x1024/apps

cp -a extracted/opt/Driftleaf/. %{buildroot}/opt/Driftleaf/
cp -a extracted/usr/share/applications/driftleaf.desktop \
    %{buildroot}%{_datadir}/applications/
cp -a extracted/usr/share/icons/hicolor/1024x1024/apps/driftleaf.png \
    %{buildroot}%{_datadir}/icons/hicolor/1024x1024/apps/
ln -s /opt/Driftleaf/driftleaf %{buildroot}%{_bindir}/driftleaf

%files
%license extracted/opt/Driftleaf/LICENSE.electron.txt
%doc extracted/opt/Driftleaf/LICENSES.chromium.html
/opt/Driftleaf/
%{_bindir}/driftleaf
%{_datadir}/applications/driftleaf.desktop
%dir %{_datadir}/icons/hicolor
%dir %{_datadir}/icons/hicolor/1024x1024
%dir %{_datadir}/icons/hicolor/1024x1024/apps
%{_datadir}/icons/hicolor/1024x1024/apps/driftleaf.png

%changelog
* Sat Aug 29 2026 AetherAssembly <support@aetherassembly.org> - 0.3.0-1
- Security and data-integrity fixes from a project-wide audit: path-traversal
  guards were missing on several vault operations (folder delete, note
  create/move, folder rename), a folder named `.driftleaf` could permanently
  and silently drop notes filed under it, case-insensitive filename
  collisions could overwrite an existing note's content, and the vault
  encryption key was not zeroed from memory on lock.
- Data-loss fixes: concurrent vault operations are now serialized to prevent
  manifest corruption, several operations that mutated in-memory state before
  the matching disk operation now do the reverse with rollback on failure,
  and the editor's autosave no longer silently drops an edit when switching
  notes, renaming, or locking the vault in quick succession.
- Search no longer breaks for the whole vault when a single note fails to
  decrypt.
- UI styling: bumped the `@aetherAssembly/ui` dependency, which previously
  shipped design tokens only and no actual component styling — buttons,
  cards, modals, inputs, and badges were rendering unstyled.
- Packaging: excluded `better-sqlite3`'s build-only source files (the SQLite
  amalgamation and C++ addon source) from the bundled application, which had
  been tripping rpmlint's badness threshold and aborting every openSUSE OBS
  build while passing on Fedora's more permissive profile.
  
* Fri Aug 28 2026 AetherAssembly <support@aetherassembly.org> - 0.2.1-1
- Native SQLite packaging: Electron Builder now unpacks the
  `better-sqlite3` native module for stable and beta builds on Linux, macOS, and Windows.
- Search database loading: the main-process search index now loads
  `better-sqlite3` through Node's `createRequire`, while Vite externalizes all
  `better-sqlite3` subpaths for reliable Electron native-module resolution.
- Release channels: stable Linux, macOS, and Windows configurations now
  explicitly publish on the stable channel.
- Package metadata: Debian and RPM configurations now include the Driftleaf
  synopsis and description, and macOS DMG builds include the project EULA.
- Beta packaging: beta Linux, macOS, and Windows configurations now unpack
  the native SQLite module and include the relevant package metadata.