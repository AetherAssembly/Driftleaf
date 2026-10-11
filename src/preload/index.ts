import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  RENDERER_EVENTS,
  type DriftleafApi,
  type UpdateStatus,
} from "../shared/ipc";

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
    graph: () => ipcRenderer.invoke(IPC_CHANNELS.notesGraph),
  },
  databases: {
    list: (folderPath) => ipcRenderer.invoke(IPC_CHANNELS.databasesList, folderPath),
    read: (id) => ipcRenderer.invoke(IPC_CHANNELS.databasesRead, id),
    create: (title, folderPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.databasesCreate, title, folderPath),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.databasesRename, id, title),
    update: (id, properties, rows, views, activeViewId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.databasesUpdate,
        id,
        properties,
        rows,
        views,
        activeViewId,
      ),
    createRow: (databaseId) => ipcRenderer.invoke(IPC_CHANNELS.databasesCreateRow, databaseId),
    deleteRow: (databaseId, rowId) =>
      ipcRenderer.invoke(IPC_CHANNELS.databasesDeleteRow, databaseId, rowId),
    export: (id, format) => ipcRenderer.invoke(IPC_CHANNELS.databasesExport, id, format),
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
  extensions: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.extensionsList),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.extensionsInstall),
    samples: () => ipcRenderer.invoke(IPC_CHANNELS.extensionsSamples),
    installSample: (sampleId) =>
      ipcRenderer.invoke(IPC_CHANNELS.extensionsInstallSample, sampleId),
    community: () => ipcRenderer.invoke(IPC_CHANNELS.extensionsCommunity),
    previewCommunityExtension: (assetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.extensionsCommunityPreview, assetId),
    installCommunityExtension: (assetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.extensionsCommunityInstall, assetId),
    installCommunityTemplate: (assetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.templatesCommunityInstall, assetId),
    setPermissions: (id, permissions, databaseIds) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.extensionsSetPermissions,
        id,
        permissions,
        databaseIds,
      ),
    run: (id) => ipcRenderer.invoke(IPC_CHANNELS.extensionsRun, id),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.extensionsRemove, id),
  },
  canvas: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.canvasRead),
    update: (items) => ipcRenderer.invoke(IPC_CHANNELS.canvasUpdate, items),
  },
  settings: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.settingsRead),
    patch: (update) => ipcRenderer.invoke(IPC_CHANNELS.settingsPatch, update),
  },
  diagnostics: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsRead),
  },
  updates: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.updatesStatus),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updatesDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
    openDownload: () => ipcRenderer.invoke(IPC_CHANNELS.updatesOpenDownload),
  },
  events: {
    onQuickCapture: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(RENDERER_EVENTS.quickCapture, listener);
      return () => ipcRenderer.removeListener(RENDERER_EVENTS.quickCapture, listener);
    },
    onUpdateStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, updateStatus: UpdateStatus) =>
        callback(updateStatus);
      ipcRenderer.on(RENDERER_EVENTS.updateStatus, listener);
      return () => ipcRenderer.removeListener(RENDERER_EVENTS.updateStatus, listener);
    },
  },
};

if (process.argv.includes("--driftleaf-extension-window")) {
  contextBridge.exposeInMainWorld("driftleafExtension", {
    listNotes: () => ipcRenderer.invoke(IPC_CHANNELS.extensionNotesList),
    readNote: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.extensionNotesRead, id),
    graph: () => ipcRenderer.invoke(IPC_CHANNELS.extensionGraph),
    listDatabases: () => ipcRenderer.invoke(IPC_CHANNELS.extensionDatabasesList),
    readDatabase: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.extensionDatabaseRead, id),
  });
} else {
  contextBridge.exposeInMainWorld("driftleaf", api);
}
