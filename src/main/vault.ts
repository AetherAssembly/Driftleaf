// Vault = a folder tree of encrypted markdown notes on disk (see docs/ARCHITECTURE.md).
// Organization is folder-based: a note's `folderPath` is also where its `.enc` file lives.
// Note titles/folder placement are kept in a plaintext manifest sidecar so the sidebar tree
// can render without decrypting every note — only note *content* is encrypted.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  deriveVaultKey,
  encrypt,
  decrypt,
  packPayload,
  unpackPayload,
  generateSalt,
  generateKey,
} from "./crypto";

const CANARY_TEXT = "driftleaf-vault-v1";
const DRIFTLEAF_DIR = ".driftleaf";

const WELCOME_NOTE_CONTENT = `# Welcome to Driftleaf

## Local-first, encrypted, yours alone

- Your notes live only on this device (or wherever you point the vault folder) —
  no cloud, no account, no tracking.
- Note content is encrypted at rest with AES-256-GCM. If you set a passphrase,
  it's the only way to unlock the vault — **there is no password reset**. Write
  it down and keep it somewhere safe.
- Titles and folder names are kept in a plaintext index next to the encrypted
  notes so the sidebar can render without decrypting everything — only note
  *content* is encrypted.

## Organization

Notes live in folders, not tags — the sidebar folder tree mirrors the vault's
folder structure on disk. Right-click a folder to rename or delete it;
right-click a note to move it.

## Markdown

The editor supports standard markdown with a live preview toggle:

- \`**bold**\`, \`*italic*\`, \`[links](url)\`
- \`# Heading\`, \`## Subheading\`
- Inline code and fenced code blocks (wrap text in backticks)
- \`- bullet\` or \`1. numbered\` lists

Changes autosave a moment after you stop typing.

## If something goes wrong

Every unlock double-checks the vault against what's actually on disk and
repairs small inconsistencies automatically (e.g. after a crash mid-save). If
a note ever won't decrypt, it's reported as corrupted rather than silently
losing your other notes. See \`docs/RECOVERY.md\` in the project repo for more.

Delete this note whenever you like — it's a normal note, not a special one.
`;

export interface NoteMeta {
  id: string;
  title: string;
  folderPath: string; // "" for vault root, else e.g. "Projects/Driftleaf"
  fileName: string; // on-disk basename, e.g. "Meeting notes.md.enc" — kept in sync with
  // `title` (see uniqueFileName/renameNote) so the vault folder is browsable in a normal
  // file manager, the way any other encrypted file keeps its name with the extension changed.
  updatedAt: number;
}

interface Manifest {
  notes: NoteMeta[];
  folders: string[]; // explicitly created folders so empty ones survive restarts
}

// "scrypt" vaults derive their key from a passphrase; "none" vaults hold the
// (unprotected) key directly, for people who don't want a passphrase prompt.
// Note content is encrypted at rest either way — only the passphrase gate is optional.
type VaultConfig =
  | { version: 1; kdf: "scrypt"; saltHex: string }
  | { version: 1; kdf: "none"; keyHex: string };

export interface Vault {
  rootPath: string;
  key: Buffer;
  manifest: Manifest;
}

// Reports what reconcileVault() found and fixed by cross-checking the manifest against
// the .enc files actually on disk — the self-healing pass that stands in for a crash
// recovery log (see writeFileAtomic/deleteNote/deleteFolder for how corruption is avoided
// in the first place).
export interface VaultRecoveryReport {
  renamedLegacy: string[]; // note ids migrated from an old id-based filename to title.md.enc
  removedDangling: string[]; // note ids removed because no .enc file exists for them anymore
  recoveredOrphans: string[]; // note ids found on disk with no manifest entry, re-added
}

function isEmptyReport(report: VaultRecoveryReport): boolean {
  return (
    report.renamedLegacy.length === 0 &&
    report.removedDangling.length === 0 &&
    report.recoveredOrphans.length === 0
  );
}

const MAX_FILENAME_BASE_LENGTH = 120; // leaves headroom for " (NN).md.enc" + OS path limits
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Turns a note title into a filesystem-safe basename: strips characters illegal on
// Windows/macOS/Linux, collapses whitespace, and avoids Windows-reserved device names.
function sanitizeTitleForFileName(title: string): string {
  let base = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, ""); // Windows disallows trailing dots/spaces
  if (base.length > MAX_FILENAME_BASE_LENGTH) {
    base = base.slice(0, MAX_FILENAME_BASE_LENGTH).trim();
  }
  if (!base || WINDOWS_RESERVED_NAMES.test(base)) {
    base = "Untitled";
  }
  return base;
}

