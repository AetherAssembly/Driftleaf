// Vault = a folder tree of encrypted markdown notes on disk (see docs/ARCHITECTURE.md).
// Organization is folder-based: a note's `folderPath` is also where its `.enc` file lives.
// Note titles/folder placement are kept in a plaintext manifest sidecar so the sidebar tree
// can render without decrypting every note — only note *content* is encrypted.

import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
  rename,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  deriveVaultKey,
  encrypt,
  decrypt,
  packPayload,
  unpackPayload,
  generateSalt,
} from "./crypto";
import { getVaultTemplate } from "./templates";
import { parseCsvDatabase, parseJsonDatabase } from "./database-import";
import type { VaultTemplateId } from "../shared/ipc";
import type {
  DatabaseCellValue,
  DatabaseData,
  DatabaseMeta,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
  VaultHealthCheck,
  VaultHealthReport,
} from "../shared/ipc";

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

function validateDatabaseProperties(properties: DatabaseProperty[]): void {
  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error("A database needs at least one property");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const property of properties) {
    if (
      !property ||
      typeof property.id !== "string" ||
      !property.id ||
      typeof property.name !== "string" ||
      !property.name.trim() ||
      !DATABASE_PROPERTY_TYPES.includes(property.type)
    ) {
      throw new Error("Database has an invalid property definition");
    }
    if (ids.has(property.id) || names.has(property.name)) {
      throw new Error("Database property IDs and names must be unique");
    }
    ids.add(property.id);
    names.add(property.name);
    if (property.type === "formula" && typeof property.formula !== "string") {
      throw new Error(`Formula property "${property.name}" needs a formula`);
    }
  }
  if (!properties.some((property) => property.type === "title")) {
    throw new Error("A database needs a title property");
  }
}

function validateDatabaseRows(properties: DatabaseProperty[], rows: DatabaseRow[]): void {
  if (!Array.isArray(rows)) throw new Error("Database rows must be an array");
  const propertyIds = new Set(properties.map((property) => property.id));
  const rowIds = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      !row.values ||
      typeof row.values !== "object" ||
      Array.isArray(row.values)
    ) {
      throw new Error("Database has an invalid row");
    }
    if (rowIds.has(row.id)) throw new Error("Database row IDs must be unique");
    rowIds.add(row.id);
    for (const [propertyId, value] of Object.entries(row.values)) {
      if (!propertyIds.has(propertyId))
        throw new Error("Database row references an unknown property");
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        !(Array.isArray(value) && value.every((item) => typeof item === "string"))
      ) {
        throw new Error("Database cell has an unsupported value");
      }
    }
  }
}

function clearRelationToRow(
  rows: DatabaseRow[],
  properties: DatabaseProperty[],
  databaseId: string,
  rowId: string,
): { rows: DatabaseRow[]; changed: boolean } {
  const relationIds = properties
    .filter(
      (property) => property.type === "relation" && property.relationDatabaseId === databaseId,
    )
    .map((property) => property.id);
  let changed = false;
  const updatedRows = rows.map((row) => {
    const values = { ...row.values };
    let rowChanged = false;
    for (const propertyId of relationIds) {
      const value = values[propertyId];
      if (Array.isArray(value)) {
        const next = value.filter((linkedId) => linkedId !== rowId);
        if (next.length !== value.length) {
          values[propertyId] = next;
          rowChanged = true;
        }
      } else if (typeof value === "string") {
        const next = value
          .split(",")
          .map((linkedId) => linkedId.trim())
          .filter((linkedId) => linkedId !== rowId);
        if (next.length !== value.split(",").length) {
          values[propertyId] = next.join(", ");
          rowChanged = true;
        }
      }
    }
    if (!rowChanged) return row;
    changed = true;
    return { ...row, values, updatedAt: Date.now() };
  });
  return { rows: updatedRows, changed };
}

async function writeDatabaseData(vault: Vault, data: DatabaseData): Promise<void> {
  const payload = encrypt(Buffer.from(JSON.stringify(data), "utf-8"), vault.key);
  await writeFileAtomic(databasePath(vault, data.meta.id), packPayload(payload));
}

