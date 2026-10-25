import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as vault from "../../src/main/vault.ts";
import * as links from "../../src/shared/note-links.ts";

// search.ts uses `createRequire(__filename)` to load the native better-sqlite3 addon —
// fine inside Electron, but that addon isn't built for this bare Node test process, and
// loading the raw .ts file as ESM here also trips Node's module-type auto-detection
// (__filename plus this file's own top-level await look contradictory to it). Same fix
// regressions.mjs already uses: transpile to CommonJS and run in a vm context with
// better-sqlite3 mocked onto Node's built-in node:sqlite.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
function loadModule(relative, mocks) {
  const filename = path.join(repoRoot, relative);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      __filename: filename,
      __dirname: path.dirname(filename),
      require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
      process,
      console,
      Buffer,
      URL,
      TextDecoder,
      setTimeout,
      clearTimeout,
    },
    { filename },
  );
  return module.exports;
}
class TestDatabase {
  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
  }
  exec(sql) {
    return this.db.exec(sql);
  }
  prepare(sql) {
    return this.db.prepare(sql);
  }
  transaction(fn) {
    return () => {
      this.exec("BEGIN");
      try {
        const value = fn();
        this.exec("COMMIT");
        return value;
      } catch (error) {
        this.exec("ROLLBACK");
        throw error;
      }
    };
  }
}
const { openIndex, buildIndex, search: nodeSearch, buildNoteGraph } = loadModule("src/main/search.ts", {
  "node:module": { createRequire: () => () => TestDatabase },
  "./vault": vault,
  "../shared/note-links": links,
});

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/branch_mutate" +
    (process.platform === "win32" ? ".exe" : ""),
);
const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-rust-search-"));
const passphrase = "Test fixture 🌿 café";
const searchQueries = ["driftleaf", "companion", "fenced"];

function run(ops) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ root, passphrase, ops, searchQueries }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Order-independent comparison: Rust's note graph builds its edges/mentions from a
// HashMap, so array order isn't meaningful — sort both sides by a stable key before
// comparing, the same way a real caller would treat an unordered graph.
function sortGraph(graph) {
  const byKey = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  return {
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort(byKey),
    unlinkedMentions: [...graph.unlinkedMentions].sort(byKey),
  };
}

try {
  await vault.createVault(root, passphrase, "blank");

  const built = run([
    {
      type: "createNote",
      folderPath: "",
      title: "Driftleaf overview",
    },
    {
      type: "writeNote",
      id: "$note:0",
      content:
        "Driftleaf is a notes app. See [[Companion]] for the extension, and note that " +
        "Companion is mentioned again here as plain text, not a link.\n\n" +
        "```\nCompanion inside a fenced block must not count as a mention.\n```\n" +
        "Inline `Companion` in code must not count either.",
    },
    { type: "createNote", folderPath: "", title: "Companion" },
    { type: "writeNote", id: "$note:1", content: "The companion extension's own page." },
    { type: "createNote", folderPath: "", title: "Unrelated" },
    { type: "writeNote", id: "$note:2", content: "Nothing fenced or linked here." },
  ]);

  // Build the same index on the Node side from the same (now-written) branch.
  const { vault: v } = await vault.unlockVault(root, passphrase);
  const nodeIndex = openIndex();
  await buildIndex(nodeIndex, v);

  // Both search() (via node:sqlite's null-prototype row objects) and buildNoteGraph()
  // (built inside loadModule's vm sandbox, so its plain objects carry that realm's own
  // Object.prototype) return objects that fail a strict deepEqual against this realm's
  // objects despite identical content — invisible to JSON.stringify's own output, but
  // not to deepEqual's prototype check. A JSON round trip normalizes both away.
  const toPlain = (value) => JSON.parse(JSON.stringify(value));
  for (const query of searchQueries) {
    const rustResults = toPlain(built.search.results[query]);
    const nodeResults = toPlain(nodeSearch(nodeIndex, query));
    assert.deepEqual(rustResults, nodeResults, `search results differ for query "${query}"`);
  }

  const rustGraph = sortGraph(toPlain(built.search.noteGraph));
  const nodeGraph = sortGraph(toPlain(buildNoteGraph(nodeIndex)));
  assert.deepEqual(rustGraph, nodeGraph);
  // The wikilink must have produced exactly one edge, and the fenced/inline-code
  // "Companion" mentions and the already-linked one must not appear as unlinked mentions.
  assert.equal(built.search.noteGraph.edges.length, 1);
  assert.equal(built.search.noteGraph.unlinkedMentions.length, 0);

  // Deleting a note must drop it (and anything mentioning only it) from a fresh index —
  // exercised here by just rebuilding against the branch after a Rust delete.
  const afterDelete = run([{ type: "deleteNote", id: built.createdNotes[2] }]);
  const { vault: v2 } = await vault.unlockVault(root, passphrase);
  const nodeIndex2 = openIndex();
  await buildIndex(nodeIndex2, v2);
  // 4 notes total (the automatic welcome note plus the 3 created above) minus the 1 just
  // deleted ("Unrelated").
  assert.equal(afterDelete.search.noteGraph.nodes.length, 3);
  assert.equal(buildNoteGraph(nodeIndex2).nodes.length, 3);

  // An empty/whitespace-only query must return no results on both sides, and a query
  // containing characters that could otherwise break FTS5 syntax must not error.
  for (const query of ["", "   ", "NOT broken AND"]) {
    const rustEdge = spawnSync(binary, [], {
      input: JSON.stringify({ root, passphrase, ops: [], searchQueries: [query] }),
      encoding: "utf8",
    });
    assert.equal(rustEdge.status, 0, rustEdge.stderr);
    const rustEdgeResult = toPlain(JSON.parse(rustEdge.stdout).search.results[query]);
    const nodeEdgeResult = toPlain(nodeSearch(nodeIndex2, query));
    assert.deepEqual(rustEdgeResult, nodeEdgeResult, `edge-case query mismatch: ${JSON.stringify(query)}`);
  }

  console.log(
    "Rust's FTS5 search index and wikilink note graph (snippets, fenced/inline-code " +
      "exclusion, and unlinked-mention detection) match search.ts exactly, including " +
      "after a delete and for edge-case queries.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
