// Node sidecar entry point for the Tauri shell (see docs/ELECTRON_MIGRATION_REVIEW.md,
// Phase 2). Rust spawns this script as a child process and talks to it over a private,
// length-prefixed JSON request/response protocol on stdin/stdout — nothing here is reachable
// from the renderer directly. Rust is the sole caller and owns every OS dialog, so the
// single-use picked-path allowlist in src/main/service.ts's notes.import/vault.createBackup/
// vault.verifyBackup is intentionally left unused by this first slice rather than re-derived
// on this side; see the "Phase 2 first slice" section of docs/TAURI_MIGRATION.md for what's
// deliberately not wired yet.
//
// This process is transitional: it lets the stabilized Node domain service (src/main/
// service.ts) run unmodified behind a real desktop shell before Phase 4 ports storage to
// Rust. To avoid needing a second native better-sqlite3 build pinned to this sidecar's own
// Node ABI/OS/architecture, search.ts and branch-lock.ts's native SQLite dependency is
// swapped for a tiny adapter over Node's built-in node:sqlite — the exact pattern already
// proven by scripts/tests/regressions.mjs's TestDatabase. Electron keeps using the real
// better-sqlite3 addon; this sidecar only ever uses the engine built into its own Node binary.
//
// Not typechecked/linted as part of src/ (same treatment as scripts/tests/regressions.mjs):
// this file is glue/infrastructure, not application code, and leans on the same dynamic
// module-loading trick that file already uses.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as vaultModule from "../src/main/vault.ts";
import * as linksModule from "../src/shared/note-links.ts";
import * as storageModule from "../src/shared/storage.ts";
import { SerialQueue } from "../src/shared/serial-queue.ts";
import * as databaseExportModule from "../src/main/database-export.ts";
import * as communityCatalogModule from "../src/main/community-catalog.ts";
import { createSettingsStore } from "../src/main/settings-store.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

// Same vm-sandbox module loader as scripts/tests/regressions.mjs, for the same reason: it
// lets a module keep its real production source (transpiled, not hand-copied) while swapping
// out specific import specifiers — here, the native-SQLite-dependent ones.
function loadModule(relative, mocks) {
  const filename = path.join(root, relative);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleObject = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      module: moduleObject,
      exports: moduleObject.exports,
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
  return moduleObject.exports;
}

