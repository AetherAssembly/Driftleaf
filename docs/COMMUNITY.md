# Community extensions and templates

The in-app **Extensions → Community gallery** reads public, stable GitHub
releases from:

- [AetherAssembly/Driftleaf-Extensions](https://github.com/AetherAssembly/Driftleaf-Extensions)
- [AetherAssembly/Driftleaf-Templates](https://github.com/AetherAssembly/Driftleaf-Templates)

The gallery shows non-draft, non-prerelease releases and reads their release
description and assets. Release requests are made only when the gallery is
opened or refreshed. The app remains usable offline.

## Extension releases

Attach standalone `.js` files to a GitHub Release in `Driftleaf-Extensions`.
The asset filename becomes the extension name; the release title/tag and body
become its version and release notes. Assets must be no larger than 512 KB.
The in-app gallery previews the downloaded source. Installation stores the
extension in the encrypted vault with no permissions enabled.

## Template releases

Attach a `.zip` asset to a GitHub Release in `Driftleaf-Templates`. The ZIP may
contain Markdown notes and optional CSV or Driftleaf JSON databases in folders.
The gallery imports supported files under
`Community templates/<asset filename>` in the currently open vault. ZIP paths
are validated and supported files are imported into the vault's encrypted
storage. Keep archives under 25 MB; individual imported files are subject to
the same size limits as regular ZIP imports.

Release notes are displayed as plain text. Do not put private information in
release descriptions or assets.

## Network and privacy

The gallery uses GitHub's public Releases API and public release assets. GitHub
receives normal request metadata, such as the user's IP address; Driftleaf does
not include vault contents or account identifiers in those requests. See the
[privacy policy](../.github/PRIVACY.md) for details.
