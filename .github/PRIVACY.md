# Privacy Policy

_Last updated: 2026-11-21_

> The canonical, always-current version of this document is hosted at
> [legal.aetherassembly.org/driftleaf/privacy.html](https://legal.aetherassembly.org/driftleaf/privacy.html).
> This copy is provided for convenience when browsing the repository and may lag behind the hosted version.

## Overview

Driftleaf is a local-first, encrypted-by-default notes application for desktop. It is designed so that your notes never leave your device: there are no accounts, no cloud storage, and no server operated by AetherAssembly that your data passes through.

## Who We Are

Driftleaf is developed and maintained by [AetherAssembly](https://aetherassembly.org/about.html). For privacy-related questions, contact us at [privacy@aetherassembly.org](mailto:privacy@aetherassembly.org) or via the [contact form](https://forms.gle/T4i7GGzaT3HUrffm9).

## Data We Process

Driftleaf stores the following information locally on your device, inside the
branch folder you choose.

- Your note content, databases, and attachments (images and files you add to notes), each encrypted with AES-256-GCM using a key protected by your passphrase
- An encrypted manifest (`.driftleaf/manifest.enc`) recording note titles, folders, timestamps, attachment names, items in Trash, and installed extension code and permissions. Note and attachment files use opaque IDs rather than titles in their filesystem paths.
- Application settings (such as theme and preferences, and the path of the last branch you opened), stored unencrypted in the app's settings directory for your operating-system user account

Deleted notes and databases are kept, still encrypted, in the branch's Trash for 30 days so you can restore them, and are then removed. You can empty Trash yourself at any time.

The only time Driftleaf writes your notes to disk unencrypted is when you choose **Export unencrypted copy** yourself, into a folder you pick, or save a copy of a single attachment.

Branch contents remain on your device. The app also makes update-check requests
to GitHub when automatic update checks are enabled, or when you manually
choose **Check for updates**. These requests are for public release metadata;
they do not include notes, branch contents, the passphrase, or an account
identifier. GitHub receives the ordinary network request metadata (such as
your IP address). Update downloads are user-initiated. Disable automatic checks
in **Settings → Updates** to skip startup checks. With that same setting on,
Driftleaf also reads a public announcement feed
(`https://driftleaf.aetherassembly.org/rss_driftleaf.xml`) once per launch to
show the latest project announcement; the request carries no branch data or
identifier, and the web host receives ordinary network request metadata such
as your IP address. Turning the setting off stops both startup requests, so
Driftleaf then makes no network request on its own. Extensions run with network
access disabled by the app. When you open or refresh **Extensions → Community
gallery**, Driftleaf requests public release metadata from GitHub for the
`AetherAssembly/Driftleaf-Extensions` and `AetherAssembly/Driftleaf-Templates`
repositories. Previewing or installing an item downloads its public release
asset from GitHub. These requests do not include branch data or an account
identifier; GitHub receives ordinary network request metadata such as your IP
address. Community items are optional, and the app remains usable offline.

## Data We Do Not Intentionally Collect

Driftleaf does not include user accounts, built-in analytics or tracking, advertising identifiers, crash reporting, or remote telemetry of any kind sent by the application itself.

## Network Requests

Apart from the GitHub release checks, the announcement feed, community catalog
requests, and user-initiated downloads described above, Driftleaf does not sync, phone home,
or transmit branch data. Extensions run in isolated windows with network access
disabled by the app. The application remains usable offline; release catalog
requests simply fail until a network connection is available.

If other networked features — such as optional device sync — are added in a
future release, they will be off by default, and this policy will be updated
to describe exactly what is sent and where before that release ships.

## Encryption and Your Passphrase

Your branch is encrypted with a key that is derived from, or sealed by, your passphrase using scrypt. Your passphrase is never transmitted anywhere and is not stored by Driftleaf or AetherAssembly in any recoverable form. This also means AetherAssembly cannot reset your passphrase or recover your notes if it is lost. You can change the passphrase yourself while the branch is unlocked.

## Data Sharing

Driftleaf does not sell, rent, or share your notes or any other local data with third parties, because it has no mechanism to transmit that data in the first place.

## Data Retention and Deletion

Your data remains on your device, in the branch folder you chose, until you delete it yourself. Uninstalling the application does not delete your branch or the app's local settings directory — you are responsible for removing those manually if desired.

## Open Source Nature of the Project

Because this project is open source, anyone can inspect the code to verify how data is handled. If you build modified versions yourself or install builds from third parties, their behavior may differ from official AetherAssembly releases.

## Contact

For privacy-related questions, contact AetherAssembly at [privacy@aetherassembly.org](mailto:privacy@aetherassembly.org) or via the [contact form](https://forms.gle/T4i7GGzaT3HUrffm9).

---

Also see: [Terms of Service](TERMS.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
