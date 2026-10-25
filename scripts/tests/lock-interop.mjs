import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/lock_bridge" +
    (process.platform === "win32" ? ".exe" : ""),
);
const directory = await mkdtemp(path.join(os.tmpdir(), "driftleaf-lock-interop-"));
const children = [];
function rustLock() {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const exited = once(child, "close");
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const ready = once(child.stdout, "data");
  child.stdin.write(JSON.stringify(directory) + "\n");
  return { child, exited, ready, stderr: () => stderr };
}
let database;
try {
  database = new DatabaseSync(path.join(directory, ".driftleaf-writer.sqlite"));
  database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  const denied = rustLock();
  assert.notEqual((await denied.exited)[0], 0);
  assert.match(denied.stderr(), /already open/);
  database.exec("ROLLBACK");
  const owner = rustLock();
  await Promise.race([
    owner.ready,
    owner.exited.then(() => {
      throw new Error(owner.stderr() || "Rust lock failed");
    }),
  ]);
  assert.throws(() => database.exec("BEGIN EXCLUSIVE"), /locked/);
  owner.child.kill();
  await owner.exited;
  database.exec("BEGIN EXCLUSIVE");
  database.exec("ROLLBACK");
  const normal = rustLock();
  await normal.ready;
  normal.child.stdin.end();
  assert.equal((await normal.exited)[0], 0);
  database.exec("BEGIN EXCLUSIVE");
  database.exec("ROLLBACK");
  console.log("Node/Rust exclusive writers and normal/crash lock release passed.");
} finally {
  database?.close();
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "close");
    }
  await rm(directory, { recursive: true, force: true });
}
