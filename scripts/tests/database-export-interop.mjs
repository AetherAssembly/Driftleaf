import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
process.env.TZ = "UTC"; // see formula-interop.mjs: formula date functions are timezone-sensitive.
import * as vault from "../../src/main/vault.ts";
import { exportDatabase } from "../../src/main/database-export.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-export-"));
const passphrase = "Test fixture 🌿 café";

function run(ops) {
  const result = spawnSync(binary, [], { input: JSON.stringify({ root, passphrase, ops }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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

  console.log(
    "Rust's exportDatabase (CSV and JSON, formula columns including prop()-chained " +
      "formulas, a divide-by-zero #ERROR cell, and genuine cycle detection) matches " +
      "database-export.ts's output exactly.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
