// Tauri implementation of the same DriftleafApi contract Electron's preload
// (src/preload/index.ts) provides, so src/renderer/** — the "unchanged React interface" the
// migration plan calls for — never has to know which shell it's running under. See
// docs/ELECTRON_MIGRATION_REVIEW.md, Phase 2.
//
// Rust owns every OS dialog directly (pick_directory), so only that one command bypasses the
// sidecar. Everything else that has real session/data semantics goes through sidecar_call,
// which forwards to the Node domain service (src/main/service.ts, unmodified) over a private
// stdin/stdout pipe. Commands not needed for this first slice's edit-and-close workflow throw
// a clear "not yet available" error instead of silently doing nothing — see the Phase 2
// section of docs/TAURI_MIGRATION.md for exactly what's wired versus stubbed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DriftleafApi } from "../shared/ipc";

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  // invoke() JSON-serializes this call to cross into Rust, and JSON.stringify turns
  // `undefined` *array elements* into `null` (unlike object properties, which it omits).
  // DriftleafApi's optional parameters are always trailing, so an omitted argument (e.g.
  // notes.list() with no folderPath) arrives on the sidecar as `null` instead of `undefined`
  // — and vault.ts's `folderPath === undefined` checks then treat that as "filter to the
  // folder literally named null", silently returning nothing instead of everything. Trim
  // trailing undefineds here so an omitted argument reaches the sidecar as an omitted
  // argument, matching how a plain JS call (and the Electron preload) behaves.
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  return invoke<T>("sidecar_call", { method, args });
}

function notSupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} is not yet available in this Tauri preview build`));
}

export const tauriDriftleafApi: DriftleafApi = {
  vault: {
    pickDirectory: () => invoke<string | null>("pick_directory"),
    pickBackupDirectory: notSupported("vault.pickBackupDirectory"),
    pickBackupDestination: notSupported("vault.pickBackupDestination"),
    createBackup: notSupported("vault.createBackup"),
    pickImportFiles: notSupported("vault.pickImportFiles"),
    create: (rootPath, passphrase, template) => call("vault.create", rootPath, passphrase, template),
    unlock: (rootPath, passphrase) => call("vault.unlock", rootPath, passphrase),
    hasPassphrase: (rootPath) => call("vault.hasPassphrase", rootPath),
    healthCheck: () => call("vault.healthCheck"),
    verifyBackup: notSupported("vault.verifyBackup"),
    lock: () => call("vault.lock"),
  },
  notes: {
    list: (folderPath) => call("notes.list", folderPath),
    listFolders: () => call("notes.listFolders"),
    read: (id) => call("notes.read", id),
    write: (id, content) => call("notes.write", id, content),
    create: (folderPath, title) => call("notes.create", folderPath, title),
    rename: (id, title) => call("notes.rename", id, title),
    remove: (id) => call("notes.remove", id),
    move: (id, targetFolder) => call("notes.move", id, targetFolder),
    import: notSupported("notes.import"),
    graph: () => call("notes.graph"),
  },
  databases: {
    list: (folderPath) => call("databases.list", folderPath),
    read: (id) => call("databases.read", id),
    create: (title, folderPath) => call("databases.create", title, folderPath),
    rename: (id, title) => call("databases.rename", id, title),
    update: (id, properties, rows, views, activeViewId) =>
      call("databases.update", id, properties, rows, views, activeViewId),
    createRow: (databaseId) => call("databases.createRow", databaseId),
    deleteRow: (databaseId, rowId) => call("databases.deleteRow", databaseId, rowId),
    // databases.export needs a native save-file dialog on the Rust side (like
    // vault.createBackup/notes.import, it's picker-coupled), not wired yet.
    export: notSupported("databases.export"),
    delete: (id) => call("databases.delete", id),
  },
  folders: {
    create: (folderPath) => call("folders.create", folderPath),
    rename: (oldPath, newPath) => call("folders.rename", oldPath, newPath),
    delete: (folderPath) => call("folders.delete", folderPath),
  },
  search: {
    query: (text) => call("search.query", text),
  },
  extensions: {
    list: () => call("extensions.list"),
    // extensions.install needs a native file-picker dialog on the Rust side, not wired yet.
    install: notSupported("extensions.install"),
    samples: () => call("extensions.samples"),
    installSample: (sampleId) => call("extensions.installSample", sampleId),
    community: () => call("extensions.community"),
    previewCommunityExtension: (assetId) => call("extensions.previewCommunityExtension", assetId),
    installCommunityExtension: (assetId) => call("extensions.installCommunityExtension", assetId),
    installCommunityTemplate: (assetId) => call("extensions.installCommunityTemplate", assetId),
    setPermissions: (id, permissions, databaseIds) =>
      call("extensions.setPermissions", id, permissions, databaseIds),
    // extensions.run opens a sandboxed BrowserWindow-equivalent; Tauri has no extension
    // window support yet (Phase 3 territory).
    run: notSupported("extensions.run"),
    remove: (id) => call("extensions.remove", id),
  },
  canvas: {
    read: () => call("canvas.read"),
    update: (items) => call("canvas.update", items),
  },
  settings: {
    read: () => call("settings.read"),
    patch: (update) => call("settings.patch", update),
  },
  diagnostics: {
    read: () => call("diagnostics.read"),
  },
  updates: {
    status: () => call("updates.status"),
    check: notSupported("updates.check"),
    download: notSupported("updates.download"),
    install: notSupported("updates.install"),
    openDownload: notSupported("updates.openDownload"),
  },
  events: {
    onCloseCancelled: (callback) => {
      const unlistenPromise = listen("driftleaf:closeCancelled", () => callback());
      return () => void unlistenPromise.then((unlisten) => unlisten());
    },
    onBeforeClose: (callback) => {
      const unlistenPromise = listen<number>("driftleaf:beforeClose", (event) => {
        void callback().then(
          () => invoke("flush_result", { id: event.payload, error: null }),
          (error: unknown) =>
            invoke("flush_result", {
              id: event.payload,
              error: error instanceof Error ? error.message : "Could not save edits",
            }),
        );
      });
      return () => void unlistenPromise.then((unlisten) => unlisten());
    },
    // The global quick-capture shortcut and the updater are both out of scope for this first
    // slice (window/OS-shortcut and updater work land in later Tauri phases) — these report
    // "never fires" rather than throwing, since callers only ever register a listener and
    // expect an unsubscribe function back, not a result they await.
    onQuickCapture: () => () => {},
    onUpdateStatus: () => () => {},
  },
};
