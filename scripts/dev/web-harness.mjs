// Development-only harness: runs the real renderer in an ordinary browser against the real
// Node sidecar, with no Tauri shell. It exists so the UI can be exercised, inspected with
// browser dev tools, and screenshotted on a machine (or CI runner) with no desktop session.
//
//   node scripts/dev/web-harness.mjs          # then open the printed URL
//
// What it is: a tiny HTTP server that stands in for the Rust shell. It spawns
// sidecar/index.mjs exactly the way src-tauri/src/main.rs does and answers the same command
// names the Tauri bridge (src/tauri-bridge/index.ts) invokes, plus a script that installs a
// minimal `window.__TAURI_INTERNALS__` so that bridge loads unmodified. It also starts Vite
// with DRIFTLEAF_WEB_HARNESS set, which makes vite.config.ts inject that script.
//
// What it is not: a security boundary or a supported way to run Driftleaf. Native dialogs
// are replaced by fixed paths inside a throwaway directory, extensions and updates are
// stubbed, and anything on this machine that can reach the port can drive the sidecar. It
// binds to 127.0.0.1, only answers the Vite origin, and only ever opens branches inside its
// own temporary directory. Never point it at a real branch.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const HARNESS_PORT = Number(process.env.DRIFTLEAF_HARNESS_PORT ?? 5184);
const VITE_PORT = 5183;
const ALLOWED_ORIGINS = new Set([`http://localhost:${VITE_PORT}`, `http://127.0.0.1:${VITE_PORT}`]);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const workDir = await mkdtemp(path.join(os.tmpdir(), "driftleaf-web-harness-"));
const dirs = {
  settings: path.join(workDir, "settings"),
  branch: path.join(workDir, "branch"),
  backups: path.join(workDir, "backups"),
  exports: path.join(workDir, "exports"),
  saved: path.join(workDir, "saved"),
};
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

const publicMethods = new Set(
  JSON.parse(readFileSync(path.join(root, "sidecar/public-methods.json"), "utf8")),
);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

// ---- sidecar, spoken to with the same length-prefixed JSON frames main.rs uses ----
// The Rust service, behind the stdio wrapper built by
// `cargo build --release --examples --manifest-path crates/driftleaf-core/Cargo.toml`.
// DRIFTLEAF_HARNESS_NODE=1 runs the Node reference implementation instead.
const rustBinary = path.join(
  root,
  "crates/driftleaf-core/target/release/examples/service_stdio" +
    (process.platform === "win32" ? ".exe" : ""),
);
const useNode = process.env.DRIFTLEAF_HARNESS_NODE === "1";
if (!useNode && !existsSync(rustBinary)) {
  console.error(
    "[harness] the Rust backend is not built. Run:\n" +
      "  cargo build --release --examples --manifest-path crates/driftleaf-core/Cargo.toml",
  );
  process.exit(1);
}
const sidecar = useNode
  ? spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--loader",
        pathToFileURL(path.join(root, "scripts/tests/typescript-loader.mjs")).href,
        path.join(root, "sidecar/index.mjs"),
      ],
      { cwd: root, env: { ...process.env, DRIFTLEAF_SETTINGS_DIR: dirs.settings }, stdio: ["pipe", "pipe", "inherit"] },
    )
  : spawn(rustBinary, [], {
      env: { ...process.env, DRIFTLEAF_SETTINGS_DIR: dirs.settings },
      stdio: ["pipe", "pipe", "inherit"],
    });
let nextId = 1;
const pending = new Map();
let buffer = Buffer.alloc(0);
sidecar.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) return;
    const response = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
    buffer = buffer.subarray(4 + length);
    const waiter = pending.get(response.id);
    pending.delete(response.id);
    if (!waiter) continue;
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(response.error));
  }
});
sidecar.on("exit", (code) => {
  for (const waiter of pending.values()) waiter.reject(new Error("sidecar stopped"));
  console.error(`[harness] sidecar exited (${code})`);
  shutdown(1);
});