// Derives a `<title>.md.enc` filename for a note, adding a " (2)", " (3)", ... suffix if
// another note in the same folder already claims that name — mirrors how a file manager
// resolves a naming collision on copy/save.
function uniqueFileName(
  vault: Vault,
  folderPath: string,
  title: string,
  excludeId?: string,
): string {
  const base = sanitizeTitleForFileName(title);
  // Compared case-insensitively: Windows and default macOS (APFS/NTFS) filesystems are
  // case-insensitive-but-preserving, so a candidate that only differs in case from an
  // existing file would resolve to the same inode and silently overwrite it on rename.
  const taken = new Set(
    vault.manifest.notes
      .filter((n) => n.folderPath === folderPath && n.id !== excludeId)
      .map((n) => n.fileName.toLowerCase()),
  );
  let candidate = `${base}.md.enc`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${base} (${i}).md.enc`;
  }
  return candidate;
}

// Recovers a reasonable title from an on-disk filename when a note's manifest entry is
// gone (orphan recovery) — strips our own ".md.enc"/".enc" convention if present.
function titleFromFileName(fileName: string): string {
  const withoutEnc = fileName.endsWith(".enc") ? fileName.slice(0, -".enc".length) : fileName;
  const withoutMd = withoutEnc.endsWith(".md") ? withoutEnc.slice(0, -".md".length) : withoutEnc;
  return withoutMd || "Recovered note";
}

// Node's Buffer#toString("utf-8") silently substitutes U+FFFD for invalid byte sequences
// instead of throwing, so a non-UTF-8 .md file (e.g. UTF-16 from Notepad, Latin-1) would
// otherwise "import successfully" as silently mangled content. TextDecoder with fatal:true
// throws instead, so the caller's existing skip-and-report-the-reason handling catches it.
function decodeStrictUtf8(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("not valid UTF-8 text");
  }
}

function configPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "vault.json");
}

function manifestPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "manifest.json");
}

function canaryPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "canary.enc");
}

function notePath(rootPath: string, note: Pick<NoteMeta, "folderPath" | "fileName">): string {
  return path.join(rootPath, note.folderPath, note.fileName);
}

// Writes go to a sibling temp file and land via rename(), which POSIX/NTFS guarantee is
// atomic within the same directory — a crash mid-write leaves the old file (or nothing
// where there was nothing before) rather than a half-written one.
async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
}

async function readManifest(rootPath: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(rootPath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    return { notes: [], folders: [], ...parsed };
  } catch {
    return { notes: [], folders: [] };
  }
}

function validateFolderPath(folderPath: string): void {
  if (folderPath.includes("..") || path.isAbsolute(folderPath)) {
    throw new Error(`Invalid folder path: ${folderPath}`);
  }
  // DRIFTLEAF_DIR is reserved for the vault's own config/manifest — a folder with this
  // name would be invisible to scanEncFiles()'s reconcile pass (it explicitly skips this
  // name at every depth), so any note filed under it would be treated as dangling and
  // silently dropped from the manifest on the very next unlock.
  if (folderPath.split("/").includes(DRIFTLEAF_DIR)) {
    throw new Error(`"${DRIFTLEAF_DIR}" is a reserved name and can't be used as a folder`);
  }
}

async function writeManifest(rootPath: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(manifestPath(rootPath), JSON.stringify(manifest, null, 2));
}

export async function createVault(rootPath: string, passphrase: string): Promise<Vault> {
  await mkdir(path.join(rootPath, DRIFTLEAF_DIR), { recursive: true });

  let key: Buffer;
  let config: VaultConfig;
  if (passphrase) {
    const salt = generateSalt();
    key = await deriveVaultKey(passphrase, salt);
    config = { version: 1, kdf: "scrypt", saltHex: salt.toString("hex") };
  } else {
    key = generateKey();
    config = { version: 1, kdf: "none", keyHex: key.toString("hex") };
  }
  await writeFile(configPath(rootPath), JSON.stringify(config, null, 2), "utf-8");

  const canary = encrypt(Buffer.from(CANARY_TEXT, "utf-8"), key);
  await writeFile(canaryPath(rootPath), packPayload(canary));

  const manifest: Manifest = { notes: [], folders: [] };
  await writeManifest(rootPath, manifest);

  const vault: Vault = { rootPath, key, manifest };
  const welcomeNote = await createNote(vault, "", "Welcome to Driftleaf");
  await writeNote(vault, welcomeNote.id, WELCOME_NOTE_CONTENT);

  return vault;
}

