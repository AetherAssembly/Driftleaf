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

async function openSession(vault: Vault): Promise<void> {
  session.vault = vault;
  session.index = searchModule.openIndex();
  await searchModule.buildIndex(session.index, vault);
}

export function registerIpcHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.vaultPickDirectory, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.vaultCreate, async (_e, rootPath: string, passphrase: string) => {
    const vault = await vaultModule.createVault(rootPath, passphrase);
    await openSession(vault);
    await settingsModule.patchSettings({ lastVaultPath: rootPath });
  });

  ipcMain.handle(IPC_CHANNELS.vaultUnlock, async (_e, rootPath: string, passphrase: string) => {
    const vault = await vaultModule.unlockVault(rootPath, passphrase);
    await openSession(vault);
    await settingsModule.patchSettings({ lastVaultPath: rootPath });
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

  ipcMain.handle(IPC_CHANNELS.notesWrite, async (_e, id: string, content: string) => {
    const vault = requireVault();
    await vaultModule.writeNote(vault, id, content);
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) searchModule.reindexNote(session.index, meta, content);
  });

  ipcMain.handle(IPC_CHANNELS.notesCreate, async (_e, folderPath: string, title: string) => {
    const vault = requireVault();
    const meta = await vaultModule.createNote(vault, folderPath, title);
    if (session.index) searchModule.reindexNote(session.index, meta, "");
    return meta;
  });

  ipcMain.handle(IPC_CHANNELS.notesRename, async (_e, id: string, title: string) => {
    const vault = requireVault();
    await vaultModule.renameNote(vault, id, title);
    const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
    if (meta && session.index) {
      const content = await vaultModule.readNote(vault, id);
      searchModule.reindexNote(session.index, meta, content);
    }
  });

  ipcMain.handle(IPC_CHANNELS.notesRemove, async (_e, id: string) => {
    const vault = requireVault();
    await vaultModule.deleteNote(vault, id);
    if (session.index) searchModule.removeFromIndex(session.index, id);
  });

  ipcMain.handle(IPC_CHANNELS.foldersCreate, async (_e, folderPath: string) => {
    await vaultModule.createFolder(requireVault(), folderPath);
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
