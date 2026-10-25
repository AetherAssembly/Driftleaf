// Syncs package.json/package-lock.json/tauri.conf.json/Cargo.toml/Cargo.lock/the RPM spec
// to one version number, without invoking `npm version` or creating a commit/tag. Used both
// for rolling pre-release dev checkpoints (any version) and by the tag-triggered release
// workflow (release.yml) to set the real release version before packaging — pass
// --allow-same there, since the committed package.json may already match the tag.
import { readFile, writeFile } from "node:fs/promises";
const version = process.argv[2];
const allowSame = process.argv.includes("--allow-same");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  throw new Error("Expected a semver version, e.g. 0.7.0 or 0.7.0-beta.1");
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const parse = (v) => v.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
const [newMajor, newMinor, newPatch] = parse(version);
const [curMajor, curMinor, curPatch] = parse(pkg.version);
const increased =
  newMajor > curMajor ||
  (newMajor === curMajor && newMinor > curMinor) ||
  (newMajor === curMajor && newMinor === curMinor && newPatch > curPatch);
if (!increased && !(allowSame && version === pkg.version)) {
  throw new Error(`Version must increase (currently ${pkg.version})`);
}
for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
  const data = JSON.parse(await readFile(file, "utf8"));
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}
for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
  const data = await readFile(file, "utf8");
  await writeFile(file, data.replace(/(name = "driftleaf"\nversion = ")[^"]+/, "$1" + version));
}
const spec = "docs/packaging/rpm/driftleaf.spec";
await writeFile(
  spec,
  (await readFile(spec, "utf8")).replace(/^Version:\s+\S+/m, `Version:        ${version}`),
);
const service = "docs/packaging/rpm/_service";
await writeFile(service, (await readFile(service, "utf8")).replaceAll(pkg.version, version));
console.log(`Set version to ${version}; no commit or tag created.`);
