# Extensions

Extensions add optional features to Driftleaf. Each extension is JavaScript
that runs in its own isolated window. Installed extensions are stored inside
the encrypted branch.

## Installing and managing extensions

JavaScript extensions can be installed from a `.js` file smaller than 512 KB
through **Extensions** in the sidebar. The in-app community gallery also
offers public extension releases and templates. Community extensions can be
previewed before installation.

All extension permissions start disabled. Permissions are shown in
**Extensions** and can be granted individually. Note access, note-graph access,
and access to selected databases are separate capabilities. Database access
also requires selecting the databases the extension may read. Calls outside
the granted permissions are denied.

Extensions can read permitted note contents, note links, and selected
databases. They cannot edit notes or databases or access Driftleaf settings
and arbitrary files. Removing an extension closes its open windows, and
changing a permission takes effect on its next request.

## Privacy and trust

Extension windows cannot use Node.js, navigate to websites, open popups, or
make network requests. Their access to branch data is mediated by Driftleaf and
checked against the extension's current permissions.

Extensions are still executable code from a source you choose. A granted
extension can read and process the data covered by its permissions while it is
running. Review unfamiliar source and consider its permissions before
installation. Isolation reduces access to the rest of the app and device, but
cannot protect against vulnerabilities in Electron or the operating system.

Extensions and their permissions are stored in the encrypted branch. Community
gallery behavior and network requests are described in
[Community Gallery](COMMUNITY.md).
