import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
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

const temporaryRoots = [root, destinationParent];

function attempt(request) {
  const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

function run(request) {
  const result = attempt(request);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function copyOf(source) {
  const copy = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-backup-copy-"));
  temporaryRoots.push(copy);
  await cp(source, copy, { recursive: true });
  return copy;
}

// The whole report, not just the verdicts: every check's name, status, and detail string
// must be the same on both sides, in the same order. Only `checkedAt` (a clock reading)
// is left out.
async function assertSameHealth(target, password, label) {
  const nodeReport = await vault.verifyVaultBackup(target, password);
  const rustReport = run({ action: "verify", root: target, passphrase: password });
  assert.deepEqual(rustReport.checks, nodeReport.checks, label);
  assert.deepEqual(Object.keys(rustReport), Object.keys(nodeReport), label);
  return rustReport.checks;
}

// The example binary exits with `Error: "<message>"` (Rust's Debug form of the error
// string), which for these messages is exactly `Error: ${JSON.stringify(message)}`.
async function assertSameRefusal(target, password, pattern) {
  let nodeMessage;
  await assert.rejects(vault.verifyVaultBackup(target, password), (error) => {
    nodeMessage = error.message;
    return true;
  });
  assert.match(nodeMessage, pattern);
  const rustResult = attempt({ action: "verify", root: target, passphrase: password });
  assert.notEqual(rustResult.status, 0, "Rust must refuse what Node refuses");
  assert.equal(rustResult.stderr.trim(), `Error: ${JSON.stringify(nodeMessage)}`);
}

const check = (checks, name) => checks.find((item) => item.name === name);

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
  assert.deepEqual(rustVerify.checks, nodeHealth.checks);
  assert.ok(rustVerify.checks.every((c) => c.status === "ok"));
  assert.equal(check(rustVerify.checks, "Trash"), undefined, "an empty Trash is not reported");
  assert.equal(
    check(rustVerify.checks, "Encrypted attachments").details,
    "0 attachment(s) decrypt successfully.",
  );

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
  assert.deepEqual(damagedHealth.checks, (await vault.inspectVault(damagedBranch)).checks);
  await rm(damagedRoot, { recursive: true, force: true });

  // (e) A branch with Trash and attachments. A trashed note and a trashed database still
  // own their files, so both sides must count those files as accounted for, report the
  // attachments, and add the "Trash" line, word for word the same.
  const trashedNote = await vault.createNote(branch, "Folder", "Trashed note");
  await vault.writeNote(branch, trashedNote.id, "held in Trash");
  const trashedDatabase = await vault.createDatabase(
    branch,
    "Trashed database",
    "Folder",
    [{ id: "title", name: "Name", type: "title" }],
    [],
  );
  const liveDatabase = await vault.createDatabase(
    branch,
    "Live database",
    "",
    [{ id: "title", name: "Name", type: "title" }],
    [],
  );
  await vault.deleteNote(branch, trashedNote.id);
  await vault.deleteDatabase(branch, trashedDatabase.id);
  const attachmentBytes = randomBytes(4096);
  const firstAttachment = await vault.addAttachment(branch, "photo.png", "image/png", attachmentBytes);
  const secondAttachment = await vault.addAttachment(branch, "notes.pdf", "application/pdf", randomBytes(9000));

  const withTrash = await assertSameHealth(root, passphrase, "trash and attachments");
  assert.deepEqual(withTrash, (await vault.inspectVault(branch)).checks);
  assert.ok(withTrash.every((item) => item.status === "ok"), JSON.stringify(withTrash));
  assert.equal(
    check(withTrash, "Trash").details,
    "2 deleted item(s) are held in Trash and can be restored.",
  );
  assert.equal(
    check(withTrash, "Encrypted attachments").details,
    "2 attachment(s) decrypt successfully.",
  );
  assert.equal(
    check(withTrash, "Unindexed encrypted files").details,
    "All encrypted note files are represented in the manifest.",
  );
  assert.equal(
    check(withTrash, "Encrypted databases").details,
    "1 database(s) decrypt and validate successfully.",
  );
  assert.equal(withTrash.at(-1).name, "Trash");

  // A Rust-made backup of that branch carries the Trash and the attachments with it, and
  // both sides give the backup the same report as the original.
  const { backupPath: fullBackupPath } = run({ action: "create", root, destinationParent });
  assert.deepEqual(await assertSameHealth(fullBackupPath, passphrase, "backup with trash"), withTrash);
  const { vault: fullBackup, recovery: fullBackupRecovery } = await vault.unlockVault(
    fullBackupPath,
    passphrase,
  );
  assert.deepEqual(fullBackupRecovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
  assert.ok((await vault.readAttachment(fullBackup, firstAttachment.id)).data.equals(attachmentBytes));
  assert.deepEqual(
    vault.listTrash(fullBackup).map((item) => item.id).sort(),
    [trashedNote.id, trashedDatabase.id].sort(),
  );
  await vault.restoreTrashItem(fullBackup, "note", trashedNote.id);
  assert.equal(await vault.readNote(fullBackup, trashedNote.id), "held in Trash");

  // Damage, one kind at a time, each on its own copy: both sides must reach the same
  // status and the same counts in the same sentence.
  const attachmentsDir = (target) => path.join(target, ".driftleaf/attachments");
  const damageCases = [
    {
      name: "a damaged attachment",
      damage: async (target) => {
        const file = path.join(attachmentsDir(target), `${firstAttachment.id}.enc`);
        const bytes = await readFile(file);
        bytes[40] ^= 1;
        await writeFile(file, bytes);
      },
      expect: ["Encrypted attachments", "error", "1 missing or damaged attachment(s) and 0 unindexed attachment file(s)."],
    },
    {
      name: "a missing attachment and an unindexed one",
      damage: async (target) => {
        await rm(path.join(attachmentsDir(target), `${secondAttachment.id}.enc`));
        await writeFile(path.join(attachmentsDir(target), `${randomUUID()}.enc`), randomBytes(64));
        await writeFile(path.join(attachmentsDir(target), "not-an-attachment.txt"), "ignored");
      },
      expect: ["Encrypted attachments", "error", "1 missing or damaged attachment(s) and 1 unindexed attachment file(s)."],
    },
    {
      name: "only an unindexed attachment file",
      damage: async (target) => {
        await writeFile(path.join(attachmentsDir(target), `${randomUUID()}.enc`), randomBytes(64));
      },
      expect: ["Encrypted attachments", "warning", "0 missing or damaged attachment(s) and 1 unindexed attachment file(s)."],
    },
    {
      name: "the whole attachments folder gone",
      damage: (target) => rm(attachmentsDir(target), { recursive: true }),
      expect: ["Encrypted attachments", "error", "2 missing or damaged attachment(s) and 0 unindexed attachment file(s)."],
    },
    {
      name: "a trashed note's file gone",
      damage: (target) => rm(path.join(target, ".driftleaf/notes", `${trashedNote.id}.enc`)),
      expect: ["Trash", "ok", "2 deleted item(s) are held in Trash and can be restored."],
    },
    {
      name: "a trashed database's file damaged, a live one's too, and one unindexed",
      damage: async (target) => {
        for (const id of [trashedDatabase.id, liveDatabase.id]) {
          const file = path.join(target, ".driftleaf", `${id}.db.enc`);
          const bytes = await readFile(file);
          bytes[30] ^= 1;
          await writeFile(file, bytes);
        }
        await writeFile(path.join(target, ".driftleaf", `${randomUUID()}.db.enc`), randomBytes(64));
        await writeFile(path.join(target, ".driftleaf", ".manifest.enc.tmp-leftover"), "x");
      },
      expect: ["Encrypted databases", "error", "0 invalid metadata entries, 1 unreadable databases, and 1 unindexed database file(s)."],
    },
    {
      name: "an unindexed note file and a leftover temp file",
      damage: async (target) => {
        await cp(
          path.join(target, ".driftleaf/notes", `${note.id}.enc`),
          path.join(target, ".driftleaf/notes", `${randomUUID()}.enc`),
        );
        await writeFile(path.join(target, ".driftleaf/notes", ".x.enc.tmp-leftover"), "x");
      },
      expect: ["Unindexed encrypted files", "warning", "1 encrypted file(s) are not listed in the manifest and may be recoverable on the next unlock."],
    },
  ];
  for (const damageCase of damageCases) {
    const target = await copyOf(root);
    await damageCase.damage(target);
    const checks = await assertSameHealth(target, passphrase, damageCase.name);
    const [name, status, details] = damageCase.expect;
    assert.deepEqual(
      [check(checks, name).status, check(checks, name).details],
      [status, details],
      damageCase.name,
    );
  }

  // Version-2 (wrapped key) backups. Node changes the passphrase, which rewrites vault.json
  // as version 2; Rust must verify the branch with the new passphrase, give the same
  // report, and refuse the old passphrase with the same message Node uses. The backup made
  // before the change keeps its old passphrase on both sides.
  const newPassphrase = "Changed passphrase ✨ ñ";
  await vault.changeVaultPassphrase(branch, passphrase, newPassphrase);
  assert.equal(JSON.parse(await readFile(path.join(root, ".driftleaf/vault.json"), "utf8")).version, 2);
  assert.deepEqual(await assertSameHealth(root, newPassphrase, "version 2"), withTrash);
  await assertSameRefusal(root, passphrase, /passphrase is incorrect or its key check is damaged/);
  await assertSameRefusal(root, "", /passphrase is incorrect or its key check is damaged/);
  await assertSameHealth(backupPath, passphrase, "version 1 backup made before the change");
  await assertSameRefusal(backupPath, newPassphrase, /passphrase is incorrect or its key check is damaged/);
  const { backupPath: wrappedBackupPath } = run({ action: "create", root, destinationParent });
  assert.deepEqual(await assertSameHealth(wrappedBackupPath, newPassphrase, "version 2 backup"), withTrash);

  // A damaged or too-new vault.json is refused with the same explanation by both.
  const wrappedConfig = JSON.parse(await readFile(path.join(root, ".driftleaf/vault.json"), "utf8"));
  const badConfigs = [
    [{ ...wrappedConfig, wrappedKeyHex: wrappedConfig.wrappedKeyHex.slice(2) }, /invalid wrapped encryption key/],
    [{ ...wrappedConfig, wrappedKeyHex: undefined }, /invalid wrapped encryption key/],
    [{ ...wrappedConfig, saltHex: "xyz" }, /invalid key-derivation salt/],
    [{ ...wrappedConfig, version: 3 }, /unsupported branch format/],
    [{ ...wrappedConfig, version: "2" }, /unsupported branch format/],
    [{ ...wrappedConfig, kdf: "none", keyHex: "00".repeat(32) }, /unsupported key-derivation method/],
    [{ version: 1, kdf: "none", keyHex: "00" }, /invalid encryption key/],
    [{ version: 1, kdf: "argon2" }, /unsupported key-derivation method/],
    ["not an object", /invalid branch configuration/],
    [null, /invalid branch configuration/],
    // The wrapped key no longer authenticates: indistinguishable from a wrong passphrase.
    [
      {
        ...wrappedConfig,
        wrappedKeyHex:
          wrappedConfig.wrappedKeyHex.slice(0, -1) + (wrappedConfig.wrappedKeyHex.endsWith("0") ? "1" : "0"),
      },
      /passphrase is incorrect or its key check is damaged/,
    ],
  ];
  const badConfigRoot = await copyOf(root);
  for (const [config, pattern] of badConfigs) {
    await writeFile(path.join(badConfigRoot, ".driftleaf/vault.json"), JSON.stringify(config));
    await assertSameRefusal(badConfigRoot, newPassphrase, pattern);
  }
  // With the config intact but the key check file gone, both report a damaged key check.
  const noCanaryRoot = await copyOf(root);
  await rm(path.join(noCanaryRoot, ".driftleaf/canary.enc"));
  await assertSameRefusal(noCanaryRoot, newPassphrase, /passphrase is incorrect or its key check is damaged/);

  console.log(
    "Rust creates a backup Node can open and read (Trash and attachments included), refuses " +
      "a destination inside the open branch, and its health report matches Node's check for " +
      "check, word for word, on a clean branch, one with Trash and attachments, version-1 and " +
      "version-2 (wrapped key) configs, and every kind of damage tried; wrong passphrases and " +
      "damaged configs are refused with the same messages.",
  );
} finally {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true });
}
