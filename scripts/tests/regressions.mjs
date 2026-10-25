import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as vault from "../../src/main/vault.ts";
import * as links from "../../src/shared/note-links.ts";
import { SerialQueue } from "../../src/shared/serial-queue.ts";
import * as storage from "../../src/shared/storage.ts";
import * as databaseExport from "../../src/main/database-export.ts";
import * as communityCatalog from "../../src/main/community-catalog.ts";
import { DraftWrites } from "../../src/renderer/lib/draft-writes.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
function loadModule(relative, mocks) {
  const filename = path.join(root, relative);
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

// The production addon is rebuilt for Electron in CI. Run the actual search
// functions against Node's FTS5 engine without rebuilding that addon for tests.
class TestDatabase {
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
const search = loadModule("src/main/search.ts", {
  "node:module": { createRequire: () => () => TestDatabase },
  "./vault": vault,
  "../shared/note-links": links,
});

const branchLocks = loadModule("src/main/branch-lock.ts", {
  "node:module": { createRequire: () => () => TestDatabase },
  "../shared/storage": storage,
});

// The Electron-independent domain service (see docs/ELECTRON_MIGRATION_REVIEW.md, Phase 1).
// Loaded once; every harness below calls createDriftleafService(...) fresh so sessions stay
// isolated between independent harness instances without re-loading the module each time.
const serviceModule = loadModule("src/main/service.ts", {
  "../shared/serial-queue": { SerialQueue },
  "./branch-lock": branchLocks,
  "./vault": vault,
  "./search": search,
  "./database-export": databaseExport,
  "./community-catalog": communityCatalog,
});

const extensionAccessModule = loadModule("src/main/extension-access.ts", {
  "./vault": vault,
  "./search": search,
});

async function temporaryBranch(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "driftleaf-regression-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A minimal ServiceHost for tests: no real dialogs/updater/settings-directory, just enough
// for the session/command logic under test. Pass `overrides.settings` to swap in a
// settings store that fails, as the real app's settings directory might.
function fakeHost(overrides = {}) {
  return {
    settings: overrides.settings ?? {
      readSettings: async () => ({}),
      patchSettings: async () => ({}),
    },
    updates: {
      status: () => ({}),
      check: async () => ({}),
      download: async () => ({}),
      openDownload: async () => {},
    },
    onSessionReset: () => {},
    pickDirectory: async () => null,
    pickBackupDirectory: async () => null,
    pickBackupDestination: async () => null,
    pickImportFiles: async () => null,
    pickExtensionFile: async () => null,
    pickExportDestination: async () => null,
    openExternal: async () => {},
    diagnosticsExtras: () => ({ version: "test", runtime: "test" }),
    ...overrides,
  };
}

// Exercises the production TypeScript service directly — this is the only adapter now
// that the Electron IPC layer (src/main/ipc.ts) has been removed; the Tauri shell's own
// command surface is tested separately in src-tauri's Rust tests.
function serviceHarness(hostOverrides) {
  return serviceModule.createDriftleafService(fakeHost(hostOverrides));
}

function serviceInvoke(service) {
  return (method, ...args) => {
    switch (method) {
      case "vault.create":
        return service.vault.create(...args);
      case "vault.unlock":
        return service.vault.unlock(...args);
      case "vault.lock":
        return service.vault.lock();
      case "vault.hasPassphrase":
        return service.vault.hasPassphrase(...args);
      case "notes.create":
        return service.notes.create(...args);
      case "notes.write":
        return service.notes.write(...args);
      case "notes.read":
        return service.notes.read(...args);
      default:
        throw new Error(`Unmapped contract method: ${method}`);
    }
  };
}

// Shared assertions: create, prove the passphrase is recorded, round-trip a note through
// write/read, lock, then prove the session is really gone (Finding #2's invariant — no
// command can still see the vault once locked). `call(method, ...args)` is adapter-agnostic.
async function runCoreCommandContract(call, directory) {
  await call("vault.create", directory, "contract-passphrase", "blank");
  assert.equal(await call("vault.hasPassphrase", directory), true);
  const note = await call("notes.create", "", "Contract note");
  await call("notes.write", note.id, "hello from the contract test");
  assert.equal(await call("notes.read", note.id), "hello from the contract test");
  await call("vault.lock");
  await assert.rejects(call("notes.read", note.id), /No vault is unlocked/);
}

test("service contract: core session/note commands work directly against the service", async () => {
  await temporaryBranch(async (directory) => {
    const service = serviceHarness();
    await runCoreCommandContract(serviceInvoke(service), directory);
  });
});

test("recreating a branch leaves all encryption metadata and existing notes intact", async () => {
  await temporaryBranch(async (directory) => {
    const original = await vault.createVault(directory, "original");
    const note = await vault.createNote(original, "", "Keep me");
    await vault.writeNote(original, note.id, "Original private content");
    // Use actual names from the initialized directory, including every root metadata file.
    const { readdir } = await import("node:fs/promises");
    const metadata = path.join(directory, ".driftleaf");
    const names = (await readdir(metadata, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    const before = await Promise.all(names.map((name) => readFile(path.join(metadata, name))));
    await assert.rejects(vault.createVault(directory, "replacement"), /already contains a branch/);
    const after = await Promise.all(names.map((name) => readFile(path.join(metadata, name))));
    assert.deepEqual(after, before);
    const reopened = await vault.unlockVault(directory, "original");
    assert.equal(await vault.readNote(reopened.vault, note.id), "Original private content");
  });
});

test("only one concurrent creator can reserve a branch", async () => {
  await temporaryBranch(async (directory) => {
    const results = await Promise.allSettled([
      vault.createVault(directory, "first"),
      vault.createVault(directory, "second"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    await vault.unlockVault(directory, winner === 0 ? "first" : "second");
  });
});

test("service op queue waits for complete writes and rejects writes queued after lock", async () => {
  await temporaryBranch(async (directory) => {
    const service = serviceHarness();
    await service.vault.create(directory, "passphrase", "blank");
    const note = await service.notes.create("", "Race");
    const writes = Array.from({ length: 8 }, (_, n) => service.notes.write(note.id, `revision ${n}`));
    const locking = service.vault.lock();
    const late = assert.rejects(service.notes.write(note.id, "too late"), /No vault is unlocked/);
    await Promise.all([...writes, locking, late]);
    const reopened = await vault.unlockVault(directory, "passphrase");
    assert.equal(await vault.readNote(reopened.vault, note.id), "revision 7");
  });
});

test("reindexing removes stale matches and links without duplicating graph nodes", () => {
  const index = search.openIndex();
  try {
    search.reindexNote(index, { id: "target", title: "Target", folderPath: "" }, "");
    search.reindexNote(
      index,
      { id: "note", title: "Old title", folderPath: "" },
      "obsoleteword [[Target]]",
    );
    search.reindexNote(
      index,
      { id: "note", title: "New title", folderPath: "Moved" },
      "currentword",
    );
    search.reindexNote(
      index,
      { id: "note", title: "New title", folderPath: "Moved" },
      "currentword",
    );
    assert.equal(search.search(index, "obsoleteword").length, 0);
    assert.equal(search.search(index, "currentword").length, 1);
    assert.equal(search.search(index, "currentword")[0].folderPath, "Moved");
    assert.equal(search.buildNoteGraph(index).nodes.length, 2);
    assert.equal(search.buildNoteGraph(index).edges.length, 0);
  } finally {
    index.db.close();
  }
});

test("failed drafts survive for retry and prevent a successful flush acknowledgement", async () => {
  const drafts = new DraftWrites();
  let fail = true;
  let persisted = "";
  drafts.set("note", async () => {
    if (fail) throw new Error("Disk full");
    persisted = "keep this edit";
  });
  await assert.rejects(drafts.flush(), /Disk full/);
  assert.equal(persisted, "");
  fail = false;
  await drafts.flush();
  assert.equal(persisted, "keep this edit");
});

test("close flush waits for in-flight saves and the latest edit", async () => {
  const drafts = new DraftWrites();
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const persisted = [];
  drafts.set("note", async () => {
    started();
    await gate;
    persisted.push("first");
  });
  const autosave = drafts.flush();
  await entered;
  drafts.set("note", async () => {
    persisted.push("latest");
  });
  let closed = false;
  const close = drafts.flush().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([autosave, close]);
  assert.deepEqual(persisted, ["first", "latest"]);
  assert.equal(closed, true);
});

test("independent sessions cannot unlock the same branch until the owner locks it", async () => {
  await temporaryBranch(async (directory) => {
    const first = serviceHarness();
    const second = serviceHarness();
    try {
      await first.vault.create(directory, "passphrase", "blank");
      await assert.rejects(second.vault.unlock(directory, "passphrase"), /already open/);
      await first.vault.lock();
      await second.vault.unlock(directory, "passphrase");
    } finally {
      await first.vault.lock();
      await second.vault.lock();
    }
  });
});

test("failed unlock and failed session setup release the writer lock", async () => {
  await temporaryBranch(async (directory) => {
    await vault.createVault(directory, "passphrase");
    const first = serviceHarness();
    await assert.rejects(first.vault.unlock(directory, "wrong"), /Incorrect passphrase/);
    const broken = serviceHarness({
      settings: {
        patchSettings: async () => {
          throw new Error("Settings are read-only");
        },
      },
    });
    await assert.rejects(broken.vault.unlock(directory, "passphrase"), /read-only/);
    try {
      await first.vault.unlock(directory, "passphrase");
    } finally {
      await first.vault.lock();
    }
  });
});

test("backup includes flushed drafts but excludes the live writer lock", async () => {
  await temporaryBranch(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "backups");
    const { mkdir, access } = await import("node:fs/promises");
    await mkdir(destination);
    const lock = await branchLocks.acquireBranchLock(source, true);
    try {
      const branch = await vault.createVault(source, "passphrase");
      const note = await vault.createNote(branch, "", "Pending draft");
      const drafts = new DraftWrites();
      drafts.set("note", () => vault.writeNote(branch, note.id, "Latest edit"));
      await drafts.flush();
      const backup = await vault.createVaultBackup(branch, destination);
      await assert.rejects(access(path.join(backup, storage.BRANCH_LOCK_FILENAME)), {
        code: "ENOENT",
      });
      const restored = await vault.unlockVault(backup, "passphrase");
      assert.equal(await vault.readNote(restored.vault, note.id), "Latest edit");
    } finally {
      lock.release();
    }
  });
});

test("OS writer lock is released after another process crashes", async () => {
  await temporaryBranch(async (directory) => {
    const filename = path.join(directory, storage.BRANCH_LOCK_FILENAME);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.on('message', () => {});
      process.send('locked');
    `,
        filename,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    try {
      const [message] = await once(child, "message");
      assert.equal(message, "locked");
      await assert.rejects(branchLocks.acquireBranchLock(directory), /already open/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const lock = await branchLocks.acquireBranchLock(directory);
      lock.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});

test("failed canvas writes remain queued and persist the newest revision on retry", async () => {
  const drafts = new DraftWrites();
  let persisted;
  drafts.set("canvas", async () => {
    throw new Error("Read-only branch");
  });
  await assert.rejects(drafts.flush(), /Read-only/);
  drafts.set("canvas", async () => {
    persisted = [{ id: "card", x: 20, y: 30 }];
  });
  await drafts.flush();
  assert.deepEqual(persisted, [{ id: "card", x: 20, y: 30 }]);
});


test("shared extension access enforces sender, grants, revocation, removal, and session generation", async () => {
  await temporaryBranch(async directory => {
    const service = serviceHarness();
    await service.vault.create(directory, "test-passphrase", "blank");
    try {
      const current = service.__internal.requireVault();
      const extension = await vault.installExtension(current, "Reader", "void 0;");
      const note = await service.notes.create("", "Private note");
      await service.notes.write(note.id, "private content");
      const context = { extensionId: extension.id, generation: service.__internal.generation() };
      const access = extensionAccessModule.createExtensionAccess(service, sender => sender === "owned-window" ? context : undefined);
      await assert.rejects(access.readNote("other-window", note.id), /not an active/);
      await assert.rejects(access.readNote("owned-window", note.id), /not been granted/);
      await service.extensions.setPermissions(extension.id, ["read_notes"], []);
      assert.equal(await access.readNote("owned-window", note.id), "private content");
      await assert.rejects(access.graph("owned-window"), /not been granted/);
      // Queue revocation before a read: authorization must run when the read executes.
      const revoke = service.extensions.setPermissions(extension.id, [], []);
      const denied = assert.rejects(access.readNote("owned-window", note.id), /not been granted/);
      await Promise.all([revoke, denied]);
      await service.extensions.setPermissions(extension.id, ["read_notes"], []);
      await service.vault.lock();
      await service.vault.unlock(directory, "test-passphrase");
      await assert.rejects(access.readNote("owned-window", note.id), /not an active/);
      context.generation = service.__internal.generation();
      assert.equal(await access.readNote("owned-window", note.id), "private content");
      await service.extensions.remove(extension.id);
      await assert.rejects(access.listNotes("owned-window"), /removed/);
    } finally { await service.vault.lock(); }
  });
});

test("shared extension database reads hide ungranted databases and related columns", async () => {
  await temporaryBranch(async directory => {
    const service = serviceHarness();
    await service.vault.create(directory, "test-passphrase", "blank");
    try {
      const current = service.__internal.requireVault();
      const hidden = await vault.createDatabase(current, "Secret", "", [{ id: "hidden-title", name: "Name", type: "title" }], []);
      const visible = await vault.createDatabase(current, "Shared", "", [
        { id: "title", name: "Name", type: "title" },
        { id: "relation", name: "Secret relation", type: "relation", relationDatabaseId: hidden.id },
        { id: "rollup", name: "Secret rollup", type: "rollup", rollupRelationPropertyId: "relation", rollupTargetPropertyId: "hidden-title", rollupFunction: "count" },
      ], [{ id: "shared-row", values: { title: "Visible row", relation: [] }, createdAt: 1, updatedAt: 1 }]);
      const extension = await vault.installExtension(current, "Database reader", "void 0;");
      await service.extensions.setPermissions(extension.id, ["read_databases"], [visible.id]);
      const context = { extensionId: extension.id, generation: service.__internal.generation() };
      const access = extensionAccessModule.createExtensionAccess(service, () => context);
      const list = await access.listDatabases("owned-window");
      assert.deepEqual(Array.from(list, item => item.id), [visible.id]);
      await assert.rejects(access.readDatabase("owned-window", hidden.id), /not been granted/);
      const filtered = await access.readDatabase("owned-window", visible.id);
      assert.deepEqual(Array.from(filtered.properties, property => property.id), ["title"]);
      assert.deepEqual(Object.keys(filtered.rows[0].values), ["title"]);
      await service.extensions.setPermissions(extension.id, ["read_databases"], [visible.id, hidden.id]);
      const expanded = await access.readDatabase("owned-window", visible.id);
      assert.equal(expanded.properties.length, 3);
    } finally { await service.vault.lock(); }
  });
});
