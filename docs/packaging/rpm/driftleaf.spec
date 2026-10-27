# This spec repackages prebuilt release binaries without their build sources.
# Automatic debuginfo/debugsource generation would produce an empty source list.
%global debug_package %{nil}

Name:           driftleaf
Version:        0.7.2
Release:        1%{?dist}
Summary:        A local-first encrypted notes, graph, and database app
License:        AGPL-3.0-or-later
URL:            https://github.com/AetherAssembly/Driftleaf

ExclusiveArch:  x86_64 aarch64
BuildRequires:  cpio
BuildRequires:  rpm
Requires:       hicolor-icon-theme

# Driftleaf's own release RPM (built by `tauri build`, not this spec) installs its Node
# sidecar backend under the fixed path /usr/lib/Driftleaf/ — not the %%{_libdir} macro,
# since Tauri's Linux resource-path resolution expects that literal location regardless of
# whether a distro's convention for 64-bit libraries is /usr/lib or /usr/lib64. This spec
# repackages that same tree unchanged for OBS/Copr's distro-native expectations.
Source0:        https://github.com/AetherAssembly/Driftleaf/releases/download/v%{version}/Driftleaf-%{version}-1.x86_64.rpm
Source1:        https://github.com/AetherAssembly/Driftleaf/releases/download/v%{version}/Driftleaf-%{version}-1.aarch64.rpm
Source2:        https://raw.githubusercontent.com/AetherAssembly/Driftleaf/v%{version}/LICENSE

%description
Driftleaf is a local-first desktop workspace for encrypted Markdown notes,
linked-note graphs, a spatial canvas, JavaScript extensions, and editable
databases. Vault metadata, notes, database contents, canvas layouts, and
extension permissions are encrypted at rest. Database table, board, and
calendar views support formulas, while CSV and JSON import/export help move
data between tools. Driftleaf works offline; update and community catalogs
use optional public GitHub release requests.

%prep
%setup -c -T
mkdir extracted
cd extracted
%ifarch x86_64
rpm2cpio %{SOURCE0} | cpio -idm --quiet
%else
rpm2cpio %{SOURCE1} | cpio -idm --quiet
%endif
cp %{SOURCE2} %{_builddir}/LICENSE

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}/usr/lib/Driftleaf
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/32x32/apps
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/128x128/apps
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/256x256@2/apps
mkdir -p %{buildroot}%{_datadir}/licenses/%{name}

cp -a extracted/usr/bin/driftleaf %{buildroot}%{_bindir}/
cp -a extracted/usr/lib/Driftleaf/. %{buildroot}/usr/lib/Driftleaf/
cp -a extracted/usr/share/applications/Driftleaf.desktop %{buildroot}%{_datadir}/applications/
cp -a extracted/usr/share/icons/hicolor/32x32/apps/driftleaf.png \
    %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/
cp -a extracted/usr/share/icons/hicolor/128x128/apps/driftleaf.png \
    %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/
cp -a extracted/usr/share/icons/hicolor/256x256@2/apps/driftleaf.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256@2/apps/
install -Dm644 %{_builddir}/LICENSE %{buildroot}%{_datadir}/licenses/%{name}/LICENSE

%files
%dir %{_datadir}/licenses/%{name}
%license %{_datadir}/licenses/%{name}/LICENSE
%{_bindir}/driftleaf
/usr/lib/Driftleaf/
%{_datadir}/applications/Driftleaf.desktop
%dir %{_datadir}/icons/hicolor
%dir %{_datadir}/icons/hicolor/32x32
%dir %{_datadir}/icons/hicolor/32x32/apps
%{_datadir}/icons/hicolor/32x32/apps/driftleaf.png
%dir %{_datadir}/icons/hicolor/128x128
%dir %{_datadir}/icons/hicolor/128x128/apps
%{_datadir}/icons/hicolor/128x128/apps/driftleaf.png
%dir %{_datadir}/icons/hicolor/256x256@2
%dir %{_datadir}/icons/hicolor/256x256@2/apps
%{_datadir}/icons/hicolor/256x256@2/apps/driftleaf.png

