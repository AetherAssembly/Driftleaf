import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as vault from "../../src/main/vault.ts";
import * as links from "../../src/shared/note-links.ts";
import * as contract from "../../src/shared/ipc.ts";
import { SerialQueue } from "../../src/shared/serial-queue.ts";
import * as storage from "../../src/shared/storage.ts";
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

async function temporaryBranch(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "driftleaf-regression-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ipcHarness(settings = { patchSettings: async () => {} }) {
  const handlers = new Map();
  const api = loadModule("src/main/ipc.ts", {
    electron: {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: {},
      BrowserWindow: class {},
      dialog: {},
    },
    "../shared/serial-queue": { SerialQueue },
    "../shared/ipc": contract,
    "./window-lifecycle": {},
    "./vault": vault,
    "./search": search,
    "./settings": settings,
    "./branch-lock": branchLocks,
    "./updates": {},
    "./database-export": {},
    "./community-catalog": {},
  });
  api.registerIpcHandlers({});
  return (channel, ...args) => handlers.get(channel)({}, ...args);
}

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

test("real IPC lock waits for complete writes and rejects writes queued after lock", async () => {
  await temporaryBranch(async (directory) => {
    const invoke = ipcHarness();
    await invoke(contract.IPC_CHANNELS.vaultCreate, directory, "passphrase", "blank");
    const note = await invoke(contract.IPC_CHANNELS.notesCreate, "", "Race");
    const writes = Array.from({ length: 8 }, (_, n) =>
      invoke(contract.IPC_CHANNELS.notesWrite, note.id, `revision ${n}`),
    );
    const locking = invoke(contract.IPC_CHANNELS.vaultLock);
    const late = assert.rejects(
      invoke(contract.IPC_CHANNELS.notesWrite, note.id, "too late"),
      /No vault is unlocked/,
    );
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

test("close handshake validates sender, drains after acknowledgement, and permits retry after failure", async () => {
  const ipc = new EventEmitter();
  const lifecycle = loadModule("src/main/window-lifecycle.ts", {
    electron: { ipcMain: ipc },
    "../shared/ipc": contract,
  });
  const frame = {};
  let requestId;
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame: frame,
      send: (channel, id) => {
        if (channel === contract.RENDERER_EVENTS.beforeClose) requestId = id;
      },
    },
  };
  let drained = 0;
  const drain = async () => {
    drained++;
  };
  const first = lifecycle.prepareWindowClose(win, drain);
  ipc.emit(contract.IPC_CHANNELS.flushResult, { sender: {}, senderFrame: frame }, requestId);
  assert.equal(drained, 0);
  ipc.emit(
    contract.IPC_CHANNELS.flushResult,
    { sender: win.webContents, senderFrame: frame },
    requestId,
    "Disk full",
  );
  await assert.rejects(first, /Disk full/);
  assert.equal(lifecycle.isCloseApproved(win), false);
  assert.equal(drained, 0);
  const retry = lifecycle.prepareWindowClose(win, drain);
  ipc.emit(
    contract.IPC_CHANNELS.flushResult,
    { sender: win.webContents, senderFrame: frame },
    requestId,
  );
  await retry;
  assert.equal(lifecycle.isCloseApproved(win), true);
  assert.equal(drained, 1);
});

test("independent sessions cannot unlock the same branch until the owner locks it", async () => {
  await temporaryBranch(async (directory) => {
    const first = ipcHarness();
    const second = ipcHarness();
    try {
      await first(contract.IPC_CHANNELS.vaultCreate, directory, "passphrase", "blank");
      await assert.rejects(
        second(contract.IPC_CHANNELS.vaultUnlock, directory, "passphrase"),
        /already open/,
      );
      await first(contract.IPC_CHANNELS.vaultLock);
      await second(contract.IPC_CHANNELS.vaultUnlock, directory, "passphrase");
    } finally {
      await first(contract.IPC_CHANNELS.vaultLock);
      await second(contract.IPC_CHANNELS.vaultLock);
    }
  });
});

test("failed unlock and failed session setup release the writer lock", async () => {
  await temporaryBranch(async (directory) => {
    await vault.createVault(directory, "passphrase");
    const first = ipcHarness();
    await assert.rejects(
      first(contract.IPC_CHANNELS.vaultUnlock, directory, "wrong"),
      /Incorrect passphrase/,
    );
    const broken = ipcHarness({
      patchSettings: async () => {
        throw new Error("Settings are read-only");
      },
    });
    await assert.rejects(
      broken(contract.IPC_CHANNELS.vaultUnlock, directory, "passphrase"),
      /read-only/,
    );
    try {
      await first(contract.IPC_CHANNELS.vaultUnlock, directory, "passphrase");
    } finally {
      await first(contract.IPC_CHANNELS.vaultLock);
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
