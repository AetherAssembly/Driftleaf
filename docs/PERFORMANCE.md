# Search

Search works locally across note titles and content in the currently unlocked
branch. Driftleaf prepares its search index when the branch opens and keeps it
current as notes change. The index exists only in memory; it is cleared when
the branch is locked and is not written to disk.

Search is designed to remain responsive as a branch grows. Actual results and
response times depend on the device, the size of the branch, and the search
phrase. The first search after unlocking may take longer while the index is
being prepared.

Search and graph features use information already decrypted for the open
branch. No note content is sent to a remote search service.

## Benchmarks

Measured with `scripts/perf/search-benchmark.mjs` against generated branches of
each size (~1.4 KB of varied prose per note), on an AMD Ryzen 7 7700 (8-core,
16-thread) desktop with Node 26. Reproduce with:

```sh
node --experimental-strip-types --loader ./scripts/tests/typescript-loader.mjs scripts/perf/search-benchmark.mjs
```

`buildIndex()` — the full index rebuild that runs once on every unlock — scales
linearly with branch size:

| Notes | buildIndex total | ms/note |
| ----- | ---------------- | ------- |
| 101   | 2.6ms            | 0.026ms |
| 501   | 9.1ms            | 0.018ms |
| 1,001 | 24.9ms           | 0.025ms |
| 2,501 | 71.8ms           | 0.029ms |
| 5,001 | 211.0ms          | 0.042ms |

Search query latency depends far more on how many notes match than on branch
size. A query matching most notes (common words) grows with branch size; a
query matching exactly one note, or none, stays under a tenth of a millisecond
even at 5,000 notes:

| Notes | common-word query (median) | unique/no-match query (median) |
| ----- | -------------------------- | ------------------------------ |
| 101   | 0.6ms                      | 0.02ms                         |
| 501   | 0.8ms                      | 0.02ms                         |
| 1,001 | 0.9ms                      | 0.02ms                         |
| 2,501 | 1.5ms                      | 0.03–0.07ms                    |
| 5,001 | 2.4ms                      | 0.03–0.07ms                    |

These are a single dev machine's numbers, not a guarantee for every device —
re-run the script to get numbers for a specific machine or branch size. The
script's own note-creation timings (also printed) are **not** representative
of real typing: they bulk-create notes back-to-back, so they mostly measure
how manifest-rewrite cost grows with note count, not interactive performance.

`DEBUG_SEARCH=1` enables the `[search]` timing lines inside `buildIndex()` and
`search()` themselves (`src/main/search.ts`), but only when that code runs
directly in a plain Node process, as the benchmark script does. Running
through the actual app (`npx tauri dev` or a packaged build) routes those same
calls through the sidecar process, whose entrypoint intentionally replaces
`console.log` with a no-op — stdout there is reserved exclusively for the
framed wire protocol to the Tauri shell — so `[search]` lines never reach any
terminal or devtools console that way. The benchmark script (or a similar
standalone script importing `vault.ts`/`search.ts` directly) is currently the
only way to see that instrumentation's output at all.

For related details, see [How Driftleaf Keeps Your Data](ARCHITECTURE.md) and
[Branch Recovery](RECOVERY.md).
