import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

function mutate(ops) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase, ops }),
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

function run(ops) {
  const result = mutate(ops);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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
  const { vault: v2 } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(
    (await vault.listDatabases(v2)).map((d) => d.id),
    [projectsId],
  );
  await assert.rejects(readFile(path.join(root, ".driftleaf", `${tasksId}.db.enc`)));

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
  await assert.rejects(readFile(path.join(root, ".driftleaf", `${insideId}.db.enc`)));

  // Plain folder rename/move/delete, with a note and an unrelated database inside —
  // Rust's rename must cascade to both, and delete must remove both along with their files.
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
  run([{ type: "deleteFolder", folderPath: "Renamed" }]);
  const { vault: v4 } = await vault.unlockVault(root, passphrase);
  assert.ok(!vault.listFolders(v4).includes("Renamed"));
  assert.ok(!vault.listNotes(v4).some((n) => n.id === movableNoteId));
  assert.ok(!(await vault.listDatabases(v4)).some((d) => d.id === movableDbId));

  // removeExtension, the last piece not yet exercised.
  run([{ type: "removeExtension", id: built.createdExtensions[0] }]);
  const { vault: v5 } = await vault.unlockVault(root, passphrase);
  assert.equal(vault.listExtensions(v5).length, 0);

  console.log(
    "Rust creates, updates, and deletes related databases, canvas items, and extensions " +
      "that Node reads and reconciles correctly; Node's own row-delete relation cascade " +
      "round-trips back through Rust; and both the direct-delete and folder-delete " +
      "database-relation guards block and then succeed exactly as vault.ts does.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
