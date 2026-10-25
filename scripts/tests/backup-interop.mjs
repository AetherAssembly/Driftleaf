import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as vault from "../../src/main/vault.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_backup" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-backup-source-"));
const destinationParent = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-backup-dest-"));
const passphrase = "Test fixture 🌿 café";

function run(request) {
  const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const branch = await vault.createVault(root, passphrase, "blank");
  const note = await vault.createNote(branch, "", "Backed up note");
  await vault.writeNote(branch, note.id, "content that must survive the backup");
  // vault.ts's functions don't themselves acquire the writer lock (that's service.ts's
  // job); write the lock file directly so the exclusion below is actually exercised.
  await writeFile(path.join(root, ".driftleaf-writer.sqlite"), "lock");

  // Rust makes the backup; Node must be able to open and read it with the real passphrase,
  // and the hidden writer-lock file must not have been copied into it.
  const { backupPath } = run({ action: "create", root, destinationParent });
  const { vault: backupVault } = await vault.unlockVault(backupPath, passphrase);
  assert.equal(await vault.readNote(backupVault, note.id), "content that must survive the backup");
  await assert.rejects(
    stat(path.join(backupPath, ".driftleaf-writer.sqlite")),
    (err) => err.code === "ENOENT",
  );

  // Rust refuses a destination inside the open branch, same as createVaultBackup()'s guard.
  const insideAttempt = spawnSync(binary, [], {
    input: JSON.stringify({ action: "create", root, destinationParent: path.join(root, ".driftleaf") }),
    encoding: "utf8",
  });
  assert.notEqual(insideAttempt.status, 0);

  // Rust's health check on a clean branch must report every section "ok", matching
  // inspectVault()'s own verdict on the same, undamaged branch.
  const nodeHealth = await vault.inspectVault(branch);
  const rustVerify = run({ action: "verify", root, passphrase });
  assert.deepEqual(
    rustVerify.checks.map((c) => [c.name, c.status]),
    nodeHealth.checks.map((c) => [c.name, c.status]),
  );
  assert.ok(rustVerify.checks.every((c) => c.status === "ok"));

  // A wrong passphrase against the same backup must be refused.
  const wrongPassphrase = spawnSync(binary, [], {
    input: JSON.stringify({ action: "verify", root: backupPath, passphrase: "wrong passphrase" }),
    encoding: "utf8",
  });
  assert.notEqual(wrongPassphrase.status, 0);

  // Damage one note file on disk and confirm Rust's health check flags it the same way
  // Node's does: as an unreadable encrypted file, not a crash.
  const damagedRoot = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-backup-damaged-"));
  const damagedBranch = await vault.createVault(damagedRoot, passphrase, "blank");
  const damagedNote = await vault.createNote(damagedBranch, "", "Will be damaged");
  await vault.writeNote(damagedBranch, damagedNote.id, "content");
  const noteFile = path.join(damagedRoot, ".driftleaf/notes", `${damagedNote.id}.enc`);
  const bytes = await readFile(noteFile);
  bytes[20] ^= 1;
  await writeFile(noteFile, bytes);
  const damagedHealth = run({ action: "verify", root: damagedRoot, passphrase });
  const noteCheck = damagedHealth.checks.find((c) => c.name === "Encrypted note contents");
  assert.equal(noteCheck.status, "error");
  await rm(damagedRoot, { recursive: true, force: true });

  console.log(
    "Rust creates a backup Node can open and read, refuses a destination inside the open " +
      "branch, and its health check matches Node's on both a clean branch and one with a " +
      "damaged note file.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(destinationParent, { recursive: true, force: true });
}
