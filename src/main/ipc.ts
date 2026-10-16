import { SerialQueue } from "../shared/serial-queue";
import { app, BrowserWindow, ipcMain, dialog, type IpcMainInvokeEvent } from "electron";
import { prepareWindowClose, cancelWindowClose } from "./window-lifecycle";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  IPC_CHANNELS,
  type DatabaseExportFormat,
  type ExtensionPermission,
} from "../shared/ipc";
import * as vaultModule from "./vault";
import type { Vault } from "./vault";
import * as searchModule from "./search";
import type { SearchIndex } from "./search";
import * as settingsModule from "./settings";
import * as updatesModule from "./updates";
import { exportDatabase } from "./database-export";
import { downloadCommunityAsset, listCommunityReleases } from "./community-catalog";

interface Session {
  vault: Vault | null;
  index: SearchIndex | null;
}

const session: Session = { vault: null, index: null };

function requireVault(): Vault {
  if (!session.vault) throw new Error("No vault is unlocked");
  return session.vault;
}

// Async vault operations and locking share one queue. Each operation retains the
// key and index until its file I/O and index maintenance have both finished.
const vaultOpQueue = new SerialQueue();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  return vaultOpQueue.run(fn);
}

// The renderer is only supposed to import files it selected via vault:pickImportFiles's
// native OS dialog, never an arbitrary path it constructs itself — this tracks the most
// recent picker result as a single-use allowlist so notes:import can enforce that even if
// the renderer-side code is compromised (XSS, a malicious dependency) and calls the IPC
// channel directly with attacker-chosen paths.
let lastPickedImportPaths: Set<string> | null = null;
let lastPickedBackupPath: string | null = null;
let lastPickedBackupDestination: string | null = null;

// Translates raw Node fs error codes into messages a user can act on. Thrown errors from
// an ipcMain.handle callback reject the renderer's invoke() promise with the message intact,
// so this is the one place worth doing the translation rather than in every handler.
function friendlyError(err: unknown): Error {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") return new Error("Disk is full. Free up space and try again.");
    if (code === "EACCES" || code === "EPERM") {
      return new Error("Permission denied. Check that Driftleaf can write to this folder.");
    }
    if (code === "ENOENT")
      return new Error("A vault file is missing. The vault folder may have moved.");
    return err;
  }
  return new Error(String(err));
}

// Wraps an ipcMain.handle callback so any thrown fs error is translated before it crosses
// the IPC boundary, instead of the renderer having to guess what a raw Error.message means.
function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
): void {
  ipcMain.handle(channel, async (event, ...args: Args) => {
    try {
      const invoke = () => fn(event, ...args);
      // Serialize the entire operation, including reads and index maintenance.
      // Resolve requireVault inside this boundary, never before waiting for it.
      return await (channel.startsWith("updates:") || channel.startsWith("settings:")
        ? invoke()
        : serialized(async () => invoke()));
    } catch (err) {
      throw friendlyError(err);
    }
  });
}

async function openSession(vault: Vault): Promise<void> {
  const sessionStart = Date.now();
  // Build the index against a fresh, not-yet-committed index handle first — session.vault/
  // session.index are only assigned once indexing actually succeeds. Assigning them up front
  // meant a failed unlock (buildIndex throwing) still left the main process holding a "live"
  // vault + key internally even though the renderer was told unlock failed and returned to
  // the lock screen.
  const index = searchModule.openIndex();
  try {
    await searchModule.buildIndex(index, vault);
  } catch (err) {
    index.db.close();
    vault.key.fill(0);
    throw err;
  }
  session.vault?.key.fill(0);
  session.index?.db.close();
  closeExtensionWindows();
  session.vault = vault;
  session.index = index;
  const sessionDuration = Date.now() - sessionStart;
  if (process.env.DEBUG_SEARCH) {
    console.log(`[ipc] openSession (unlock + index build): ${sessionDuration}ms`);
  }
}

export function lockSession(): Promise<void> {
  return serialized(async () => {
    closeExtensionWindows();
    session.vault?.key.fill(0);
    session.index?.db.close();
    session.vault = null;
    session.index = null;
  });
}

let currentWindow: BrowserWindow | null = null;
let handlersRegistered = false;
const extensionContexts = new Map<number, { extensionId: string; vault: Vault }>();
const extensionWindows = new Map<number, BrowserWindow>();

