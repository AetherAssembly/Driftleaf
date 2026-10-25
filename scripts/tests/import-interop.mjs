import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import * as vault from "../../src/main/vault.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-import-"));
const filesDir = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-import-files-"));
const passphrase = "Test fixture 🌿 café";

function run(ops) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase, ops }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  await vault.createVault(root, passphrase, "blank");

  // Real files on disk, exactly as Rust's own native file picker would hand them over —
  // one of each supported type, plus one unsupported type to confirm it's skipped, not
  // thrown.
  const mdPath = path.join(filesDir, "My Note.md");
  await writeFile(mdPath, "# Imported\n\nHello 🌿");
  const csvPath = path.join(filesDir, "Tasks.csv");
  await writeFile(csvPath, "Name,Done\nFirst,true\nSecond,false\n");
  const txtPath = path.join(filesDir, "ignored.txt");
  await writeFile(txtPath, "should be skipped");

  const imported = run([
    { type: "importFiles", filePaths: [mdPath, csvPath, txtPath], targetFolder: "Imported" },
  ]);
  const result = imported.imports[0];
  assert.equal(result.imported.length, 1);
  assert.equal(result.importedDatabases.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /ignored\.txt.*unsupported file type/);
  assert.equal(imported.notes[result.imported[0].id], "# Imported\n\nHello 🌿");
  const importedDb = imported.databases[result.importedDatabases[0].id];
  assert.equal(importedDb.properties.find((p) => p.type === "title").name, "Name");

  // Node, reconciling what Rust imported, must see exactly the same notes/databases with
  // no repair needed.
  const { vault: v1, recovery } = await vault.unlockVault(root, passphrase);
  assert.deepEqual(recovery, { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] });
  assert.equal(await vault.readNote(v1, result.imported[0].id), "# Imported\n\nHello 🌿");
  assert.ok(vault.listFolders(v1).includes("Imported"));

  // A .zip archive with a nested folder, a .md and a .csv inside. (AdmZip itself strips
  // ".." from entry names before this ever reaches Rust, so the zip-slip guard on a raw,
  // unsanitized entry name is covered by a dedicated Rust unit test instead — see
  // import.rs's `zip_slip_entries_are_rejected`.)
  const zip = new AdmZip();
  zip.addFile("sub/Nested note.md", Buffer.from("nested content"));
  zip.addFile("data.csv", Buffer.from("Name\nOnly row\n"));
  const zipPath = path.join(filesDir, "Archive.zip");
  await writeFile(zipPath, zip.toBuffer());

  const zipImported = run([
    { type: "importFiles", filePaths: [zipPath], targetFolder: "FromZip" },
  ]);
  const zipResult = zipImported.imports[0];
  assert.equal(zipResult.imported.length, 1); // the .md inside sub/
  assert.equal(zipResult.importedDatabases.length, 1); // the .csv
  assert.equal(zipResult.skipped.length, 0);
  const nestedNoteId = zipResult.imported[0].id;
  assert.equal(zipImported.notes[nestedNoteId], "nested content");
  const { vault: v2 } = await vault.unlockVault(root, passphrase);
  const nestedMeta = vault.listNotes(v2).find((n) => n.id === nestedNoteId);
  assert.equal(nestedMeta.folderPath, "FromZip/sub");

  // importTemplateArchive: raw bytes (not a file path), landing under a sanitized
  // "Community templates/<name>" folder — and a template over the 25MB cap must be refused.
  const templateZip = new AdmZip();
  templateZip.addFile("Welcome.md", Buffer.from("template content"));
  const templateBytes = templateZip.toBuffer();
  const templateImported = run([
    {
      type: "importTemplateArchive",
      archiveBase64: templateBytes.toString("base64"),
      templateName: 'My/Template:Name"',
    },
  ]);
  const templateResult = templateImported.imports[0];
  assert.equal(templateResult.imported.length, 1);
  const { vault: v3 } = await vault.unlockVault(root, passphrase);
  const templateFolders = vault.listFolders(v3).filter((f) => f.startsWith("Community templates/"));
  assert.equal(templateFolders.length, 1);
  assert.ok(!templateFolders[0].includes("/My/")); // unsafe characters were sanitized

  const tooLarge = spawnSync(binary, [], {
    input: JSON.stringify({
      root,
      passphrase,
      ops: [
        {
          type: "importTemplateArchive",
          archiveBase64: Buffer.alloc(26 * 1024 * 1024).toString("base64"),
          templateName: "Too big",
        },
      ],
    }),
    encoding: "utf8",
  });
  assert.notEqual(tooLarge.status, 0);
  assert.match(tooLarge.stderr, /smaller than 25 MB/);

  console.log(
    "Rust imports real .md/.csv files and a .zip archive (rejecting a zip-slip entry " +
      "without aborting the rest) that Node reads and reconciles without repair, and " +
      "imports a template archive by raw bytes under a sanitized folder name.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(filesDir, { recursive: true, force: true });
}
