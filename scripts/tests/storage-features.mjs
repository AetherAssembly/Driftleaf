// Storage-level tests for Trash, passphrase change, attachments, and plaintext export.
// These run the production TypeScript in src/main directly (no service, no shell), the same
// way data-loss-integration.mjs does. Service-level coverage of the same features lives in
// regressions.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import * as vault from "../../src/main/vault.ts";
import { exportBranchPlaintext } from "../../src/main/branch-export.ts";

const PASSPHRASE = "correct horse 🌿 battery";

async function withBranch(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-features-"));
  try {
    const branch = await vault.createVault(root, PASSPHRASE, "blank");
    await run(branch, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const noteFile = (root, id) => path.join(root, ".driftleaf", "notes", `${id}.enc`);
const databaseFile = (root, id) => path.join(root, ".driftleaf", `${id}.db.enc`);
const attachmentFile = (root, id) => path.join(root, ".driftleaf", "attachments", `${id}.enc`);
const titleProperty = () => ({ id: randomUUID(), name: "Title", type: "title" });

test("deleting a note moves it to Trash without touching its file, and restore brings it back", async () => {
  await withBranch(async (branch, root) => {
    await vault.createFolder(branch, "Projects");
    const note = await vault.createNote(branch, "Projects", "Plan");
    await vault.writeNote(branch, note.id, "the plan");
    const before = await readFile(noteFile(root, note.id));

    await vault.deleteNote(branch, note.id);
    assert.ok(!vault.listNotes(branch).some((n) => n.id === note.id));
    assert.deepEqual(await readFile(noteFile(root, note.id)), before, "ciphertext is untouched");
    const [trashed] = vault.listTrash(branch);
    assert.equal(trashed.id, note.id);
    assert.equal(trashed.kind, "note");
    assert.equal(trashed.title, "Plan");
    assert.equal(trashed.folderPath, "Projects");
    assert.equal(trashed.expiresAt, trashed.deletedAt + vault.TRASH_RETENTION_MS);
    await assert.rejects(vault.readNote(branch, note.id), /Note not found/);

    // Reopening must not mistake the trashed file for a crash orphan.
    const { vault: reopened, recovery } = await vault.unlockVault(root, PASSPHRASE);
    assert.deepEqual(recovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
    assert.equal(vault.listTrash(reopened).length, 1);
    assert.ok(!vault.listNotes(reopened).some((n) => n.id === note.id));

    // The folder is deleted while the note sits in Trash; restore must recreate it.
    await vault.deleteFolder(reopened, "Projects");
    assert.ok(!vault.listFolders(reopened).includes("Projects"));
    const restored = await vault.restoreTrashItem(reopened, "note", note.id);
    assert.deepEqual(restored.map((item) => item.meta.id), [note.id]);
    assert.ok(vault.listFolders(reopened).includes("Projects"));
    assert.equal(await vault.readNote(reopened, note.id), "the plan");
    assert.equal(vault.listTrash(reopened).length, 0);
    await assert.rejects(
      vault.restoreTrashItem(reopened, "note", note.id),
      /no longer in Trash/,
    );
  });
});

test("purging, emptying, and the retention sweep are the only things that remove files", async () => {
  await withBranch(async (branch, root) => {
    const a = await vault.createNote(branch, "", "A");
    const b = await vault.createNote(branch, "", "B");
    const c = await vault.createNote(branch, "", "C");
    const database = await vault.createDatabase(branch, "Tasks", "", [titleProperty()], []);
    for (const note of [a, b, c]) await vault.deleteNote(branch, note.id);
    await vault.deleteDatabase(branch, database.id);
    assert.ok(await exists(databaseFile(root, database.id)));

    await vault.purgeTrashItem(branch, "note", a.id);
    assert.equal(await exists(noteFile(root, a.id)), false);
    assert.ok(await exists(noteFile(root, b.id)));
    await assert.rejects(vault.purgeTrashItem(branch, "note", a.id), /no longer in Trash/);

    // Nothing has expired yet.
    assert.equal(await vault.purgeExpiredTrash(branch), 0);
    assert.equal(vault.listTrash(branch).length, 3);

    // Age one entry past retention; only that one goes, on the next unlock.
    branch.manifest.trash.find((entry) => entry.meta.id === b.id).deletedAt -=
      vault.TRASH_RETENTION_MS + 1;
    await vault.writeNote(branch, vault.listNotes(branch)[0].id, "persist the manifest");
    const { vault: reopened } = await vault.unlockVault(root, PASSPHRASE);
    assert.equal(await exists(noteFile(root, b.id)), false);
    assert.deepEqual(
      vault.listTrash(reopened).map((item) => item.id).sort(),
      [c.id, database.id].sort(),
    );

    assert.equal(await vault.emptyTrash(reopened), 2);
    assert.equal(await exists(noteFile(root, c.id)), false);
    assert.equal(await exists(databaseFile(root, database.id)), false);
    assert.equal(vault.listTrash(reopened).length, 0);

    const report = await vault.inspectVault(reopened);
    assert.ok(report.checks.every((check) => check.status === "ok"), JSON.stringify(report.checks));
  });
});

test("the health check treats trashed files as accounted for", async () => {
  await withBranch(async (branch) => {
    const note = await vault.createNote(branch, "", "Gone");
    const database = await vault.createDatabase(branch, "Gone too", "", [titleProperty()], []);
    await vault.deleteNote(branch, note.id);
    await vault.deleteDatabase(branch, database.id);
    const report = await vault.inspectVault(branch);
    assert.ok(report.checks.every((check) => check.status === "ok"), JSON.stringify(report.checks));
    assert.match(report.checks.find((check) => check.name === "Trash").details, /2 deleted item/);
  });
});

test("a Trash entry whose file has vanished is dropped, and a damaged entry cannot block unlock", async () => {
  await withBranch(async (branch, root) => {
    const note = await vault.createNote(branch, "", "Vanishing");
    const keeper = await vault.createNote(branch, "", "Keeper");
    await vault.deleteNote(branch, note.id);
    await rm(noteFile(root, note.id));
    branch.manifest.trash.push({ kind: "note", meta: { id: "not-a-uuid" }, deletedAt: "soon" });
    await vault.writeNote(branch, keeper.id, "persist the manifest");

    const { vault: reopened, recovery } = await vault.unlockVault(root, PASSPHRASE);
    assert.deepEqual(recovery.recoveredOrphans, []);
    assert.equal(vault.listTrash(reopened).length, 0);
    assert.equal(await vault.readNote(reopened, keeper.id), "persist the manifest");
  });
});

test("a trashed note that an older Driftleaf recovered as an orphan keeps its title and folder", async () => {
  await withBranch(async (branch, root) => {
    await vault.createFolder(branch, "Ideas");
    const note = await vault.createNote(branch, "Ideas", "Real title");
    await vault.writeNote(branch, note.id, "body");
    await vault.deleteNote(branch, note.id);
    // What a pre-Trash release does on unlock: it does not know the file is claimed by
    // Trash, so it re-adds it as a root-level "Recovered note" and leaves `trash` alone.
    branch.manifest.notes.push({
      id: note.id,
      title: "Recovered note",
      folderPath: "",
      fileName: `${note.id}.enc`,
      updatedAt: Date.now(),
    });
    await vault.writeNote(branch, note.id, "body");

    const { vault: reopened } = await vault.unlockVault(root, PASSPHRASE);
    const live = vault.listNotes(reopened).filter((n) => n.id === note.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].title, "Real title");
    assert.equal(live[0].folderPath, "Ideas");
    assert.equal(vault.listTrash(reopened).length, 0);
  });
});

test("database relations never dangle across Trash", async () => {
  await withBranch(async (branch) => {
    await vault.createFolder(branch, "Work");
    const people = await vault.createDatabase(branch, "People", "Work", [titleProperty()], []);
    const tasks = await vault.createDatabase(
      branch,
      "Tasks",
      "Work",
      [
        titleProperty(),
        { id: randomUUID(), name: "Owner", type: "relation", relationDatabaseId: people.id },
      ],
      [],
    );

    // Tasks (which links to People) goes to Trash alone. People must then be undeletable.
    await vault.deleteDatabase(branch, tasks.id);
    await assert.rejects(vault.deleteDatabase(branch, people.id), /A database in Trash, "Tasks"/);
    await assert.rejects(vault.deleteFolder(branch, "Work"), /A database in Trash, "Tasks"/);
    await vault.restoreTrashItem(branch, "database", tasks.id);

    // Deleted together by a folder delete, both sit in Trash. Purging the target alone is
    // refused, and restoring the linking database brings its target back with it.
    await vault.deleteFolder(branch, "Work");
    assert.equal(vault.listTrash(branch).length, 2);
    await assert.rejects(
      vault.purgeTrashItem(branch, "database", people.id),
      /A database in Trash, "Tasks"/,
    );
    const restored = await vault.restoreTrashItem(branch, "database", tasks.id);
    assert.deepEqual(restored.map((item) => item.meta.id).sort(), [people.id, tasks.id].sort());
    assert.equal(vault.listTrash(branch).length, 0);
    assert.ok(vault.listFolders(branch).includes("Work"));
    const data = await vault.readDatabase(branch, tasks.id);
    assert.equal(data.properties[1].relationDatabaseId, people.id);

    // The retention sweep keeps a target alive while something unexpired still links to it.
    await vault.deleteFolder(branch, "Work");
    branch.manifest.trash.find((entry) => entry.meta.id === people.id).deletedAt -=
      vault.TRASH_RETENTION_MS + 1;
    assert.equal(await vault.purgeExpiredTrash(branch), 0);
    assert.equal(vault.listTrash(branch).length, 2);
  });
});

test("changing the passphrase re-wraps the key without re-encrypting, and only the new one opens", async () => {
  await withBranch(async (branch, root) => {
    const note = await vault.createNote(branch, "", "Secret");
    await vault.writeNote(branch, note.id, "still here");
    const cipherBefore = await readFile(noteFile(root, note.id));
    const configFile = path.join(root, ".driftleaf", "vault.json");
    const configBefore = await readFile(configFile, "utf8");
    assert.equal(JSON.parse(configBefore).version, 1);

    await assert.rejects(
      vault.changeVaultPassphrase(branch, "not the passphrase", "new one"),
      /Current passphrase is incorrect/,
    );
    await assert.rejects(
      vault.changeVaultPassphrase(branch, PASSPHRASE, "   "),
      /new passphrase is required/,
    );
    assert.equal(await readFile(configFile, "utf8"), configBefore, "a refused change writes nothing");

    await vault.changeVaultPassphrase(branch, PASSPHRASE, "nouvelle phrase ✨");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.version, 2);
    assert.equal(config.kdf, "scrypt");
    assert.match(config.wrappedKeyHex, /^[0-9a-f]{120}$/);
    assert.ok(!JSON.stringify(config).includes(branch.key.toString("hex")), "key is not stored in the clear");
    assert.deepEqual(await readFile(noteFile(root, note.id)), cipherBefore, "notes are not rewritten");
    assert.equal(await vault.vaultHasPassphrase(root), true);
    // The open session keeps working.
    assert.equal(await vault.readNote(branch, note.id), "still here");

    await assert.rejects(vault.unlockVault(root, PASSPHRASE), /Incorrect passphrase/);
    const { vault: reopened } = await vault.unlockVault(root, "nouvelle phrase ✨");
    assert.equal(await vault.readNote(reopened, note.id), "still here");
    assert.deepEqual(reopened.key, branch.key);

    // A second change (version 2 to version 2) works the same way.
    await vault.changeVaultPassphrase(reopened, "nouvelle phrase ✨", "third");
    await assert.rejects(vault.unlockVault(root, "nouvelle phrase ✨"), /Incorrect passphrase/);
    const { vault: third } = await vault.unlockVault(root, "third");
    assert.equal(await vault.readNote(third, note.id), "still here");

    // A backup of the re-keyed branch verifies with the new passphrase only.
    const backupParent = await mkdtemp(path.join(os.tmpdir(), "driftleaf-features-backup-"));
    try {
      const backupPath = await vault.createVaultBackup(third, backupParent);
      const report = await vault.verifyVaultBackup(backupPath, "third");
      assert.ok(report.checks.every((check) => check.status === "ok"), JSON.stringify(report.checks));
      await assert.rejects(vault.verifyVaultBackup(backupPath, PASSPHRASE), /passphrase is incorrect/);
    } finally {
      await rm(backupParent, { recursive: true, force: true });
    }
  });
});

test("a damaged or too-new vault.json is refused with a clear message", async () => {
  await withBranch(async (branch, root) => {
    const configFile = path.join(root, ".driftleaf", "vault.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    await writeFile(configFile, JSON.stringify({ ...config, version: 3 }));
    await assert.rejects(vault.unlockVault(root, PASSPHRASE), /newer version of Driftleaf/);
    await writeFile(configFile, JSON.stringify({ ...config, saltHex: "zz" }));
    await assert.rejects(vault.unlockVault(root, PASSPHRASE), /invalid key-derivation salt/);
    await writeFile(configFile, JSON.stringify({ ...config, version: 2 }));
    await assert.rejects(vault.unlockVault(root, PASSPHRASE), /invalid wrapped encryption key/);
    await writeFile(configFile, JSON.stringify(config));
    await vault.unlockVault(root, PASSPHRASE);
    assert.ok(branch);
  });
});

test("attachments are encrypted on disk, round-trip exactly, and are bounded", async () => {
  await withBranch(async (branch, root) => {
    const bytes = Buffer.concat([Buffer.from("PLAINTEXT-MARKER"), randomBytes(4096)]);
    const meta = await vault.addAttachment(branch, "../../evil/na:me?.PNG", "image/PNG", bytes);
    assert.equal(meta.name, "name.PNG");
    assert.equal(meta.mimeType, "image/png");
    assert.equal(meta.size, bytes.length);
    const onDisk = await readFile(attachmentFile(root, meta.id));
    assert.ok(!onDisk.includes("PLAINTEXT-MARKER"), "attachment bytes are encrypted at rest");
    assert.deepEqual((await vault.readAttachment(branch, meta.id)).data, bytes);

    const odd = await vault.addAttachment(branch, "", "not a mime type", Buffer.from("x"));
    assert.equal(odd.name, "attachment");
    assert.equal(odd.mimeType, "application/octet-stream");

    await assert.rejects(vault.addAttachment(branch, "empty", "text/plain", Buffer.alloc(0)), /empty/);
    await assert.rejects(
      vault.addAttachment(branch, "big", "text/plain", Buffer.alloc(vault.ATTACHMENT_MAX_BYTES + 1)),
      /at most 25 MB/,
    );
    await assert.rejects(vault.readAttachment(branch, randomUUID()), /Attachment not found/);
    await assert.rejects(vault.readAttachment(branch, "../../etc/passwd"), /Attachment not found/);

    // Survives a reopen, and the health check covers it.
    const { vault: reopened } = await vault.unlockVault(root, PASSPHRASE);
    assert.deepEqual((await vault.readAttachment(reopened, meta.id)).data, bytes);
    let report = await vault.inspectVault(reopened);
    assert.equal(report.checks.find((c) => c.name === "Encrypted attachments").status, "ok");

    // A flipped byte is detected, not returned as garbage.
    onDisk[onDisk.length - 1] ^= 0xff;
    await writeFile(attachmentFile(root, meta.id), onDisk);
    await assert.rejects(vault.readAttachment(reopened, meta.id), /corrupted/);
    report = await vault.inspectVault(reopened);
    assert.equal(report.checks.find((c) => c.name === "Encrypted attachments").status, "error");
  });
});

test("unused-attachment cleanup spares referenced, trashed-note, and recent attachments", async () => {
  await withBranch(async (branch, root) => {
    const add = (name) => vault.addAttachment(branch, name, "image/png", Buffer.from(name));
    const used = await add("used.png");
    const usedByTrashed = await add("trashed.png");
    const unused = await add("unused.png");
    const recent = await add("recent.png");
    const old = Date.now() - vault.ATTACHMENT_UNUSED_GRACE_MS - 1000;
    for (const item of [used, usedByTrashed, unused]) item.createdAt = old;

    const live = await vault.createNote(branch, "", "Live");
    await vault.writeNote(branch, live.id, `![pic](attachment:${used.id.toUpperCase()})`);
    const gone = await vault.createNote(branch, "", "Gone");
    await vault.writeNote(branch, gone.id, `[file](attachment:${usedByTrashed.id})`);
    await vault.deleteNote(branch, gone.id);

    assert.deepEqual((await vault.findUnusedAttachments(branch)).map((a) => a.id), [unused.id]);
    assert.deepEqual(await vault.removeUnusedAttachments(branch), {
      removed: 1,
      bytes: unused.size,
    });
    assert.equal(await exists(attachmentFile(root, unused.id)), false);
    for (const kept of [used, usedByTrashed, recent]) {
      assert.ok(await exists(attachmentFile(root, kept.id)), kept.name);
    }
    assert.deepEqual(await vault.removeUnusedAttachments(branch), { removed: 0, bytes: 0 });

    // If any note cannot be read, cleanup refuses instead of guessing.
    recent.createdAt = old;
    const cipher = await readFile(noteFile(root, live.id));
    cipher[cipher.length - 1] ^= 0xff;
    await writeFile(noteFile(root, live.id), cipher);
    await assert.rejects(vault.removeUnusedAttachments(branch), /cannot be worked out safely/);
    assert.ok(await exists(attachmentFile(root, recent.id)));
  });
});

test("plaintext export writes readable notes, databases, and attachments, and rewrites links", async () => {
  await withBranch(async (branch, root) => {
    const image = await vault.addAttachment(branch, "diagram (v2).png", "image/png", Buffer.from("PNGDATA"));
    await vault.addAttachment(branch, "diagram (v2).png", "image/png", Buffer.from("OTHER"));
    await vault.createFolder(branch, "Projects/Q4: Plans?");
    await vault.createFolder(branch, "Empty");
    const nested = await vault.createNote(branch, "Projects/Q4: Plans?", "Road/map");
    await vault.writeNote(branch, nested.id, `See ![d](attachment:${image.id}) and [[Other]]`);
    const twin = await vault.createNote(branch, "Projects/Q4: Plans?", "Road/map");
    await vault.writeNote(branch, twin.id, "second note with the same title");
    const reserved = await vault.createNote(branch, "", "CON");
    await vault.writeNote(branch, reserved.id, "reserved on Windows");
    const trashed = await vault.createNote(branch, "", "Deleted");
    await vault.writeNote(branch, trashed.id, "must not be exported");
    await vault.deleteNote(branch, trashed.id);
    const title = titleProperty();
    await vault.createDatabase(branch, "Tasks", "Projects", [title], [
      { id: randomUUID(), values: { [title.id]: "Ship it" }, createdAt: 1, updatedAt: 1 },
    ]);

    await assert.rejects(exportBranchPlaintext(branch, root), /outside the open branch folder/);

    const destination = await mkdtemp(path.join(os.tmpdir(), "driftleaf-features-export-"));
    try {
      const result = await exportBranchPlaintext(branch, destination);
      assert.equal(path.dirname(result.path), await import("node:fs/promises").then((fs) => fs.realpath(destination)));
      assert.match(path.basename(result.path), /^Driftleaf-Export-.+-\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(result.skipped, []);
      assert.equal(result.notes, 4); // welcome note + three live notes
      assert.equal(result.databases, 1);
      assert.equal(result.attachments, 2);
      assert.deepEqual((await readdir(destination)).length, 1, "no temp folder is left behind");

      const archive = new AdmZip(result.path);
      const exportRoot = path.basename(result.path, ".zip");
      const entryNames = archive.getEntries().map((entry) => entry.entryName);
      const readText = (name) => archive.readAsText(`${exportRoot}/${name}`);
      const folderEntries = entryNames
        .filter((name) => name.startsWith(`${exportRoot}/Projects/Q4- Plans-/`) && !name.endsWith("/"))
        .map((name) => name.slice(`${exportRoot}/Projects/Q4- Plans-/`.length))
        .sort();
      assert.deepEqual(folderEntries, ["Road-map (2).md", "Road-map.md"]);
      assert.equal(
        readText("Projects/Q4- Plans-/Road-map.md"),
        "See ![d](../../attachments/diagram%20%28v2%29.png) and [[Other]]",
      );
      assert.deepEqual(entryNames
        .filter((name) => name.startsWith(`${exportRoot}/attachments/`) && !name.endsWith("/"))
        .map((name) => name.slice(`${exportRoot}/attachments/`.length))
        .sort(), [
        "diagram (v2) (2).png",
        "diagram (v2).png",
      ]);
      assert.equal(
        archive.getEntry(`${exportRoot}/attachments/diagram (v2).png`).getData().toString("utf8"),
        "PNGDATA",
      );
      assert.equal(readText("CON_.md"), "reserved on Windows");
      assert.ok(entryNames.includes(`${exportRoot}/Empty/`));
      assert.equal(entryNames.includes(`${exportRoot}/Deleted.md`), false);
      assert.match(readText("Projects/Tasks.csv"), /Ship it/);
      assert.equal(
        JSON.parse(readText("Projects/Tasks.json")).format,
        "driftleaf/database-v1",
      );

      // A second export never overwrites the first.
      const again = await exportBranchPlaintext(branch, destination);
      assert.notEqual(again.path, result.path);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});

test("long names are shortened without cutting a character in half", async () => {
  await withBranch(async (branch, root) => {
    // 150 emoji are 300 UTF-16 units; a plain slice(0, 200) lands mid-pair when offset by one.
    const meta = await vault.addAttachment(branch, "a" + "🌿".repeat(150) + ".png", "image/png", Buffer.from("x"));
    assert.ok(meta.name.isWellFormed(), "no lone surrogate may reach the manifest");
    assert.ok(meta.name.length <= 200);
    assert.equal(vault.truncateWhole("ab🌿", 3), "ab");
    assert.equal(vault.truncateWhole("ab🌿", 4), "ab🌿");
    assert.equal(vault.truncateWhole("abc", 10), "abc");
    // The manifest must survive a strict JSON round trip (what the Rust port requires).
    const { vault: reopened } = await vault.unlockVault(root, PASSPHRASE);
    assert.equal(vault.listAttachments(reopened)[0].name, meta.name);

    const title = "n" + "🌿".repeat(80);
    const note = await vault.createNote(reopened, "", title);
    await vault.writeNote(reopened, note.id, "long title");
    const destination = await mkdtemp(path.join(os.tmpdir(), "driftleaf-features-export-"));
    try {
      const result = await exportBranchPlaintext(reopened, destination);
      assert.deepEqual(result.skipped, []);
      const exportRoot = path.basename(result.path, ".zip");
      const exported = new AdmZip(result.path)
        .getEntries()
        .map((entry) => entry.entryName)
        .find((name) => name.startsWith(`${exportRoot}/n`))
        ?.slice(exportRoot.length + 1);
      assert.ok(exported);
      assert.ok(exported.isWellFormed(), "exported file names are valid Unicode");
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});

test("export keeps same-titled notes apart when their folders differ only by case", async () => {
  await withBranch(async (branch) => {
    for (const folder of ["Case", "case"]) {
      await vault.createFolder(branch, folder);
      const note = await vault.createNote(branch, folder, "Same title");
      await vault.writeNote(branch, note.id, `from ${folder}`);
    }
    const destination = await mkdtemp(path.join(os.tmpdir(), "driftleaf-features-export-"));
    try {
      const result = await exportBranchPlaintext(branch, destination);
      // On a case-insensitive filesystem both folders are one directory, so the two notes
      // must not be given the same file name there. Nothing may be skipped on any platform.
      assert.deepEqual(result.skipped, []);
      const exportRoot = path.basename(result.path, ".zip");
      const names = new AdmZip(result.path)
        .getEntries()
        .map((entry) => entry.entryName.slice(exportRoot.length + 1).split("/").at(-1).toLowerCase());
      assert.ok(names.includes("same title.md") && names.includes("same title (2).md"), names.join(", "));
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
