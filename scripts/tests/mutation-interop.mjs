import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

function mutate(ops, password = passphrase) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase: password, ops }),
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

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

  // Rust deleting a note Node created must remove both the manifest entry and the file.
  const afterDelete = mutate([{ type: "deleteNote", id: nodeNote.id }]);
  assert.equal(afterDelete.status, 0, afterDelete.stderr);
  const deleteParsed = JSON.parse(afterDelete.stdout);
  assert.ok(!deleteParsed.manifest.notes.some((note) => note.id === nodeNote.id));
  await assert.rejects(readFile(path.join(root, ".driftleaf/notes", `${nodeNote.id}.enc`)));

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

  console.log(
    "Rust creates, writes, renames, and deletes notes and folders that Node reads and " +
      "reconciles without repair; Node's own writes round-trip back through Rust; and a " +
      "note file orphaned by a simulated crash is recovered by Node's reconciliation.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