%changelog
* Tue Oct 27 2026 AetherAssembly <support@aetherassembly.org> - 0.7.2-1
- Added an announcement banner that checks Driftleaf's own site RSS feed once per
  launch, showing only its single most recent item; dismissal persists across restarts.
- Fixed a missing rustls crypto provider that panicked on first network release/
  announcement check in debug and other unsigned builds.

* Mon Oct 26 2026 AetherAssembly <support@aetherassembly.org> - 0.7.1-1
- Added a "View license" button to Settings -> About.
- Release builds now produce signed auto-update manifests, merged into one latest.json
  for the updater to verify.
- Updated dependencies: React 19.3.1, ESLint 10.13, typescript-eslint 8.72, Vite 8.3.5,
  and others; held TypeScript at 6.x since typescript-eslint does not yet support 7.0.

* Sun Oct 25 2026 AetherAssembly <support@aetherassembly.org> - 0.7.0-1
- Rebuilt for the Tauri release RPM layout: binary at /usr/bin/driftleaf, backend
  resources under /usr/lib/Driftleaf/, desktop file and icons unchanged. No longer
  bundles Electron or better-sqlite3. Unverified on a real OBS/Copr build.

* Thu Oct 15 2026 AetherAssembly <support@aetherassembly.org> - 0.6.4-1
- Protect existing branches, drain writes before locking or closing, and retain
  failed edits for retry.
- Fix duplicate search entries and run data-loss regression tests in CI.
- Announce the planned desktop upgrade, with a Windows migration notice.

* Mon Oct 12 2026 AetherAssembly <support@aetherassembly.org> - 0.6.3-1
- Show only the newest release for duplicate community catalog assets.
- Replace the collapsed sidebar's Extensions text abbreviation with an icon.
- Use "branch" in user-facing workspace terminology; internal vault API and
  storage names remain unchanged.

* Sun Oct 11 2026 AetherAssembly <support@aetherassembly.org> - 0.6.2-1
- Added Cherry, Arctic, and Amber color themes.
- Fixed Windows update checks by including channel-specific updater metadata
  in release assets.

* Sun Oct 11 2026 AetherAssembly <support@aetherassembly.org> - 0.6.1-1
- Added saved Gallery, List, and Timeline database views, improved Calendar
  with week and month modes, and added view-independent property management.
- Improved database view creation, property option editing, and sidebar actions.

* Sun Oct 11 2026 AetherAssembly <support@aetherassembly.org> - 0.6.0-1
- Updated package version and description for the 0.6.0 feature set, including
  encrypted vault metadata, linked-note graphs, canvas workspaces, isolated
  extensions, richer database views and formulas, and community catalogs.

* Thu Oct 08 2026 AetherAssembly <support@aetherassembly.org> - 0.5.0-1
- Added direct creation of encrypted editable databases, with a default title
  property, alongside fixes for note selection, external links, and Wayland
  application icon association.

* Wed Oct 07 2026 AetherAssembly <support@aetherassembly.org> - 0.4.1-1
- Updated package version and description for the 0.4.1 feature set, including
  encrypted editable databases imported from CSV and JSON.

* Tue Oct 06 2026 AetherAssembly <support@aetherassembly.org> - 0.3.1-1
- Resolved npm audit findings by updating the affected brace-expansion
  dependency and overriding the vulnerable transitive @electron/get
  dependency to avoid its vulnerable dependency chain.

* Mon Aug 31 2026 AetherAssembly <support@aetherassembly.org> - 0.3.0-2
- Disabled the automatic post-install strip pass (%%__os_install_post). The
  packaged app bundles better-sqlite3's prebuilt native binaries for every
  OS/arch it supports; brp-strip tried to strip all of them regardless of the
  target architecture and treated a foreign-architecture binary it couldn't
  parse as a fatal error on some build systems, aborting the build (seen on
  Mageia 9 x86_64 in COPR while the same package's aarch64 build succeeded).

* Mon Aug 31 2026 AetherAssembly <support@aetherassembly.org> - 0.3.0-1
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