function sidecarCall(method, args = []) {
  const id = nextId++;
  const json = Buffer.from(JSON.stringify({ id, method, args }), "utf8");
  if (json.length > MAX_FRAME_BYTES) return Promise.reject(new Error("Request too large"));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  sidecar.stdin.write(Buffer.concat([header, json]));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// ---- the commands src-tauri/src/main.rs registers, with dialogs replaced by fixed paths ----
const updateStatus = () => ({
  state: "unsupported",
  currentVersion: version,
  availableVersion: null,
  downloadUrl: null,
  checkedAt: null,
  message: "Updates are not available in the web harness.",
  automaticInstall: false,
});

async function newestBackup() {
  const entries = (await readdir(dirs.backups)).filter((name) => !name.startsWith(".")).sort();
  return entries.length ? path.join(dirs.backups, entries[entries.length - 1]) : null;
}

const commands = {
  backend_call: ({ method, args }) => {
    if (!publicMethods.has(method)) {
      throw new Error("This command is not available through the renderer bridge");
    }
    return sidecarCall(method, args);
  },
  pick_directory: () => dirs.branch,
  pick_backup_destination: () => dirs.backups,
  pick_backup_directory: () => newestBackup(),
  pick_import_files: () => null,
  create_backup: ({ destinationPath }) => sidecarCall("vault.trustedCreateBackup", [destinationPath]),
  verify_backup: ({ rootPath, passphrase }) =>
    sidecarCall("vault.trustedVerifyBackup", [rootPath, passphrase]),
  import_files: () => ({ imported: 0, importedDatabases: 0, skipped: [] }),
  export_branch: () => sidecarCall("vault.trustedExportPlaintext", [dirs.exports]),
  save_attachment: async ({ id }) => {
    const attachments = await sidecarCall("attachments.list");
    const meta = attachments.find((item) => item.id === id);
    if (!meta) throw new Error("Attachment not found");
    await sidecarCall("attachments.trustedSaveCopy", [
      id,
      path.join(dirs.saved, `${Date.now()}-${path.basename(meta.name)}`),
    ]);
    return true;
  },
  export_database: () => false,
  install_extension: () => null,
  run_extension: () => {
    throw new Error("Extensions need the Tauri shell and cannot run in the web harness");
  },
  update_status: updateStatus,
  update_check: updateStatus,
  update_download: updateStatus,
  update_install: () => null,
  update_open_download: () => null,
  announcement_status: () => ({}),
  announcement_check: () => ({}),
  flush_result: () => null,
  // @tauri-apps/api's listen()/unlisten(). No shell events are ever emitted here.
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => null,
};

const shim = `
(() => {
  const base = "http://127.0.0.1:${HARNESS_PORT}";
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    // Rejects with a bare string, exactly as a Rust command returning Err(String) does.
    invoke: async (cmd, args = {}) => {
      const response = await fetch(base + "/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, args }),
      });
      const body = await response.json();
      if (!body.ok) throw body.error;
      return body.result;
    },
    transformCallback: (callback) => {
      const id = ++callbackId;
      window["_" + id] = callback;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (filePath) => filePath,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  console.info("[driftleaf] running in the web harness; branches live in ${workDir.replaceAll("\\", "\\\\")}");
})();
`;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        reject(new Error("Request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const cors = origin && ALLOWED_ORIGINS.has(origin) ? { "access-control-allow-origin": origin } : {};
  if (request.method === "GET" && request.url === "/harness.js") {
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    response.end(shim);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...cors, "access-control-allow-headers": "content-type" });
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/invoke" || !cors["access-control-allow-origin"]) {
    response.writeHead(403).end();
    return;
  }
  const send = (payload) => {
    response.writeHead(200, { ...cors, "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  try {
    const { cmd, args } = JSON.parse(await readBody(request));
    if (!Object.hasOwn(commands, cmd)) throw new Error(`Unknown command: ${cmd}`);
    const result = await commands[cmd](args ?? {});
    send({ ok: true, result: result === undefined ? null : result });
  } catch (error) {
    send({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const vite = spawn(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"],
  {
    cwd: root,
    env: { ...process.env, DRIFTLEAF_WEB_HARNESS: `http://127.0.0.1:${HARNESS_PORT}` },
    stdio: "inherit",
  },
);
vite.on("exit", (code) => shutdown(code ?? 0));

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  server.close();
  vite.kill();
  sidecar.kill();
  void rm(workDir, { recursive: true, force: true }).finally(() => process.exit(code));
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.listen(HARNESS_PORT, "127.0.0.1", () => {
  console.error(`[harness] bridge on http://127.0.0.1:${HARNESS_PORT}, working directory ${workDir}`);
  console.error(`[harness] open http://localhost:${VITE_PORT} once Vite reports it is ready`);
});
