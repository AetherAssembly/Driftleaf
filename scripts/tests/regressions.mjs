import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as vault from "../../src/main/vault.ts";
import * as links from "../../src/shared/note-links.ts";
import * as contract from "../../src/shared/ipc.ts";
import { SerialQueue } from "../../src/shared/serial-queue.ts";
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
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  exec(sql) {
    return this.db.exec(sql);
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

async function temporaryBranch(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "driftleaf-regression-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ipcHarness() {
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
    "./settings": { patchSettings: async () => {} },
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
