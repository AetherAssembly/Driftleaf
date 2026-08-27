# Security Policy

## Reporting a Vulnerability

**Do not** open a public issue for security vulnerabilities. Instead, please email security concerns to the maintainers privately.

For Driftleaf, security issues are especially critical because they may affect user data encryption or note storage safety. Please report vulnerabilities responsibly.

When reporting a vulnerability, include:

- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact (data loss, unauthorized access, etc.)
- Suggested fix (if you have one)

We will:

1. Confirm receipt within 48 hours
2. Assess the severity
3. Work on a fix privately
4. Credit you in the security advisory (unless you prefer anonymity)

## Security Considerations

### For Users

- **Passphrase is your only security** - Driftleaf derives the encryption key from your passphrase using scrypt. Choose a strong passphrase.
- **No password reset** - If you forget your passphrase, your vault cannot be recovered. Write it down and store it safely.
- **Local-first by default** - Notes are always encrypted on disk. Sync (when added) will be optional and you control the server.
- **Keep updated** - Install security updates when available.

### For Developers

Driftleaf uses:

- **AES-256-GCM** for note encryption
- **Scrypt** for key derivation (N=2^17, r=8, p=1)
- **12-byte IV** per note (GCM recommended)
- **16-byte authentication tag** for corruption detection
- **Atomic writes** for crash safety

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for full details.

## Known Limitations

### v0.2.0 (Pre-Release)

- **Unsigned builds** - Binaries are not code-signed (planned for v1.0)
- **No security audit** - External review is planned for RC phase
- **No sync** - Sync feature is post-v1.0 stretch work
- **Passphrase only** - No biometric or hardware key support (future work)

### Vault Security

- Vault writes are **crash-safe** via atomic operations and reconciliation, but **not transactional**
- On crash between a file write and manifest update, reconciliation may create orphaned files (this is safe and intentional)
- File permissions are not enforced by Driftleaf (relies on OS file permissions)

## Security Roadmap

- **Milestone 13 (RC phase)** - Self-review of crypto module for key derivation, IV/nonce reuse, memory hygiene
- **Future** - External security audit if the vault format becomes widely used
- **Future** - Hardware key support (FIDO2, TPM, etc.)
- **Future** - Post-quantum crypto options (when standard)

## Vulnerability History

None reported yet. If you find one, please report it securely.

## Additional Resources

- [docs/RECOVERY.md](../docs/RECOVERY.md) - Vault recovery procedures
- [docs/DATA_LOSS_TESTING.md](../docs/DATA_LOSS_TESTING.md) - Data loss safeguards
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Technical architecture
