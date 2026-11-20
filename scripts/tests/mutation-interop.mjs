import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as vault from "../../src/main/vault.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-mutate-"));
const passphrase = "Test fixture 🌿 café";

const temporaryRoots = [root];

function mutate(ops, password = passphrase, target = root, extra = {}) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root: target, passphrase: password, ops, ...extra }),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function run(ops, password = passphrase, target = root, extra = {}) {
  const result = mutate(ops, password, target, extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// The example binary exits with `Error: "<message>"` (Rust's Debug form of the error
// string) on stderr. For the plain messages compared here that is exactly
// `Error: ${JSON.stringify(message)}`, so a refusal can be checked for the same wording
// as the reference implementation's, not just "it failed".
async function assertSameRefusal(nodeAttempt, rustResult, pattern) {
  let nodeMessage;
  await assert.rejects(nodeAttempt, (error) => {
    nodeMessage = error.message;
    return true;
  });
  assert.match(nodeMessage, pattern);
  assert.notEqual(rustResult.status, 0, "Rust must refuse what Node refuses");
  assert.equal(rustResult.stderr.trim(), `Error: ${JSON.stringify(nodeMessage)}`);
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// A byte-for-byte copy of a branch, so the same operation can be applied by Node to one
// copy and by Rust to the other and the two results compared.
async function twinOf(source) {
  const copy = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-mutate-twin-"));
  temporaryRoots.push(copy);
  await cp(source, copy, { recursive: true });
  return copy;
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

// Everything observable about a branch on disk, read through one reader (Rust) so two
// branches can be compared like for like. Only the wall-clock fields that legitimately
// differ between two runs of the same operation are blanked.
async function diskState(target, password = passphrase) {
  const read = run([], password, target);
  return {
    manifest: {
      ...read.manifest,
      trash: read.manifest.trash.map((entry) => ({ ...entry, deletedAt: "<time>" })),
    },
    trash: read.trash
      .map(({ deletedAt: _deletedAt, expiresAt: _expiresAt, ...item }) => item)
      .sort((a, b) => a.id.localeCompare(b.id)),
    notes: read.notes,
    databases: read.databases,
    attachments: read.attachments,
    health: read.health.checks,
    files: await listFiles(target),
  };
}

const noteFile = (target, id) => path.join(target, ".driftleaf/notes", `${id}.enc`);
const databaseFile = (target, id) => path.join(target, ".driftleaf", `${id}.db.enc`);
const attachmentFile = (target, id) => path.join(target, ".driftleaf/attachments", `${id}.enc`);
const emptyRecovery = { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] };
const titleProperty = () => ({ id: "p_title", name: "Name", type: "title" });

try {
  await vault.createVault(root, passphrase, "blank");

  // Rust creates, writes, and renames notes and a folder — Node never touches the branch
  // in between, so this is a pure native write path from branch creation to manifest.
  const written = mutate([
    { type: "createNote", folderPath: "", title: "Rust note" },
    { type: "writeNote", id: "$note:0", content: "Hello from Rust 🦀 — 日本語" },
    { type: "createFolder", folderPath: "Rust Folder" },
    { type: "createNote", folderPath: "Rust Folder", title: "Nested note" },
    { type: "writeNote", id: "$note:1", content: "nested content" },
    { type: "renameNote", id: "$note:0", title: "Renamed by Rust" },
  ]);
  assert.equal(written.status, 0, written.stderr);
  const parsed = JSON.parse(written.stdout);
  assert.equal(parsed.notes[parsed.createdNotes[0]], "Hello from Rust 🦀 — 日本語");
  assert.equal(parsed.notes[parsed.createdNotes[1]], "nested content");
  assert.ok(parsed.manifest.folders.includes("Rust Folder"));
  assert.equal(
    parsed.manifest.notes.find((note) => note.id === parsed.createdNotes[0]).title,
    "Renamed by Rust",
  );

  // Node unlocking (and thus reconciling) a Rust-written branch must find nothing to
  // repair: every write above left the manifest and its files in a fully consistent state.
  const { vault: reopened, recovery } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(recovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
  assert.equal(await vault.readNote(reopened, parsed.createdNotes[0]), "Hello from Rust 🦀 — 日本語");
  assert.ok(vault.listFolders(reopened).includes("Rust Folder"));

  // Node mutates further on top of the Rust-written branch...
  await vault.writeNote(reopened, parsed.createdNotes[1], "edited by node");
  const nodeNote = await vault.createNote(reopened, "", "Node note");
  await vault.writeNote(reopened, nodeNote.id, "written by node");

  // ...and Rust reads all of it back correctly, completing the round trip.
  const reread = mutate([]);
  assert.equal(reread.status, 0, reread.stderr);
  const rereadParsed = JSON.parse(reread.stdout);
  assert.equal(rereadParsed.notes[parsed.createdNotes[1]], "edited by node");
  assert.equal(rereadParsed.notes[nodeNote.id], "written by node");

  // (b) Rust deleting a note Node created moves it to Trash: the manifest entry leaves
  // `notes` and reappears, unchanged, under `trash`, and the encrypted file is not touched.
  const trashedFile = noteFile(root, nodeNote.id);
  const trashedFileBefore = await readFile(trashedFile);
  const deleteParsed = run([{ type: "deleteNote", id: nodeNote.id }]);
  assert.ok(!deleteParsed.manifest.notes.some((note) => note.id === nodeNote.id));
  assert.equal(deleteParsed.manifest.trash.length, 1);
  assert.equal(deleteParsed.manifest.trash[0].kind, "note");
  assert.deepEqual(deleteParsed.manifest.trash[0].meta, { ...nodeNote });
  assert.deepEqual(Object.keys(deleteParsed.manifest.trash[0]), ["kind", "meta", "deletedAt"]);
  assert.deepEqual(await readFile(trashedFile), trashedFileBefore, "deleting must not touch the file");
  assert.ok(!(nodeNote.id in deleteParsed.notes), "a trashed note is not a live note");

  // Node unlocking the branch Rust trashed in must not "recover" the trashed file as an
  // orphan, must list the same Trash Rust lists, and must be able to restore the note.
  const { vault: afterRustTrash, recovery: afterRustTrashRecovery } = await vault.unlockVault(
    root,
    passphrase,
  );
  assert.deepEqual(afterRustTrashRecovery, emptyRecovery);
  assert.ok(!vault.listNotes(afterRustTrash).some((note) => note.id === nodeNote.id));
  assert.deepEqual(vault.listTrash(afterRustTrash), deleteParsed.trash);
  assert.equal(
    deleteParsed.trash[0].expiresAt,
    deleteParsed.trash[0].deletedAt + vault.TRASH_RETENTION_MS,
  );
  const nodeRestored = await vault.restoreTrashItem(afterRustTrash, "note", nodeNote.id);
  assert.deepEqual(nodeRestored, [{ kind: "note", meta: { ...nodeNote } }]);
  assert.equal(await vault.readNote(afterRustTrash, nodeNote.id), "written by node");
  assert.equal(vault.listTrash(afterRustTrash).length, 0);

  // (a) Node trashes a note and a database (and then the folder they were in). Rust must
  // see exactly Node's Trash, restore the note (re-registering its folder chain), and
  // purge the database; only the purge removes a file.
  const doomedDatabase = await vault.createDatabase(
    afterRustTrash,
    "Doomed database",
    "Trash Folder",
    [titleProperty()],
    [],
  );
  const savedNote = await vault.createNote(afterRustTrash, "Trash Folder/Deep", "Saved from Trash");
  await vault.writeNote(afterRustTrash, savedNote.id, "trashed by node, restored by rust 🌿");
  await vault.deleteNote(afterRustTrash, savedNote.id);
  await vault.deleteDatabase(afterRustTrash, doomedDatabase.id);
  await vault.deleteFolder(afterRustTrash, "Trash Folder");
  assert.ok(!vault.listFolders(afterRustTrash).includes("Trash Folder"));

  const rustSeesTrash = run([]);
  assert.deepEqual(rustSeesTrash.manifest, afterRustTrash.manifest);
  assert.deepEqual(rustSeesTrash.trash, vault.listTrash(afterRustTrash));
  assert.deepEqual(
    rustSeesTrash.trash.map((item) => [item.kind, item.id]).sort(),
    [
      ["database", doomedDatabase.id],
      ["note", savedNote.id],
    ].sort(),
  );
  assert.deepEqual(rustSeesTrash.health.checks, (await vault.inspectVault(afterRustTrash)).checks);

  const rustActed = run([
    { type: "restoreTrashItem", kind: "note", id: savedNote.id },
    { type: "purgeTrashItem", kind: "database", id: doomedDatabase.id },
  ]);
  assert.deepEqual(rustActed.restored, [[{ kind: "note", meta: { ...savedNote } }]]);
  assert.deepEqual(rustActed.trash, []);
  assert.equal(rustActed.notes[savedNote.id], "trashed by node, restored by rust 🌿");
  assert.ok(rustActed.manifest.folders.includes("Trash Folder"));
  assert.ok(rustActed.manifest.folders.includes("Trash Folder/Deep"));
  assert.equal(await exists(noteFile(root, savedNote.id)), true);
  assert.equal(await exists(databaseFile(root, doomedDatabase.id)), false, "purge removes the file");

  const { vault: afterRustRestore, recovery: afterRustRestoreRecovery } = await vault.unlockVault(
    root,
    passphrase,
  );
  assert.deepEqual(afterRustRestoreRecovery, emptyRecovery);
  assert.deepEqual(afterRustRestore.manifest, rustActed.manifest);
  assert.equal(vault.listTrash(afterRustRestore).length, 0);
  assert.equal(
    await vault.readNote(afterRustRestore, savedNote.id),
    "trashed by node, restored by rust 🌿",
  );
  assert.equal(
    vault.listNotes(afterRustRestore).find((note) => note.id === savedNote.id).folderPath,
    "Trash Folder/Deep",
  );
  assert.ok(vault.listFolders(afterRustRestore).includes("Trash Folder/Deep"));
  assert.ok(!(await vault.listDatabases(afterRustRestore)).some((d) => d.id === doomedDatabase.id));
  const healthAfterRestore = await vault.inspectVault(afterRustRestore);
  assert.ok(healthAfterRestore.checks.every((check) => check.status === "ok"));
  assert.deepEqual(rustActed.health.checks, healthAfterRestore.checks);

  // Refusals carry the reference implementation's wording.
  await assertSameRefusal(
    vault.restoreTrashItem(afterRustRestore, "note", savedNote.id),
    mutate([{ type: "restoreTrashItem", kind: "note", id: savedNote.id }]),
    /no longer in Trash/,
  );
  await assertSameRefusal(
    vault.purgeTrashItem(afterRustRestore, "database", doomedDatabase.id),
    mutate([{ type: "purgeTrashItem", kind: "database", id: doomedDatabase.id }]),
    /no longer in Trash/,
  );

  // Twin branches: the same Trash operations applied by Node to one copy and by Rust to
  // the other must leave the same manifest, the same readable content, the same health
  // report, and the same set of files on disk after every step.
  {
    const fixture = await vault.createNote(afterRustRestore, "Twin/Inner", "Twin note");
    await vault.writeNote(afterRustRestore, fixture.id, "twin content");
    const second = await vault.createNote(afterRustRestore, "", "Second twin note");
    const twinDatabase = await vault.createDatabase(
      afterRustRestore,
      "Twin database",
      "Twin",
      [titleProperty()],
      [],
    );
    await vault.updateCanvas(afterRustRestore, [
      { id: randomUUID(), kind: "note", targetId: fixture.id, x: 1, y: 2 },
      { id: randomUUID(), kind: "database", targetId: twinDatabase.id, x: 3, y: 4 },
      { id: randomUUID(), kind: "note", targetId: second.id, x: 5, y: 6 },
    ]);
    const nodeTwin = await twinOf(root);
    const rustTwin = await twinOf(root);
    const { vault: nodeSide } = await vault.unlockVault(nodeTwin, passphrase);
    // Unlocking rewrites the manifest; do the same to the Rust twin's starting point so
    // both begin from a manifest Node has just written.
    await vault.unlockVault(rustTwin, passphrase);
    assert.deepEqual(await diskState(rustTwin), await diskState(nodeTwin));

    const steps = [
      {
        name: "delete a note",
        node: () => vault.deleteNote(nodeSide, fixture.id),
        rust: [{ type: "deleteNote", id: fixture.id }],
      },
      {
        name: "delete a folder holding a database",
        node: () => vault.deleteFolder(nodeSide, "Twin"),
        rust: [{ type: "deleteFolder", folderPath: "Twin" }],
      },
      {
        name: "restore the note into its deleted folder",
        node: () => vault.restoreTrashItem(nodeSide, "note", fixture.id),
        rust: [{ type: "restoreTrashItem", kind: "note", id: fixture.id }],
        result: (parsed) => parsed.restored[0],
      },
      {
        name: "delete another note",
        node: () => vault.deleteNote(nodeSide, second.id),
        rust: [{ type: "deleteNote", id: second.id }],
      },
      {
        name: "purge one item",
        node: () => vault.purgeTrashItem(nodeSide, "note", second.id),
        rust: [{ type: "purgeTrashItem", kind: "note", id: second.id }],
      },
      {
        name: "retention sweep before anything has expired",
        node: () => vault.purgeExpiredTrash(nodeSide, Date.now()),
        rust: [{ type: "purgeExpiredTrash", now: Date.now() }],
        result: (parsed) => parsed.purged[0],
      },
      {
        name: "delete the folder again",
        node: () => vault.deleteFolder(nodeSide, "Twin"),
        rust: [{ type: "deleteFolder", folderPath: "Twin" }],
      },
      {
        name: "retention sweep after everything has expired",
        node: () => vault.purgeExpiredTrash(nodeSide, Date.now() + vault.TRASH_RETENTION_MS + 60_000),
        rust: [{ type: "purgeExpiredTrash", now: Date.now() + vault.TRASH_RETENTION_MS + 60_000 }],
        result: (parsed) => parsed.purged[0],
      },
      {
        name: "empty an already empty Trash",
        node: () => vault.emptyTrash(nodeSide),
        rust: [{ type: "emptyTrash" }],
        result: (parsed) => parsed.purged[0],
      },
    ];
    for (const step of steps) {
      const nodeResult = await step.node();
      const rustParsed = run(step.rust, passphrase, rustTwin);
      if (step.result) assert.deepEqual(step.result(rustParsed), nodeResult, step.name);
      assert.deepEqual(await diskState(rustTwin), await diskState(nodeTwin), step.name);
    }
    const finalState = await diskState(rustTwin);
    assert.deepEqual(finalState.trash, []);
    assert.equal(await exists(noteFile(rustTwin, fixture.id)), false);
    assert.equal(await exists(databaseFile(rustTwin, twinDatabase.id)), false);
    const { recovery: twinRecovery } = await vault.unlockVault(rustTwin, passphrase);
    assert.deepEqual(twinRecovery, emptyRecovery);
  }

  // Crash fixture: a note file written but never recorded in the manifest, simulating a
  // process killed between writeNote()'s file write and its manifest write. Node's own
  // reconcileVault() (run automatically on unlock) must recover it without losing content —
  // the same orphan-file recovery path that protects a real Electron/Tauri crash.
  const orphaned = mutate([
    { type: "orphanNoteFile", content: "orphan content survives a crash" },
  ]);
  assert.equal(orphaned.status, 0, orphaned.stderr);
  const orphanId = JSON.parse(orphaned.stdout).orphans[0];
  const beforeRecovery = mutate([]);
  assert.ok(
    !JSON.parse(beforeRecovery.stdout).manifest.notes.some((note) => note.id === orphanId),
    "orphan must not be in the manifest before reconciliation",
  );

  const { vault: recoveredVault, recovery: recoveredReport } = await vault.unlockVault(
    root,
    passphrase,
  );
  assert.deepEqual(recoveredReport.recoveredOrphans, [orphanId]);
  assert.equal(
    await vault.readNote(recoveredVault, orphanId),
    "orphan content survives a crash",
  );
  const recoveredMeta = vault.listNotes(recoveredVault).find((note) => note.id === orphanId);
  assert.equal(recoveredMeta.title, "Recovered note");
  assert.equal(recoveredMeta.folderPath, "");

  assert.notEqual(mutate([], "wrong").status, 0, "a wrong passphrase must be rejected");

  // (d) Attachments. One added by each side must be read back byte-identical by the
  // other, with the same sanitised name and MIME type recorded in the manifest.
  const { vault: attachmentVault } = await vault.unlockVault(root, passphrase);
  const attachmentBytes = Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    randomBytes(70_000),
  ]);
  const rawName = "C:\\Users\\me\\Pho<to> 🌿.PNG";
  const nodeAttachment = await vault.addAttachment(attachmentVault, rawName, "IMAGE/PNG", attachmentBytes);
  const rustAdded = run([
    {
      type: "addAttachment",
      name: rawName,
      mimeType: "IMAGE/PNG",
      dataBase64: attachmentBytes.toString("base64"),
    },
  ]);
  const [rustAttachmentId] = rustAdded.createdAttachments;
  assert.deepEqual(rustAdded.attachments[nodeAttachment.id].meta, nodeAttachment);
  assert.equal(
    rustAdded.attachments[nodeAttachment.id].dataBase64,
    attachmentBytes.toString("base64"),
    "Rust must read Node's attachment back byte-identical",
  );
  const rustAttachmentMeta = rustAdded.attachments[rustAttachmentId].meta;
  assert.deepEqual(Object.keys(rustAttachmentMeta), Object.keys(nodeAttachment));
  assert.deepEqual(
    { ...rustAttachmentMeta, id: "", createdAt: 0 },
    { ...nodeAttachment, id: "", createdAt: 0 },
  );
  for (const id of [nodeAttachment.id, rustAttachmentId]) {
    const onDisk = await readFile(attachmentFile(root, id));
    assert.equal(onDisk.length, 12 + 16 + attachmentBytes.length);
    assert.ok(!onDisk.includes(attachmentBytes.subarray(0, 64)), "attachments are encrypted at rest");
  }

  const { vault: attachmentReader, recovery: attachmentRecovery } = await vault.unlockVault(
    root,
    passphrase,
  );
  assert.deepEqual(attachmentRecovery, emptyRecovery);
  assert.deepEqual(vault.listAttachments(attachmentReader), rustAdded.manifest.attachments);
  const readByNode = await vault.readAttachment(attachmentReader, rustAttachmentId);
  assert.deepEqual(readByNode.meta, rustAttachmentMeta);
  assert.ok(
    readByNode.data.equals(attachmentBytes),
    "Node must read Rust's attachment back byte-identical",
  );

  // Name and MIME sanitising must agree on awkward input, since both end up in the manifest.
  const awkward = [
    ["../../etc/passwd", "text/plain; charset=utf-8"],
    ["  spaced name.txt  ", "Text/Plain"],
    ["", ""],
    ["..", "a/b/c"],
    [".", "image/"],
    ["trailing/", "/png"],
    ["日本語 🌿.pdf", "application/pdf"],
    [`${"x".repeat(300)}.bin`, "application/vnd.x+y-z.1"],
    ["🌿".repeat(150), "x/y"],
    ["a\u0001b\tc?*.md", "TEXT/MARKDOWN"],
    ["\uFEFF bom.txt\u00A0", "text/x\n"],
    ["mixed\\and/separators.tar.gz", `${"a".repeat(61)}/${"b".repeat(61)}`],
    ["   ", `${"a".repeat(62)}/b`],
    ['quote"colon:pipe|.txt', ".text/plain"],
    ["caf\u00e9\u0085.txt", "imag\u00e9/png"],
  ];
  const nodeCleaned = [];
  for (const [name, mimeType] of awkward) {
    const meta = await vault.addAttachment(attachmentReader, name, mimeType, Buffer.from("x"));
    nodeCleaned.push([meta.name, meta.mimeType]);
  }
  const rustCleaned = run(
    awkward.map(([name, mimeType]) => ({
      type: "addAttachment",
      name,
      mimeType,
      dataBase64: Buffer.from("x").toString("base64"),
    })),
  );
  assert.deepEqual(
    rustCleaned.createdAttachments.map((id) => {
      const { name, mimeType } = rustCleaned.attachments[id].meta;
      return [name, mimeType];
    }),
    nodeCleaned,
  );

  // Both refuse an empty file with the same words.
  await assertSameRefusal(
    vault.addAttachment(attachmentReader, "empty.bin", "application/octet-stream", Buffer.alloc(0)),
    mutate([{ type: "addAttachment", name: "empty.bin", mimeType: "application/octet-stream", dataBase64: "" }]),
    /empty/,
  );

  // Unused-attachment cleanup: a live note refers to Node's attachment (in upper case) and a
  // trashed note to Rust's; everything else is unreferenced. Both sides must pick the same
  // set, honour the same 24-hour grace period, and remove the same files.
  {
    const { vault: cleanupVault } = await vault.unlockVault(root, passphrase);
    const referrer = await vault.createNote(cleanupVault, "", "Refers to an attachment");
    await vault.writeNote(
      cleanupVault,
      referrer.id,
      `![image](ATTACHMENT:${nodeAttachment.id.toUpperCase()}) and attachment:not-an-id`,
    );
    const trashedReferrer = await vault.createNote(cleanupVault, "", "Trashed referrer");
    await vault.writeNote(cleanupVault, trashedReferrer.id, `[file](attachment:${rustAttachmentId})`);
    await vault.deleteNote(cleanupVault, trashedReferrer.id);

    const later = Date.now() + 2 * vault.ATTACHMENT_UNUSED_GRACE_MS;
    const nodeUnusedNow = await vault.findUnusedAttachments(cleanupVault);
    const nodeUnusedLater = await vault.findUnusedAttachments(cleanupVault, later);
    assert.deepEqual(nodeUnusedNow, [], "nothing this recent may be reported");
    assert.equal(nodeUnusedLater.length, 2 * awkward.length);
    assert.deepEqual(
      run([], passphrase, root, { unusedAttachmentsNow: Date.now() }).unusedAttachments,
      nodeUnusedNow,
    );
    assert.deepEqual(
      run([], passphrase, root, { unusedAttachmentsNow: later }).unusedAttachments,
      nodeUnusedLater,
    );

    const nodeTwin = await twinOf(root);
    const rustTwin = await twinOf(root);
    const { vault: nodeSide } = await vault.unlockVault(nodeTwin, passphrase);
    await vault.unlockVault(rustTwin, passphrase);
    const nodeRemoved = await vault.removeUnusedAttachments(nodeSide, later);
    const rustRemoved = run([{ type: "removeUnusedAttachments", now: later }], passphrase, rustTwin);
    assert.deepEqual(rustRemoved.removedAttachments, [nodeRemoved]);
    assert.deepEqual(nodeRemoved, { removed: 2 * awkward.length, bytes: 2 * awkward.length });
    const rustTwinState = await diskState(rustTwin);
    assert.deepEqual(rustTwinState, await diskState(nodeTwin));
    assert.deepEqual(Object.keys(rustTwinState.attachments).sort(), [nodeAttachment.id, rustAttachmentId].sort());
    assert.deepEqual(
      rustTwinState.files.filter((file) => file.startsWith(".driftleaf/attachments/")),
      [nodeAttachment.id, rustAttachmentId].map((id) => `.driftleaf/attachments/${id}.enc`).sort(),
    );
    // Restoring the trashed note on the Rust twin still finds its attachment intact.
    const restoredReferrer = run(
      [{ type: "restoreTrashItem", kind: "note", id: trashedReferrer.id }],
      passphrase,
      rustTwin,
    );
    assert.equal(
      restoredReferrer.attachments[rustAttachmentId].dataBase64,
      attachmentBytes.toString("base64"),
    );

    // An unreadable note stops the cleanup on both sides, with the same explanation.
    const damagedTwin = await twinOf(root);
    const { vault: damagedSide } = await vault.unlockVault(damagedTwin, passphrase);
    const damagedBytes = await readFile(noteFile(damagedTwin, referrer.id));
    damagedBytes[20] ^= 1;
    await writeFile(noteFile(damagedTwin, referrer.id), damagedBytes);
    await assertSameRefusal(
      vault.removeUnusedAttachments(damagedSide, later),
      mutate([{ type: "removeUnusedAttachments", now: later }], passphrase, damagedTwin),
      /cannot be worked out safely/,
    );
  }

  // (c) Changing the passphrase. Node changes it first (version 1 -> version 2, wrapped
  // key): Rust must open with the new passphrase and refuse the old one.
  const secondPassphrase = "Neues Passwort ✨ ñandú";
  const thirdPassphrase = "третий пароль 🔑";
  const configFile = path.join(root, ".driftleaf/vault.json");
  const { vault: passphraseVault } = await vault.unlockVault(root, passphrase);
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).version, 1);
  await vault.changeVaultPassphrase(passphraseVault, passphrase, secondPassphrase);
  const nodeConfigText = await readFile(configFile, "utf8");
  const nodeConfig = JSON.parse(nodeConfigText);
  assert.equal(nodeConfig.version, 2);
  assert.match(nodeConfig.wrappedKeyHex, /^[0-9a-f]{120}$/);

  const openedWithNew = run([], secondPassphrase);
  assert.equal(openedWithNew.notes[parsed.createdNotes[0]], "Hello from Rust 🦀 — 日本語");
  assert.equal(
    openedWithNew.attachments[nodeAttachment.id].dataBase64,
    attachmentBytes.toString("base64"),
  );
  await assertSameRefusal(vault.unlockVault(root, passphrase), mutate([], passphrase), /Incorrect passphrase/);
  assert.equal(mutate([], "wrong").stderr.trim(), 'Error: "Incorrect passphrase"');

  // A wrong current passphrase is refused by Rust and changes nothing.
  await assertSameRefusal(
    vault.changeVaultPassphrase(passphraseVault, "not the current one", thirdPassphrase),
    mutate(
      [{ type: "changePassphrase", currentPassphrase: "not the current one", newPassphrase: thirdPassphrase }],
      secondPassphrase,
    ),
    /Current passphrase is incorrect/,
  );
  await assertSameRefusal(
    vault.changeVaultPassphrase(passphraseVault, secondPassphrase, " \t "),
    mutate(
      [{ type: "changePassphrase", currentPassphrase: secondPassphrase, newPassphrase: " \t " }],
      secondPassphrase,
    ),
    /A new passphrase is required/,
  );
  assert.equal(await readFile(configFile, "utf8"), nodeConfigText);

  // Then Rust changes it (version 2 -> version 2, new salt): one atomic rewrite of
  // vault.json and nothing else, laid out exactly as Node writes it.
  const snapshotFiles = async () => {
    const contents = {};
    for (const file of await listFiles(root)) {
      if (file !== ".driftleaf/vault.json") contents[file] = await readFile(path.join(root, file));
    }
    return contents;
  };
  const filesBeforeRustChange = await snapshotFiles();
  const rustChanged = mutate(
    [{ type: "changePassphrase", currentPassphrase: secondPassphrase, newPassphrase: thirdPassphrase }],
    secondPassphrase,
  );
  assert.equal(rustChanged.status, 0, rustChanged.stderr);
  assert.deepEqual(await snapshotFiles(), filesBeforeRustChange, "only vault.json may be rewritten");
  const rustConfigText = await readFile(configFile, "utf8");
  const rustConfig = JSON.parse(rustConfigText);
  assert.equal(rustConfigText, JSON.stringify(rustConfig, null, 2));
  assert.deepEqual(Object.keys(rustConfig), Object.keys(nodeConfig));
  assert.deepEqual(
    { ...rustConfig, saltHex: "", wrappedKeyHex: "" },
    { ...nodeConfig, saltHex: "", wrappedKeyHex: "" },
  );
  assert.match(rustConfig.saltHex, /^[0-9a-f]{32}$/);
  assert.match(rustConfig.wrappedKeyHex, /^[0-9a-f]{120}$/);
  assert.notEqual(rustConfig.saltHex, nodeConfig.saltHex);
  assert.notEqual(rustConfig.wrappedKeyHex, nodeConfig.wrappedKeyHex);

  assert.equal(await vault.vaultHasPassphrase(root), true);
  await assert.rejects(vault.unlockVault(root, secondPassphrase), /Incorrect passphrase/);
  await assert.rejects(vault.unlockVault(root, passphrase), /Incorrect passphrase/);
  const { vault: openedByNode, recovery: passphraseRecovery } = await vault.unlockVault(
    root,
    thirdPassphrase,
  );
  assert.deepEqual(passphraseRecovery, emptyRecovery);
  assert.equal(await vault.readNote(openedByNode, parsed.createdNotes[0]), "Hello from Rust 🦀 — 日本語");
  assert.ok((await vault.readAttachment(openedByNode, rustAttachmentId)).data.equals(attachmentBytes));
  assert.notEqual(mutate([], secondPassphrase).status, 0, "Rust must refuse its own old passphrase");
  assert.equal(run([], thirdPassphrase).notes[parsed.createdNotes[1]], "edited by node");

  // And Node can change it again on top of the config Rust wrote.
  await vault.changeVaultPassphrase(openedByNode, thirdPassphrase, passphrase);
  assert.notEqual(mutate([], thirdPassphrase).status, 0);
  assert.equal(run([]).notes[parsed.createdNotes[1]], "edited by node");

  // A version-1 branch changed by Rust first (the 1 -> 2 upgrade done natively).
  {
    const upgradeRoot = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-mutate-upgrade-"));
    temporaryRoots.push(upgradeRoot);
    const fresh = await vault.createVault(upgradeRoot, passphrase, "blank");
    const upgradeNote = await vault.createNote(fresh, "", "Survives the upgrade");
    await vault.writeNote(fresh, upgradeNote.id, "same data key, new wrapping");
    const upgraded = run(
      [{ type: "changePassphrase", currentPassphrase: passphrase, newPassphrase: secondPassphrase }],
      passphrase,
      upgradeRoot,
    );
    assert.equal(upgraded.notes[upgradeNote.id], "same data key, new wrapping");
    assert.equal(JSON.parse(await readFile(path.join(upgradeRoot, ".driftleaf/vault.json"), "utf8")).version, 2);
    await assert.rejects(vault.unlockVault(upgradeRoot, passphrase), /Incorrect passphrase/);
    const { vault: upgradedVault } = await vault.unlockVault(upgradeRoot, secondPassphrase);
    assert.equal(await vault.readNote(upgradedVault, upgradeNote.id), "same data key, new wrapping");
    assert.notEqual(mutate([], passphrase, upgradeRoot).status, 0);
    // A version newer than either side knows is refused by both with the same message.
    await writeFile(
      path.join(upgradeRoot, ".driftleaf/vault.json"),
      JSON.stringify({ version: 3, kdf: "scrypt", saltHex: "00".repeat(16) }),
    );
    await assertSameRefusal(
      vault.unlockVault(upgradeRoot, secondPassphrase),
      mutate([], secondPassphrase, upgradeRoot),
      /newer version of Driftleaf/,
    );
  }

  console.log(
    "Rust creates, writes, renames, and trashes notes and folders that Node reads and " +
      "reconciles without repair; Node's own writes round-trip back through Rust; Trash " +
      "(delete, restore, purge, empty, retention sweep) and unused-attachment cleanup leave " +
      "identical branches whichever side runs them; attachments added by either side are read " +
      "back byte-identical by the other; a passphrase changed by either side opens only with " +
      "the new passphrase on the other; and a note file orphaned by a simulated crash is " +
      "recovered by Node's reconciliation.",
  );
} finally {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true });
}