function closeExtensionWindows(): void {
  for (const win of extensionWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  extensionContexts.clear();
  extensionWindows.clear();
}

function requireExtensionContext(
  event: IpcMainInvokeEvent,
  permission: ExtensionPermission,
): { extensionId: string; vault: Vault } {
  const context = extensionContexts.get(event.sender.id);
  if (!context || context.vault !== session.vault) {
    throw new Error("This window is not an active Driftleaf extension");
  }
  const extension = vaultModule.getExtension(context.vault, context.extensionId);
  if (!extension) throw new Error("This extension was removed");
  if (!extension.permissions.includes(permission)) {
    throw new Error(`This extension has not been granted ${permission.replace("_", " ")} access`);
  }
  return context;
}

// Safe to call every time a window is (re)created — e.g. on macOS, clicking the dock icon
// after closing the only window calls this again. ipcMain.handle() throws synchronously on
// a duplicate registration for the same channel, so the actual handler wiring below only
// runs once; later calls just repoint the dialogs (which need a live BrowserWindow to
// anchor to) at the new window.
export function registerIpcHandlers(win: BrowserWindow): void {
  currentWindow = win;
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(IPC_CHANNELS.vaultPickDirectory, async () => {
    if (!currentWindow) return null;
    const result = await dialog.showOpenDialog(currentWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.vaultPickBackupDirectory, async () => {
    lastPickedBackupPath = null;
    if (!currentWindow) return null;
    const result = await dialog.showOpenDialog(currentWindow, {
      properties: ["openDirectory"],
      title: "Choose a Driftleaf backup folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    lastPickedBackupPath = result.filePaths[0];
    return lastPickedBackupPath;
  });

  ipcMain.handle(IPC_CHANNELS.vaultPickBackupDestination, async () => {
    lastPickedBackupDestination = null;
    if (!currentWindow) return null;
    const result = await dialog.showOpenDialog(currentWindow, {
      properties: ["openDirectory"],
      title: "Choose where to save the backup",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    lastPickedBackupDestination = result.filePaths[0];
    return lastPickedBackupDestination;
  });

  handle(IPC_CHANNELS.vaultCreateBackup, async (_e, destinationPath: string) => {
    const selectedDestination = lastPickedBackupDestination;
    lastPickedBackupDestination = null;
    if (!selectedDestination || destinationPath !== selectedDestination) {
      throw new Error("Choose the backup destination using the folder picker first");
    }
    const vault = requireVault();
    return vaultModule.createVaultBackup(vault, selectedDestination);
  });

  ipcMain.handle(IPC_CHANNELS.vaultPickImportFiles, async () => {
    if (!currentWindow) return null;
    const result = await dialog.showOpenDialog(currentWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Notes, tables, and zip archives", extensions: ["md", "csv", "json", "zip"] },
        { name: "Markdown", extensions: ["md"] },
        { name: "Tables (CSV / JSON)", extensions: ["csv", "json"] },
        { name: "Zip archive", extensions: ["zip"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      lastPickedImportPaths = null;
      return null;
    }
    lastPickedImportPaths = new Set(result.filePaths);
    return result.filePaths;
  });

  handle(
    IPC_CHANNELS.vaultCreate,
    async (
      _e,
      rootPath: string,
      passphrase: string,
      template: Parameters<typeof vaultModule.createVault>[2],
    ) => {
      const vault = await vaultModule.createVault(rootPath, passphrase, template);
      await openSession(vault);
      await settingsModule.patchSettings({ lastVaultPath: rootPath });
    },
  );

  handle(IPC_CHANNELS.vaultUnlock, async (_e, rootPath: string, passphrase: string) => {
    const { vault, recovery } = await vaultModule.unlockVault(rootPath, passphrase);
    await openSession(vault);
    await settingsModule.patchSettings({ lastVaultPath: rootPath });
    return recovery;
  });

  handle(IPC_CHANNELS.vaultHasPassphrase, (_e, rootPath: string) => {
    return vaultModule.vaultHasPassphrase(rootPath);
  });

  handle(IPC_CHANNELS.vaultHealthCheck, async () => {
    const report = await vaultModule.inspectVault(requireVault());
    if (session.index) {
      const indexedCount = (
        session.index.db.prepare("SELECT COUNT(*) AS count FROM notes_fts").get() as {
          count: number;
        }
      ).count;
      const noteCount = vaultModule.listNotes(requireVault()).length;
      report.checks.push({
        name: "Search index",
        status: indexedCount === noteCount ? "ok" : "warning",
        details:
          indexedCount === noteCount
            ? `${indexedCount} note(s) are indexed for search.`
            : `Search contains ${indexedCount} of ${noteCount} indexed note(s).`,
      });
    }
    return report;
  });

  handle(IPC_CHANNELS.vaultVerifyBackup, (_e, rootPath: string, passphrase: string) => {
    if (!lastPickedBackupPath || rootPath !== lastPickedBackupPath) {
      throw new Error("Choose the backup folder using the folder picker before verifying it");
    }
    return vaultModule.verifyVaultBackup(rootPath, passphrase);
  });

  ipcMain.handle(IPC_CHANNELS.vaultLock, () => lockSession());

  ipcMain.handle(IPC_CHANNELS.notesList, (_e, folderPath?: string) => {
    return vaultModule.listNotes(requireVault(), folderPath);
  });

  ipcMain.handle(IPC_CHANNELS.notesListFolders, () => {
    return vaultModule.listFolders(requireVault());
  });

  handle(IPC_CHANNELS.notesRead, (_e, id: string) => {
    return vaultModule.readNote(requireVault(), id);
  });

  handle(IPC_CHANNELS.notesWrite, async (_e, id: string, content: string) => {
    const vault = requireVault();
    await vaultModule.writeNote(vault, id, content);
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) searchModule.reindexNote(session.index, meta, content);
  });

  handle(IPC_CHANNELS.notesCreate, async (_e, folderPath: string, title: string) => {
    const vault = requireVault();
    const meta = await vaultModule.createNote(vault, folderPath, title);
    if (session.index) searchModule.reindexNote(session.index, meta, "");
    return meta;
  });

  handle(IPC_CHANNELS.notesRename, async (_e, id: string, title: string) => {
    const vault = requireVault();
    await vaultModule.renameNote(vault, id, title);
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) {
      const content = await vaultModule.readNote(vault, id);
      searchModule.reindexNote(session.index, meta, content);
    }
  });

  handle(IPC_CHANNELS.notesRemove, async (_e, id: string) => {
    const vault = requireVault();
    await vaultModule.deleteNote(vault, id);
    if (session.index) searchModule.removeFromIndex(session.index, id);
  });

  handle(IPC_CHANNELS.foldersCreate, async (_e, folderPath: string) => {
    const vault = requireVault();
    await vaultModule.createFolder(vault, folderPath);
  });

  handle(IPC_CHANNELS.notesImport, async (_e, filePaths: string[], targetFolder: string) => {
    const vault = requireVault();
    // Only import paths that actually came back from this session's most recent
    // vault:pickImportFiles call — a renderer calling this channel directly with paths it
    // made up itself (bypassing the OS file picker) shouldn't be able to pull arbitrary
    // files off disk into the vault. Single-use: consumed immediately so it can't be
    // replayed against a later, unrelated import call.
    const allowed = lastPickedImportPaths;
    lastPickedImportPaths = null;
    const safePaths = filePaths.filter((p) => allowed?.has(p));
    const rejectedPaths = filePaths.filter((p) => !allowed?.has(p));

    const result = await vaultModule.importFiles(vault, safePaths, targetFolder);
    if (session.index) {
      for (const meta of result.imported) {
        const content = await vaultModule.readNote(vault, meta.id);
        searchModule.reindexNote(session.index, meta, content);
      }
    }
    const skipped = [
      ...result.skipped,
      ...rejectedPaths.map((p) => `${path.basename(p)} (not selected via the file picker)`),
    ];
    return {
      imported: result.imported.length,
      importedDatabases: result.importedDatabases.length,
      skipped,
    };
  });

  ipcMain.handle(IPC_CHANNELS.databasesList, (_e, folderPath?: string) => {
    return vaultModule.listDatabases(requireVault(), folderPath);
  });

  handle(IPC_CHANNELS.databasesRead, (_e, id: string) => {
    return vaultModule.readDatabase(requireVault(), id);
  });

  handle(IPC_CHANNELS.databasesCreate, async (_e, title: string, folderPath: string) => {
    const vault = requireVault();
    return vaultModule.createDatabase(vault, title, folderPath, [
      { id: randomUUID(), name: "Title", type: "title" },
    ], []);
  });

  handle(IPC_CHANNELS.databasesRename, async (_e, id: string, title: string) => {
    const vault = requireVault();
    return vaultModule.renameDatabase(vault, id, title);
  });

  handle(
    IPC_CHANNELS.databasesUpdate,
    async (
      _e,
      id: string,
      properties: Parameters<typeof vaultModule.updateDatabase>[2],
      rows: Parameters<typeof vaultModule.updateDatabase>[3],
      views: Parameters<typeof vaultModule.updateDatabase>[4],
      activeViewId: Parameters<typeof vaultModule.updateDatabase>[5],
    ) => {
      const vault = requireVault();
      await vaultModule.updateDatabase(vault, id, properties, rows, views, activeViewId);
    },
  );

  handle(IPC_CHANNELS.databasesCreateRow, async (_e, id: string) => {
    const vault = requireVault();
    return vaultModule.createDatabaseRow(vault, id);
  });

  handle(IPC_CHANNELS.databasesDeleteRow, async (_e, id: string, rowId: string) => {
    const vault = requireVault();
    await vaultModule.deleteDatabaseRow(vault, id, rowId);
  });

  handle(
    IPC_CHANNELS.databasesExport,
    async (_event, id: string, format: DatabaseExportFormat) => {
      if (format !== "csv" && format !== "json") {
        throw new Error("Unsupported database export format");
      }
      if (!currentWindow || currentWindow.isDestroyed()) {
        throw new Error("No Driftleaf window is available");
      }
      const { title, content } = await exportDatabase(requireVault(), id, format);
      const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 100);
      const result = await dialog.showSaveDialog(currentWindow, {
        title: `Export ${title}`,
        defaultPath: path.join(os.homedir(), `${safeTitle || "database"}.${format}`),
        filters: [
          {
            name: format === "csv" ? "CSV spreadsheet" : "Driftleaf database JSON",
            extensions: [format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return false;
      const temporaryPath = `${result.filePath}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, result.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
      return true;
    },
  );

  handle(IPC_CHANNELS.databasesDelete, async (_e, id: string) => {
    const vault = requireVault();
    await vaultModule.deleteDatabase(vault, id);
  });

  handle(IPC_CHANNELS.notesMove, async (_e, id: string, targetFolder: string) => {
    const vault = requireVault();
    const meta = await vaultModule.moveNote(vault, id, targetFolder);
    if (session.index) {
      const content = await vaultModule.readNote(vault, id);
      searchModule.reindexNote(session.index, meta, content);
    }
    return meta;
  });

  handle(IPC_CHANNELS.foldersRename, async (_e, oldPath: string, newPath: string) => {
    const vault = requireVault();
    await vaultModule.renameFolder(vault, oldPath, newPath);
    if (session.index) await searchModule.buildIndex(session.index, vault);
  });

  handle(IPC_CHANNELS.foldersDelete, async (_e, folderPath: string) => {
    const vault = requireVault();
    const deletedIds = await vaultModule.deleteFolder(vault, folderPath);
    if (session.index) {
      deletedIds.forEach((id) => searchModule.removeFromIndex(session.index!, id));
    }
    return deletedIds;
  });

  ipcMain.handle(IPC_CHANNELS.searchQuery, (_e, text: string) => {
    if (!session.index) return [];
    return searchModule.search(session.index, text);
  });

  handle(IPC_CHANNELS.notesGraph, () => {
    if (!session.index) throw new Error("No vault is unlocked");
    return searchModule.buildNoteGraph(session.index);
  });

  handle(IPC_CHANNELS.extensionsList, () => vaultModule.listExtensions(requireVault()));

  handle(IPC_CHANNELS.extensionsInstall, async () => {
    const vault = requireVault();
    if (!currentWindow) throw new Error("No Driftleaf window is available");
    const result = await dialog.showOpenDialog(currentWindow, {
      properties: ["openFile"],
      title: "Choose a JavaScript extension",
      filters: [{ name: "JavaScript extension", extensions: ["js"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    if (path.extname(filePath).toLowerCase() !== ".js") {
      throw new Error("Choose a JavaScript (.js) extension file");
    }
    const fileInfo = await stat(filePath);
    if (fileInfo.size > 512 * 1024) throw new Error("Extension files must be smaller than 512 KB");
    const sourceBytes = await readFile(filePath);
    if (sourceBytes.length > 512 * 1024) {
      throw new Error("Extension files must be smaller than 512 KB");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    } catch {
      throw new Error("Extension files must contain valid UTF-8 JavaScript");
    }
    const name = path.basename(filePath, path.extname(filePath));
    return vaultModule.installExtension(vault, name, source);
  });

  handle(
    IPC_CHANNELS.extensionsSetPermissions,
    async (
      _event,
      id: string,
      permissions: ExtensionPermission[],
      databaseIds: string[] = [],
    ) => {
      const vault = requireVault();
      await vaultModule.setExtensionPermissions(vault, id, permissions, databaseIds);
    },
  );

  ipcMain.handle(IPC_CHANNELS.extensionsSamples, () => vaultModule.listExtensionSamples());
  handle(IPC_CHANNELS.extensionsCommunity, () => listCommunityReleases());
  handle(IPC_CHANNELS.extensionsCommunityPreview, async (_event, assetId: number) => {
    const { bytes } = await downloadCommunityAsset(assetId, "extension");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("The extension release asset is not valid UTF-8 JavaScript");
    }
  });
  handle(IPC_CHANNELS.extensionsCommunityInstall, async (_event, assetId: number) => {
    const vault = requireVault();
    const { item, bytes } = await downloadCommunityAsset(assetId, "extension");
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("The extension release asset is not valid UTF-8 JavaScript");
    }
    return vaultModule.installExtension(vault, item.name, source);
  });
  handle(IPC_CHANNELS.templatesCommunityInstall, async (_event, assetId: number) => {
    const vault = requireVault();
    const { item, bytes } = await downloadCommunityAsset(assetId, "template");
    const result = await vaultModule.importTemplateArchive(vault, bytes, item.name);
    if (session.index) {
      for (const meta of result.imported) {
        const content = await vaultModule.readNote(vault, meta.id);
        searchModule.reindexNote(session.index, meta, content);
      }
    }
    return {
      imported: result.imported.length,
      importedDatabases: result.importedDatabases.length,
      skipped: result.skipped,
    };
  });
  handle(IPC_CHANNELS.extensionsInstallSample, async (_event, sampleId: string) => {
    const vault = requireVault();
    return vaultModule.installExtensionSample(vault, sampleId);
  });

  handle(IPC_CHANNELS.extensionsRemove, async (_event, id: string) => {
    const vault = requireVault();
    await vaultModule.removeExtension(vault, id);
    for (const [webContentsId, context] of extensionContexts) {
      if (context.extensionId === id) extensionWindows.get(webContentsId)?.close();
    }
  });

  handle(IPC_CHANNELS.extensionsRun, async (_event, id: string) => {
    const vault = requireVault();
    const extension = vaultModule.getExtension(vault, id);
    if (!extension) throw new Error("Extension not found");
    if (!currentWindow || currentWindow.isDestroyed()) {
      throw new Error("No Driftleaf window is available");
    }
    const win = new BrowserWindow({
      parent: currentWindow,
      width: 800,
      height: 600,
      title: `${extension.name} — Driftleaf extension`,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        additionalArguments: ["--driftleaf-extension-window"],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        partition: `driftleaf-extension-${randomUUID()}`,
      },
    });
    const webContentsId = win.webContents.id;
    extensionWindows.set(webContentsId, win);
    extensionContexts.set(webContentsId, { extensionId: id, vault });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => {
      extensionWindows.delete(webContentsId);
      extensionContexts.delete(webContentsId);
    });
    const safeSource = extension.source.replace(/<\/script/gi, "<\\/script");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${extension.name.replace(/[&<>"']/g, "")}</title></head><body><script>${safeSource}</script></body></html>`;
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    } catch (error) {
      win.close();
      throw error;
    }
  });

  handle(IPC_CHANNELS.extensionNotesList, (event) => {
    const { vault } = requireExtensionContext(event, "read_notes");
    return vaultModule.listNotes(vault).map(({ id, title, folderPath, updatedAt }) => ({
      id,
      title,
      folderPath,
      updatedAt,
    }));
  });

  handle(IPC_CHANNELS.extensionNotesRead, (event, id: string) => {
    const { vault } = requireExtensionContext(event, "read_notes");
    return vaultModule.readNote(vault, id);
  });

  handle(IPC_CHANNELS.extensionGraph, (event) => {
    const { vault } = requireExtensionContext(event, "read_graph");
    if (vault !== session.vault || !session.index) throw new Error("No vault is unlocked");
    return searchModule.buildNoteGraph(session.index);
  });

  handle(IPC_CHANNELS.extensionDatabasesList, async (event) => {
    const { vault, extensionId } = requireExtensionContext(event, "read_databases");
    const extension = vaultModule.getExtension(vault, extensionId);
    if (!extension) throw new Error("This extension was removed");
    return (await vaultModule
      .listDatabases(vault))
      .filter((database) => extension.databaseIds.includes(database.id));
  });

  handle(IPC_CHANNELS.extensionDatabaseRead, async (event, id: string) => {
    const { vault, extensionId } = requireExtensionContext(event, "read_databases");
    const extension = vaultModule.getExtension(vault, extensionId);
    if (!extension?.databaseIds.includes(id)) {
      throw new Error("This extension has not been granted access to that database");
    }
    const data = await vaultModule.readDatabase(vault, id);
    const relationSafePropertyIds = new Set(
      data.properties
        .filter(
          (property) =>
            property.type !== "relation" ||
            !property.relationDatabaseId ||
            extension.databaseIds.includes(property.relationDatabaseId),
        )
        .map((property) => property.id),
    );
    const permittedPropertyIds = new Set(
      data.properties
        .filter((property) => {
          if (
            property.type === "rollup" &&
            property.rollupRelationPropertyId &&
            !relationSafePropertyIds.has(property.rollupRelationPropertyId)
          ) {
            return false;
          }
          return relationSafePropertyIds.has(property.id);
        })
        .map((property) => property.id),
    );
    return {
      ...data,
      properties: data.properties.filter((property) => permittedPropertyIds.has(property.id)),
      rows: data.rows.map((row) => ({
        ...row,
        values: Object.fromEntries(
          Object.entries(row.values).filter(([propertyId]) =>
            permittedPropertyIds.has(propertyId),
          ),
        ),
      })),
    };
  });

  handle(IPC_CHANNELS.canvasRead, () => vaultModule.readCanvas(requireVault()));
  handle(IPC_CHANNELS.canvasUpdate, async (_event, items: Parameters<typeof vaultModule.updateCanvas>[1]) => {
    const vault = requireVault();
    await vaultModule.updateCanvas(vault, items);
  });

  ipcMain.handle(IPC_CHANNELS.settingsRead, () => {
    return settingsModule.readSettings();
  });

  handle(IPC_CHANNELS.settingsPatch, (_e, patch: Partial<settingsModule.AppSettings>) => {
    return settingsModule.patchSettings(patch);
  });

  ipcMain.handle(IPC_CHANNELS.diagnosticsRead, () => {
    const sessionType =
      process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || !!process.env.WAYLAND_DISPLAY
        ? "Wayland"
        : process.env.XDG_SESSION_TYPE?.toLowerCase() === "x11" || !!process.env.DISPLAY
          ? "X11"
          : "Not detected";
    return {
      version: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      architecture: process.arch,
      electron: process.versions.electron ?? "Unknown",
      chromium: process.versions.chrome ?? "Unknown",
      displayServer: sessionType,
      desktopEnvironment:
        process.env.XDG_CURRENT_DESKTOP ?? process.env.XDG_SESSION_DESKTOP ?? "Not detected",
    };
  });

  ipcMain.handle(IPC_CHANNELS.updatesStatus, () => updatesModule.getUpdateStatus());
  handle(IPC_CHANNELS.updatesCheck, () => updatesModule.checkForUpdates());
  handle(IPC_CHANNELS.updatesDownload, () => updatesModule.downloadUpdate());
  handle(IPC_CHANNELS.updatesInstall, async () => {
    if (!currentWindow) throw new Error("No Driftleaf window is available");
    const status = updatesModule.getUpdateStatus();
    if (status.state !== "downloaded" || !status.automaticInstall) {
      throw new Error("No downloaded update is ready to install");
    }
    await prepareWindowClose(currentWindow, async () => { await vaultOpQueue.run(async () => {}); });
    try {
      updatesModule.installUpdate();
    } catch (error) {
      cancelWindowClose(currentWindow);
      throw error;
    }
  });
  handle(IPC_CHANNELS.updatesOpenDownload, () => updatesModule.openUpdateDownload());
}
