# Search Performance Documentation

## Overview

Want to check how fast your search is? We've added instrumentation to track search index build time, query latency, and incremental reindex performance. This doc walks you through running performance tests and figuring out what you're seeing.

## Turning on Performance Logging

By default, performance logging is off so you don't get flooded with console output. Here's how to enable it:

### macOS / Linux

```bash
export DEBUG_SEARCH=1
npm run dev
```

Or inline:

```bash
DEBUG_SEARCH=1 npm run dev
```

### Windows (PowerShell)

```powershell
$env:DEBUG_SEARCH=1
npm run dev
```

Once enabled, you'll see logs in the **Electron DevTools console** (not your regular terminal). Open DevTools with **Ctrl+Shift+I** (or **Cmd+Opt+I** on macOS) after launching the app.

Example output:

```bash
[search] buildIndex: 523ms total (decrypt: 287ms, insert: 236ms) for 1000 notes (0.52ms/note)
[search] query "test": 12ms, 8 results
```

That tells you how long it took to decrypt and index all your notes, and how fast individual searches ran.

## Running Performance Tests

### Quick Test With Your Current Vault

1. Start the dev server with `DEBUG_SEARCH=1` set (see above)
2. Open DevTools (**Ctrl+Shift+I** or **Cmd+Opt+I**)
3. Create a vault with a few notes, then unlock it
4. Check the DevTools console for `[search]` tagged logs with build timing
5. Try searching for terms in the sidebar and check for query timing logs

You should see logs like:

```bash
[search] buildIndex: XXms total (decrypt: XXms, insert: XXms) for N notes
[search] query "searchterm": XXms, N results
```

### Benchmarking With Generated Test Data

For consistent, reproducible benchmarks, generate a test vault with a specific number of notes:

```bash
npx ts-node scripts/generateTestVault.ts 1000 /tmp/test-vault-1000
```

This creates a test vault at `/tmp/test-vault-1000` with 1,000 notes across 5 folders. The passphrase is hardcoded to `testpass123` so you can repeat the test easily.

Once the test vault exists:

1. Start the app in debug mode: `DEBUG_SEARCH=1 npm run dev`
2. Open the test vault from the file picker
3. Enter passphrase `testpass123`
4. Check the DevTools console for build and query timing logs
5. Run searches (try "test", "lorem", "project") to measure query latency at various scales

### Scaling Tests

Generate vaults of different sizes to profile performance curves:

```bash
# Small
npx ts-node scripts/generateTestVault.ts 100 /tmp/test-vault-100

# Medium
npx ts-node scripts/generateTestVault.ts 500 /tmp/test-vault-500

# Large
npx ts-node scripts/generateTestVault.ts 1000 /tmp/test-vault-1000

# Very large (if your machine can handle it)
npx ts-node scripts/generateTestVault.ts 5000 /tmp/test-vault-5000
```

## Baseline Metrics (v0.2.x Target)

These targets come from the original plan ("unlock + reconcile 258ms for 1,000 notes"):

| Metric | Target | Notes |
| --- | --- | --- |
| Index build (100 notes) | <50ms | Initial reference point |
| Index build (500 notes) | <200ms | Mid-scale performance |
| Index build (1000 notes) | <500ms | Full-scale target |
| Decrypt phase (1000 notes) | <400ms | Parallel decryption speedup |
| Insert phase (1000 notes) | <150ms | Transaction + REPLACE INTO |
| Query latency (simple, any scale) | <50ms | "test", "lorem", etc. |
| Query latency (complex, any scale) | <100ms | Multi-word, phrase queries |
| Incremental reindex (1 note) | <5ms | Single REPLACE INTO |
| Incremental reindex (folder rename, 100 notes) | <100ms | Full rebuild triggered |

## Making Sense of the Results

### Build Time Breakdown

```bash
[search] buildIndex: 523ms total (decrypt: 287ms, insert: 236ms) for 1000 notes
```

- **Total** — wall-clock time from start to finish
- **Decrypt** — time spent decrypting all notes (runs in parallel via `Promise.all`)
- **Insert** — time spent in the SQLite transaction (inserts + COMMIT)
- **Per-note average** — `total / noteCount`, handy for scaling predictions

What to expect:

- Decrypt should dominate for large vaults (parallel crypto is the bottleneck)
- Insert should stay roughly constant fraction as notes scale (transaction overhead is minimal)
- If decrypt is very fast and insert is slow, the transaction probably isn't being used correctly

### Query Latency

```bash
[search] query "test": 12ms, 8 results
```

- **Time** — milliseconds from query to first result
- **Results** — number of matching notes (capped at 50)

What to expect:

- Simple queries (single word, common term): 5–20ms
- Complex queries (multi-word, rare terms): 20–100ms
- Latency should be roughly independent of vault size (FTS5 indexes are efficient)

## Optimizations Made (v0.2.x)

1. **Parallel decryption** (in `buildIndex`)
   - Replaced sequential `for` loop with `Promise.all()`
   - All notes decrypt in parallel; inserts remain serial (SQLite is single-threaded)
   - Expected improvement: 2–3× faster on large vaults (I/O bound)

2. **Transaction wrapping** (in `buildIndex`)
   - Wrapped all inserts in `BEGIN TRANSACTION` / `COMMIT`
   - Reduces SQLite overhead per insert
   - Expected improvement: 10–20% faster

3. **REPLACE INTO** (in `reindexNote`)
   - Replaced DELETE + INSERT with atomic REPLACE
   - Reduces statement overhead on single-note updates
   - Expected improvement: ~50% faster on incremental reindex

4. **Timing instrumentation**
   - Precise measurement of each phase
   - Toggle on/off via `DEBUG_SEARCH` env var

## Next Steps (Post-v0.2)

- **Memory profiling** — measure peak memory during decrypt with large vaults (parallel decryption may spike it)
- **Incremental index updates** — folder rename currently triggers full rebuild; could optimize to only update paths
- **Query optimization** — profile complex queries; consider index tuning for common patterns
- **Streaming inserts** — if inserts ever become a bottleneck, look at batch sizing or prepared statement pooling

## Troubleshooting

### "buildIndex not logging even with DEBUG_SEARCH=1"

- Make sure `DEBUG_SEARCH=1` is set *before* starting the app (`export DEBUG_SEARCH=1`, then `npm run dev`)
- You have to open the Electron DevTools console to see logs (Ctrl+Shift+I on Linux/Windows, Cmd+Opt+I on macOS)
- Logs go to the main process — visible only in DevTools, not the terminal
- Verify `process.env.DEBUG_SEARCH` is truthy when notes load

### "No logs in DevTools console"

- Make sure DevTools is actually open when you unlock the vault (logs fire immediately on unlock)
- Logs are prefixed with `[search]` — search for that in the console
- Try triggering an action: create a note, rename a folder, or search — those should produce logs

### "Query latency looks really high (>100ms on small vault)"

- Check if other processes are hogging CPU
- Verify the vault actually contains the notes you're searching for (empty results should be fast)
- Run the same test multiple times; first query may be slower than subsequent ones

### "Test vault generation fails"

- Make sure the app is built: `npm run build`
- Verify `scripts/generateTestVault.ts` exists and is executable
- Check that the output directory is writable

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md#search) — search index design
- [src/main/search.ts](../src/main/search.ts) — search module with instrumentation
- [src/main/ipc.ts](../src/main/ipc.ts) — IPC unlock timing
