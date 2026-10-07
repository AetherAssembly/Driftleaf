import { app, ipcMain, dialog, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import * as vaultModule from "./vault";
import type { Vault } from "./vault";
import * as searchModule from "./search";
import type { SearchIndex } from "./search";
import * as settingsModule from "./settings";

interface Session {
  vault: Vault | null;
  index: SearchIndex | null;
}

const session: Session = { vault: null, index: null };

function requireVault(): Vault {
  if (!session.vault) throw new Error("No vault is unlocked");
  return session.vault;
}

// Serializes vault-mutating operations so two concurrent IPC calls (e.g. an in-flight
// autosave racing a delete, or two rapid folder operations) can't interleave their
// manifest read-modify-write and lose or resurrect a change. Read-only operations
// (list/read/search) don't need to join this queue.
let vaultOpQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = vaultOpQueue.catch(() => {}).then(fn);
  vaultOpQueue = run.catch(() => {});
  return run;
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
      return await fn(event, ...args);
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
    throw err;
  }
  session.vault = vault;
  session.index = index;
  const sessionDuration = Date.now() - sessionStart;
  if (process.env.DEBUG_SEARCH) {
    console.log(`[ipc] openSession (unlock + index build): ${sessionDuration}ms`);
  }
}

let currentWindow: BrowserWindow | null = null;
let handlersRegistered = false;

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
    return serialized(() => vaultModule.createVaultBackup(vault, selectedDestination));
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

  ipcMain.handle(IPC_CHANNELS.vaultLock, async () => {
    // Zero the raw AES key before dropping the reference — GC timing isn't a scrub
    // guarantee, and this app's entire pitch is "lock this vault."
    session.vault?.key.fill(0);
    session.index?.db.close();
    session.vault = null;
    session.index = null;
  });

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
    await serialized(() => vaultModule.writeNote(vault, id, content));
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) searchModule.reindexNote(session.index, meta, content);
  });

  handle(IPC_CHANNELS.notesCreate, async (_e, folderPath: string, title: string) => {
    const vault = requireVault();
    const meta = await serialized(() => vaultModule.createNote(vault, folderPath, title));
    if (session.index) searchModule.reindexNote(session.index, meta, "");
    return meta;
  });

  handle(IPC_CHANNELS.notesRename, async (_e, id: string, title: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.renameNote(vault, id, title));
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) {
      const content = await vaultModule.readNote(vault, id);
      searchModule.reindexNote(session.index, meta, content);
    }
  });

  handle(IPC_CHANNELS.notesRemove, async (_e, id: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.deleteNote(vault, id));
    if (session.index) searchModule.removeFromIndex(session.index, id);
  });

  handle(IPC_CHANNELS.foldersCreate, async (_e, folderPath: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.createFolder(vault, folderPath));
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

    const result = await serialized(() => vaultModule.importFiles(vault, safePaths, targetFolder));
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
    return serialized(() =>
      vaultModule.createDatabase(vault, title, folderPath, [
        { id: randomUUID(), name: "Title", type: "title" },
      ], []),
    );
  });

  handle(
    IPC_CHANNELS.databasesUpdate,
    async (
      _e,
      id: string,
      properties: Parameters<typeof vaultModule.updateDatabase>[2],
      rows: Parameters<typeof vaultModule.updateDatabase>[3],
    ) => {
      const vault = requireVault();
      await serialized(() => vaultModule.updateDatabase(vault, id, properties, rows));
    },
  );

  handle(IPC_CHANNELS.databasesCreateRow, async (_e, id: string) => {
    const vault = requireVault();
    return serialized(() => vaultModule.createDatabaseRow(vault, id));
  });

  handle(IPC_CHANNELS.databasesDeleteRow, async (_e, id: string, rowId: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.deleteDatabaseRow(vault, id, rowId));
  });

  handle(IPC_CHANNELS.databasesDelete, async (_e, id: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.deleteDatabase(vault, id));
  });

  handle(IPC_CHANNELS.notesMove, async (_e, id: string, targetFolder: string) => {
    const vault = requireVault();
    const meta = await serialized(() => vaultModule.moveNote(vault, id, targetFolder));
    if (session.index) {
      const content = await vaultModule.readNote(vault, id);
      searchModule.reindexNote(session.index, meta, content);
    }
    return meta;
  });

  handle(IPC_CHANNELS.foldersRename, async (_e, oldPath: string, newPath: string) => {
    const vault = requireVault();
    await serialized(() => vaultModule.renameFolder(vault, oldPath, newPath));
    if (session.index) await searchModule.buildIndex(session.index, vault);
  });

  handle(IPC_CHANNELS.foldersDelete, async (_e, folderPath: string) => {
    const vault = requireVault();
    const deletedIds = await serialized(() => vaultModule.deleteFolder(vault, folderPath));
    if (session.index) {
      deletedIds.forEach((id) => searchModule.removeFromIndex(session.index!, id));
    }
    return deletedIds;
  });

  ipcMain.handle(IPC_CHANNELS.searchQuery, (_e, text: string) => {
    if (!session.index) return [];
    return searchModule.search(session.index, text);
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
}
