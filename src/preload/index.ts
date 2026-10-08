import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, RENDERER_EVENTS, type DriftleafApi } from "../shared/ipc";

const api: DriftleafApi = {
  vault: {
    pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.vaultPickDirectory),
    pickBackupDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.vaultPickBackupDirectory),
    pickBackupDestination: () =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultPickBackupDestination),
    createBackup: (destinationPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultCreateBackup, destinationPath),
    pickImportFiles: () => ipcRenderer.invoke(IPC_CHANNELS.vaultPickImportFiles),
    create: (rootPath, passphrase, template) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultCreate, rootPath, passphrase, template),
    unlock: (rootPath, passphrase) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultUnlock, rootPath, passphrase),
    hasPassphrase: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.vaultHasPassphrase, rootPath),
    healthCheck: () => ipcRenderer.invoke(IPC_CHANNELS.vaultHealthCheck),
    verifyBackup: (rootPath, passphrase) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultVerifyBackup, rootPath, passphrase),
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
    import: (filePaths, targetFolder) =>
      ipcRenderer.invoke(IPC_CHANNELS.notesImport, filePaths, targetFolder),
  },
  databases: {
    list: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.databasesList, folderPath),
    read: (id) => ipcRenderer.invoke(IPC_CHANNELS.databasesRead, id),
    create: (title, folderPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.databasesCreate, title, folderPath),
    update: (id, properties, rows) =>
      ipcRenderer.invoke(IPC_CHANNELS.databasesUpdate, id, properties, rows),
    createRow: (databaseId) => ipcRenderer.invoke(IPC_CHANNELS.databasesCreateRow, databaseId),
    deleteRow: (databaseId, rowId) =>
      ipcRenderer.invoke(IPC_CHANNELS.databasesDeleteRow, databaseId, rowId),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.databasesDelete, id),
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
  diagnostics: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsRead),
  },
  events: {
    onQuickCapture: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(RENDERER_EVENTS.quickCapture, listener);
      return () => ipcRenderer.removeListener(RENDERER_EVENTS.quickCapture, listener);
    },
  },
};

contextBridge.exposeInMainWorld("driftleaf", api);
