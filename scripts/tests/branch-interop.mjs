import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as vault from "../../src/main/vault.ts";
const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_snapshot" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-compat-"));
const passphrase = "Test fixture 🌿 café";
function snapshot(password = passphrase) {
  return spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase: password }),
    encoding: "utf8",
  });
}
try {
  const branch = await vault.createVault(root, passphrase, "blank");
  const note = await vault.createNote(branch, "", "Unicode 🌿");
  await vault.writeNote(branch, note.id, "\n日本語 e\u0301\n");
  const empty = await vault.createNote(branch, "", "Empty");
  const database = await vault.createDatabase(
    branch,
    "Test database",
    "",
    [{ id: "title", name: "Name", type: "title" }],
    [],
  );
  const extension = await vault.installExtension(branch, "Fixture extension", "void 0;");
  await vault.setExtensionPermissions(branch, extension.id, ["read_databases"], [database.id]);
  const manifestFile = path.join(root, ".driftleaf/manifest.enc");
  const original = await readFile(manifestFile);
  const result = snapshot();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.manifest, branch.manifest);
  assert.equal(parsed.notes[note.id], await vault.readNote(branch, note.id));
  assert.equal(parsed.notes[empty.id], "");
  assert.deepEqual(parsed.databases[database.id], await vault.readDatabase(branch, database.id));
  assert.deepEqual(
    await readFile(manifestFile),
    original,
    "read-only Rust path must not rewrite metadata",
  );
  assert.notEqual(snapshot("wrong").status, 0);
  // Legacy plaintext manifest + named note path: read without migration side effects.
  await rename(manifestFile, manifestFile + ".saved");
  branch.manifest.notes.find((item) => item.id === note.id).fileName = "Legacy name.enc";
  await rename(
    path.join(root, ".driftleaf/notes", note.id + ".enc"),
    path.join(root, "Legacy name.enc"),
  );
  await writeFile(path.join(root, ".driftleaf/manifest.json"), JSON.stringify(branch.manifest));
  const legacy = snapshot();
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).notes[note.id], parsed.notes[note.id]);
  const corrupt = Buffer.from(await readFile(path.join(root, "Legacy name.enc")));
  corrupt[12] ^= 1;
  await writeFile(path.join(root, "Legacy name.enc"), corrupt);
  assert.notEqual(snapshot().status, 0, "corrupted note must be rejected");
  console.log(
    "Rust reads Node branches, databases, extensions, Unicode/empty notes and legacy paths without rewriting them.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
