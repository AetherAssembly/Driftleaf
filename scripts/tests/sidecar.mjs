import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.env.DRIFTLEAF_TEST_BACKEND || path.resolve(import.meta.dirname, "../..");
const nodeBinary = process.env.DRIFTLEAF_TEST_BACKEND
  ? path.join(root, process.platform === "win32" ? "node.exe" : "node") : process.execPath;
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "driftleaf-sidecar-"));
  const children = [];
  function start() {
    const child = spawn(
      nodeBinary,
      [
        "--experimental-strip-types",
        "--loader",
        path.join(root, "scripts/tests/typescript-loader.mjs"),
        path.join(root, "sidecar/index.mjs"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DRIFTLEAF_SETTINGS_DIR: path.join(directory, "settings"),
          DEBUG_SEARCH: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    let stderr = "";
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    let exited = false;
    const exit = new Promise((resolve) =>
      child.once("close", (code) => {
        exited = true;
        for (const { reject } of pending.values())
          reject(new Error(`Sidecar exited (${code}): ${stderr}`));
        pending.clear();
        resolve(code);
      }),
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE();
        assert.ok(size <= 64 * 1024 * 1024, "stdout must contain only bounded protocol frames");
        if (buffer.length < size + 4) return;
        const response = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        const request = pending.get(response.id);
        assert.ok(request, "response must match a pending request");
        pending.delete(response.id);
        if (response.ok) request.resolve(response.result);
        else request.reject(new Error(response.error));
      }
    });
    function request(method, args = [], fragmented = false) {
      if (exited) return Promise.reject(new Error(`Sidecar already exited: ${stderr}`));
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const bytes = frame({ id, method, args });
      if (fragmented) {
        child.stdin.write(bytes.subarray(0, 2));
        child.stdin.write(bytes.subarray(2, 9));
        child.stdin.write(bytes.subarray(9));
      } else child.stdin.write(bytes);
      return result;
    }
    return { request, child, exit, stderr: () => stderr };
  }
  try {
    await run({ directory, start });
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("close", resolve);
            child.kill();
          }),
      ),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "real sidecar: framed commands, encrypted branch lifecycle, FTS, backup, and exclusive writers",
  { timeout: 30000 },
  async () => {
    await fixture(async ({ directory, start }) => {
      const first = start();
      const branch = path.join(directory, "branch");
      await first.request("vault.create", [branch, "test passphrase", "blank"], true);
      const note = await first.request("notes.create", ["", "Sidecar note"]);
      await first.request("notes.write", [note.id, "obsoleteword"]);
      await first.request("notes.write", [note.id, "privatecanaryword 🪴"]);
      assert.equal(await first.request("notes.read", [note.id]), "privatecanaryword 🪴");
      assert.ok((await first.request("notes.list")).some((item) => item.id === note.id));
      assert.equal((await first.request("search.query", ["obsoleteword"])).length, 0);
      assert.equal((await first.request("search.query", ["privatecanaryword"])).length, 1);
      const [settings, status] = await Promise.all([
        first.request("settings.read"),
        first.request("updates.status"),
      ]);
      assert.equal(settings.lastVaultPath, branch);
      assert.equal(status.automaticInstall, false);
      const backupRoot = path.join(directory, "backups");
      await mkdir(backupRoot);
      const backup = await first.request("vault.trustedCreateBackup", [backupRoot]);
      assert.ok(backup.startsWith(backupRoot));
      const second = start();
      await assert.rejects(
        second.request("vault.unlock", [branch, "test passphrase"]),
        /already open/,
      );
      await first.request("vault.lock");
      await assert.rejects(first.request("notes.read", [note.id]), /No vault is unlocked/);
      await second.request("vault.unlock", [branch, "test passphrase"]);
      assert.equal(await second.request("notes.read", [note.id]), "privatecanaryword 🪴");
      await second.request("vault.lock");
      await second.request("vault.unlock", [backup, "test passphrase"]);
      assert.equal(await second.request("notes.read", [note.id]), "privatecanaryword 🪴");
      await second.request("vault.lock");
      assert.ok(
        !first.stderr().includes("privatecanaryword"),
        "debug logging must not leak note/search content",
      );
      first.child.stdin.end();
      assert.equal(await first.exit, 0);
    });
  },
);

test(
  "real sidecar rejects internals, prototype methods, extra path segments, and invalid arguments",
  { timeout: 15000 },
  async () => {
    await fixture(async ({ start }) => {
      const service = start();
      for (const method of [
        "__internal.requireVault",
        "__internal.currentVault",
        "__internal.currentIndex",
        "notes.constructor",
        "notes.toString",
        "notes.list.extra",
        "constructor.constructor",
        "privatecanaryword",
      ]) {
        await assert.rejects(service.request(method), /Unknown sidecar command/);
      }
      await assert.rejects(service.request("settings.read", null), /arguments must be an array/);
      assert.ok(
        await service.request("settings.read"),
        "rejected requests must not kill valid later requests",
      );
      assert.ok(
        !service.stderr().includes("privatecanaryword"),
        "unknown method strings must not be logged",
      );
    });
  },
);

test(
  "real sidecar terminates on invalid JSON, invalid envelope, or oversized framing",
  { timeout: 15000 },
  async () => {
    await fixture(async ({ start }) => {
      const oversized = Buffer.alloc(4);
      oversized.writeUInt32BE(64 * 1024 * 1024 + 1);
      for (const bytes of [Buffer.from([0, 0, 0, 1, 123]), frame(null), oversized]) {
        const service = start();
        service.child.stdin.write(bytes);
        assert.equal(await service.exit, 1);
      }
    });
  },
);

test(
  "real sidecar extension contexts cannot cross windows, revocation, or sessions",
  { timeout: 30000 },
  async () => {
    await fixture(async ({ directory, start }) => {
      const service = start();
      const branch = path.join(directory, "extensions");
      await service.request("vault.create", [branch, "test passphrase", "blank"]);
      const extension = await service.request("extensions.trustedInstall", [
        "Reader",
        "document.body.textContent = 'Reader';",
      ]);
      const note = await service.request("notes.create", ["", "Test note"]);
      await service.request("extensions.setPermissions", [extension.id, ["read_notes"], []]);
      const opened = await service.request("extensions.trustedOpen", [extension.id, "extension-1"]);
      assert.match(opened.source, /Reader/);
      assert.ok((await service.request("extensions.trustedCall", ["extension-1", "listNotes", []])).some(item => item.id === note.id));
      await assert.rejects(
        service.request("extensions.trustedCall", ["extension-2", "listNotes", []]),
        /not an active/,
      );
      await assert.rejects(
        service.request("extensions.trustedCall", ["extension-1", "constructor", []]),
        /Unknown/,
      );
      await service.request("extensions.setPermissions", [extension.id, [], []]);
      await assert.rejects(
        service.request("extensions.trustedCall", ["extension-1", "listNotes", []]),
        /not been granted/,
      );
      await service.request("vault.lock");
      await service.request("vault.unlock", [branch, "test passphrase"]);
      await assert.rejects(
        service.request("extensions.trustedCall", ["extension-1", "listNotes", []]),
        /not an active/,
      );
      await service.request("vault.lock");
    });
  },
);
