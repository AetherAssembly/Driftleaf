import { BRANCH_LOCK_FILENAME } from "../shared/storage";
// Vault = an encrypted workspace on disk (see docs/ARCHITECTURE.md). Note titles,
// folder placement, and database metadata live in an encrypted manifest; note files
// use opaque IDs under .driftleaf/notes rather than exposing names in paths.

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
  rmdir,
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
import type {
  CanvasItem,
  ExtensionPermission,
  ExtensionSample,
  ExtensionSummary,
  VaultTemplateId,
} from "../shared/ipc";
import type {
  DatabaseCellValue,
  DatabaseData,
  DatabaseMeta,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
  DatabaseViewDefinition,
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
- Note titles, folder names, and database metadata are encrypted too. The app
  decrypts the index only while this vault is unlocked.

## Organization

Notes live in folders, not tags — the sidebar folder tree is private vault
metadata, not the on-disk folder structure. Right-click a folder to rename or delete it;
right-click a note to move it.

## Markdown

The editor supports standard markdown with a live preview toggle:

- \`**bold**\`, \`*italic*\`, \`[links](url)\`
- \`[[Note title]]\` links, with backlinks and a note graph
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
  folderPath: string;
  fileName: string;
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
    const normalizedName = property.name.trim().toLocaleLowerCase();
    if (ids.has(property.id) || names.has(normalizedName)) {
      throw new Error("Database property IDs and names must be unique");
    }
    ids.add(property.id);
    names.add(normalizedName);
    if (property.type === "formula" && typeof property.formula !== "string") {
      throw new Error(`Formula property "${property.name}" needs a formula`);
    }
    if (
      property.options !== undefined &&
      (!Array.isArray(property.options) ||
        property.options.some((option) => typeof option !== "string") ||
        new Set(property.options).size !== property.options.length)
    ) {
      throw new Error(`Database property "${property.name}" has invalid options`);
    }
    if (
      property.type === "relation" &&
      (typeof property.relationDatabaseId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(property.relationDatabaseId))
    ) {
      throw new Error(`Relation property "${property.name}" needs a valid database`);
    }
    if (
      property.type === "rollup" &&
      (typeof property.rollupRelationPropertyId !== "string" ||
        typeof property.rollupTargetPropertyId !== "string" ||
        !["count", "sum", "average", "min", "max", "show_original"].includes(
          property.rollupFunction ?? "",
        ))
    ) {
      throw new Error(`Rollup property "${property.name}" has an invalid configuration`);
    }
  }
  if (properties.filter((property) => property.type === "title").length !== 1) {
    throw new Error("A database needs exactly one title property");
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

function validateDatabaseViews(
  views: DatabaseViewDefinition[],
  properties: DatabaseProperty[],
): void {
  if (!Array.isArray(views) || views.length === 0) {
    throw new Error("A database needs at least one view");
  }
  const propertyIds = new Set(properties.map((property) => property.id));
  const ids = new Set<string>();
  for (const view of views) {
    if (
      !view ||
      typeof view.id !== "string" ||
      !view.id ||
      ids.has(view.id) ||
      typeof view.name !== "string" ||
      !view.name.trim() ||
      !["table", "board", "calendar", "gallery", "list", "timeline"].includes(view.type)
    ) {
      throw new Error("Database has an invalid view definition");
    }
    ids.add(view.id);
    if (
      (view.sortPropertyId && !propertyIds.has(view.sortPropertyId)) ||
      (view.groupPropertyId && !propertyIds.has(view.groupPropertyId)) ||
      (view.datePropertyId &&
        !properties.some(
          (property) => property.id === view.datePropertyId && property.type === "date",
        )) ||
      (view.endDatePropertyId &&
        !properties.some(
          (property) => property.id === view.endDatePropertyId && property.type === "date",
        ))
    ) {
      throw new Error("Database view references an unknown or incompatible property");
    }
    if (
      view.sortDirection !== undefined &&
      view.sortDirection !== "ascending" &&
      view.sortDirection !== "descending"
    ) {
      throw new Error("Database view has an invalid sort direction");
    }
    if (!Array.isArray(view.filters ?? [])) {
      throw new Error("Database view filters must be an array");
    }
    for (const filter of view.filters ?? []) {
      if (
        !propertyIds.has(filter.propertyId) ||
        !["contains", "equals", "is_empty", "is_not_empty"].includes(filter.operator) ||
        typeof filter.value !== "string"
      ) {
        throw new Error("Database view has an invalid filter");
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
  const views = data.views ?? [{ id: "table", name: "Table", type: "table" as const }];
  validateDatabaseViews(views, data.properties);
  return { ...data, meta, views, activeViewId: data.activeViewId ?? views[0].id };
}

export async function createDatabase(
  vault: Vault,
  title: string,
  folderPath: string,
  properties: DatabaseProperty[],
  rows: DatabaseRow[],
  views?: DatabaseViewDefinition[],
  activeViewId?: string,
): Promise<DatabaseMeta> {
  validateFolderPath(folderPath);
  validateDatabaseProperties(properties);
  validateDatabaseRows(properties, rows);
  const existingDatabaseIds = new Set(databasesFor(vault).map((database) => database.id));
  for (const property of properties) {
    if (property.type === "relation" && !existingDatabaseIds.has(property.relationDatabaseId!)) {
      throw new Error(`Relation property "${property.name}" references an unknown database`);
    }
    if (property.type === "rollup") {
      const relation = properties.find(
        (candidate) =>
          candidate.id === property.rollupRelationPropertyId && candidate.type === "relation",
      );
      if (
        !relation ||
        !property.rollupTargetPropertyId ||
        !property.rollupFunction
      ) {
        throw new Error(`Rollup property "${property.name}" needs a valid relation and target`);
      }
      const targetDatabase = await readDatabase(vault, relation.relationDatabaseId!);
      if (!targetDatabase.properties.some((target) => target.id === property.rollupTargetPropertyId)) {
        throw new Error(`Rollup property "${property.name}" references an unknown target property`);
      }
    }
  }
  await ensureFolderChain(vault, folderPath);
  const meta: DatabaseMeta = {
    id: randomUUID(),
    title: title.trim() || "Untitled database",
    folderPath,
    updatedAt: Date.now(),
  };
  const databaseViews = views ?? [{ id: "table", name: "Table", type: "table" as const }];
  const selectedActiveViewId = activeViewId ?? databaseViews[0]?.id;
  const data: DatabaseData = {
    meta,
    properties,
    rows,
    views: databaseViews,
    activeViewId: selectedActiveViewId,
  };
  validateDatabaseViews(databaseViews, properties);
  if (!selectedActiveViewId || !databaseViews.some((view) => view.id === selectedActiveViewId)) {
    throw new Error("Active database view does not exist");
  }
  await writeDatabaseData(vault, data);
  const prevDatabases = [...databasesFor(vault)];
  databasesFor(vault).push(meta);
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    vault.manifest.databases = prevDatabases;
    await rm(databasePath(vault, meta.id), { force: true }).catch(() => {});
    throw error;
  }
  return meta;
}

export async function renameDatabase(vault: Vault, id: string, title: string): Promise<DatabaseMeta> {
  const meta = databasesFor(vault).find((database) => database.id === id);
  if (!meta) throw new Error("Database not found");
  const nextTitle = title.trim();
  if (!nextTitle) throw new Error("Database name cannot be empty");
  const previousTitle = meta.title;
  const previousUpdatedAt = meta.updatedAt;
  meta.title = nextTitle;
  meta.updatedAt = Date.now();
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    meta.title = previousTitle;
    meta.updatedAt = previousUpdatedAt;
    throw error;
  }
  return { ...meta };
}

export async function updateDatabase(
  vault: Vault,
  id: string,
  properties: DatabaseProperty[],
  rows: DatabaseRow[],
  views?: DatabaseViewDefinition[],
  activeViewId?: string,
): Promise<void> {
  validateDatabaseProperties(properties);
  validateDatabaseRows(properties, rows);
  const meta = databasesFor(vault).find((database) => database.id === id);
  if (!meta) throw new Error("Database not found");
  const existingDatabaseIds = new Set(databasesFor(vault).map((database) => database.id));
  for (const property of properties) {
    if (
      property.type === "relation" &&
      (!existingDatabaseIds.has(property.relationDatabaseId!) || property.relationDatabaseId === id)
    ) {
      throw new Error(`Relation property "${property.name}" references an unknown database`);
    }
  }
  const current = await readDatabase(vault, id);
  const propertySchemaChanged =
    JSON.stringify(current.properties) !== JSON.stringify(properties);
  if (propertySchemaChanged) {
    for (const property of properties.filter((candidate) => candidate.type === "rollup")) {
      const relation = properties.find(
        (candidate) =>
          candidate.id === property.rollupRelationPropertyId && candidate.type === "relation",
      );
      if (!relation || !property.rollupTargetPropertyId) {
        throw new Error(`Rollup property "${property.name}" needs a valid relation and target`);
      }
      const targetDatabase = await readDatabase(vault, relation.relationDatabaseId!);
      if (!targetDatabase.properties.some((target) => target.id === property.rollupTargetPropertyId)) {
        throw new Error(`Rollup property "${property.name}" references an unknown target property`);
      }
    }
    const removedPropertyIds = new Set(
      current.properties
        .filter((property) => !properties.some((next) => next.id === property.id))
        .map((property) => property.id),
    );
    if (removedPropertyIds.size > 0) {
      for (const database of databasesFor(vault)) {
        if (database.id === id) continue;
        const referencingData = await readDatabase(vault, database.id);
        for (const rollup of referencingData.properties.filter((property) => property.type === "rollup")) {
          const relation = referencingData.properties.find(
            (property) => property.id === rollup.rollupRelationPropertyId && property.type === "relation",
          );
          if (
            relation?.relationDatabaseId === id &&
            removedPropertyIds.has(rollup.rollupTargetPropertyId ?? "")
          ) {
            throw new Error(
              `Property is used by the "${rollup.name}" rollup in "${database.title}" and cannot be deleted`,
            );
          }
        }
      }
    }
  }
  const nextViews = views ?? current.views!;
  const nextActiveViewId = activeViewId ?? current.activeViewId;
  validateDatabaseViews(nextViews, properties);
  if (!nextViews.some((view) => view.id === nextActiveViewId)) {
    throw new Error("Active database view does not exist");
  }
  const nextMeta = { ...meta, updatedAt: Date.now() };
  await writeDatabaseData(vault, {
    meta: nextMeta,
    properties,
    rows,
    views: nextViews,
    activeViewId: nextActiveViewId,
  });
  const previous = { ...meta };
  Object.assign(meta, nextMeta);
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
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
  await updateDatabase(vault, id, data.properties, data.rows, data.views, data.activeViewId);
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
      await updateDatabase(
        vault,
        meta.id,
        linkedData.properties,
        cleared.rows,
        linkedData.views,
        linkedData.activeViewId,
      );
    }
  }
  const cleared = clearRelationToRow(retainedRows, data.properties, id, rowId);
  await updateDatabase(vault, id, data.properties, cleared.rows, data.views, data.activeViewId);
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
  const previousCanvas = vault.manifest.canvasItems;
  vault.manifest.canvasItems = (previousCanvas ?? []).filter(
    (item) => item.kind !== "database" || item.targetId !== id,
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    databases.splice(index, 0, meta);
    vault.manifest.canvasItems = previousCanvas;
    throw error;
  }
  await rm(databasePath(vault, id), { force: true });
}

interface Manifest {
  notes: NoteMeta[];
  folders: string[]; // explicitly created folders so empty ones survive restarts
  databases?: DatabaseMeta[];
  extensions?: StoredExtension[];
  canvasItems?: CanvasItem[];
}

export interface StoredExtension extends ExtensionSummary {
  source: string;
  sampleId?: string;
}

const EXTENSION_MAX_BYTES = 512 * 1024;
const EXTENSION_PERMISSIONS: ExtensionPermission[] = [
  "read_notes",
  "read_graph",
  "read_databases",
];

const EXTENSION_SAMPLES: Array<ExtensionSample & { source: string }> = [
  {
    id: "note-count",
    name: "Note count",
    description: "Shows how many notes are in the current vault.",
    source:
      '(async () => { const notes = await window.driftleafExtension.listNotes(); const main = document.createElement("main"); main.style.cssText = "font:16px system-ui;padding:32px"; const heading = document.createElement("h1"); heading.textContent = "Vault overview"; const summary = document.createElement("p"); summary.textContent = `${notes.length} notes`; main.append(heading, summary); document.body.replaceChildren(main); })();',
  },
  {
    id: "database-summary",
    name: "Database summary",
    description: "Lists only the databases you explicitly grant access to.",
    source:
      '(async () => { const databases = await window.driftleafExtension.listDatabases(); const main = document.createElement("main"); main.style.cssText = "font:16px system-ui;padding:32px"; const heading = document.createElement("h1"); heading.textContent = "Shared databases"; main.append(heading); const list = document.createElement("ul"); for (const database of databases) { const item = document.createElement("li"); item.textContent = database.title; list.append(item); } if (!databases.length) { const item = document.createElement("li"); item.textContent = "No database access granted"; list.append(item); } main.append(list); document.body.replaceChildren(main); })();',
  },
];

function extensionSummary(extension: StoredExtension): ExtensionSummary {
  return {
    id: extension.id,
    name: extension.name,
    permissions: [...extension.permissions],
    databaseIds: [...extension.databaseIds],
    ...(extension.sampleId ? { sampleId: extension.sampleId } : {}),
  };
}

function validateExtension(extension: StoredExtension): void {
  if (
    !extension ||
    !/^[0-9a-f-]{36}$/i.test(extension.id) ||
    typeof extension.name !== "string" ||
    !extension.name.trim() ||
    extension.name.length > 100 ||
    typeof extension.source !== "string" ||
    Buffer.byteLength(extension.source, "utf8") > EXTENSION_MAX_BYTES ||
    !Array.isArray(extension.permissions) ||
    extension.permissions.some((permission) => !EXTENSION_PERMISSIONS.includes(permission)) ||
    !Array.isArray(extension.databaseIds) ||
    extension.databaseIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) ||
    (extension.sampleId !== undefined &&
      !EXTENSION_SAMPLES.some((sample) => sample.id === extension.sampleId))
  ) {
    throw new Error("Vault contains an invalid extension definition");
  }
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
      filter: (source) => {
        const relative = path.relative(sourcePath, source);
        return ![BRANCH_LOCK_FILENAME, `${BRANCH_LOCK_FILENAME}-journal`,
          `${BRANCH_LOCK_FILENAME}-wal`, `${BRANCH_LOCK_FILENAME}-shm`].includes(relative);
      },
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
  renamedLegacy: string[]; // note ids migrated from old named paths to opaque-ID paths
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
  return path.join(rootPath, DRIFTLEAF_DIR, "manifest.enc");
}

function legacyManifestPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "manifest.json");
}

function canaryPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "canary.enc");
}

function notePath(rootPath: string, note: Pick<NoteMeta, "id">): string {
  if (!/^[0-9a-f-]{36}$/i.test(note.id)) throw new Error("Invalid note ID");
  return path.join(rootPath, DRIFTLEAF_DIR, "notes", `${note.id}.enc`);
}

function legacyNotePath(
  rootPath: string,
  note: Pick<NoteMeta, "folderPath" | "fileName">,
): string {
  validateFolderPath(note.folderPath);
  if (!note.fileName || path.basename(note.fileName) !== note.fileName) {
    throw new Error("Invalid legacy note filename");
  }
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

function parseManifest(value: unknown): Manifest {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Partial<Manifest>).notes) ||
    !Array.isArray((value as Partial<Manifest>).folders)
  ) {
    throw new Error("Vault manifest is missing valid notes or folders arrays");
  }
  const manifest = { databases: [], extensions: [], canvasItems: [], ...(value as Manifest) };
  if (!Array.isArray(manifest.extensions)) {
    throw new Error("Vault manifest contains an invalid extensions list");
  }
  for (const extension of manifest.extensions) {
    if (
      extension &&
      typeof extension === "object" &&
      !Array.isArray(extension) &&
      !Array.isArray(extension.databaseIds)
    ) {
      extension.databaseIds = [];
    }
  }
  for (const extension of manifest.extensions) validateExtension(extension);
  if (!Array.isArray(manifest.canvasItems)) {
    throw new Error("Vault manifest contains invalid canvas items");
  }
  validateCanvasItems(manifest.canvasItems, manifest.notes, manifest.databases ?? []);
  return manifest;
}

export function listExtensions(vault: Vault): ExtensionSummary[] {
  return (vault.manifest.extensions ?? []).map(extensionSummary);
}

export function getExtension(vault: Vault, id: string): StoredExtension | null {
  const extension = (vault.manifest.extensions ?? []).find((item) => item.id === id);
  return extension ? { ...extension, permissions: [...extension.permissions] } : null;
}

export async function installExtension(
  vault: Vault,
  name: string,
  source: string,
): Promise<ExtensionSummary> {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > EXTENSION_MAX_BYTES) {
    throw new Error("Extension files must be smaller than 512 KB");
  }
  if (!source.trim()) throw new Error("The selected extension file is empty");
  const extension: StoredExtension = {
    id: randomUUID(),
    name: name.trim().slice(0, 100) || "Extension",
    source,
    permissions: [],
    databaseIds: [],
  };
  validateExtension(extension);
  const extensions = (vault.manifest.extensions ??= []);
  extensions.push(extension);
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    extensions.pop();
    throw error;
  }
  return extensionSummary(extension);
}

export async function setExtensionPermissions(
  vault: Vault,
  id: string,
  permissions: ExtensionPermission[],
  databaseIds: string[] = [],
): Promise<void> {
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => !EXTENSION_PERMISSIONS.includes(permission)) ||
    new Set(permissions).size !== permissions.length ||
    !Array.isArray(databaseIds) ||
    new Set(databaseIds).size !== databaseIds.length ||
    databaseIds.some((databaseId) => !databasesFor(vault).some((database) => database.id === databaseId)) ||
    (databaseIds.length > 0 && !permissions.includes("read_databases"))
  ) {
    throw new Error("Invalid extension permissions");
  }
  const extension = (vault.manifest.extensions ?? []).find((item) => item.id === id);
  if (!extension) throw new Error("Extension not found");
  const previous = extension.permissions;
  const previousDatabaseIds = extension.databaseIds;
  extension.permissions = [...permissions];
  extension.databaseIds = [...databaseIds];
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    extension.permissions = previous;
    extension.databaseIds = previousDatabaseIds;
    throw error;
  }
}

export function listExtensionSamples(): ExtensionSample[] {
  return EXTENSION_SAMPLES.map(({ id, name, description }) => ({ id, name, description }));
}

export async function installExtensionSample(
  vault: Vault,
  sampleId: string,
): Promise<ExtensionSummary> {
  const sample = EXTENSION_SAMPLES.find((item) => item.id === sampleId);
  if (!sample) throw new Error("Unknown extension sample");
  const extension = await installExtension(vault, sample.name, sample.source);
  const stored = (vault.manifest.extensions ?? []).find((item) => item.id === extension.id);
  if (!stored) throw new Error("The sample extension could not be stored");
  stored.sampleId = sample.id;
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    await removeExtension(vault, extension.id);
    throw error;
  }
  return extensionSummary(stored);
}

function validateCanvasItems(
  items: CanvasItem[],
  notes: NoteMeta[],
  databases: DatabaseMeta[],
): void {
  if (!Array.isArray(items) || items.length > 500) {
    throw new Error("The canvas may contain up to 500 items");
  }
  const ids = new Set<string>();
  for (const item of items) {
    const targets = item?.kind === "note" ? notes : item?.kind === "database" ? databases : [];
    if (
      !item ||
      !/^[0-9a-f-]{36}$/i.test(item.id) ||
      ids.has(item.id) ||
      typeof item.targetId !== "string" ||
      !targets.some((target) => target.id === item.targetId) ||
      !Number.isFinite(item.x) ||
      !Number.isFinite(item.y) ||
      item.x < 0 ||
      item.y < 0 ||
      item.x > 10000 ||
      item.y > 10000
    ) {
      throw new Error("The canvas contains an invalid item");
    }
    ids.add(item.id);
  }
}

export function readCanvas(vault: Vault): CanvasItem[] {
  return (vault.manifest.canvasItems ?? []).map((item) => ({ ...item }));
}

export async function updateCanvas(vault: Vault, items: CanvasItem[]): Promise<void> {
  validateCanvasItems(items, vault.manifest.notes, databasesFor(vault));
  const previous = vault.manifest.canvasItems;
  vault.manifest.canvasItems = items.map((item) => ({ ...item }));
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    vault.manifest.canvasItems = previous;
    throw error;
  }
}

export async function removeExtension(vault: Vault, id: string): Promise<void> {
  const extensions = vault.manifest.extensions ?? [];
  const index = extensions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("Extension not found");
  const [removed] = extensions.splice(index, 1);
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (error) {
    extensions.splice(index, 0, removed);
    throw error;
  }
}

async function readManifest(rootPath: string, key: Buffer): Promise<Manifest> {
  try {
    const encrypted = await readFile(manifestPath(rootPath));
    const plaintext = decrypt(unpackPayload(encrypted), key).toString("utf-8");
    return parseManifest(JSON.parse(plaintext) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Encrypted vault index is damaged or cannot be decrypted", { cause: error });
    }
  }
  const raw = await readFile(legacyManifestPath(rootPath), "utf-8");
  return parseManifest(JSON.parse(raw) as unknown);
}

async function readManifestStrict(rootPath: string, key: Buffer): Promise<Manifest> {
  return readManifest(rootPath, key);
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

async function writeManifest(rootPath: string, manifest: Manifest, key: Buffer): Promise<void> {
  const payload = encrypt(Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"), key);
  await writeFileAtomic(manifestPath(rootPath), packPayload(payload));
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
  await mkdir(rootPath, { recursive: true });
  try {
    // Exclusive directory creation also rejects concurrent initialization and
    // incomplete branches. Never overwrite an existing salt or manifest.
    await mkdir(path.join(rootPath, DRIFTLEAF_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("This folder already contains a branch. Open it instead, or choose a new folder.", { cause: error });
    }
    throw error;
  }
  await mkdir(path.join(rootPath, DRIFTLEAF_DIR, "notes"));

  const salt = generateSalt();
  const key = await deriveVaultKey(passphrase, salt);
  const config: VaultConfig = { version: 1, kdf: "scrypt", saltHex: salt.toString("hex") };
  await writeFile(configPath(rootPath), JSON.stringify(config, null, 2), "utf-8");

  const canary = encrypt(Buffer.from(CANARY_TEXT, "utf-8"), key);
  await writeFile(canaryPath(rootPath), packPayload(canary));

  const manifest: Manifest = {
    notes: [],
    folders: [],
    databases: [],
    extensions: [],
    canvasItems: [],
  };
  await writeManifest(rootPath, manifest, key);

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

  const manifest = await readManifest(rootPath, key);
  const vault: Vault = { rootPath, key, manifest };
  await mkdir(path.join(rootPath, DRIFTLEAF_DIR, "notes"), { recursive: true });
  const recovery = await reconcileVault(vault);
  await writeManifest(rootPath, manifest, key);
  await rm(legacyManifestPath(rootPath), { force: true });
  return { vault, recovery };
}

interface DiskEncFile {
  folderPath: string;
  fileName: string;
  private?: boolean;
}

function diskNotePath(rootPath: string, file: DiskEncFile): string {
  return file.private
    ? path.join(rootPath, DRIFTLEAF_DIR, "notes", file.fileName)
    : legacyNotePath(rootPath, file);
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
// for the operations this covers), and migrates legacy notes from named paths to opaque-ID
// paths. Runs automatically on every unlock.
export async function reconcileVault(vault: Vault): Promise<VaultRecoveryReport> {
  const onDisk = new Map<string, DiskEncFile>();
  await scanEncFiles(vault.rootPath, vault.rootPath, onDisk);
  const privateNotesPath = path.join(vault.rootPath, DRIFTLEAF_DIR, "notes");
  await mkdir(privateNotesPath, { recursive: true });
  for (const entry of await readdir(privateNotesPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".enc")) {
      onDisk.set(`@private/${entry.name}`, {
        folderPath: "",
        fileName: entry.name,
        private: true,
      });
    }
  }

  const report: VaultRecoveryReport = {
    renamedLegacy: [],
    removedDangling: [],
    recoveredOrphans: [],
  };
  const claimed = new Set<string>();
  const survivors: NoteMeta[] = [];

  for (const meta of vault.manifest.notes) {
    const privateName = `${meta.id}.enc`;
    const privateKey = `@private/${privateName}`;
    const oldName = meta.fileName ?? `${meta.id}.enc`;
    const legacyKey = `${meta.folderPath}/${oldName}`;
    const privatePath = notePath(vault.rootPath, meta);
    if (!onDisk.has(privateKey) && onDisk.has(legacyKey)) {
      await mkdir(path.dirname(privatePath), { recursive: true });
      await rename(legacyNotePath(vault.rootPath, { ...meta, fileName: oldName }), privatePath);
      onDisk.delete(legacyKey);
      onDisk.set(privateKey, { folderPath: "", fileName: privateName, private: true });
      await pruneEmptyLegacyFolders(vault.rootPath, meta.folderPath);
      report.renamedLegacy.push(meta.id);
    }
    if (!onDisk.has(privateKey)) {
      report.removedDangling.push(meta.id);
      continue;
    }
    claimed.add(privateKey);
    meta.fileName = privateName;
    survivors.push(meta);
  }

  for (const folder of vault.manifest.folders) {
    await pruneEmptyLegacyFolders(vault.rootPath, folder);
  }

  for (const [key, { folderPath, fileName, private: isPrivate }] of onDisk) {
    if (claimed.has(key)) continue;
    const id = isPrivate && /^[0-9a-f-]{36}\.enc$/i.test(fileName)
      ? fileName.slice(0, -".enc".length)
      : randomUUID();
    survivors.push({
      id,
      title: isPrivate ? "Recovered note" : titleFromFileName(fileName),
      folderPath: isPrivate ? "" : folderPath,
      fileName: `${id}.enc`,
      updatedAt: Date.now(),
    });
    report.recoveredOrphans.push(id);
  }

  vault.manifest.notes = survivors;
  const validNoteIds = new Set(survivors.map((note) => note.id));
  const validDatabaseIds = new Set(databasesFor(vault).map((database) => database.id));
  const previousCanvas = vault.manifest.canvasItems ?? [];
  vault.manifest.canvasItems = previousCanvas.filter((item) =>
    item.kind === "note" ? validNoteIds.has(item.targetId) : validDatabaseIds.has(item.targetId),
  );
  const canvasChanged = vault.manifest.canvasItems.length !== previousCanvas.length;

  if (!isEmptyReport(report) || canvasChanged) {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  }

  return report;
}

async function pruneEmptyLegacyFolders(rootPath: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  while (parts.length > 0) {
    const folder = path.join(rootPath, ...parts);
    try {
      await rmdir(folder);
    } catch (err) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
    parts.pop();
  }
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
  const privateNotesPath = path.join(rootPath, DRIFTLEAF_DIR, "notes");
  try {
    const entries = await readdir(privateNotesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.includes(".tmp-")) temporaryFiles++;
      if (entry.name.endsWith(".enc")) {
        encryptedFiles.set(`@private/${entry.name}`, {
          folderPath: "",
          fileName: entry.name,
          private: true,
        });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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

  const manifestValid = await readManifestStrict(rootPath, key)
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
    if (
      path.basename(fileName) !== fileName ||
      !fileName.endsWith(".enc") ||
      !/^[0-9a-f-]{36}$/i.test(note.id)
    ) {
      invalidEntries++;
      continue;
    }
    try {
      validateFolderPath(note.folderPath);
    } catch {
      invalidEntries++;
      continue;
    }
    const privateKey = `@private/${note.id}.enc`;
    const legacyKey = `${note.folderPath}/${fileName}`;
    const fileKey = disk.encryptedFiles.has(privateKey) ? privateKey : legacyKey;
    expected.add(fileKey);
    if (!disk.encryptedFiles.has(fileKey)) {
      missingFiles++;
    }
  }

  const orphanFiles = [...disk.encryptedFiles.keys()].filter((file) => !expected.has(file)).length;
  let unreadableFiles = 0;
  for (const file of disk.encryptedFiles.values()) {
    try {
      const bytes = await readFile(diskNotePath(rootPath, file));
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
  const manifest = await readManifest(vault.rootPath, vault.key);
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
    const manifest = await readManifest(rootPath, key);
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
  await writeManifest(vault.rootPath, vault.manifest, vault.key);
}

export async function createNote(
  vault: Vault,
  folderPath: string,
  title: string,
): Promise<NoteMeta> {
  validateFolderPath(folderPath);
  const id = randomUUID();
  const fileName = `${id}.enc`;
  const meta: NoteMeta = { id, title, folderPath, fileName, updatedAt: Date.now() };
  await mkdir(path.dirname(notePath(vault.rootPath, meta)), { recursive: true });
  const payload = encrypt(Buffer.from("", "utf-8"), vault.key);
  await writeFileAtomic(notePath(vault.rootPath, meta), packPayload(payload));
  vault.manifest.notes.push(meta);
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
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
  const prevTitle = meta.title;
  const prevUpdatedAt = meta.updatedAt;
  meta.title = title;
  meta.updatedAt = Date.now();
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (err) {
    // Mirror moveNote()'s rollback: a rejected rename must not remain visible in memory
    // (listNotes()/search would then disagree with what's actually on disk).
    meta.title = prevTitle;
    meta.updatedAt = prevUpdatedAt;
    throw err;
  }
}

// Manifest is updated before the file is removed: if a crash happens in between, the
// worst case is an orphaned .enc file on disk (harmless, cleaned up by reconcileVault()),
// never a manifest entry pointing at a note that no longer exists.
export async function deleteNote(vault: Vault, id: string): Promise<void> {
  const index = vault.manifest.notes.findIndex((n) => n.id === id);
  if (index === -1) throw new Error(`Note not found: ${id}`);
  const [meta] = vault.manifest.notes.splice(index, 1);
  const previousCanvas = vault.manifest.canvasItems;
  vault.manifest.canvasItems = (previousCanvas ?? []).filter(
    (item) => item.kind !== "note" || item.targetId !== id,
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (err) {
    vault.manifest.notes.splice(index, 0, meta);
    vault.manifest.canvasItems = previousCanvas;
    throw err;
  }
  await rm(notePath(vault.rootPath, meta), { force: true });
}

export async function createFolder(vault: Vault, folderPath: string): Promise<void> {
  validateFolderPath(folderPath);
  if (!vault.manifest.folders.includes(folderPath)) {
    vault.manifest.folders.push(folderPath);
    try {
      await writeManifest(vault.rootPath, vault.manifest, vault.key);
    } catch (err) {
      // Mirror createNote()'s rollback: don't leave the folder visible in-memory for the
      // rest of the session if it was never actually recorded on disk, or a retry would
      // see it via `includes` above and skip the write entirely, falsely reporting success.
      const index = vault.manifest.folders.indexOf(folderPath);
      if (index !== -1) vault.manifest.folders.splice(index, 1);
      throw err;
    }
  }
}

export async function moveNote(vault: Vault, id: string, targetFolder: string): Promise<NoteMeta> {
  validateFolderPath(targetFolder);
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const prevFolderPath = meta.folderPath;
  const prevFileName = meta.fileName;
  const prevUpdatedAt = meta.updatedAt;
  meta.folderPath = targetFolder;
  meta.fileName = `${meta.id}.enc`;
  meta.updatedAt = Date.now();
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (err) {
    meta.folderPath = prevFolderPath;
    meta.fileName = prevFileName;
    meta.updatedAt = prevUpdatedAt;
    throw err;
  }
  await pruneEmptyLegacyFolders(vault.rootPath, prevFolderPath);
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
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    vault.manifest.databases = prevDatabases;
    throw err;
  }
  await pruneEmptyLegacyFolders(vault.rootPath, oldFolderPath);
}

// The encrypted manifest drops entries first, then encrypted note/database files are
// removed. A crash mid-operation leaves orphaned ciphertext rather than missing entries.
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
  const prevCanvas = vault.manifest.canvasItems;
  const deletedNoteIds = new Set(deletedIds);
  const deletedDatabaseIds = new Set(affectedDatabaseIds);
  vault.manifest.notes = vault.manifest.notes.filter((n) => !deletedIds.includes(n.id));
  vault.manifest.databases = prevDatabases.filter(
    (database) =>
      !affectedDatabases.some((affectedDatabase) => affectedDatabase.id === database.id),
  );
  vault.manifest.folders = vault.manifest.folders.filter(
    (f) => f !== folderPath && !f.startsWith(folderPath + "/"),
  );
  vault.manifest.canvasItems = (prevCanvas ?? []).filter((item) =>
    item.kind === "note"
      ? !deletedNoteIds.has(item.targetId)
      : !deletedDatabaseIds.has(item.targetId),
  );
  try {
    await writeManifest(vault.rootPath, vault.manifest, vault.key);
  } catch (err) {
    vault.manifest.notes = prevNotes;
    vault.manifest.folders = prevFolders;
    vault.manifest.databases = prevDatabases;
    vault.manifest.canvasItems = prevCanvas;
    throw err;
  }
  await Promise.all(
    affectedDatabases.map((database) => rm(databasePath(vault, database.id), { force: true })),
  );
  await Promise.all(affected.map((note) => rm(notePath(vault.rootPath, note), { force: true })));
  await pruneEmptyLegacyFolders(vault.rootPath, folderPath);
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
          parsed.views,
          parsed.activeViewId,
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
  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries();
  } catch (err) {
    return {
      imported: [],
      importedDatabases: [],
      skipped: [
        `${path.basename(zipPath)} (${err instanceof Error ? err.message : "couldn't read archive"})`,
      ],
    };
  }

  return importZipEntries(vault, entries, path.basename(zipPath), targetFolder);
}

export async function importTemplateArchive(
  vault: Vault,
  archive: Uint8Array,
  templateName: string,
): Promise<ImportResult> {
  if (archive.byteLength > 25 * 1024 * 1024) {
    throw new Error("Templates must be smaller than 25 MB");
  }
  let entries;
  try {
    entries = new AdmZip(Buffer.from(archive)).getEntries();
  } catch (err) {
    throw new Error(
      `Could not read template archive: ${err instanceof Error ? err.message : "invalid ZIP file"}`,
      { cause: err },
    );
  }
  const safeName = templateName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
  if (!safeName) throw new Error("Template name is invalid");
  return importZipEntries(
    vault,
    entries,
    `${safeName}.zip`,
    `Community templates/${safeName}`,
  );
}

async function importZipEntries(
  vault: Vault,
  entries: ReturnType<AdmZip["getEntries"]>,
  archiveName: string,
  targetFolder: string,
): Promise<ImportResult> {
  const imported: NoteMeta[] = [];
  const importedDatabases: DatabaseMeta[] = [];
  const skipped: string[] = [];

  if (entries.length > MAX_IMPORT_ENTRIES) {
    return {
      imported,
      importedDatabases,
      skipped: [`${archiveName} (archive has too many entries — over ${MAX_IMPORT_ENTRIES})`],
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
          parsed.views,
          parsed.activeViewId,
        );
        importedDatabases.push(meta);
      }
    } catch (err) {
      skipped.push(`${entry.entryName} (${err instanceof Error ? err.message : "import failed"})`);
    }
  }

  return { imported, importedDatabases, skipped };
}
