// Passphrase-derived key -> AES-256-GCM for at-rest note encryption (see docs/ARCHITECTURE.md).
// One key per vault, derived with scrypt from the vault's stored salt.

import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "node:crypto";

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // recommended for GCM
const SCRYPT_N = 2 ** 17;
const SCRYPT_PARAMS = {
  N: SCRYPT_N,
  r: 8,
  p: 1,
  // Node defaults maxmem to 32MB; scrypt needs roughly 128 * N * r bytes.
  maxmem: 256 * 1024 * 1024,
} as const;

function scryptAsync(passphrase: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, keyLength, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export interface EncryptedPayload {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

// Used for passphrase-less vaults: a random key with nothing to derive it from.
// Content is still encrypted at rest, but opening the vault needs no secret.
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export async function deriveVaultKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(passphrase, salt, KEY_LENGTH);
}

export function encrypt(plaintext: Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

// On-disk framing for a `.enc` file: [16-byte iv][16-byte authTag][ciphertext].
export function packPayload(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.iv, payload.authTag, payload.ciphertext]);
}

export function unpackPayload(data: Buffer): EncryptedPayload {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);
  return { iv, authTag, ciphertext };
}
