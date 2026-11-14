import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as vault from "../../src/main/vault.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-database-"));
const passphrase = "Test fixture 🌿 café";

const temporaryRoots = [root];

function mutate(ops, target = root) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root: target, passphrase, ops }),
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

function run(ops, target = root) {
  const result = mutate(ops, target);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

const databaseFile = (target, id) => path.join(target, ".driftleaf", `${id}.db.enc`);
const noteFile = (target, id) => path.join(target, ".driftleaf/notes", `${id}.enc`);
const emptyRecovery = { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] };

// A byte-for-byte copy of a branch, so the same operation can be applied by Node to one
// copy and by Rust to the other and the two results compared.
async function twinOf(source) {
  const copy = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-database-twin-"));
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
// branches can be compared like for like. Only the Trash timestamps, which legitimately
// differ between two runs of the same operation, are blanked.
async function diskState(target) {
  const read = run([], target);
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
    canvas: read.canvas,
    health: read.health.checks,
    files: await listFiles(target),
  };
}

// The example binary exits with `Error: "<message>"` (Rust's Debug form of the error
// string), which for these messages is exactly `Error: ${JSON.stringify(message)}`.
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

try {
  await vault.createVault(root, passphrase, "blank");

  // Rust builds two related databases, a canvas item, and an extension in one pass:
  // "Tasks" (a plain database) and "Projects" (which relates to it), with a row in
  // Projects whose relation value points at a row in Tasks.
  const canvasItemId = randomUUID();
  const built = run([
    { type: "createFolder", folderPath: "Folder A" },
    {
      type: "createDatabase",
      title: "Tasks",
      folderPath: "Folder A",
      properties: [
        { id: "p_title", name: "Name", type: "title" },
        { id: "p_status", name: "Status", type: "select", options: ["Todo", "Done"] },
      ],
      rows: [],
    },
    { type: "createDatabaseRow", id: "$db:0" },
    {
      type: "createDatabase",
      title: "Projects",
      folderPath: "",
      properties: [
        { id: "p_title2", name: "Name", type: "title" },
        { id: "p_rel", name: "Related", type: "relation", relationDatabaseId: "$db:0" },
      ],
      rows: [],
    },
    { type: "createDatabaseRow", id: "$db:1" },
    {
      type: "updateDatabase",
      id: "$db:1",
      properties: [
        { id: "p_title2", name: "Name", type: "title" },
        { id: "p_rel", name: "Related", type: "relation", relationDatabaseId: "$db:0" },
      ],
      rows: [{ id: "$row:1", values: { p_title2: "P1", p_rel: ["$row:0"] } }],
    },
    {
      type: "updateCanvas",
      items: [{ id: canvasItemId, kind: "database", targetId: "$db:0", x: 10, y: 20 }],
    },
    { type: "installExtension", name: "Ext1", source: "void 0;" },
    {
      type: "setExtensionPermissions",
      id: "$ext:0",
      permissions: ["read_databases"],
      databaseIds: ["$db:0"],
    },
  ]);
  const [tasksId, projectsId] = built.createdDatabases;
  const [tasksRowId, projectsRowId] = built.createdRows;

  // createDatabaseRow()'s per-type defaults: title/select both fall through to null;
  // checkbox/multi_select/relation are specifically defaulted elsewhere (not exercised by
  // this particular row, which has neither).
  assert.deepEqual(built.databases[tasksId].rows[0].values, { p_title: null, p_status: null });
  assert.deepEqual(built.databases[projectsId].rows[0].values, {
    p_title2: "P1",
    p_rel: [tasksRowId],
  });
  assert.equal(built.canvas.length, 1);
  assert.equal(built.canvas[0].targetId, tasksId);
  assert.equal(built.extensions.length, 1);
  assert.deepEqual(built.extensions[0].databaseIds, [tasksId]);

  // Node, unlocking (and so reconciling) what Rust just wrote, must see the identical
  // structure through its own reads — no repair needed, same as the note/folder fixture.
  const { vault: v1, recovery } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(recovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
  assert.equal((await vault.listDatabases(v1)).length, 2);
  const tasksFromNode = await vault.readDatabase(v1, tasksId);
  assert.equal(tasksFromNode.meta.folderPath, "Folder A");
  const projectsFromNode = await vault.readDatabase(v1, projectsId);
  assert.deepEqual(projectsFromNode.rows[0].values.p_rel, [tasksRowId]);
  assert.deepEqual(vault.listExtensions(v1)[0].databaseIds, [tasksId]);
  assert.equal(vault.readCanvas(v1)[0].targetId, tasksId);
  assert.ok(vault.listFolders(v1).includes("Folder A"));

  // Node deletes the Tasks row Projects relates to — its own clearRelationToRow cascade
  // must clear Projects' relation value. Rust reading the branch afterward (no ops; a pure
  // read pass) must see that cascade exactly as Node left it.
  await vault.deleteDatabaseRow(v1, tasksId, tasksRowId);
  const afterNodeDelete = run([]);
  assert.deepEqual(afterNodeDelete.databases[projectsId].rows[0].values.p_rel, []);

  // Tasks is still linked from Projects' *property* (independent of row content) — Rust
  // deleting it must be refused, matching deleteDatabase()'s guard in vault.ts.
  const blocked = mutate([{ type: "deleteDatabase", id: tasksId }]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /linked from/);

  // Once Rust itself removes the relation (a schema change empties Projects down to its
  // title property), the same delete succeeds.
  run([
    {
      type: "updateDatabase",
      id: projectsId,
      properties: [{ id: "p_title2", name: "Name", type: "title" }],
      rows: [{ id: projectsRowId, values: { p_title2: "P1" } }],
    },
    { type: "deleteDatabase", id: tasksId },
  ]);
  // The delete moved Tasks to Trash: gone from the live list, file still in place, and
  // Node (which must not report anything to repair) lists it as restorable.
  const { vault: v2, recovery: recoveryAfterDelete } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(recoveryAfterDelete, emptyRecovery);
  assert.deepEqual(
    (await vault.listDatabases(v2)).map((d) => d.id),
    [projectsId],
  );
  assert.equal(await exists(databaseFile(root, tasksId)), true, "deleting must keep the file");
  assert.deepEqual(
    vault.listTrash(v2).map((item) => [item.kind, item.id, item.title, item.folderPath]),
    [["database", tasksId, "Tasks", "Folder A"]],
  );
  assert.ok((await vault.inspectVault(v2)).checks.every((check) => check.status === "ok"));
  // Only a purge removes the file.
  const purged = run([{ type: "purgeTrashItem", kind: "database", id: tasksId }]);
  assert.deepEqual(purged.trash, []);
  assert.equal(await exists(databaseFile(root, tasksId)), false);

  // A database inside a folder, still linked from a database outside it (the reverse of
  // the direct-delete guard above), must block deleting that folder — and succeed once
  // the outside database drops the relation.
  const guardSetup = run([
    { type: "createFolder", folderPath: "Blocked" },
    {
      type: "createDatabase",
      title: "Inside",
      folderPath: "Blocked",
      properties: [{ id: "t", name: "Name", type: "title" }],
      rows: [],
    },
    {
      type: "createDatabase",
      title: "Outside",
      folderPath: "",
      properties: [
        { id: "t2", name: "Name", type: "title" },
        { id: "rel", name: "Related", type: "relation", relationDatabaseId: "$db:0" },
      ],
      rows: [],
    },
  ]);
  const [insideId, outsideId] = guardSetup.createdDatabases;
  const folderBlocked = mutate([{ type: "deleteFolder", folderPath: "Blocked" }]);
  assert.notEqual(folderBlocked.status, 0);
  assert.match(folderBlocked.stderr, /linked from/);
  run([
    {
      type: "updateDatabase",
      id: outsideId,
      properties: [{ id: "t2", name: "Name", type: "title" }],
      rows: [],
    },
    { type: "deleteFolder", folderPath: "Blocked" },
  ]);
  const { vault: v3 } = await vault.unlockVault(root, passphrase);
  assert.ok(!vault.listFolders(v3).includes("Blocked"));
  assert.ok(!(await vault.listDatabases(v3)).some((d) => d.id === insideId));
  assert.equal(await exists(databaseFile(root, insideId)), true, "a folder delete keeps the files");
  assert.deepEqual(
    vault.listTrash(v3).map((item) => [item.kind, item.id, item.folderPath]),
    [["database", insideId, "Blocked"]],
  );
  // Node restores what Rust's folder delete trashed, and the folder comes back with it.
  await vault.restoreTrashItem(v3, "database", insideId);
  assert.ok(vault.listFolders(v3).includes("Blocked"));
  assert.equal((await vault.readDatabase(v3, insideId)).meta.title, "Inside");

  // Plain folder rename/move/delete, with a note and an unrelated database inside —
  // Rust's rename must cascade to both, and delete must move both to Trash (files kept)
  // until Rust empties it.
  const movable = run([
    { type: "createFolder", folderPath: "Movable" },
    { type: "createNote", folderPath: "Movable", title: "Movable note" },
    {
      type: "createDatabase",
      title: "Movable db",
      folderPath: "Movable",
      properties: [{ id: "t", name: "Name", type: "title" }],
      rows: [],
    },
    { type: "renameFolder", oldFolderPath: "Movable", newFolderPath: "Renamed" },
  ]);
  const [movableNoteId] = movable.createdNotes;
  const [movableDbId] = movable.createdDatabases.slice(-1);
  assert.equal(movable.manifest.notes.find((n) => n.id === movableNoteId).folderPath, "Renamed");
  assert.equal(
    movable.manifest.databases.find((d) => d.id === movableDbId).folderPath,
    "Renamed",
  );
  const folderDeleted = run([{ type: "deleteFolder", folderPath: "Renamed" }]);
  assert.deepEqual(
    folderDeleted.manifest.trash.map((entry) => [entry.kind, entry.meta.id, entry.meta.folderPath]),
    [
      ["note", movableNoteId, "Renamed"],
      ["database", movableDbId, "Renamed"],
    ],
  );
  assert.equal(
    folderDeleted.manifest.trash[0].deletedAt,
    folderDeleted.manifest.trash[1].deletedAt,
    "one folder delete stamps every entry with the same time",
  );
  const { vault: v4, recovery: recoveryAfterFolderDelete } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(recoveryAfterFolderDelete, emptyRecovery);
  assert.ok(!vault.listFolders(v4).includes("Renamed"));
  assert.ok(!vault.listNotes(v4).some((n) => n.id === movableNoteId));
  assert.ok(!(await vault.listDatabases(v4)).some((d) => d.id === movableDbId));
  assert.deepEqual(vault.listTrash(v4), folderDeleted.trash);
  assert.equal(await exists(noteFile(root, movableNoteId)), true);
  assert.equal(await exists(databaseFile(root, movableDbId)), true);
  const emptied = run([{ type: "emptyTrash" }]);
  assert.deepEqual(emptied.purged, [2]);
  assert.equal(await exists(noteFile(root, movableNoteId)), false);
  assert.equal(await exists(databaseFile(root, movableDbId)), false);

  // removeExtension, the last piece not yet exercised.
  run([{ type: "removeExtension", id: built.createdExtensions[0] }]);
  const { vault: v5 } = await vault.unlockVault(root, passphrase);
  assert.equal(vault.listExtensions(v5).length, 0);

  // Relations must never dangle across Trash. A chain Archive -> Tasks -> People is built
  // by Node, the branch is copied twice, and the same sequence of deletes, refusals,
  // restores, and purges is run by Node on one copy and by Rust on the other. After every
  // step the two copies must hold the same manifest, the same readable databases, the same
  // health report, and the same files; every refusal must carry the same message.
  {
    const title = (id) => ({ id, name: "Name", type: "title" });
    const relation = (id, target) => ({ id, name: "Related", type: "relation", relationDatabaseId: target });
    await vault.createFolder(v5, "Work");
    const people = await vault.createDatabase(v5, "People", "Work", [title("t")], []);
    const linked = await vault.createDatabase(
      v5,
      "Linked tasks",
      "Work",
      [title("t"), relation("r", people.id)],
      [],
    );
    const archive = await vault.createDatabase(
      v5,
      "Archive",
      "Work/Old",
      [title("t"), relation("r", linked.id)],
      [],
    );
    const bystander = await vault.createNote(v5, "Work/Old", "Bystander note");
    await vault.writeNote(v5, bystander.id, "goes to Trash with its folder");
    await vault.updateCanvas(v5, [
      { id: randomUUID(), kind: "database", targetId: people.id, x: 1, y: 1 },
      { id: randomUUID(), kind: "database", targetId: archive.id, x: 2, y: 2 },
      { id: randomUUID(), kind: "note", targetId: bystander.id, x: 3, y: 3 },
    ]);

    const nodeTwin = await twinOf(root);
    const rustTwin = await twinOf(root);
    const { vault: nodeSide } = await vault.unlockVault(nodeTwin, passphrase);
    await vault.unlockVault(rustTwin, passphrase);
    assert.deepEqual(await diskState(rustTwin), await diskState(nodeTwin));

    const steps = [
      {
        name: "delete the end of the chain",
        node: () => vault.deleteDatabase(nodeSide, archive.id),
        rust: [{ type: "deleteDatabase", id: archive.id }],
      },
      {
        name: "a database something in Trash links to cannot be deleted",
        node: () => vault.deleteDatabase(nodeSide, linked.id),
        rust: [{ type: "deleteDatabase", id: linked.id }],
        refused: /A database in Trash, "Archive", links to this/,
      },
      {
        name: "nor can its folder",
        node: () => vault.deleteFolder(nodeSide, "Work"),
        rust: [{ type: "deleteFolder", folderPath: "Work" }],
        refused: /A database in Trash, "Archive", links to this/,
      },
      {
        name: "a database a live one links to still cannot be deleted",
        node: () => vault.deleteDatabase(nodeSide, people.id),
        rust: [{ type: "deleteDatabase", id: people.id }],
        refused: /Database is linked from "Linked tasks"/,
      },
      {
        name: "restore the end of the chain",
        node: () => vault.restoreTrashItem(nodeSide, "database", archive.id),
        rust: [{ type: "restoreTrashItem", kind: "database", id: archive.id }],
        result: (parsed) => parsed.restored[0],
        expectRestored: [archive.id],
      },
      {
        name: "delete the whole folder",
        node: () => vault.deleteFolder(nodeSide, "Work"),
        rust: [{ type: "deleteFolder", folderPath: "Work" }],
      },
      {
        name: "a linked target cannot be purged on its own",
        node: () => vault.purgeTrashItem(nodeSide, "database", people.id),
        rust: [{ type: "purgeTrashItem", kind: "database", id: people.id }],
        refused: /A database in Trash, "Linked tasks", links to this/,
      },
      {
        name: "nor can the middle of the chain",
        node: () => vault.purgeTrashItem(nodeSide, "database", linked.id),
        rust: [{ type: "purgeTrashItem", kind: "database", id: linked.id }],
        refused: /A database in Trash, "Archive", links to this/,
      },
      {
        name: "restoring the middle brings its target back with it",
        node: () => vault.restoreTrashItem(nodeSide, "database", linked.id),
        rust: [{ type: "restoreTrashItem", kind: "database", id: linked.id }],
        result: (parsed) => parsed.restored[0],
        expectRestored: [linked.id, people.id],
      },
      {
        name: "the folder cannot be deleted while Trash still links into it",
        node: () => vault.deleteFolder(nodeSide, "Work"),
        rust: [{ type: "deleteFolder", folderPath: "Work" }],
        refused: /A database in Trash, "Archive", links to this/,
      },
      {
        name: "restoring the end of the chain alone, its targets being live",
        node: () => vault.restoreTrashItem(nodeSide, "database", archive.id),
        rust: [{ type: "restoreTrashItem", kind: "database", id: archive.id }],
        result: (parsed) => parsed.restored[0],
        expectRestored: [archive.id],
      },
      {
        name: "delete the folder again",
        node: () => vault.deleteFolder(nodeSide, "Work"),
        rust: [{ type: "deleteFolder", folderPath: "Work" }],
      },
      {
        name: "restoring the end of the chain restores all of it, transitively",
        node: () => vault.restoreTrashItem(nodeSide, "database", archive.id),
        rust: [{ type: "restoreTrashItem", kind: "database", id: archive.id }],
        result: (parsed) => parsed.restored[0],
        expectRestored: [archive.id, linked.id, people.id],
      },
      {
        name: "restore the note that went with the folder",
        node: () => vault.restoreTrashItem(nodeSide, "note", bystander.id),
        rust: [{ type: "restoreTrashItem", kind: "note", id: bystander.id }],
        result: (parsed) => parsed.restored[0],
        expectRestored: [bystander.id],
      },
      {
        name: "delete everything and empty Trash",
        node: async () => {
          await vault.deleteFolder(nodeSide, "Work");
          return vault.emptyTrash(nodeSide);
        },
        rust: [{ type: "deleteFolder", folderPath: "Work" }, { type: "emptyTrash" }],
        result: (parsed) => parsed.purged[0],
      },
    ];
    for (const step of steps) {
      if (step.refused) {
        await assertSameRefusal(step.node(), mutate(step.rust, rustTwin), step.refused);
      } else {
        const nodeResult = await step.node();
        const rustParsed = run(step.rust, rustTwin);
        if (step.result) assert.deepEqual(step.result(rustParsed), nodeResult, step.name);
        if (step.expectRestored) {
          assert.deepEqual(nodeResult.map((item) => item.meta.id), step.expectRestored, step.name);
        }
      }
      assert.deepEqual(await diskState(rustTwin), await diskState(nodeTwin), step.name);
    }
    const finalState = await diskState(rustTwin);
    assert.deepEqual(finalState.trash, []);
    for (const id of [people.id, linked.id, archive.id]) {
      assert.equal(await exists(databaseFile(rustTwin, id)), false);
    }
    assert.equal(await exists(noteFile(rustTwin, bystander.id)), false);
    const { vault: rustTwinVault, recovery: twinRecovery } = await vault.unlockVault(rustTwin, passphrase);
    assert.deepEqual(twinRecovery, emptyRecovery);
    assert.deepEqual(rustTwinVault.manifest, nodeSide.manifest);

    // Retention sweep. People has expired but Linked tasks, which links to it, has not, so
    // People must be kept; Archive and the note have expired with nothing fresh holding
    // them. The same manifest (same timestamps) is given to both sides.
    await vault.deleteFolder(v5, "Work");
    const now = Date.now();
    const expired = now - vault.TRASH_RETENTION_MS;
    for (const entry of v5.manifest.trash) {
      if (entry.meta.id !== linked.id) entry.deletedAt = expired;
    }
    await vault.createFolder(v5, "Persist the edited timestamps");
    const nodeSweepTwin = await twinOf(root);
    const rustSweepTwin = await twinOf(root);
    const { vault: nodeSweep } = await vault.unlockVault(nodeSweepTwin, passphrase);
    // unlockVault() runs the sweep itself, with the real clock: the same outcome as below.
    assert.deepEqual(
      vault.listTrash(nodeSweep).map((item) => item.id).sort(),
      [people.id, linked.id].sort(),
    );
    const firstSweep = run([{ type: "purgeExpiredTrash", now }], rustSweepTwin);
    assert.deepEqual(firstSweep.purged, [2]);
    assert.deepEqual(await diskState(rustSweepTwin), await diskState(nodeSweepTwin));
    assert.equal(await exists(databaseFile(rustSweepTwin, people.id)), true);
    assert.equal(await exists(databaseFile(rustSweepTwin, archive.id)), false);
    assert.equal(await exists(noteFile(rustSweepTwin, bystander.id)), false);
    const farFuture = now + 2 * vault.TRASH_RETENTION_MS;
    assert.equal(await vault.purgeExpiredTrash(nodeSweep, farFuture), 2);
    assert.deepEqual(run([{ type: "purgeExpiredTrash", now: farFuture }], rustSweepTwin).purged, [2]);
    assert.deepEqual(await diskState(rustSweepTwin), await diskState(nodeSweepTwin));
  }

  console.log(
    "Rust creates, updates, and trashes related databases, canvas items, and extensions " +
      "that Node reads and reconciles correctly; Node's own row-delete relation cascade " +
      "round-trips back through Rust; the direct-delete and folder-delete database-relation " +
      "guards block and then succeed exactly as vault.ts does; and deletes, refusals, " +
      "restores (including linked databases), purges, and the retention sweep across Trash " +
      "leave identical branches whether Node or Rust runs them.",
  );
} finally {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true });
}
