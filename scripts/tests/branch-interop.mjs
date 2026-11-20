import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
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
const temporaryRoots = [root];
function snapshot(password = passphrase, target = root) {
  return spawnSync(binary, [], {
    input: JSON.stringify({ root: target, passphrase: password }),
    encoding: "utf8",
  });
}
async function copyOf(source) {
  const copy = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-compat-copy-"));
  temporaryRoots.push(copy);
  await cp(source, copy, { recursive: true });
  return copy;
}
// What Node's own parseManifest() makes of the manifest on disk, taken from an unlock of a
// copy so the original's files stay untouched for the "must not rewrite" checks.
async function nodeParsedManifest(password = passphrase) {
  const copy = await copyOf(root);
  const { vault: unlocked, recovery } = await vault.unlockVault(copy, password);
  assert.deepEqual(recovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
  return unlocked.manifest;
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
  // createVault() writes a manifest with no `trash` or `attachments` key; both sides default
  // them to empty lists when they read it.
  assert.ok(!("trash" in branch.manifest) && !("attachments" in branch.manifest));
  assert.deepEqual(parsed.manifest, await nodeParsedManifest());
  assert.deepEqual(parsed.manifest, { ...branch.manifest, trash: [], attachments: [] });
  assert.equal(parsed.notes[note.id], await vault.readNote(branch, note.id));
  assert.equal(parsed.notes[empty.id], "");
  assert.deepEqual(parsed.databases[database.id], await vault.readDatabase(branch, database.id));
  assert.deepEqual(
    await readFile(manifestFile),
    original,
    "read-only Rust path must not rewrite metadata",
  );
  assert.notEqual(snapshot("wrong").status, 0);

  // Trash and attachments, read-only. Node trashes a note and a database and adds an
  // attachment; Rust must read exactly Node's manifest (Trash entries and attachment
  // records included), must not serve the trashed items as live ones, and must still not
  // rewrite anything.
  const trashedNote = await vault.createNote(branch, "Gone", "Trashed note");
  await vault.writeNote(branch, trashedNote.id, "in Trash");
  const trashedDatabase = await vault.createDatabase(
    branch,
    "Trashed database",
    "Gone",
    [{ id: "title", name: "Name", type: "title" }],
    [],
  );
  await vault.deleteNote(branch, trashedNote.id);
  await vault.deleteDatabase(branch, trashedDatabase.id);
  const attachment = await vault.addAttachment(branch, "pic.png", "image/png", randomBytes(2048));
  const withTrashBytes = await readFile(manifestFile);
  const withTrashResult = snapshot();
  assert.equal(withTrashResult.status, 0, withTrashResult.stderr);
  const withTrash = JSON.parse(withTrashResult.stdout);
  assert.deepEqual(withTrash.manifest, branch.manifest);
  assert.deepEqual(withTrash.manifest, await nodeParsedManifest());
  assert.deepEqual(
    withTrash.manifest.trash.map((entry) => [entry.kind, entry.meta.id]),
    [
      ["note", trashedNote.id],
      ["database", trashedDatabase.id],
    ],
  );
  assert.deepEqual(withTrash.manifest.attachments, [attachment]);
  assert.ok(!(trashedNote.id in withTrash.notes));
  assert.ok(!(trashedDatabase.id in withTrash.databases));
  assert.equal(withTrash.notes[note.id], parsed.notes[note.id]);
  assert.deepEqual(await readFile(manifestFile), withTrashBytes, "read-only Rust path must not rewrite metadata");

  // Damaged Trash and attachment entries must not stop the branch from opening on either
  // side; both drop the same entries and keep the same good ones.
  const goodTrash = structuredClone(branch.manifest.trash);
  const goodAttachments = structuredClone(branch.manifest.attachments);
  branch.manifest.trash.push(
    { kind: "note", meta: { id: "not-a-uuid" }, deletedAt: "soon" },
    { kind: "note", meta: { ...goodTrash[0].meta, id: "not-a-uuid" }, deletedAt: 1 },
    { kind: "note", meta: { ...goodTrash[0].meta, fileName: null }, deletedAt: 1 },
    { kind: "database", meta: { ...goodTrash[1].meta, updatedAt: "now" }, deletedAt: 1 },
    { kind: "folder", meta: goodTrash[0].meta, deletedAt: 1 },
    { kind: "note", meta: goodTrash[0].meta },
    null,
    "junk",
    [],
  );
  branch.manifest.attachments.push(
    { ...attachment, id: "nope" },
    { ...attachment, size: "big" },
    { ...attachment, name: 7 },
    { id: attachment.id },
    null,
  );
  await vault.writeNote(branch, note.id, await vault.readNote(branch, note.id));
  const damagedEntries = snapshot();
  assert.equal(damagedEntries.status, 0, damagedEntries.stderr);
  const damagedManifest = JSON.parse(damagedEntries.stdout).manifest;
  assert.deepEqual(damagedManifest.trash, goodTrash);
  assert.deepEqual(damagedManifest.attachments, goodAttachments);
  assert.deepEqual(damagedManifest, await nodeParsedManifest());
  branch.manifest.trash = structuredClone(goodTrash);
  branch.manifest.attachments = structuredClone(goodAttachments);
  // A `trash` or `attachments` value that is not a list at all is read as an empty one.
  branch.manifest.trash = { not: "a list" };
  branch.manifest.attachments = "nope";
  await vault.writeNote(branch, note.id, await vault.readNote(branch, note.id));
  const wrongShape = snapshot();
  assert.equal(wrongShape.status, 0, wrongShape.stderr);
  assert.deepEqual(JSON.parse(wrongShape.stdout).manifest.trash, []);
  assert.deepEqual(JSON.parse(wrongShape.stdout).manifest.attachments, []);
  // (Node reads it the same way. Its unlock then also reconciles, which this read-only
  // path never does: with the Trash bookkeeping gone, the trashed note's file is an orphan
  // and comes back as a recovered note.)
  const wrongShapeCopy = await copyOf(root);
  const { vault: wrongShapeVault, recovery: wrongShapeRecovery } = await vault.unlockVault(
    wrongShapeCopy,
    passphrase,
  );
  assert.deepEqual(vault.listTrash(wrongShapeVault), []);
  assert.deepEqual(vault.listAttachments(wrongShapeVault), []);
  assert.deepEqual(wrongShapeRecovery.recoveredOrphans, [trashedNote.id]);
  branch.manifest.trash = structuredClone(goodTrash);
  branch.manifest.attachments = structuredClone(goodAttachments);
  await vault.writeNote(branch, note.id, await vault.readNote(branch, note.id));

  // Version-2 vault.json (wrapped key), read-only: after Node changes the passphrase on a
  // copy, Rust reads the same content with the new passphrase and refuses the old one.
  const wrappedRoot = await copyOf(root);
  const { vault: wrappedVault } = await vault.unlockVault(wrappedRoot, passphrase);
  const newPassphrase = "Wrapped 🔑 passphrase";
  await vault.changeVaultPassphrase(wrappedVault, passphrase, newPassphrase);
  const wrappedFiles = async () =>
    Promise.all(
      ["vault.json", "canary.enc", "manifest.enc"].map((file) =>
        readFile(path.join(wrappedRoot, ".driftleaf", file)),
      ),
    );
  const wrappedBefore = await wrappedFiles();
  const wrappedResult = snapshot(newPassphrase, wrappedRoot);
  assert.equal(wrappedResult.status, 0, wrappedResult.stderr);
  const wrappedParsed = JSON.parse(wrappedResult.stdout);
  assert.deepEqual(wrappedParsed.manifest, wrappedVault.manifest);
  assert.equal(wrappedParsed.notes[note.id], parsed.notes[note.id]);
  assert.deepEqual(wrappedParsed.databases[database.id], await vault.readDatabase(wrappedVault, database.id));
  const oldPassphraseResult = snapshot(passphrase, wrappedRoot);
  assert.notEqual(oldPassphraseResult.status, 0);
  assert.equal(oldPassphraseResult.stderr.trim(), 'Error: "Incorrect passphrase"');
  assert.deepEqual(await wrappedFiles(), wrappedBefore, "read-only Rust path must not rewrite metadata");
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
    "Rust reads Node branches, databases, extensions, Trash, attachment records, version-2 " +
      "(wrapped key) configs, Unicode/empty notes and legacy paths without rewriting them.",
  );
} finally {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true });
}