export async function listDatabases(vault: Vault, folderPath?: string): Promise<DatabaseMeta[]> {
  const databases = databasesFor(vault);
  return folderPath === undefined
    ? databases
    : databases.filter((database) => database.folderPath === folderPath);
}

export async function readDatabase(vault: Vault, id: string): Promise<DatabaseData> {
  const meta = databasesFor(vault).find((database) => database.id === id);
  if (!meta) throw new Error("Database not found");
  let parsed: unknown;
  try {
    const encrypted = await readFile(databasePath(vault, id));
    parsed = JSON.parse(decrypt(unpackPayload(encrypted), vault.key).toString("utf-8"));
  } catch {
    throw new Error(`Database is corrupted or cannot be read: ${meta.title}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as DatabaseData).properties) ||
    !Array.isArray((parsed as DatabaseData).rows)
  ) {
    throw new Error(`Database data is invalid: ${meta.title}`);
  }
  const data = parsed as DatabaseData;
  validateDatabaseProperties(data.properties);
  validateDatabaseRows(data.properties, data.rows);
  return { ...data, meta };
}

export async function createDatabase(
  vault: Vault,
  title: string,
  folderPath: string,
  properties: DatabaseProperty[],
  rows: DatabaseRow[],
): Promise<DatabaseMeta> {
  validateFolderPath(folderPath);
  validateDatabaseProperties(properties);
  validateDatabaseRows(properties, rows);
  await ensureFolderChain(vault, folderPath);
  const meta: DatabaseMeta = {
    id: randomUUID(),
    title: title.trim() || "Untitled database",
    folderPath,
    updatedAt: Date.now(),
  };
  const data: DatabaseData = { meta, properties, rows };
  await writeDatabaseData(vault, data);
  const prevDatabases = [...databasesFor(vault)];
  databasesFor(vault).push(meta);
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (error) {
    vault.manifest.databases = prevDatabases;
    await rm(databasePath(vault, meta.id), { force: true }).catch(() => {});
    throw error;
  }
  return meta;
}

export async function updateDatabase(
  vault: Vault,
  id: string,
  properties: DatabaseProperty[],
  rows: DatabaseRow[],
): Promise<void> {
  validateDatabaseProperties(properties);
  validateDatabaseRows(properties, rows);
  const meta = databasesFor(vault).find((database) => database.id === id);
  if (!meta) throw new Error("Database not found");
  const nextMeta = { ...meta, updatedAt: Date.now() };
  await writeDatabaseData(vault, { meta: nextMeta, properties, rows });
  const previous = { ...meta };
  Object.assign(meta, nextMeta);
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (error) {
    Object.assign(meta, previous);
    throw error;
  }
}

export async function createDatabaseRow(vault: Vault, id: string): Promise<DatabaseRow> {
  const data = await readDatabase(vault, id);
  const now = Date.now();
  const values: Record<string, DatabaseCellValue> = {};
  for (const property of data.properties) {
    if (property.type === "checkbox") values[property.id] = false;
    else if (property.type === "multi_select" || property.type === "relation")
      values[property.id] = [];
    else if (!["formula", "rollup", "created_time", "last_edited_time"].includes(property.type)) {
      values[property.id] = null;
    }
  }
  const row: DatabaseRow = { id: randomUUID(), values, createdAt: now, updatedAt: now };
  data.rows.push(row);
  await updateDatabase(vault, id, data.properties, data.rows);
  return row;
}

export async function deleteDatabaseRow(vault: Vault, id: string, rowId: string): Promise<void> {
  const data = await readDatabase(vault, id);
  const retainedRows = data.rows.filter((row) => row.id !== rowId);
  if (retainedRows.length === data.rows.length) throw new Error("Database row not found");

  for (const meta of databasesFor(vault)) {
    if (meta.id === id) continue;
    const linkedData = await readDatabase(vault, meta.id);
    const cleared = clearRelationToRow(linkedData.rows, linkedData.properties, id, rowId);
    if (cleared.changed) {
      await updateDatabase(vault, meta.id, linkedData.properties, cleared.rows);
    }
  }
  const cleared = clearRelationToRow(retainedRows, data.properties, id, rowId);
  await updateDatabase(vault, id, data.properties, cleared.rows);
}

export async function deleteDatabase(vault: Vault, id: string): Promise<void> {
  const databases = databasesFor(vault);
  const index = databases.findIndex((database) => database.id === id);
  if (index < 0) throw new Error("Database not found");
  for (const referencedBy of databases) {
    if (referencedBy.id === id) continue;
    const referencedData = await readDatabase(vault, referencedBy.id);
    if (referencedData.properties.some((property) => property.relationDatabaseId === id)) {
      throw new Error(`Database is linked from "${referencedBy.title}" and cannot be deleted yet`);
    }
  }
  const [meta] = databases.splice(index, 1);
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (error) {
    databases.splice(index, 0, meta);
    throw error;
  }
  await rm(databasePath(vault, id), { force: true });
}

interface Manifest {
  notes: NoteMeta[];
  folders: string[]; // explicitly created folders so empty ones survive restarts
  databases?: DatabaseMeta[];
}

const DATABASE_PROPERTY_TYPES: DatabasePropertyType[] = [
  "title",
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "url",
  "email",
  "phone",
  "status",
  "people",
  "files",
  "formula",
  "relation",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
];

function databasesFor(vault: Vault): DatabaseMeta[] {
  vault.manifest.databases ??= [];
  return vault.manifest.databases;
}

function databaseFilePath(rootPath: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid database ID");
  return path.join(rootPath, DRIFTLEAF_DIR, `${id}.db.enc`);
}

function databasePath(vault: Vault, id: string): string {
  return databaseFilePath(vault.rootPath, id);
}

// "scrypt" vaults derive their key from a passphrase. "none" remains only for
// compatibility with legacy vaults created before this requirement was enforced.
type VaultConfig =
  { version: 1; kdf: "scrypt"; saltHex: string } | { version: 1; kdf: "none"; keyHex: string };

export interface Vault {
  rootPath: string;
  key: Buffer;
  manifest: Manifest;
}

function pathIsWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export async function createVaultBackup(vault: Vault, destinationParent: string): Promise<string> {
  const sourcePath = await realpath(vault.rootPath);
  const destinationPath = await realpath(destinationParent);
  if (pathIsWithin(sourcePath, destinationPath)) {
    throw new Error("Choose a backup destination outside the open vault folder");
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
  const baseName = `Driftleaf-Backup-${timestamp}`;
  let backupName = baseName;
  for (let suffix = 2; ; suffix++) {
    try {
      await access(path.join(destinationPath, backupName));
      backupName = `${baseName}-${suffix}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }

  const backupPath = path.join(destinationPath, backupName);
  const temporaryPath = path.join(destinationPath, `.${backupName}.tmp-${randomUUID()}`);
  try {
    await cp(sourcePath, temporaryPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    await rename(temporaryPath, backupPath);
    return backupPath;
  } catch (err) {
    try {
      await rm(temporaryPath, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Failed to remove incomplete vault backup:", cleanupError);
    }
    throw err;
  }
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
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${randomUUID()}`,
  );
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

async function readManifestStrict(rootPath: string): Promise<Manifest> {
  const raw = await readFile(manifestPath(rootPath), "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Partial<Manifest>).notes) ||
    !Array.isArray((parsed as Partial<Manifest>).folders)
  ) {
    throw new Error("Vault manifest is missing valid notes or folders arrays");
  }
  return parsed as Manifest;
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

export async function createVault(
  rootPath: string,
  passphrase: string,
  templateId: VaultTemplateId = "blank",
): Promise<Vault> {
  if (!passphrase || passphrase.trim().length === 0) {
    throw new Error("A passphrase is required to create a vault.");
  }

  const template = getVaultTemplate(templateId);
  await mkdir(path.join(rootPath, DRIFTLEAF_DIR), { recursive: true });

  const salt = generateSalt();
  const key = await deriveVaultKey(passphrase, salt);
  const config: VaultConfig = { version: 1, kdf: "scrypt", saltHex: salt.toString("hex") };
  await writeFile(configPath(rootPath), JSON.stringify(config, null, 2), "utf-8");

  const canary = encrypt(Buffer.from(CANARY_TEXT, "utf-8"), key);
  await writeFile(canaryPath(rootPath), packPayload(canary));

  const manifest: Manifest = { notes: [], folders: [], databases: [] };
  await writeManifest(rootPath, manifest);

  const vault: Vault = { rootPath, key, manifest };
  const welcomeNote = await createNote(vault, "", "Welcome to Driftleaf");
  await writeNote(vault, welcomeNote.id, WELCOME_NOTE_CONTENT);

  for (const folderPath of template.folders) {
    await createFolder(vault, folderPath);
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  for (const note of template.notes) {
    const title = note.title.replaceAll("{{date}}", date);
    const content = note.content.replaceAll("{{date}}", date);
    const meta = await createNote(vault, note.folderPath, title);
    await writeNote(vault, meta.id, content);
  }

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

  const report: VaultRecoveryReport = {
    renamedLegacy: [],
    removedDangling: [],
    recoveredOrphans: [],
  };
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
    survivors.push({
      id,
      title: titleFromFileName(fileName),
      folderPath,
      fileName,
      updatedAt: Date.now(),
    });
    report.recoveredOrphans.push(id);
  }

  vault.manifest.notes = survivors;

  if (!isEmptyReport(report)) {
    await writeManifest(vault.rootPath, vault.manifest);
  }

  return report;
}

async function scanVaultFiles(rootPath: string): Promise<{
  encryptedFiles: Map<string, DiskEncFile>;
  temporaryFiles: number;
}> {
  const encryptedFiles = new Map<string, DiskEncFile>();
  let temporaryFiles = 0;

  async function scanDirectory(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== DRIFTLEAF_DIR) await scanDirectory(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.includes(".tmp-")) temporaryFiles++;
        if (entry.name.endsWith(".enc")) {
          const folderPath = path.relative(rootPath, dir).split(path.sep).join("/");
          encryptedFiles.set(`${folderPath === "." ? "" : folderPath}/${entry.name}`, {
            folderPath: folderPath === "." ? "" : folderPath,
            fileName: entry.name,
          });
        }
      }
    }
  }

  await scanDirectory(rootPath);
  return { encryptedFiles, temporaryFiles };
}

function validManifestNote(value: unknown): value is NoteMeta {
  if (!value || typeof value !== "object") return false;
  const note = value as Partial<NoteMeta>;
  return (
    typeof note.id === "string" &&
    typeof note.title === "string" &&
    typeof note.folderPath === "string" &&
    (note.fileName === undefined || typeof note.fileName === "string") &&
    typeof note.updatedAt === "number"
  );
}

function validDatabaseMeta(value: unknown): value is DatabaseMeta {
  if (!value || typeof value !== "object") return false;
  const database = value as Partial<DatabaseMeta>;
  return (
    typeof database.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(database.id) &&
    typeof database.title === "string" &&
    typeof database.folderPath === "string" &&
    typeof database.updatedAt === "number"
  );
}

async function inspectVaultData(
  rootPath: string,
  key: Buffer,
  manifest: Manifest,
): Promise<VaultHealthReport> {
  const checks: VaultHealthCheck[] = [];
  const addCheck = (name: string, status: VaultHealthCheck["status"], details: string) => {
    checks.push({ name, status, details });
  };

  const canaryValid = await (async () => {
    try {
      const config: unknown = JSON.parse(await readFile(configPath(rootPath), "utf-8"));
      const canary = await readFile(canaryPath(rootPath));
      const decrypted = decrypt(unpackPayload(canary), key);
      return (
        !!config &&
        typeof config === "object" &&
        (config as Partial<VaultConfig>).version === 1 &&
        decrypted.toString("utf-8") === CANARY_TEXT
      );
    } catch {
      return false;
    }
  })();
  addCheck(
    "Vault metadata and key check",
    canaryValid ? "ok" : "error",
    canaryValid
      ? "Vault configuration and encrypted key check are readable."
      : "Vault configuration or encrypted key check is missing, invalid, or damaged.",
  );

  const manifestValid = await readManifestStrict(rootPath)
    .then(
      (onDiskManifest) =>
        onDiskManifest.notes.every(validManifestNote) &&
        onDiskManifest.folders.every((folder) => typeof folder === "string"),
    )
    .catch(() => false);
  addCheck(
    "Vault index",
    manifestValid ? "ok" : "error",
    manifestValid
      ? `${manifest.notes.length} note entries and ${manifest.folders.length} folders are indexed.`
      : "The vault manifest is missing, unreadable, or has an invalid structure.",
  );
  if (!manifestValid) {
    return { checkedAt: Date.now(), checks };
  }

  let disk: Awaited<ReturnType<typeof scanVaultFiles>>;
  try {
    disk = await scanVaultFiles(rootPath);
  } catch (error) {
    addCheck(
      "Encrypted files",
      "error",
      `Could not scan the vault folder: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { checkedAt: Date.now(), checks };
  }

  const expected = new Set<string>();
  let invalidEntries = 0;
  let missingFiles = 0;
  for (const note of manifest.notes) {
    if (!validManifestNote(note)) {
      invalidEntries++;
      continue;
    }
    const fileName = note.fileName ?? `${note.id}.enc`;
    if (path.basename(fileName) !== fileName || !fileName.endsWith(".enc")) {
      invalidEntries++;
      continue;
    }
    try {
      validateFolderPath(note.folderPath);
    } catch {
      invalidEntries++;
      continue;
    }
    const fileKey = `${note.folderPath}/${fileName}`;
    expected.add(fileKey);
    if (!disk.encryptedFiles.has(fileKey)) {
      missingFiles++;
    }
  }

  const orphanFiles = [...disk.encryptedFiles.keys()].filter((file) => !expected.has(file)).length;
  let unreadableFiles = 0;
  for (const file of disk.encryptedFiles.values()) {
    try {
      const bytes = await readFile(notePath(rootPath, file));
      decodeStrictUtf8(decrypt(unpackPayload(bytes), key));
    } catch {
      unreadableFiles++;
    }
  }
  const integrityStatus =
    invalidEntries > 0 || missingFiles > 0 || unreadableFiles > 0 ? "error" : "ok";
  addCheck(
    "Encrypted note contents",
    integrityStatus,
    invalidEntries + missingFiles + unreadableFiles === 0
      ? `All ${disk.encryptedFiles.size} encrypted note file(s) decrypt successfully.`
      : `${invalidEntries} invalid index entries, ${missingFiles} missing note files, and ${unreadableFiles} unreadable or damaged encrypted file(s).`,
  );
  addCheck(
    "Unindexed encrypted files",
    orphanFiles > 0 ? "warning" : "ok",
    orphanFiles > 0
      ? `${orphanFiles} encrypted file(s) are not listed in the manifest and may be recoverable on the next unlock.`
      : "All encrypted note files are represented in the manifest.",
  );
  addCheck(
    "Incomplete-write leftovers",
    disk.temporaryFiles > 0 ? "warning" : "ok",
    disk.temporaryFiles > 0
      ? `${disk.temporaryFiles} temporary file(s) remain in the vault folder.`
      : "No temporary write files were found.",
  );

  const databaseMetas = manifest.databases ?? [];
  let invalidDatabases = 0;
  let unreadableDatabases = 0;
  const expectedDatabaseFiles = new Set<string>();
  for (const database of databaseMetas) {
    if (!validDatabaseMeta(database)) {
      invalidDatabases++;
      continue;
    }
    const filePath = databaseFilePath(rootPath, database.id);
    expectedDatabaseFiles.add(`${database.id}.db.enc`);
    try {
      const bytes = await readFile(filePath);
      const value: unknown = JSON.parse(decrypt(unpackPayload(bytes), key).toString("utf-8"));
      if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as DatabaseData).properties) ||
        !Array.isArray((value as DatabaseData).rows)
      ) {
        throw new Error("Invalid database structure");
      }
      const data = value as DatabaseData;
      validateDatabaseProperties(data.properties);
      validateDatabaseRows(data.properties, data.rows);
    } catch {
      unreadableDatabases++;
    }
  }

  const { orphanDatabaseFiles, metadataTempFiles } = await readdir(
    path.join(rootPath, DRIFTLEAF_DIR),
    { withFileTypes: true },
  )
    .then((entries) => ({
      orphanDatabaseFiles: entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".db.enc") &&
          !expectedDatabaseFiles.has(entry.name),
      ).length,
      metadataTempFiles: entries.filter((entry) => entry.isFile() && entry.name.includes(".tmp-"))
        .length,
    }))
    .catch(() => ({ orphanDatabaseFiles: databaseMetas.length, metadataTempFiles: 0 }));
  const databaseStatus =
    invalidDatabases > 0 || unreadableDatabases > 0
      ? "error"
      : orphanDatabaseFiles > 0
        ? "warning"
        : "ok";
  addCheck(
    "Encrypted databases",
    databaseStatus,
    invalidDatabases + unreadableDatabases + orphanDatabaseFiles === 0
      ? `${databaseMetas.length} database(s) decrypt and validate successfully.`
      : `${invalidDatabases} invalid metadata entries, ${unreadableDatabases} unreadable databases, and ${orphanDatabaseFiles} unindexed database file(s).`,
  );
  if (metadataTempFiles > 0) {
    addCheck(
      "Database write leftovers",
      "warning",
      `${metadataTempFiles} temporary file(s) remain in the vault metadata folder.`,
    );
  }
  return { checkedAt: Date.now(), checks };
}

