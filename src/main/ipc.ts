import { ipcMain, dialog, type BrowserWindow } from "electron";
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
    if (code === "ENOENT") return new Error("A vault file is missing. The vault folder may have moved.");
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
  session.vault = vault;
  session.index = searchModule.openIndex();
  await searchModule.buildIndex(session.index, vault);
  const sessionDuration = Date.now() - sessionStart;
  if (process.env.DEBUG_SEARCH) {
    console.log(`[ipc] openSession (unlock + index build): ${sessionDuration}ms`);
  }
}

export function registerIpcHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.vaultPickDirectory, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.vaultPickImportFiles, async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Markdown and zip archives", extensions: ["md", "zip"] },
        { name: "Markdown", extensions: ["md"] },
        { name: "Zip archive", extensions: ["zip"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  });

  handle(IPC_CHANNELS.vaultCreate, async (_e, rootPath: string, passphrase: string) => {
    const vault = await vaultModule.createVault(rootPath, passphrase);
    await openSession(vault);
    await settingsModule.patchSettings({ lastVaultPath: rootPath });
  });

  handle(IPC_CHANNELS.vaultUnlock, async (_e, rootPath: string, passphrase: string) => {
    const { vault, recovery } = await vaultModule.unlockVault(rootPath, passphrase);
    await openSession(vault);
    await settingsModule.patchSettings({ lastVaultPath: rootPath });
    return recovery;
  });

  ipcMain.handle(IPC_CHANNELS.vaultHasPassphrase, (_e, rootPath: string) => {
    return vaultModule.vaultHasPassphrase(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.vaultLock, async () => {
    session.vault = null;
    session.index = null;
  });

  ipcMain.handle(IPC_CHANNELS.notesList, (_e, folderPath?: string) => {
    return vaultModule.listNotes(requireVault(), folderPath);
  });

  ipcMain.handle(IPC_CHANNELS.notesListFolders, () => {
    return vaultModule.listFolders(requireVault());
  });

  ipcMain.handle(IPC_CHANNELS.notesRead, (_e, id: string) => {
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
    await vaultModule.createFolder(requireVault(), folderPath);
  });

  handle(IPC_CHANNELS.notesImport, async (_e, filePaths: string[], targetFolder: string) => {
    const vault = requireVault();
    const result = await vaultModule.importFiles(vault, filePaths, targetFolder);
    if (session.index) {
      for (const meta of result.imported) {
        const content = await vaultModule.readNote(vault, meta.id);
        searchModule.reindexNote(session.index, meta, content);
      }
    }
    return { imported: result.imported.length, skipped: result.skipped };
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

  handle(
    IPC_CHANNELS.foldersRename,
    async (_e, oldPath: string, newPath: string) => {
      const vault = requireVault();
      await vaultModule.renameFolder(vault, oldPath, newPath);
      if (session.index) await searchModule.buildIndex(session.index, vault);
    },
  );

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

  ipcMain.handle(IPC_CHANNELS.settingsRead, () => {
    return settingsModule.readSettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_e, patch: Partial<settingsModule.AppSettings>) => {
    return settingsModule.patchSettings(patch);
  });
}
