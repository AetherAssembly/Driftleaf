# Community Gallery

The in-app **Extensions → Community gallery** displays public releases from
the [Driftleaf Extensions](https://github.com/AetherAssembly/Driftleaf-Extensions)
and [Driftleaf Templates](https://github.com/AetherAssembly/Driftleaf-Templates)
repositories. It lists stable releases and their descriptions and downloadable
assets. When an asset with the same filename appears in multiple releases, only
the version from the newest release is shown. The gallery contacts GitHub when
opened or refreshed; Driftleaf remains usable offline.

Want to create and share your own extensions or templates? Visit the
[Driftleaf Extensions](https://github.com/AetherAssembly/Driftleaf-Extensions)
or [Driftleaf Templates](https://github.com/AetherAssembly/Driftleaf-Templates)
repository to learn about contributing and publishing releases.

## Extensions

The gallery previews an extension's JavaScript before installation. Installed
extensions are stored in the encrypted branch and begin with all permissions
disabled. Their permissions can be reviewed and granted separately in
**Extensions**. Extensions are executable code, so their safety depends on
trust in the source. A granted extension can read information covered by its
permissions while it is running.

## Templates

Templates are ZIP archives containing Markdown notes and, optionally, CSV or
Driftleaf JSON databases. Imported files are added to the currently open
branch under **Community templates** and are encrypted as part of that branch.
Archives and individual files are subject to the same import limits as other
ZIP imports; see [Databases](DATABASES.md).

## Network and privacy

Gallery requests use GitHub's public Releases API and public release assets.
GitHub receives ordinary request metadata, such as an IP address. Driftleaf
does not include branch contents or account identifiers in those requests.
Release descriptions and assets are public, so they are not a place for
private information.

For permissions and extension behavior, see [Extensions](EXTENSIONS.md).