export async function inspectVault(vault: Vault): Promise<VaultHealthReport> {
  const manifest = await readManifest(vault.rootPath);
  return inspectVaultData(vault.rootPath, vault.key, manifest);
}

export async function verifyVaultBackup(
  rootPath: string,
  passphrase: string,
): Promise<VaultHealthReport> {
  const rawConfig: unknown = JSON.parse(await readFile(configPath(rootPath), "utf-8"));
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Backup has an invalid vault configuration");
  }
  const config = rawConfig as Partial<VaultConfig>;
  if (config.version !== 1) throw new Error("This backup uses an unsupported vault format");
  let key: Buffer;
  if (config.kdf === "scrypt") {
    if (typeof config.saltHex !== "string" || !/^[0-9a-f]{32}$/i.test(config.saltHex)) {
      throw new Error("Backup has an invalid key-derivation salt");
    }
    key = await deriveVaultKey(passphrase, Buffer.from(config.saltHex, "hex"));
  } else if (config.kdf === "none") {
    if (typeof config.keyHex !== "string" || !/^[0-9a-f]{64}$/i.test(config.keyHex)) {
      throw new Error("Backup has an invalid encryption key");
    }
    key = Buffer.from(config.keyHex, "hex");
  } else {
    throw new Error("Backup uses an unsupported key-derivation method");
  }

  try {
    const canary = decrypt(unpackPayload(await readFile(canaryPath(rootPath))), key);
    if (canary.toString("utf-8") !== CANARY_TEXT) throw new Error("Key check did not match");
  } catch {
    key.fill(0);
    throw new Error("Backup passphrase is incorrect or its key check is damaged");
  }

  try {
    const manifest = await readManifest(rootPath);
    return await inspectVaultData(rootPath, key, manifest);
  } finally {
    key.fill(0);
  }
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
  await rename(path.join(vault.rootPath, oldFolderPath), path.join(vault.rootPath, newFolderPath));

  const prevNotes = vault.manifest.notes;
  const prevFolders = vault.manifest.folders;
  const prevDatabases = vault.manifest.databases;
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
  if (vault.manifest.databases) {
    vault.manifest.databases = vault.manifest.databases.map((database) =>
      database.folderPath === oldFolderPath || database.folderPath.startsWith(oldFolderPath + "/")
        ? {
            ...database,
            folderPath: newFolderPath + database.folderPath.slice(oldFolderPath.length),
          }
        : database,
    );
  }
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    vault.manifest.databases = prevDatabases;
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
  const affectedDatabases = databasesFor(vault).filter(
    (database) =>
      database.folderPath === folderPath || database.folderPath.startsWith(folderPath + "/"),
  );
  const affectedDatabaseIds = new Set(affectedDatabases.map((database) => database.id));
  if (affectedDatabaseIds.size > 0) {
    for (const database of databasesFor(vault)) {
      if (affectedDatabaseIds.has(database.id)) continue;
      const data = await readDatabase(vault, database.id);
      if (
        data.properties.some(
          (property) =>
            property.type === "relation" &&
            property.relationDatabaseId !== undefined &&
            affectedDatabaseIds.has(property.relationDatabaseId),
        )
      ) {
        throw new Error(
          `Folder contains a database linked from "${database.title}"; remove that relation before deleting the folder`,
        );
      }
    }
  }
  const deletedIds = affected.map((n) => n.id);
  const prevNotes = vault.manifest.notes;
  const prevFolders = vault.manifest.folders;
  const prevDatabases = [...databasesFor(vault)];
  vault.manifest.notes = vault.manifest.notes.filter((n) => !deletedIds.includes(n.id));
  vault.manifest.databases = prevDatabases.filter(
    (database) =>
      !affectedDatabases.some((affectedDatabase) => affectedDatabase.id === database.id),
  );
  vault.manifest.folders = vault.manifest.folders.filter(
    (f) => f !== folderPath && !f.startsWith(folderPath + "/"),
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    vault.manifest.databases = prevDatabases;
    throw err;
  }
  await Promise.all(
    affectedDatabases.map((database) => rm(databasePath(vault, database.id), { force: true })),
  );
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
  importedDatabases: DatabaseMeta[];
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
  const importedDatabases: DatabaseMeta[] = [];
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
        importedDatabases.push(...result.importedDatabases);
        skipped.push(...result.skipped);
      } else if (ext === ".csv" || ext === ".json") {
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_IMPORT_ENTRY_BYTES) {
          throw new Error(
            `file too large to import (over ${MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)}MB)`,
          );
        }
        const bytes = await readFile(filePath);
        if (bytes.length > MAX_IMPORT_ENTRY_BYTES) {
          throw new Error(
            `file too large to import (over ${MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)}MB)`,
          );
        }
        const text = decodeStrictUtf8(bytes);
        const title = path.basename(filePath, ext) || "Untitled database";
        const parsed =
          ext === ".csv" ? parseCsvDatabase(text, title) : parseJsonDatabase(text, title);
        const meta = await createDatabase(
          vault,
          parsed.title,
          targetFolder,
          parsed.properties,
          parsed.rows,
        );
        importedDatabases.push(meta);
      } else {
        skipped.push(
          `${baseName} (unsupported file type — only .md, .csv, .json, and .zip can be imported)`,
        );
      }
    } catch (err) {
      skipped.push(`${baseName} (${err instanceof Error ? err.message : "import failed"})`);
    }
  }

  return { imported, importedDatabases, skipped };
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
  const importedDatabases: DatabaseMeta[] = [];
  const skipped: string[] = [];

  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries();
  } catch (err) {
    return {
      imported,
      importedDatabases,
      skipped: [
        `${path.basename(zipPath)} (${err instanceof Error ? err.message : "couldn't read archive"})`,
      ],
    };
  }

  if (entries.length > MAX_IMPORT_ENTRIES) {
    return {
      imported,
      importedDatabases,
      skipped: [
        `${path.basename(zipPath)} (archive has too many entries — over ${MAX_IMPORT_ENTRIES})`,
      ],
    };
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const ext = path.posix.extname(entry.entryName).toLowerCase();
    if (![".md", ".csv", ".json"].includes(ext)) continue;

    try {
      if (entry.header.size > MAX_IMPORT_ENTRY_BYTES) {
        throw new Error(
          `file too large to import (over ${MAX_IMPORT_ENTRY_BYTES / (1024 * 1024)}MB)`,
        );
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
      const title = fileName.replace(/\.(md|csv|json)$/i, "") || "Untitled";
      const folderPath = targetFolder
        ? relDir
          ? `${targetFolder}/${relDir}`
          : targetFolder
        : relDir;
      validateFolderPath(folderPath);

      const content = decodeStrictUtf8(entry.getData());
      if (ext === ".md") {
        await ensureFolderChain(vault, folderPath);
        const meta = await createNote(vault, folderPath, title);
        await writeNote(vault, meta.id, content);
        imported.push(meta);
      } else {
        const parsed =
          ext === ".csv" ? parseCsvDatabase(content, title) : parseJsonDatabase(content, title);
        const meta = await createDatabase(
          vault,
          parsed.title,
          folderPath,
          parsed.properties,
          parsed.rows,
        );
        importedDatabases.push(meta);
      }
    } catch (err) {
      skipped.push(`${entry.entryName} (${err instanceof Error ? err.message : "import failed"})`);
    }
  }

  return { imported, importedDatabases, skipped };
}
