# Terms of Service

_Last updated: 2026-08-31_

> The canonical, always-current version of this document is hosted at
> [legal.aetherassembly.org/driftleaf/tos.html](https://legal.aetherassembly.org/driftleaf/tos.html).
> This copy is provided for convenience when browsing the repository and may lag behind the hosted version.

## Acceptance

By downloading, building, running, or distributing Driftleaf, you agree to these terms.

## Who We Are

Driftleaf is developed and maintained by AetherAssembly, a small team consisting of Aster and Milo. For questions or support, contact us at [support@aetherassembly.org](mailto:support@aetherassembly.org).

## License

Driftleaf is currently licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). AetherAssembly is in the process of finalizing a custom organization-wide license. Until that license is in effect, the AGPL-3.0-or-later governs your use of this software.

Under the AGPL-3.0-or-later and in line with AetherAssembly's intended licensing direction:

- **Personal use** is free and unrestricted.
- **Commercial use**, including using this software as part of a paid product or service, offering it as a hosted service, or using it to generate revenue, requires a written commercial agreement with AetherAssembly. Contact [support@aetherassembly.org](mailto:support@aetherassembly.org) to discuss commercial licensing.
- **Forks and modifications** must remain publicly available under the same license. You may not privatize, relicense, or distribute a fork under more restrictive terms.
- **Attribution** to AetherAssembly must be maintained in all copies, forks, and derivative works.

## Permitted Use

You may use, copy, modify, and distribute this project in accordance with the AGPL-3.0-or-later and the conditions above.

## Pre-Release Status

Driftleaf is pre-1.0 software under active development. Specifically, at the current release:

- Binaries are not code-signed.
- The encryption implementation has not yet undergone an external security audit.
- Sync between devices is not yet implemented.
- Only passphrase-based unlock is supported; there is no biometric or hardware key support.

See the project's [security policy](SECURITY.md) for the current state of these limitations.

## Your Passphrase and Your Data

Driftleaf encrypts your notes locally using a key derived from a passphrase that you choose. AetherAssembly does not know, store, or have any way to recover your passphrase.

You are solely responsible for:

- Choosing and remembering (or securely storing) your passphrase — if it is lost, your vault cannot be recovered by AetherAssembly or anyone else
- Backing up your vault directory
- Complying with local laws and regulations applicable to your use of encryption software

## Support

AetherAssembly provides support under the following terms:

- **Active support** covers the current release and the two most recent major versions. These receive security patches and bug fixes, including minor versions within that window.
- **Deprecated support** applies to the major version immediately outside the active window. Deprecated versions are acknowledged but no longer actively patched. Users are strongly encouraged to update.
- **Cold storage retrieval:** versions beyond the deprecated window are archived. Retrieval for any purpose is available as a paid service. Contact [support@aetherassembly.org](mailto:support@aetherassembly.org) for pricing and terms.
- **Update guarantee:** AetherAssembly validates all updates to ensure they function without data corruption or overwriting of existing user data before being pushed to production.

Support requests can be directed to [support@aetherassembly.org](mailto:support@aetherassembly.org), the [contact form](https://forms.gle/T4i7GGzaT3HUrffm9), or via GitHub Issues.

## Third-Party Services

Driftleaf does not currently connect to any third-party service. If networked features (such as optional sync) are added in a future release, this section and the accompanying Privacy Policy will be updated before that release ships.

## Limitation of Liability

To the maximum extent permitted by law, AetherAssembly and its members are not liable for any direct, indirect, incidental, special, consequential, or exemplary damages arising from your use of the software.

This includes, without limitation, loss of data due to a forgotten passphrase, disk failure, file corruption, or software defects. This limitation does not apply to damages arising from use of versions within the active support window where AetherAssembly's update guarantee applies.

## Termination

These terms remain in effect until you stop using the software. AetherAssembly may restrict participation in project spaces, including issues or pull requests, according to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Changes to These Terms

These terms may be updated in future releases. Continued use of the project after changes are published constitutes acceptance of the revised terms.

## Contact

Questions about these terms can be directed to [support@aetherassembly.org](mailto:support@aetherassembly.org) or via the [contact form](https://forms.gle/T4i7GGzaT3HUrffm9).

---

Also see: [Privacy Policy](PRIVACY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
