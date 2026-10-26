// Measures real buildIndex()/search() timings against generated branches of varying size.
//
// This bypasses the sidecar entrypoint (sidecar/index.mjs) on purpose: that process sets
// `console.log = console.info = console.debug = () => {}` because stdout there is exclusively
// the framed wire protocol, including when DEBUG_SEARCH is set — so the [search] instrumentation
// in src/main/search.ts never actually reaches a terminal when running through the real app.
// Importing vault.ts/search.ts directly in this standalone process sidesteps that: DEBUG_SEARCH's
// own console.log calls fire normally here, and we additionally take our own timings around each
// call so results don't depend on parsing that log text.
//
// Run with:
//   node --experimental-strip-types --loader ./scripts/tests/typescript-loader.mjs scripts/perf/search-benchmark.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as vault from "../../src/main/vault.ts";
import * as links from "../../src/shared/note-links.ts";

process.env.DEBUG_SEARCH = "1";

// Same transpile-to-CommonJS-in-a-vm approach scripts/tests/search-interop.mjs uses: search.ts's
// `createRequire(__filename)` native better-sqlite3 load only works inside Electron/Tauri's
// bundled Node, not this bare test process, so better-sqlite3 is mocked onto node:sqlite instead.
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
const { openIndex, buildIndex, search: nodeSearch } = loadModule("src/main/search.ts", {
  "node:module": { createRequire: () => () => TestDatabase },
  "./vault": vault,
  "../shared/note-links": links,
});

// ~1.4 KB of realistic note prose (paragraphs + a wikilink + inline code), repeated/varied
// per note so FTS has non-trivial, non-identical content to index and search.
const PARAGRAPHS = [
  "Driftleaf keeps every note encrypted at rest with a key derived from your passphrase.",
  "Search runs locally against SQLite FTS5 and never leaves the device.",
  "See [[Companion note]] for how backlinks resolve across folders.",
  "Use `prop(\"Status\")` inside a database formula to reference another column.",
  "Canvas cards are references, not copies — removing one never deletes its target.",
  "A branch is just a folder; back it up by copying the whole thing, hidden directory included.",
  "Extensions run isolated and start with every permission disabled until you grant it.",
  "The community gallery previews JavaScript source before you ever install anything.",
];
function noteContent(i) {
  const shuffled = PARAGRAPHS.slice((i % PARAGRAPHS.length)).concat(
    PARAGRAPHS.slice(0, i % PARAGRAPHS.length),
  );
  return `Note ${i}\n\n${shuffled.join(" ")}\n\nUnique marker: zz${i}token.`;
}

const QUERIES = ["driftleaf", "encrypted", "zz1337token", "nonexistentqueryterm", "formula"];

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

// Sub-millisecond precision: at realistic branch sizes buildIndex/search complete in well
// under 1ms, where Date.now()'s millisecond granularity just reads back as a string of zeros.
function hrMillis(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsedNs = process.hrtime.bigint() - start;
  return { result, ms: Number(elapsedNs) / 1e6 };
}
async function hrMillisAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const elapsedNs = process.hrtime.bigint() - start;
  return { result, ms: Number(elapsedNs) / 1e6 };
}

async function benchmarkSize(noteCount) {
  const root = await mkdtemp(path.join(os.tmpdir(), "driftleaf-perf-"));
  try {
    const passphrase = "benchmark fixture passphrase";
    const v = await vault.createVault(root, passphrase, "blank");

    const createStart = Date.now();
    for (let i = 0; i < noteCount; i++) {
      const meta = await vault.createNote(v, "", `Benchmark note ${i}`);
      await vault.writeNote(v, meta.id, noteContent(i));
    }
    const createDuration = Date.now() - createStart;

    const index = openIndex();
    const { ms: buildDuration } = await hrMillisAsync(() => buildIndex(index, v));

    const queryTimings = {};
    for (const query of QUERIES) {
      const samples = [];
      for (let run = 0; run < 20; run++) {
        const { ms } = hrMillis(() => nodeSearch(index, query));
        samples.push(ms);
      }
      samples.sort((a, b) => a - b);
      queryTimings[query] = {
        min: samples[0],
        median: percentile(samples, 0.5),
        max: samples[samples.length - 1],
      };
    }

    return {
      noteCount: noteCount + 1, // +1 for the automatic "Welcome to Driftleaf" note
      createDuration,
      buildDuration,
      msPerNoteBuild: buildDuration / (noteCount + 1),
      queryTimings,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sizes = [100, 500, 1000, 2500, 5000];
const results = [];
for (const size of sizes) {
  console.log(`\n=== Benchmarking ${size} notes ===`);
  const result = await benchmarkSize(size);
  results.push(result);
}

console.log("\n\n# Results summary\n");
console.log("| Notes | Create (bulk, not representative of real typing) | buildIndex total | ms/note |");
console.log("| ----- | --- | --- | --- |");
for (const r of results) {
  console.log(
    `| ${r.noteCount} | ${r.createDuration}ms | ${r.buildDuration}ms | ${r.msPerNoteBuild.toFixed(3)}ms |`,
  );
}

console.log("\n| Notes | " + QUERIES.map((q) => `"${q}" (median ms)`).join(" | ") + " |");
console.log("| ----- | " + QUERIES.map(() => "---").join(" | ") + " |");
for (const r of results) {
  console.log(
    `| ${r.noteCount} | ` +
      QUERIES.map((q) => r.queryTimings[q].median.toFixed(3)).join(" | ") +
      " |",
  );
}

console.log("\nFull per-query min/median/max:");
console.log(JSON.stringify(results.map((r) => ({ notes: r.noteCount, queries: r.queryTimings })), null, 2));
