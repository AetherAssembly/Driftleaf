import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import {
  deriveVaultKey,
  encrypt,
  decrypt,
  packPayload,
  unpackPayload,
} from "../../src/main/crypto.ts";
const root = path.resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(path.join(root, "crates/driftleaf-core/tests/fixtures/crypto.json")),
);
const binary = path.join(
  root,
  "crates/driftleaf-core/target/release/examples/crypto_bridge" +
    (process.platform === "win32" ? ".exe" : ""),
);
const key = await deriveVaultKey(fixture.passphrase, Buffer.from(fixture.saltHex, "hex"));
assert.equal(key.toString("hex"), fixture.keyHex);
for (const vector of fixture.vectors) {
  const original = Buffer.from(vector.plaintextHex, "hex");
  const nodeEncrypted = packPayload(encrypt(original, key));
  for (const packed of [Buffer.from(vector.packedHex, "hex"), nodeEncrypted]) {
    const result = spawnSync(binary, [], {
      input: JSON.stringify({ ...fixture, operation: "decrypt", dataHex: packed.toString("hex") }),
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), original.toString("hex"));
  }
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ ...fixture, operation: "encrypt", dataHex: original.toString("hex") }),
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(decrypt(unpackPayload(Buffer.from(result.stdout.trim(), "hex")), key), original);
}
key.fill(0);
console.log(
  "Node ↔ Rust encryption interoperability passed for empty, Unicode, and binary content.",
);
