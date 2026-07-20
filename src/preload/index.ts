import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DriftleafApi } from "../shared/ipc";

const api: DriftleafApi = {
  vault: {
    pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.vaultPickDirectory),
    create: (rootPath, passphrase) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultCreate, rootPath, passphrase),
    unlock: (rootPath, passphrase) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultUnlock, rootPath, passphrase),
    hasPassphrase: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.vaultHasPassphrase, rootPath),
    lock: () => ipcRenderer.invoke(IPC_CHANNELS.vaultLock),
  },
  notes: {
    list: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.notesList, folderPath),
    listFolders: () => ipcRenderer.invoke(IPC_CHANNELS.notesListFolders),
    read: (id) => ipcRenderer.invoke(IPC_CHANNELS.notesRead, id),
    write: (id, content) => ipcRenderer.invoke(IPC_CHANNELS.notesWrite, id, content),
    create: (folderPath, title) => ipcRenderer.invoke(IPC_CHANNELS.notesCreate, folderPath, title),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.notesRename, id, title),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.notesRemove, id),
    move: (id, targetFolder) => ipcRenderer.invoke(IPC_CHANNELS.notesMove, id, targetFolder),
  },
  folders: {
    create: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.foldersCreate, folderPath),
    rename: (oldPath, newPath) => ipcRenderer.invoke(IPC_CHANNELS.foldersRename, oldPath, newPath),
    delete: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.foldersDelete, folderPath),
  },
  search: {
    query: (text) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, text),
  },
  settings: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.settingsRead),
    patch: (update) => ipcRenderer.invoke(IPC_CHANNELS.settingsPatch, update),
  },
};

contextBridge.exposeInMainWorld("driftleaf", api);
