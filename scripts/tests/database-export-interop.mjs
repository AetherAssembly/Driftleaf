import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
process.env.TZ = "UTC"; // see formula-interop.mjs: formula date functions are timezone-sensitive.
import * as vault from "../../src/main/vault.ts";
import { exportDatabase } from "../../src/main/database-export.ts";
import { exportBranchPlaintext } from "../../src/main/branch-export.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-export-"));
const passphrase = "Test fixture 🌿 café";

const temporaryRoots = [root];

function run(ops, extra = {}) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase, ops, ...extra }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Every entry and file content under the export's top-level folder, so the Node and Rust
// archives can be compared exactly even though their automatically generated roots differ.
function tree(zipPath) {
  const archive = new AdmZip(zipPath);
  const root = `${path.basename(zipPath, ".zip")}/`;
  return archive
    .getEntries()
    .filter((entry) => entry.entryName.startsWith(root))
    .map((entry) => {
      const relative = entry.entryName.slice(root.length).replace(/\/$/, "");
      return [relative, entry.isDirectory ? "<directory>" : entry.getData().toString("base64")];
    })
    .filter(([name]) => name !== "")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

try {
  await vault.createVault(root, passphrase, "blank");

  // A database with a formula that references another property (prop() + arithmetic +
  // string functions) and one whose formula produces an error (divide by zero) for a row.
  const built = run([
    {
      type: "createDatabase",
      title: "Orders",
      folderPath: "",
      properties: [
        { id: "p_title", name: "Item", type: "title" },
        { id: "p_qty", name: "Qty", type: "number" },
        { id: "p_price", name: "Price", type: "number" },
        { id: "p_total", name: "Total", type: "formula", formula: 'prop("Qty") * prop("Price")' },
        { id: "p_label", name: "Label", type: "formula", formula: 'upper(prop("Item")) + " x" + toString(prop("Qty"))' },
        { id: "p_bad", name: "Bad", type: "formula", formula: 'prop("Qty") / 0' },
      ],
      rows: [
        { id: "r1", values: { p_title: "Widget", p_qty: 3, p_price: 2.5 } },
        { id: "r2", values: { p_title: "Gadget, \"Pro\"", p_qty: 1, p_price: 10 } },
      ],
    },
  ]);
  const databaseId = built.createdDatabases[0];
  const { vault: branchAfterCreate } = await vault.unlockVault(root, passphrase);

  for (const format of ["csv", "json"]) {
    const rustExported = run([{ type: "exportDatabase", id: databaseId, format }]).exports[0];
    const nodeExported = await exportDatabase(branchAfterCreate, databaseId, format);
    if (format === "json") {
      assert.deepEqual(JSON.parse(rustExported.content), JSON.parse(nodeExported.content));
    } else {
      assert.equal(rustExported.content, nodeExported.content);
    }
    assert.equal(rustExported.title, nodeExported.title);
  }

  // CSV must carry the computed formula columns, including the quoted-comma row and the
  // #ERROR: placeholder for the divide-by-zero row.
  const csv = run([{ type: "exportDatabase", id: databaseId, format: "csv" }]).exports[0].content;
  assert.match(csv, /"Gadget, ""Pro"""/);
  assert.match(csv, /7\.5/); // 3 * 2.5
  assert.match(csv, /#ERROR: Formula cannot divide by zero/);
  assert.match(csv, /WIDGET x3/);

  // A genuine formula dependency cycle (A -> B -> A) must be detected and reported per-row
  // as a CSV #ERROR cell, not crash the whole export — exactly like exportCsv()'s per-cell
  // try/catch in database-export.ts.
  const cyclic = run([
    {
      type: "createDatabase",
      title: "Cyclic",
      folderPath: "",
      properties: [
        { id: "p_title", name: "Name", type: "title" },
        { id: "p_a", name: "A", type: "formula", formula: 'prop("B")' },
        { id: "p_b", name: "B", type: "formula", formula: 'prop("A")' },
      ],
      rows: [{ id: "r1", values: { p_title: "Loop" } }],
    },
  ]);
  const cyclicId = cyclic.createdDatabases[0];
  const { vault: branchAfterCyclic } = await vault.unlockVault(root, passphrase);
  const cyclicCsv = run([{ type: "exportDatabase", id: cyclicId, format: "csv" }]).exports[0].content;
  const cyclicNode = await exportDatabase(branchAfterCyclic, cyclicId, "csv");
  assert.equal(cyclicCsv, cyclicNode.content);
  assert.match(cyclicCsv, /#ERROR: Formula dependency cycle/);

  // An unsupported format must be rejected identically.
  const badFormat = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase, ops: [{ type: "exportDatabase", id: databaseId, format: "xml" }] }),
    encoding: "utf8",
  });
  assert.notEqual(badFormat.status, 0);
  await assert.rejects(exportDatabase(branchAfterCyclic, databaseId, "xml"));

  // Whole-branch plaintext export (src/main/branch-export.ts). Node builds a branch full of
  // awkward names, collisions, Trash, and a few deliberately unreadable items; Node and Rust
  // each export it to their own folder, and the two folders must be identical: the same
  // files and folders, the same names, the same bytes, the same counts, the same "skipped"
  // list with the same reasons.
  {
    const { vault: v } = await vault.unlockVault(root, passphrase);
    const attachmentNames = [
      "diagram (v2).png",
      "diagram (v2).png",
      "Diagram (V2).PNG",
      "CON.txt",
      "no extension",
      ".hidden",
      "archive.verylongextension",
      "日本語 🌿.pdf",
      "trailing dot.",
      "#hash & percent%.md",
      `${"long".repeat(40)}.bin`,
    ];
    const attachments = [];
    for (const [index, name] of attachmentNames.entries()) {
      attachments.push(
        await vault.addAttachment(v, name, "application/octet-stream", Buffer.from(`attachment ${index} \u0000\u00ff`, "latin1")),
      );
    }
    const missingAttachment = await vault.addAttachment(v, "missing.bin", "a/b", Buffer.from("gone"));
    const damagedAttachment = await vault.addAttachment(v, "damaged.bin", "a/b", Buffer.from("broken"));

    for (const folder of ["Projects/Q4: Plans?", "Empty", "日本語/子", "Trail. /In", "aux", "Projects/Q4- Plans-"]) {
      await vault.createFolder(v, folder);
    }
    const writeNote = async (folder, title, content) => {
      const meta = await vault.createNote(v, folder, title);
      await vault.writeNote(v, meta.id, content);
      return meta;
    };
    await writeNote("Projects/Q4: Plans?", "Road/map", `See ![d](attachment:${attachments[0].id}) and [[Other]]`);
    await writeNote("Projects/Q4: Plans?", "Road/map", "second note with the same title");
    await writeNote("Projects/Q4: Plans?", "road/MAP", "same name in another case");
    // A different folder that cleans to the same exported folder shares its name space.
    await writeNote("Projects/Q4- Plans-", "Road-map", "same exported folder, same exported name");
    await writeNote("", "CON", "reserved on Windows");
    await writeNote("", "nul.txt", "reserved with an extension");
    await writeNote("", "", "no title");
    await writeNote("", "", "no title either");
    await writeNote("", "...", "only dots");
    await writeNote("", `${"x".repeat(99)}. and more`, "cut at 100, trailing dot removed");
    await writeNote("", "Orders", "a note named like a database");
    await writeNote(
      "日本語/子",
      "日本語 🌿",
      [
        `![a](attachment:${attachments[7].id})`,
        `[b](ATTACHMENT:${attachments[2].id.toUpperCase()})`,
        `[c](attachment:${attachments[9].id}) twice attachment:${attachments[9].id}`,
        `unknown attachment:${randomUUID()}`,
        `skipped attachment:${missingAttachment.id}`,
        "not an id attachment:1234",
      ].join("\n"),
    );
    await writeNote("Trail. /In", "Inside a folder with a trailing dot", `![x](attachment:${attachments[4].id})`);
    await writeNote("aux", "In a reserved folder", "x");
    const damagedNote = await writeNote("", "Damaged note", "will not decrypt");
    const trashedNote = await writeNote("", "Deleted", "must not be exported");
    await vault.deleteNote(v, trashedNote.id);

    const titleOnly = [{ id: "t", name: "Name", type: "title" }];
    const row = (value) => ({ id: randomUUID(), values: { t: value }, createdAt: 1, updatedAt: 1 });
    await vault.createDatabase(v, "Tasks: Q4?", "Projects", titleOnly, [row("Ship, \"it\""), row("日本語")]);
    await vault.createDatabase(v, "Orders", "", titleOnly, [row("a second Orders")]);
    await vault.createDatabase(v, "", "Empty", titleOnly, []);
    const damagedDatabase = await vault.createDatabase(v, "Damaged database", "", titleOnly, []);
    const trashedDatabase = await vault.createDatabase(v, "Deleted database", "", titleOnly, []);
    await vault.deleteDatabase(v, trashedDatabase.id);

    await rm(path.join(root, ".driftleaf/attachments", `${missingAttachment.id}.enc`));
    for (const file of [
      path.join(root, ".driftleaf/attachments", `${damagedAttachment.id}.enc`),
      path.join(root, ".driftleaf/notes", `${damagedNote.id}.enc`),
      path.join(root, ".driftleaf", `${damagedDatabase.id}.db.enc`),
    ]) {
      const bytes = await readFile(file);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(file, bytes);
    }

    const nodeDestination = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-export-node-"));
    const rustDestination = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-export-rust-"));
    temporaryRoots.push(nodeDestination, rustDestination);
    const nodeExport = await exportBranchPlaintext(v, nodeDestination);
    const rustExport = run(
      [{ type: "exportPlaintext", destinationParent: rustDestination }],
      { dump: false },
    ).plaintextExports[0];

    const { path: nodePath, ...nodeCounts } = nodeExport;
    const { path: rustPath, ...rustCounts } = rustExport;
    assert.deepEqual(rustCounts, nodeCounts);
    assert.deepEqual(nodeCounts.skipped, [
      "missing.bin (This attachment's encrypted file is missing)",
      "damaged.bin (Attachment is corrupted and cannot be decrypted)",
      `Damaged note (Note is corrupted and cannot be decrypted: ${damagedNote.id})`,
      "Damaged database (Database is corrupted or cannot be read: Damaged database)",
    ]);
    assert.equal(nodeCounts.attachments, attachmentNames.length);
    assert.match(
      path.basename(rustPath),
      /^Driftleaf-Export-.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.zip$/,
    );
    assert.deepEqual(await readdir(rustDestination), [path.basename(rustPath)], "no work folder is left behind");
    assert.deepEqual(await readdir(nodeDestination), [path.basename(nodePath)]);

    const nodeTree = await tree(nodePath);
    const rustTree = await tree(rustPath);
    assert.deepEqual(
      rustTree.map(([name]) => name),
      nodeTree.map(([name]) => name),
    );
    assert.deepEqual(rustTree, nodeTree);
    // Spot checks, so "identical" cannot mean "identically empty".
    const exportedNames = new Set(rustTree.map(([name]) => name));
    for (const expected of [
      "Empty",
      "aux_/In a reserved folder.md",
      "Trail/In/Inside a folder with a trailing dot.md",
      "Projects/Q4- Plans-/Road-map.md",
      "Projects/Q4- Plans-/Road-map (2).md",
      "Projects/Q4- Plans-/road-MAP (3).md",
      "Projects/Q4- Plans-/Road-map (4).md",
      "Projects/Tasks- Q4-.csv",
      "Projects/Tasks- Q4-.json",
      "Empty/Untitled database.csv",
      "CON_.md",
      "nul.txt_.md",
      "Untitled.md",
      "Untitled (2).md",
      "Untitled (3).md",
      `${"x".repeat(99)}.md`,
      "Orders.md",
      "Orders.csv",
      "Orders (2).csv",
      "Orders (2).json",
      "attachments/diagram (v2).png",
      "attachments/diagram (v2) (2).png",
      "attachments/Diagram (V2) (3).PNG",
      "attachments/CON_.txt",
      "attachments/no extension",
      "attachments/.hidden",
      "attachments/archive.verylongextension",
      "attachments/trailing dot",
      `attachments/${"long".repeat(25)}.bin`,
      "日本語/子/日本語 🌿.md",
    ]) {
      assert.ok(exportedNames.has(expected), `missing from the export: ${expected}`);
    }
    for (const absent of ["Deleted.md", "Deleted database.csv", "Damaged note.md", "Damaged database.csv"]) {
      assert.ok(!exportedNames.has(absent), `must not be exported: ${absent}`);
    }
    const rustArchive = new AdmZip(rustPath);
    const rustExportRoot = `${path.basename(rustPath, ".zip")}/`;
    const readExport = (name) => rustArchive.getEntry(`${rustExportRoot}${name}`).getData();
    const rewritten = readExport("日本語/子/日本語 🌿.md").toString("utf8").split("\n");
    assert.match(rewritten[3], /^unknown attachment:[0-9a-f-]{36}$/);
    rewritten[3] = "";
    assert.deepEqual(rewritten, [
      "![a](../../attachments/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%8C%BF.pdf)",
      "[b](../../attachments/Diagram%20%28V2%29%20%283%29.PNG)",
      "[c](../../attachments/%23hash%20%26%20percent%25.md) twice ../../attachments/%23hash%20%26%20percent%25.md",
      "",
      `skipped attachment:${missingAttachment.id}`,
      "not an id attachment:1234",
    ]);
    assert.deepEqual(
      readExport("attachments/diagram (v2).png"),
      Buffer.from("attachment 0 \u0000\u00ff", "latin1"),
    );

    // Both refuse to write decrypted content inside the branch itself, in the same words.
    let nodeRefusal;
    await assert.rejects(exportBranchPlaintext(v, path.join(root, ".driftleaf")), (error) => {
      nodeRefusal = error.message;
      return true;
    });
    const rustRefusal = spawnSync(binary, [], {
      input: JSON.stringify({
        root,
        passphrase,
        dump: false,
        ops: [{ type: "exportPlaintext", destinationParent: path.join(root, ".driftleaf") }],
      }),
      encoding: "utf8",
    });
    assert.notEqual(rustRefusal.status, 0);
    assert.equal(rustRefusal.stderr.trim(), `Error: ${JSON.stringify(nodeRefusal)}`);
    assert.match(nodeRefusal, /outside the open branch folder/);

    // A second export into the same folder never overwrites the first.
    const again = run(
      [
        { type: "exportPlaintext", destinationParent: rustDestination },
        { type: "exportPlaintext", destinationParent: rustDestination },
      ],
      { dump: false },
    ).plaintextExports;
    assert.equal(new Set([rustPath, again[0].path, again[1].path]).size, 3);
    assert.deepEqual(await tree(again[1].path), nodeTree);
  }

  console.log(
    "Rust's exportDatabase (CSV and JSON, formula columns including prop()-chained " +
      "formulas, a divide-by-zero #ERROR cell, and genuine cycle detection) matches " +
      "database-export.ts's output exactly, and Rust's whole-branch plaintext export " +
      "(notes, databases, attachments, rewritten attachment links, name clean-up and " +
      "collisions, skipped unreadable items, nothing from Trash) is file-for-file and " +
      "byte-for-byte identical to branch-export.ts's.",
  );
} finally {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true });
}