export async function vaultHasPassphrase(rootPath: string): Promise<boolean> {
  const configRaw = await readFile(configPath(rootPath), "utf-8");
  const config = JSON.parse(configRaw) as VaultConfig;
  return config.kdf === "scrypt";
}

export interface UnlockResult {
  vault: Vault;
  recovery: VaultRecoveryReport;
}

export async function unlockVault(rootPath: string, passphrase: string): Promise<UnlockResult> {
  const configRaw = await readFile(configPath(rootPath), "utf-8");
  const config = JSON.parse(configRaw) as VaultConfig;
  const key =
    config.kdf === "scrypt"
      ? await deriveVaultKey(passphrase, Buffer.from(config.saltHex, "hex"))
      : Buffer.from(config.keyHex, "hex");

  const canaryData = await readFile(canaryPath(rootPath));
  let decrypted: Buffer;
  try {
    decrypted = decrypt(unpackPayload(canaryData), key);
  } catch {
    throw new Error("Incorrect passphrase");
  }
  if (decrypted.toString("utf-8") !== CANARY_TEXT) {
    throw new Error("Incorrect passphrase");
  }

  const manifest = await readManifest(rootPath);
  const vault: Vault = { rootPath, key, manifest };
  const recovery = await reconcileVault(vault);
  return { vault, recovery };
}

interface DiskEncFile {
  folderPath: string;
  fileName: string;
}

// Recursively finds every `*.enc` file under the vault root (skipping the .driftleaf config
// dir), keyed by its full "<folderPath>/<fileName>" location.
async function scanEncFiles(
  rootPath: string,
  dir: string,
  results: Map<string, DiskEncFile>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === DRIFTLEAF_DIR) continue;
      await scanEncFiles(rootPath, path.join(dir, entry.name), results);
    } else if (entry.isFile() && entry.name.endsWith(".enc")) {
      const relFolder = path.relative(rootPath, dir).split(path.sep).join("/");
      const folderPath = relFolder === "." ? "" : relFolder;
      results.set(`${folderPath}/${entry.name}`, { folderPath, fileName: entry.name });
    }
  }
}

// Cross-checks the manifest against what's actually on disk and self-heals mismatches left
// by a crash between a file write and its manifest update (see writeNote/moveNote/deleteNote
// for the operations this covers), and opportunistically migrates any note still using the
// pre-"title.md.enc" id-based filename. Runs automatically on every unlock.
export async function reconcileVault(vault: Vault): Promise<VaultRecoveryReport> {
  const onDisk = new Map<string, DiskEncFile>();
  await scanEncFiles(vault.rootPath, vault.rootPath, onDisk);

  const report: VaultRecoveryReport = { renamedLegacy: [], removedDangling: [], recoveredOrphans: [] };
  const claimed = new Set<string>();
  const survivors: NoteMeta[] = [];

  for (const meta of vault.manifest.notes) {
    // Backfill fileName for notes written before this field existed, matching the file's
    // actual (pre-existing) on-disk name so nothing moves until the migration pass below.
    if (!meta.fileName) {
      meta.fileName = `${meta.id}.enc`;
    }
    const key = `${meta.folderPath}/${meta.fileName}`;
    if (!onDisk.has(key)) {
      report.removedDangling.push(meta.id);
      continue;
    }
    claimed.add(key);
    survivors.push(meta);
  }

  // Migrate legacy id-named files to the readable "title.md.enc" scheme opportunistically,
  // so vaults created before this feature get browsable filenames without a manual re-save.
  for (const meta of survivors) {
    if (/\.md\.enc$/.test(meta.fileName)) continue;
    const oldPath = notePath(vault.rootPath, meta);
    const newFileName = uniqueFileName(vault, meta.folderPath, meta.title, meta.id);
    const newPath = path.join(vault.rootPath, meta.folderPath, newFileName);
    try {
      await rename(oldPath, newPath);
    } catch {
      continue; // leave it on the legacy name (e.g. permissions issue); still fully readable
    }
    claimed.delete(`${meta.folderPath}/${meta.fileName}`);
    meta.fileName = newFileName;
    claimed.add(`${meta.folderPath}/${newFileName}`);
    report.renamedLegacy.push(meta.id);
  }

  for (const [key, { folderPath, fileName }] of onDisk) {
    if (claimed.has(key)) continue;
    const id = randomUUID();
    survivors.push({ id, title: titleFromFileName(fileName), folderPath, fileName, updatedAt: Date.now() });
    report.recoveredOrphans.push(id);
  }

  vault.manifest.notes = survivors;

  if (!isEmptyReport(report)) {
    await writeManifest(vault.rootPath, vault.manifest);
  }

  return report;
}

