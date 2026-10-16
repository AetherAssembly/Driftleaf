// Thin Electron IPC adapter: every command delegates to the injected, Electron-independent
// DriftleafService (src/main/service.ts), which already owns session state, the save/lock
// op queue, and error translation. What's left here is genuinely Electron/window-bound and
// can't live in the service: opening a sandboxed BrowserWindow to run an extension, the
// extension-context map keyed by webContents id (which only makes sense against a live
// webContents sender), and the update-install close/relaunch handshake.
// See docs/ELECTRON_MIGRATION_REVIEW.md, Phase 1.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { cancelWindowClose, prepareWindowClose } from "./window-lifecycle";
import { IPC_CHANNELS, type ExtensionPermission } from "../shared/ipc";
import * as vaultModule from "./vault";
import type { Vault } from "./vault";
import * as searchModule from "./search";
import * as updatesModule from "./updates";
import type { DriftleafService } from "./service";

let currentWindow: BrowserWindow | null = null;
let handlersRegistered = false;
const extensionContexts = new Map<number, { extensionId: string; vault: Vault }>();
const extensionWindows = new Map<number, BrowserWindow>();

export function closeExtensionWindows(): void {
  for (const win of extensionWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  extensionContexts.clear();
  extensionWindows.clear();
}

function requireExtensionContext(
  service: DriftleafService,
  event: IpcMainInvokeEvent,
  permission: ExtensionPermission,
): { extensionId: string; vault: Vault } {
  const context = extensionContexts.get(event.sender.id);
  if (!context || context.vault !== service.__internal.currentVault()) {
    throw new Error("This window is not an active Driftleaf extension");
  }
  const extension = vaultModule.getExtension(context.vault, context.extensionId);
  if (!extension) throw new Error("This extension was removed");
  if (!extension.permissions.includes(permission)) {
    throw new Error(`This extension has not been granted ${permission.replace("_", " ")} access`);
  }
  return context;
}

async function runExtensionWindow(service: DriftleafService, id: string): Promise<void> {
  const vault = service.__internal.requireVault();
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
}

// Safe to call every time a window is (re)created — e.g. on macOS, clicking the dock icon
// after closing the only window calls this again. ipcMain.handle() throws synchronously on
// a duplicate registration for the same channel, so the actual handler wiring below only
// runs once; later calls just repoint window-anchored commands at the new window via the
// host's getWindow() callback, which always reads this module-level currentWindow.
export function registerIpcHandlers(win: BrowserWindow, service: DriftleafService): void {
  currentWindow = win;
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(IPC_CHANNELS.vaultPickDirectory, () => service.vault.pickDirectory());
  ipcMain.handle(IPC_CHANNELS.vaultPickBackupDirectory, () => service.vault.pickBackupDirectory());
  ipcMain.handle(IPC_CHANNELS.vaultPickBackupDestination, () =>
    service.vault.pickBackupDestination(),
  );
  ipcMain.handle(IPC_CHANNELS.vaultCreateBackup, (_e, destinationPath: string) =>
    service.vault.createBackup(destinationPath),
  );
  ipcMain.handle(IPC_CHANNELS.vaultPickImportFiles, () => service.vault.pickImportFiles());
  ipcMain.handle(
    IPC_CHANNELS.vaultCreate,
    (_e, rootPath: string, passphrase: string, template: Parameters<DriftleafService["vault"]["create"]>[2]) =>
      service.vault.create(rootPath, passphrase, template),
  );
  ipcMain.handle(IPC_CHANNELS.vaultUnlock, (_e, rootPath: string, passphrase: string) =>
    service.vault.unlock(rootPath, passphrase),
  );
  ipcMain.handle(IPC_CHANNELS.vaultHasPassphrase, (_e, rootPath: string) =>
    service.vault.hasPassphrase(rootPath),
  );
  ipcMain.handle(IPC_CHANNELS.vaultHealthCheck, () => service.vault.healthCheck());
  ipcMain.handle(IPC_CHANNELS.vaultVerifyBackup, (_e, rootPath: string, passphrase: string) =>
    service.vault.verifyBackup(rootPath, passphrase),
  );
  ipcMain.handle(IPC_CHANNELS.vaultLock, () => service.vault.lock());

  ipcMain.handle(IPC_CHANNELS.notesList, (_e, folderPath?: string) => service.notes.list(folderPath));
  ipcMain.handle(IPC_CHANNELS.notesListFolders, () => service.notes.listFolders());
  ipcMain.handle(IPC_CHANNELS.notesRead, (_e, id: string) => service.notes.read(id));
  ipcMain.handle(IPC_CHANNELS.notesWrite, (_e, id: string, content: string) =>
    service.notes.write(id, content),
  );
  ipcMain.handle(IPC_CHANNELS.notesCreate, (_e, folderPath: string, title: string) =>
    service.notes.create(folderPath, title),
  );
  ipcMain.handle(IPC_CHANNELS.notesRename, (_e, id: string, title: string) =>
    service.notes.rename(id, title),
  );
  ipcMain.handle(IPC_CHANNELS.notesRemove, (_e, id: string) => service.notes.remove(id));
  ipcMain.handle(IPC_CHANNELS.notesMove, (_e, id: string, targetFolder: string) =>
    service.notes.move(id, targetFolder),
  );
  ipcMain.handle(IPC_CHANNELS.notesImport, (_e, filePaths: string[], targetFolder: string) =>
    service.notes.import(filePaths, targetFolder),
  );
  ipcMain.handle(IPC_CHANNELS.notesGraph, () => service.notes.graph());

  ipcMain.handle(IPC_CHANNELS.databasesList, (_e, folderPath?: string) =>
    service.databases.list(folderPath),
  );
  ipcMain.handle(IPC_CHANNELS.databasesRead, (_e, id: string) => service.databases.read(id));
  ipcMain.handle(IPC_CHANNELS.databasesCreate, (_e, title: string, folderPath: string) =>
    service.databases.create(title, folderPath),
  );
  ipcMain.handle(IPC_CHANNELS.databasesRename, (_e, id: string, title: string) =>
    service.databases.rename(id, title),
  );
  ipcMain.handle(
    IPC_CHANNELS.databasesUpdate,
    (
      _e,
      id: string,
      properties: Parameters<DriftleafService["databases"]["update"]>[1],
      rows: Parameters<DriftleafService["databases"]["update"]>[2],
      views: Parameters<DriftleafService["databases"]["update"]>[3],
      activeViewId: Parameters<DriftleafService["databases"]["update"]>[4],
    ) => service.databases.update(id, properties, rows, views, activeViewId),
  );
  ipcMain.handle(IPC_CHANNELS.databasesCreateRow, (_e, id: string) => service.databases.createRow(id));
  ipcMain.handle(IPC_CHANNELS.databasesDeleteRow, (_e, id: string, rowId: string) =>
    service.databases.deleteRow(id, rowId),
  );
  ipcMain.handle(
    IPC_CHANNELS.databasesExport,
    (_e, id: string, format: Parameters<DriftleafService["databases"]["export"]>[1]) =>
      service.databases.export(id, format),
  );
  ipcMain.handle(IPC_CHANNELS.databasesDelete, (_e, id: string) => service.databases.delete(id));

  ipcMain.handle(IPC_CHANNELS.foldersCreate, (_e, folderPath: string) =>
    service.folders.create(folderPath),
  );
  ipcMain.handle(IPC_CHANNELS.foldersRename, (_e, oldPath: string, newPath: string) =>
    service.folders.rename(oldPath, newPath),
  );
  ipcMain.handle(IPC_CHANNELS.foldersDelete, (_e, folderPath: string) =>
    service.folders.delete(folderPath),
  );

  ipcMain.handle(IPC_CHANNELS.searchQuery, (_e, text: string) => service.search.query(text));

  ipcMain.handle(IPC_CHANNELS.extensionsList, () => service.extensions.list());
  ipcMain.handle(IPC_CHANNELS.extensionsInstall, () => service.extensions.install());
  ipcMain.handle(IPC_CHANNELS.extensionsSamples, () => service.extensions.samples());
  ipcMain.handle(IPC_CHANNELS.extensionsInstallSample, (_e, sampleId: string) =>
    service.extensions.installSample(sampleId),
  );
  ipcMain.handle(IPC_CHANNELS.extensionsCommunity, () => service.extensions.community());
  ipcMain.handle(IPC_CHANNELS.extensionsCommunityPreview, (_e, assetId: number) =>
    service.extensions.previewCommunityExtension(assetId),
  );
  ipcMain.handle(IPC_CHANNELS.extensionsCommunityInstall, (_e, assetId: number) =>
    service.extensions.installCommunityExtension(assetId),
  );
  ipcMain.handle(IPC_CHANNELS.templatesCommunityInstall, (_e, assetId: number) =>
    service.extensions.installCommunityTemplate(assetId),
  );
  ipcMain.handle(
    IPC_CHANNELS.extensionsSetPermissions,
    (_e, id: string, permissions: ExtensionPermission[], databaseIds: string[] = []) =>
      service.extensions.setPermissions(id, permissions, databaseIds),
  );
  ipcMain.handle(IPC_CHANNELS.extensionsRemove, async (_e, id: string) => {
    await service.extensions.remove(id);
    for (const [webContentsId, context] of extensionContexts) {
      if (context.extensionId === id) extensionWindows.get(webContentsId)?.close();
    }
  });

  // Electron-only: opens a sandboxed BrowserWindow for the extension. Shares the service's
  // op queue and error translation via runSerializedCommand instead of duplicating them.
  ipcMain.handle(IPC_CHANNELS.extensionsRun, (_e, id: string) =>
    service.__internal.runSerializedCommand(() => runExtensionWindow(service, id)),
  );

  ipcMain.handle(IPC_CHANNELS.extensionNotesList, (event) =>
    service.__internal.runSerializedCommand(() => {
      const { vault } = requireExtensionContext(service, event, "read_notes");
      return vaultModule.listNotes(vault).map(({ id, title, folderPath, updatedAt }) => ({
        id,
        title,
        folderPath,
        updatedAt,
      }));
    }),
  );

  ipcMain.handle(IPC_CHANNELS.extensionNotesRead, (event, id: string) =>
    service.__internal.runSerializedCommand(() => {
      const { vault } = requireExtensionContext(service, event, "read_notes");
      return vaultModule.readNote(vault, id);
    }),
  );

  ipcMain.handle(IPC_CHANNELS.extensionGraph, (event) =>
    service.__internal.runSerializedCommand(() => {
      const { vault } = requireExtensionContext(service, event, "read_graph");
      const index = service.__internal.currentIndex();
      if (vault !== service.__internal.currentVault() || !index) {
        throw new Error("No vault is unlocked");
      }
      return searchModule.buildNoteGraph(index);
    }),
  );

  ipcMain.handle(IPC_CHANNELS.extensionDatabasesList, (event) =>
    service.__internal.runSerializedCommand(async () => {
      const { vault, extensionId } = requireExtensionContext(service, event, "read_databases");
      const extension = vaultModule.getExtension(vault, extensionId);
      if (!extension) throw new Error("This extension was removed");
      return (await vaultModule.listDatabases(vault)).filter((database) =>
        extension.databaseIds.includes(database.id),
      );
    }),
  );

  ipcMain.handle(IPC_CHANNELS.extensionDatabaseRead, (event, id: string) =>
    service.__internal.runSerializedCommand(async () => {
      const { vault, extensionId } = requireExtensionContext(service, event, "read_databases");
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
            Object.entries(row.values).filter(([propertyId]) => permittedPropertyIds.has(propertyId)),
          ),
        })),
      };
    }),
  );

  ipcMain.handle(IPC_CHANNELS.canvasRead, () => service.canvas.read());
  ipcMain.handle(
    IPC_CHANNELS.canvasUpdate,
    (_e, items: Parameters<DriftleafService["canvas"]["update"]>[0]) =>
      service.canvas.update(items),
  );

  ipcMain.handle(IPC_CHANNELS.settingsRead, () => service.settings.read());
  ipcMain.handle(
    IPC_CHANNELS.settingsPatch,
    (_e, patch: Parameters<DriftleafService["settings"]["patch"]>[0]) =>
      service.settings.patch(patch),
  );

  ipcMain.handle(IPC_CHANNELS.diagnosticsRead, () => service.diagnostics.read());

  ipcMain.handle(IPC_CHANNELS.updatesStatus, () => service.updates.status());
  ipcMain.handle(IPC_CHANNELS.updatesCheck, () => service.updates.check());
  ipcMain.handle(IPC_CHANNELS.updatesDownload, () => service.updates.download());
  ipcMain.handle(IPC_CHANNELS.updatesOpenDownload, () => service.updates.openDownload());

  // Electron-only: installing requires flushing the renderer and draining the service's op
  // queue before the window is allowed to close and electron-updater relaunches the app.
  ipcMain.handle(IPC_CHANNELS.updatesInstall, async () => {
    if (!currentWindow) throw new Error("No Driftleaf window is available");
    const status = updatesModule.getUpdateStatus();
    if (status.state !== "downloaded" || !status.automaticInstall) {
      throw new Error("No downloaded update is ready to install");
    }
    await prepareWindowClose(currentWindow, () =>
      service.__internal.runSerializedCommand(async () => {}),
    );
    try {
      updatesModule.installUpdate();
    } catch (error) {
      cancelWindowClose(currentWindow);
      throw error;
    }
  });
}
