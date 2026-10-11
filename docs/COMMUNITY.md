# Community Gallery

The in-app **Extensions → Community gallery** displays public releases from
the [Driftleaf Extensions](https://github.com/AetherAssembly/Driftleaf-Extensions)
and [Driftleaf Templates](https://github.com/AetherAssembly/Driftleaf-Templates)
repositories. It lists stable releases and their descriptions and downloadable
assets. The gallery contacts GitHub when opened or refreshed; Driftleaf
remains usable offline.

## Extensions

The gallery previews an extension's JavaScript before installation. Installed
extensions are stored in the encrypted vault and begin with all permissions
disabled. Their permissions can be reviewed and granted separately in
**Extensions**. Extensions are executable code, so their safety depends on
trust in the source. A granted extension can read information covered by its
permissions while it is running.

## Templates

Templates are ZIP archives containing Markdown notes and, optionally, CSV or
Driftleaf JSON databases. Imported files are added to the currently open
vault under **Community templates** and are encrypted as part of that vault.
Archives and individual files are subject to the same import limits as other
ZIP imports; see [Databases](DATABASES.md).

## Network and privacy

Gallery requests use GitHub's public Releases API and public release assets.
GitHub receives ordinary request metadata, such as an IP address. Driftleaf
does not include vault contents or account identifiers in those requests.
Release descriptions and assets are public, so they are not a place for
private information.

For permissions and extension behavior, see [Extensions](EXTENSIONS.md).