export function listNotes(vault: Vault, folderPath?: string): NoteMeta[] {
  if (folderPath === undefined) return vault.manifest.notes;
  return vault.manifest.notes.filter((n) => n.folderPath === folderPath);
}

export function listFolders(vault: Vault): string[] {
  const folders = new Set<string>(["", ...vault.manifest.folders]);
  for (const note of vault.manifest.notes) {
    let current = note.folderPath;
    while (current) {
      folders.add(current);
      current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
    }
  }
  return Array.from(folders).sort();
}

export async function readNote(vault: Vault, id: string): Promise<string> {
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const data = await readFile(notePath(vault.rootPath, meta));
  try {
    const decrypted = decrypt(unpackPayload(data), vault.key);
    return decrypted.toString("utf-8");
  } catch {
    // AES-GCM's auth tag fails to verify on any bit-flip or truncation, so this reliably
    // means the .enc file itself is damaged (bad disk, killed process mid-write pre-atomic-fix,
    // manual tampering) rather than a wrong key — the key was already checked at unlock.
    throw new Error(`Note is corrupted and cannot be decrypted: ${id}`);
  }
}

// Note content is written before the manifest so a crash between the two leaves, at worst,
// a manifest with a stale updatedAt — never lost content. reconcileVault() self-heals the rest.
export async function writeNote(vault: Vault, id: string, content: string): Promise<void> {
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const payload = encrypt(Buffer.from(content, "utf-8"), vault.key);
  await writeFileAtomic(notePath(vault.rootPath, meta), packPayload(payload));
  meta.updatedAt = Date.now();
  await writeManifest(vault.rootPath, vault.manifest);
}

export async function createNote(
  vault: Vault,
  folderPath: string,
  title: string,
): Promise<NoteMeta> {
  validateFolderPath(folderPath);
  const id = randomUUID();
  const fileName = uniqueFileName(vault, folderPath, title);
  const meta: NoteMeta = { id, title, folderPath, fileName, updatedAt: Date.now() };
  await mkdir(path.join(vault.rootPath, folderPath), { recursive: true });
  const payload = encrypt(Buffer.from("", "utf-8"), vault.key);
  await writeFileAtomic(notePath(vault.rootPath, meta), packPayload(payload));
  vault.manifest.notes.push(meta);
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    // Mirror deleteNote()/deleteFolder()'s rollback: don't leave the note visible
    // in-memory for the rest of the session if it was never actually recorded on disk.
    const index = vault.manifest.notes.indexOf(meta);
    if (index !== -1) vault.manifest.notes.splice(index, 1);
    throw err;
  }
  return meta;
}

// The file is renamed on disk before the manifest is updated (same "disk first" ordering as
// createNote/writeNote): a crash in between leaves the file already at its new, correct name —
// reconcileVault() will find the stale manifest entry dangling and the file itself as an
// orphan, and recover it with the right title straight from the new filename.
export async function renameNote(vault: Vault, id: string, title: string): Promise<void> {
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const oldPath = notePath(vault.rootPath, meta);
  const newFileName = uniqueFileName(vault, meta.folderPath, title, id);
  const newPath = path.join(vault.rootPath, meta.folderPath, newFileName);
  if (newPath !== oldPath) {
    await rename(oldPath, newPath);
  }
  meta.title = title;
  meta.fileName = newFileName;
  meta.updatedAt = Date.now();
  await writeManifest(vault.rootPath, vault.manifest);
}

// Manifest is updated before the file is removed: if a crash happens in between, the
// worst case is an orphaned .enc file on disk (harmless, cleaned up by reconcileVault()),
// never a manifest entry pointing at a note that no longer exists.
export async function deleteNote(vault: Vault, id: string): Promise<void> {
  const index = vault.manifest.notes.findIndex((n) => n.id === id);
  if (index === -1) throw new Error(`Note not found: ${id}`);
  const [meta] = vault.manifest.notes.splice(index, 1);
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    vault.manifest.notes.splice(index, 0, meta);
    throw err;
  }
  await rm(notePath(vault.rootPath, meta), { force: true });
}

