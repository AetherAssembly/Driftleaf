// Stage a standalone transitional backend with a checksum-pinned official Node runtime.
// No Electron binary/addon or developer Node installation is needed at runtime.
import { readFile, writeFile, mkdir, rm, cp, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
const root = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(
  await readFile(path.join(import.meta.dirname, "node-runtime.json"), "utf8"),
);
const platform = process.platform === "win32" ? "win" : process.platform;
const artifact = lock.artifacts[`${platform}-${process.arch}`];
if (!artifact) throw new Error("No pinned runtime for this platform/architecture");
const destination = path.join(root, "src-tauri/resources/backend");
const cache = path.join(root, "src-tauri/runtime-cache");
await mkdir(cache, { recursive: true });
const archive = path.join(cache, artifact.file);
let bytes;
try {
  bytes = await readFile(archive);
} catch {
  const response = await fetch(`https://nodejs.org/dist/v${lock.version}/${artifact.file}`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
  throw new Error("Node checksum mismatch");
await writeFile(archive, bytes);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const unpacked = path.join(cache, `node-v${lock.version}-${platform}-${process.arch}`);
if (platform === "win") new AdmZip(bytes).extractAllTo(cache, true);
else execFileSync("tar", ["-xzf", archive, "-C", cache]);
const binary = platform === "win" ? "node.exe" : "bin/node";
await cp(
  path.join(unpacked, binary),
  path.join(destination, platform === "win" ? "node.exe" : "node"),
);
if (platform !== "win") await chmod(path.join(destination, "node"), 0o755);
await cp(path.join(unpacked, "LICENSE"), path.join(destination, "NODE_LICENSE"));
for (const relative of [
  "sidecar",
  "src/main",
  "src/shared",
  "scripts/tests/typescript-loader.mjs",
  "node_modules/typescript",
  "node_modules/adm-zip",
]) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, relative), target, { recursive: true });
}
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(
  path.join(destination, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }),
);
console.log(`Staged Node ${lock.version} backend for ${platform}-${process.arch}`);
