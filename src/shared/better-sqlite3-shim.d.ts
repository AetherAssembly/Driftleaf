// Minimal ambient type for the native "better-sqlite3" module, matching only the surface
// search.ts/branch-lock.ts actually use. Neither file ever loads the real native addon at
// runtime any more — Tauri's sidecar and the test suite always swap this import for a tiny
// adapter over Node's built-in node:sqlite (see sidecar/index.mjs's NodeSqliteDatabase and
// scripts/tests/regressions.mjs's TestDatabase) — so this type-only shim exists to satisfy
// `nativeRequire("better-sqlite3") as typeof import("better-sqlite3")` without depending on
// the real (native, build-tool-requiring) npm package just for its types.
declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface Statement<Result = unknown> {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): Result | undefined;
    all(...params: unknown[]): Result[];
  }
  interface DatabaseOptions {
    timeout?: number;
    readonly?: boolean;
  }
  class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare<Result = unknown>(sql: string): Statement<Result>;
    exec(sql: string): this;
    close(): this;
    transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  }
  export = Database;
}