export async function createFolder(vault: Vault, folderPath: string): Promise<void> {
  validateFolderPath(folderPath);
  await mkdir(path.join(vault.rootPath, folderPath), { recursive: true });
  if (!vault.manifest.folders.includes(folderPath)) {
    vault.manifest.folders.push(folderPath);
    await writeManifest(vault.rootPath, vault.manifest);
  }
}

export async function moveNote(vault: Vault, id: string, targetFolder: string): Promise<NoteMeta> {
  validateFolderPath(targetFolder);
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const oldPath = notePath(vault.rootPath, meta);
  // Recompute the filename in the target folder in case a note with the same title already
  // lives there — moving "Notes.md.enc" into a folder that already has one shouldn't collide.
  const newFileName = uniqueFileName(vault, targetFolder, meta.title, id);
  const newPath = path.join(vault.rootPath, targetFolder, newFileName);

  // Physical move happens before the in-memory mutation (and before the manifest write) so
  // a failure here — permissions, a collision uniqueFileName didn't foresee — never leaves
  // `meta` pointing at a folderPath/fileName the file isn't actually at.
  if (oldPath !== newPath) {
    await mkdir(path.join(vault.rootPath, targetFolder), { recursive: true });
    await rename(oldPath, newPath);
  }

  const prevFolderPath = meta.folderPath;
  const prevFileName = meta.fileName;
  const prevUpdatedAt = meta.updatedAt;
  meta.folderPath = targetFolder;
  meta.fileName = newFileName;
  meta.updatedAt = Date.now();
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    meta.folderPath = prevFolderPath;
    meta.fileName = prevFileName;
    meta.updatedAt = prevUpdatedAt;
    if (oldPath !== newPath) {
      // Best-effort: move the file back so this session's in-memory rollback matches disk.
      // If this also fails, the next unlock's reconcileVault() will recover the file at
      // its new location rather than leave it permanently untracked.
      await rename(newPath, oldPath).catch(() => {});
    }
    throw err;
  }
  return meta;
}

export async function renameFolder(
  vault: Vault,
  oldFolderPath: string,
  newFolderPath: string,
): Promise<void> {
  if (!oldFolderPath) throw new Error("Cannot rename the vault root");
  validateFolderPath(oldFolderPath);
  validateFolderPath(newFolderPath);
  if (newFolderPath !== oldFolderPath && listFolders(vault).includes(newFolderPath)) {
    throw new Error(`A folder named "${newFolderPath}" already exists`);
  }

  // Physical rename happens before the in-memory mutation (and before the manifest write)
  // so a failure here — e.g. the target already exists as a non-empty directory on disk
  // but wasn't tracked in the manifest — never leaves the manifest disagreeing with disk.
  await rename(
    path.join(vault.rootPath, oldFolderPath),
    path.join(vault.rootPath, newFolderPath),
  );

  const prevNotes = vault.manifest.notes;
  const prevFolders = vault.manifest.folders;
  vault.manifest.notes = vault.manifest.notes.map((note) =>
    note.folderPath === oldFolderPath || note.folderPath.startsWith(oldFolderPath + "/")
      ? { ...note, folderPath: newFolderPath + note.folderPath.slice(oldFolderPath.length) }
      : note,
  );
  vault.manifest.folders = vault.manifest.folders.map((f) =>
    f === oldFolderPath || f.startsWith(oldFolderPath + "/")
      ? newFolderPath + f.slice(oldFolderPath.length)
      : f,
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    // Best-effort: move the directory back so this session's in-memory rollback matches
    // disk. If this also fails, the next unlock's reconcileVault() will recover notes at
    // their new on-disk location rather than leave them untracked.
    await rename(
      path.join(vault.rootPath, newFolderPath),
      path.join(vault.rootPath, oldFolderPath),
    ).catch(() => {});
    throw err;
  }
}

// Same ordering rationale as deleteNote(): manifest drops the entries first, directory
// removal happens after, so a crash mid-operation leaves orphaned files rather than
// manifest entries for notes that no longer exist.
export async function deleteFolder(vault: Vault, folderPath: string): Promise<string[]> {
  if (!folderPath) throw new Error("Cannot delete the vault root");
  validateFolderPath(folderPath);
  const affected = vault.manifest.notes.filter(
    (n) => n.folderPath === folderPath || n.folderPath.startsWith(folderPath + "/"),
  );
  const deletedIds = affected.map((n) => n.id);
  const prevNotes = vault.manifest.notes;
  const prevFolders = vault.manifest.folders;
  vault.manifest.notes = vault.manifest.notes.filter((n) => !deletedIds.includes(n.id));
  vault.manifest.folders = vault.manifest.folders.filter(
    (f) => f !== folderPath && !f.startsWith(folderPath + "/"),
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    throw err;
  }
  await rm(path.join(vault.rootPath, folderPath), { recursive: true, force: true });
  return deletedIds;
}

