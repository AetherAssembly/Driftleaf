import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCsvDatabase, parseJsonDatabase } from "../../src/main/database-import.ts";

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/database_import_bridge" +
    (process.platform === "win32" ? ".exe" : ""),
);

function runRust(format, text, title) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ format, text, title }),
    encoding: "utf8",
  });
  if (result.status !== 0) return { error: result.stderr.trim() };
  return JSON.parse(result.stdout);
}

// IDs are random on both sides, so compare structurally by re-keying each row's values by
// property *name* instead of property *id*, and stripping ids from properties before
// comparing them.
function normalize(parsed) {
  const idToName = new Map(parsed.properties.map((p) => [p.id, p.name]));
  return {
    title: parsed.title,
    properties: parsed.properties.map(({ id, ...rest }) => rest),
    rows: parsed.rows.map((row) => {
      const values = {};
      for (const [id, value] of Object.entries(row.values)) values[idToName.get(id)] = value;
      return values;
    }),
  };
}

function compare(format, text, title) {
  const rustRaw = runRust(format, text, title);
  if (rustRaw.error) return { error: rustRaw.error };
  let nodeRaw;
  try {
    nodeRaw = format === "csv" ? parseCsvDatabase(text, title) : parseJsonDatabase(text, title);
  } catch (err) {
    return { error: `node-only error: ${err.message}` };
  }
  assert.deepEqual(normalize(rustRaw), normalize(nodeRaw), `mismatch for ${format}: ${text}`);
  return normalize(rustRaw);
}

// A representative CSV exercising every inferType branch, plus the header-based hints.
const csv = [
  "Name,Status,Tags,Score,Due,Site,Notes",
  '"Task one",Todo,"work, urgent",3,2026-01-15,https://example.com,plain text',
  '"Task ""two""",Done,home,4.5,2026-02-01,http://example.org,"line one\nline two"',
].join("\r\n");
const csvResult = compare("csv", csv, "Imported CSV");
assert.equal(csvResult.properties.find((p) => p.name === "Status").type, "select");
assert.equal(csvResult.properties.find((p) => p.name === "Tags").type, "multi_select");
assert.equal(csvResult.properties.find((p) => p.name === "Score").type, "number");
assert.equal(csvResult.properties.find((p) => p.name === "Due").type, "date");
assert.equal(csvResult.properties.find((p) => p.name === "Site").type, "url");
assert.equal(csvResult.properties.find((p) => p.name === "Notes").type, "text");
assert.deepEqual(csvResult.rows[1].Notes, "line one\nline two");

// CSV edge cases that must fail identically on both sides.
assert.ok(compare("csv", "", "Empty").error);
assert.ok(compare("csv", "A,A\n1,2", "Dup columns").error);
assert.ok(compare("csv", "A,B\n1,2,3", "Ragged row").error);
assert.ok(compare("csv", 'A,B\n"unterminated,2', "Unclosed quote").error);

// A plain array-of-objects JSON import, inferring columns the same way a CSV would.
const plainJson = JSON.stringify([
  { Name: "Row one", Done: true, Count: 2 },
  { Name: "Row two", Done: false, Count: 5 },
]);
const plainResult = compare("json", plainJson, "Plain JSON");
assert.equal(plainResult.properties.find((p) => p.name === "Done").type, "checkbox");
assert.equal(plainResult.properties.find((p) => p.name === "Count").type, "number");

// A Notion-API-shaped export: rich_text/select/multi_select/checkbox/relation property
// value shapes, which notionValue()/notionPropertyHint() must normalize identically.
const notionJson = JSON.stringify([
  {
    properties: {
      Name: { type: "title", title: [{ plain_text: "Notion row" }] },
      Status: { type: "select", select: { name: "In progress" } },
      Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
      Done: { type: "checkbox", checkbox: true },
      Related: { type: "relation", relation: [{ id: "abc-123" }] },
    },
  },
  {
    properties: {
      Name: { type: "title", title: [{ plain_text: "Second row" }] },
      Status: { type: "select", select: { name: "Done" } },
      Tags: { type: "multi_select", multi_select: [] },
      Done: { type: "checkbox", checkbox: false },
      Related: { type: "relation", relation: [] },
    },
  },
]);
const notionResult = compare("json", notionJson, "Notion export");
assert.equal(notionResult.properties.find((p) => p.name === "Status").type, "select");
assert.deepEqual(
  notionResult.properties.find((p) => p.name === "Status").options.sort(),
  ["Done", "In progress"],
);
assert.deepEqual(notionResult.rows[0].Tags, ["a", "b"]);
assert.deepEqual(notionResult.rows[0].Related, ["abc-123"]);

// A Driftleaf-native export round-trips through the "format": "driftleaf/database-v1" path
// verbatim (no re-inference), including the title/views/activeViewId passthrough.
const driftleafExport = JSON.stringify({
  format: "driftleaf/database-v1",
  title: "Exported db",
  properties: [{ id: "p1", name: "Name", type: "title" }],
  rows: [{ id: "r1", values: { p1: "Hello" }, createdAt: 0, updatedAt: 0 }],
  views: [{ id: "v1", name: "Table", type: "table" }],
  activeViewId: "v1",
});
const rustExportResult = runRust("json", driftleafExport, "ignored title");
const nodeExportResult = parseJsonDatabase(driftleafExport, "ignored title");
assert.deepEqual(rustExportResult, {
  title: nodeExportResult.title,
  properties: nodeExportResult.properties,
  rows: nodeExportResult.rows,
});
assert.equal(rustExportResult.title, "Exported db");

assert.ok(compare("json", "[]", "Empty array").error);
assert.ok(compare("json", '"just a string"', "Bare string").error);

console.log(
  "Rust's CSV and Notion-JSON database import heuristics (type inference, option " +
    "aggregation, and the driftleaf-export passthrough) match parseCsvDatabase()/" +
    "parseJsonDatabase() exactly, including matching failures on malformed input.",
);
