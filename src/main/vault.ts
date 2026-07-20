// Vault = a folder tree of encrypted markdown notes on disk (see docs/ARCHITECTURE.md).
// Organization is folder-based: a note's `folderPath` is also where its `.enc` file lives.
// Note titles/folder placement are kept in a plaintext manifest sidecar so the sidebar tree
// can render without decrypting every note — only note *content* is encrypted.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
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

export interface NoteMeta {
  id: string;
  title: string;
  folderPath: string; // "" for vault root, else e.g. "Projects/Driftleaf"
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

function configPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "vault.json");
}

function manifestPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "manifest.json");
}

function canaryPath(rootPath: string): string {
  return path.join(rootPath, DRIFTLEAF_DIR, "canary.enc");
}

function notePath(rootPath: string, note: Pick<NoteMeta, "id" | "folderPath">): string {
  return path.join(rootPath, note.folderPath, `${note.id}.enc`);
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
}

async function writeManifest(rootPath: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath(rootPath), JSON.stringify(manifest, null, 2), "utf-8");
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

  return { rootPath, key, manifest };
}

export async function vaultHasPassphrase(rootPath: string): Promise<boolean> {
  const configRaw = await readFile(configPath(rootPath), "utf-8");
  const config = JSON.parse(configRaw) as VaultConfig;
  return config.kdf === "scrypt";
}

export async function unlockVault(rootPath: string, passphrase: string): Promise<Vault> {
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
  return { rootPath, key, manifest };
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
  const decrypted = decrypt(unpackPayload(data), vault.key);
  return decrypted.toString("utf-8");
}

export async function writeNote(vault: Vault, id: string, content: string): Promise<void> {
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const payload = encrypt(Buffer.from(content, "utf-8"), vault.key);
  await writeFile(notePath(vault.rootPath, meta), packPayload(payload));
  meta.updatedAt = Date.now();
  await writeManifest(vault.rootPath, vault.manifest);
}

export async function createNote(
  vault: Vault,
  folderPath: string,
  title: string,
): Promise<NoteMeta> {
  const id = randomUUID();
  const meta: NoteMeta = { id, title, folderPath, updatedAt: Date.now() };
  await mkdir(path.join(vault.rootPath, folderPath), { recursive: true });
  const payload = encrypt(Buffer.from("", "utf-8"), vault.key);
  await writeFile(notePath(vault.rootPath, meta), packPayload(payload));
  vault.manifest.notes.push(meta);
  await writeManifest(vault.rootPath, vault.manifest);
  return meta;
}

export async function renameNote(vault: Vault, id: string, title: string): Promise<void> {
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  meta.title = title;
  meta.updatedAt = Date.now();
  await writeManifest(vault.rootPath, vault.manifest);
}

export async function deleteNote(vault: Vault, id: string): Promise<void> {
  const index = vault.manifest.notes.findIndex((n) => n.id === id);
  if (index === -1) throw new Error(`Note not found: ${id}`);
  const [meta] = vault.manifest.notes.splice(index, 1);
  await rm(notePath(vault.rootPath, meta), { force: true });
  await writeManifest(vault.rootPath, vault.manifest);
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
  const meta = vault.manifest.notes.find((n) => n.id === id);
  if (!meta) throw new Error(`Note not found: ${id}`);
  const oldPath = notePath(vault.rootPath, meta);
  meta.folderPath = targetFolder;
  meta.updatedAt = Date.now();
  const newPath = notePath(vault.rootPath, meta);
  if (oldPath !== newPath) {
    await mkdir(path.join(vault.rootPath, targetFolder), { recursive: true });
    await rename(oldPath, newPath);
  }
  await writeManifest(vault.rootPath, vault.manifest);
  return meta;
}

export async function renameFolder(
  vault: Vault,
  oldFolderPath: string,
  newFolderPath: string,
): Promise<void> {
  if (!oldFolderPath) throw new Error("Cannot rename the vault root");
  validateFolderPath(newFolderPath);
  for (const note of vault.manifest.notes) {
    if (note.folderPath === oldFolderPath || note.folderPath.startsWith(oldFolderPath + "/")) {
      note.folderPath = newFolderPath + note.folderPath.slice(oldFolderPath.length);
    }
  }
  vault.manifest.folders = vault.manifest.folders.map((f) =>
    f === oldFolderPath || f.startsWith(oldFolderPath + "/")
      ? newFolderPath + f.slice(oldFolderPath.length)
      : f,
  );
  await rename(
    path.join(vault.rootPath, oldFolderPath),
    path.join(vault.rootPath, newFolderPath),
  );
  await writeManifest(vault.rootPath, vault.manifest);
}

export async function deleteFolder(vault: Vault, folderPath: string): Promise<string[]> {
  if (!folderPath) throw new Error("Cannot delete the vault root");
  const affected = vault.manifest.notes.filter(
    (n) => n.folderPath === folderPath || n.folderPath.startsWith(folderPath + "/"),
  );
  const deletedIds = affected.map((n) => n.id);
  vault.manifest.notes = vault.manifest.notes.filter((n) => !deletedIds.includes(n.id));
  vault.manifest.folders = vault.manifest.folders.filter(
    (f) => f !== folderPath && !f.startsWith(folderPath + "/"),
  );
  await rm(path.join(vault.rootPath, folderPath), { recursive: true, force: true });
  await writeManifest(vault.rootPath, vault.manifest);
  return deletedIds;
}