// Registers every ancestor of folderPath as an explicit folder (createFolder is idempotent),
// so a nested import target shows up in the sidebar tree even before any note lands in it.
async function ensureFolderChain(vault: Vault, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const parts = folderPath.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    await createFolder(vault, current);
  }
}

export interface ImportResult {
  imported: NoteMeta[];
  skipped: string[]; // "<name> (<reason>)" entries for files/entries that couldn't be imported
}

// Imports a mix of .md files and .zip archives (each .md inside imported as its own note,
// preserving the archive's internal folder structure under targetFolder). One bad file/entry
// doesn't abort the rest of the batch — failures are collected in `skipped` instead of thrown.
export async function importFiles(
  vault: Vault,
  filePaths: string[],
  targetFolder: string,
): Promise<ImportResult> {
  const imported: NoteMeta[] = [];
  const skipped: string[] = [];

  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath);
    try {
      if (ext === ".md") {
        const content = decodeStrictUtf8(await readFile(filePath));
        const title = path.basename(filePath, ".md") || "Untitled";
        await ensureFolderChain(vault, targetFolder);
        const meta = await createNote(vault, targetFolder, title);
        await writeNote(vault, meta.id, content);
        imported.push(meta);
      } else if (ext === ".zip") {
        const result = await importZipArchive(vault, filePath, targetFolder);
        imported.push(...result.imported);
        skipped.push(...result.skipped);
      } else {
        skipped.push(`${baseName} (unsupported file type — only .md and .zip can be imported)`);
      }
    } catch (err) {
      skipped.push(`${baseName} (${err instanceof Error ? err.message : "import failed"})`);
    }
  }

  return { imported, skipped };
}

// Zip-bomb guards: a small compressed archive can claim an enormous decompressed size or
// entry count. header.size (uncompressed size) is available from the central directory
// without decompressing, so oversized entries are rejected before getData() ever allocates
// their content.
const MAX_IMPORT_ENTRIES = 20_000;
const MAX_IMPORT_ENTRY_BYTES = 20 * 1024 * 1024; // 20MB — generous for a markdown note

async function importZipArchive(
  vault: Vault,
  zipPath: string,
  targetFolder: string,
): Promise<ImportResult> {
  const imported: NoteMeta[] = [];
  const skipped: string[] = [];

  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries();
  } catch (err) {
    return {
      imported,
      skipped: [`${path.basename(zipPath)} (${err instanceof Error ? err.message : "couldn't read archive"})`],
    };
  }

  if (entries.length > MAX_IMPORT_ENTRIES) {
    return {
      imported,
      skipped: [`${path.basename(zipPath)} (archive has too many entries — over ${MAX_IMPORT_ENTRIES})`],
    };
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.toLowerCase().endsWith(".md")) continue;

    try {
      if (entry.header.size > MAX_IMPORT_ENTRY_BYTES) {
        throw new Error(`file too large to import (over ${MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)}MB)`);
      }
      // Zip entry names always use "/" regardless of platform. Reject anything that could
      // escape the vault (zip-slip): ".." segments or an absolute-looking path.
      const relPath = entry.entryName.replace(/\\/g, "/");
      if (relPath.includes("..") || path.isAbsolute(relPath)) {
        throw new Error("unsafe path in archive");
      }
      const slashIndex = relPath.lastIndexOf("/");
      const relDir = slashIndex === -1 ? "" : relPath.slice(0, slashIndex);
      const fileName = slashIndex === -1 ? relPath : relPath.slice(slashIndex + 1);
      const title = fileName.replace(/\.md$/i, "") || "Untitled";
      const folderPath = targetFolder
        ? relDir
          ? `${targetFolder}/${relDir}`
          : targetFolder
        : relDir;
      validateFolderPath(folderPath);

      await ensureFolderChain(vault, folderPath);
      const meta = await createNote(vault, folderPath, title);
      await writeNote(vault, meta.id, decodeStrictUtf8(entry.getData()));
      imported.push(meta);
    } catch (err) {
      skipped.push(`${entry.entryName} (${err instanceof Error ? err.message : "import failed"})`);
    }
  }

  return { imported, skipped };
}