// node:sqlite-backed stand-in for better-sqlite3's Database, matching only the surface
// search.ts and branch-lock.ts actually use (constructor, exec, prepare, close, transaction).
class NodeSqliteDatabase {
  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout = 0");
  }
  exec(sql) {
    try {
      return this.db.exec(sql);
    } catch (error) {
      if (error.errcode === 5) error.code = "SQLITE_BUSY";
      if (error.errcode === 6) error.code = "SQLITE_LOCKED";
      throw error;
    }
  }
  prepare(sql) {
    return this.db.prepare(sql);
  }
  close() {
    this.db.close();
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

const nativeSqliteMock = { "node:module": { createRequire: () => () => NodeSqliteDatabase } };

const search = loadModule("src/main/search.ts", {
  ...nativeSqliteMock,
  "./vault": vaultModule,
  "../shared/note-links": linksModule,
});

const branchLock = loadModule("src/main/branch-lock.ts", {
  ...nativeSqliteMock,
  "../shared/storage": storageModule,
});

const serviceModule = loadModule("src/main/service.ts", {
  "../shared/serial-queue": { SerialQueue },
  "./branch-lock": branchLock,
  "./vault": vaultModule,
  "./search": search,
  "./database-export": databaseExportModule,
  "./community-catalog": communityCatalogModule,
});

// Rust owns every OS dialog and never asks this sidecar to show one, so these exist only to
// satisfy the ServiceHost shape and fail loudly (rather than hang silently) if something ever
// routes a picker call here by mistake.
function unsupportedPicker(name) {
  return async () => {
    throw new Error(`${name} is handled by the Tauri shell directly, not the sidecar`);
  };
}

const settingsDir = process.env.DRIFTLEAF_SETTINGS_DIR;
if (!settingsDir) {
  console.error("[sidecar] DRIFTLEAF_SETTINGS_DIR is not set; refusing to start");
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const host = {
  settings: createSettingsStore(settingsDir),
  updates: {
    status: () => ({
      state: "unsupported",
      currentVersion: packageJson.version,
      availableVersion: null,
      downloadUrl: null,
      checkedAt: null,
      message: "Updates are not yet available in the Tauri build.",
      automaticInstall: false,
    }),
    check: async () => {
      throw new Error("Update checks are not yet available in the Tauri build");
    },
    download: async () => {
      throw new Error("Update downloads are not yet available in the Tauri build");
    },
    openDownload: async () => {
      throw new Error("Update downloads are not yet available in the Tauri build");
    },
  },
  onSessionReset: () => {},
  pickDirectory: unsupportedPicker("pickDirectory"),
  pickBackupDirectory: unsupportedPicker("pickBackupDirectory"),
  pickBackupDestination: unsupportedPicker("pickBackupDestination"),
  pickImportFiles: unsupportedPicker("pickImportFiles"),
  pickExtensionFile: unsupportedPicker("pickExtensionFile"),
  pickExportDestination: unsupportedPicker("pickExportDestination"),
  openExternal: async () => {
    throw new Error("openExternal is handled by the Tauri shell directly, not the sidecar");
  },
  diagnosticsExtras: () => ({
    version: packageJson.version,
    electron: "n/a (Tauri)",
    chromium: "n/a (Tauri)",
  }),
};

const service = serviceModule.createDriftleafService(host);

// Bounded, length-prefixed framing over private stdin/stdout: a 4-byte big-endian length
// prefix followed by that many bytes of UTF-8 JSON. Never logs request/response bodies —
// those can carry passphrases or note content — only method names and error messages.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function writeFrame(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// service.ts (and everything it imports) runs inside a separate vm.runInNewContext realm, so
// errors it throws are instances of THAT realm's Error, not this script's — `instanceof
// Error` here is always false for them, silently falling through to `String(error)`, which
// prepends a spurious "Error: " onto the message. Check for a string `.message` instead; that
// property exists regardless of which realm constructed the error.
function errorMessage(error) {
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

// Trusted commands: not part of the DriftleafApi/service.ts command set, and not subject to
// service.ts's single-use picked-path allowlist (notes.import / vault.createBackup /
// vault.verifyBackup normally require that a matching service.vault.pick*() call happened
// first — see src/main/service.ts). Rust is this sidecar's only caller, and Rust owns every
// OS dialog directly (see src-tauri/src/main.rs), so by the time one of these arrives the
// path has already been validated against Rust's own single-use tracking of what the native
// dialog actually returned. Re-running service.ts's own picker-coupled commands here would
// just throw "choose it via the picker first" every time, since this sidecar's pickers are
// never actually called (see the unsupportedPicker stubs above). Each still runs inside the
// same serialized op queue and gets the same friendly-error translation as every other
// command, via service.__internal.
const trustedCommands = {
  "vault.trustedCreateBackup": (destinationPath) =>
    service.__internal.runSerializedCommand(() =>
      vaultModule.createVaultBackup(service.__internal.requireVault(), destinationPath),
    ),
  "vault.trustedVerifyBackup": (rootPath, passphrase) =>
    service.__internal.runSerializedCommand(() => vaultModule.verifyVaultBackup(rootPath, passphrase)),
  "notes.trustedImport": (filePaths, targetFolder) =>
    service.__internal.runSerializedCommand(async () => {
      const vault = service.__internal.requireVault();
      const result = await vaultModule.importFiles(vault, filePaths, targetFolder);
      const index = service.__internal.currentIndex();
      if (index) {
        for (const meta of result.imported) {
          const content = await vaultModule.readNote(vault, meta.id);
          search.reindexNote(index, meta, content);
        }
      }
      return {
        imported: result.imported.length,
        importedDatabases: result.importedDatabases.length,
        skipped: result.skipped,
      };
    }),
  "extensions.trustedInstall": (name, source) =>
    service.__internal.runSerializedCommand(() =>
      vaultModule.installExtension(service.__internal.requireVault(), name, source),
    ),
  "databases.trustedExportContent": (id, format) =>
    service.__internal.runSerializedCommand(() =>
      databaseExportModule.exportDatabase(service.__internal.requireVault(), id, format),
    ),
};

function resolveCommand(method) {
  if (typeof method !== "string") throw new Error(`Unknown sidecar command: ${String(method)}`);
  if (Object.hasOwn(trustedCommands, method)) return trustedCommands[method];
  if (!method.includes(".")) throw new Error(`Unknown sidecar command: ${method}`);
  const [group, action] = method.split(".");
  const target = service[group];
  const fn = target ? target[action] : undefined;
  if (typeof fn !== "function") throw new Error(`Unknown sidecar command: ${method}`);
  return (...args) => fn.apply(target, args);
}

async function handleRequest(request) {
  const { id, method, args } = request;
  if (typeof id !== "number" && typeof id !== "string") {
    console.error("[sidecar] dropping request with no id");
    return;
  }
  try {
    const result = await resolveCommand(method)(...(Array.isArray(args) ? args : []));
    writeFrame({ id, ok: true, result: result === undefined ? null : result });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[sidecar] command "${method}" failed: ${message}`);
    writeFrame({ id, ok: false, error: message });
  }
}

let inputBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  for (;;) {
    if (inputBuffer.length < 4) return;
    const length = inputBuffer.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) {
      console.error(`[sidecar] incoming frame (${length} bytes) exceeds the ${MAX_FRAME_BYTES}-byte bound, exiting`);
      process.exit(1);
    }
    if (inputBuffer.length < 4 + length) return;
    const frameBytes = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    let request;
    try {
      request = JSON.parse(frameBytes.toString("utf8"));
    } catch {
      console.error("[sidecar] dropping malformed (non-JSON) frame");
      continue;
    }
    void handleRequest(request);
  }
});

process.stdin.on("end", () => {
  console.error("[sidecar] stdin closed, exiting");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection:", errorMessage(reason));
});

process.on("uncaughtException", (error) => {
  console.error("[sidecar] uncaught exception:", errorMessage(error));
  process.exit(1);
});

console.error("[sidecar] ready");
