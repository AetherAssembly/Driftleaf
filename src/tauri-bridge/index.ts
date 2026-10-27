// Tauri implementation of the same DriftleafApi contract Electron's preload
// (src/preload/index.ts) provides, so src/renderer/** — the "unchanged React interface" the
// migration plan calls for — never has to know which shell it's running under. See
// docs/ELECTRON_MIGRATION_REVIEW.md, Phase 2.
//
// Rust owns every OS dialog directly (pick_directory, pick_backup_directory,
// pick_backup_destination, pick_import_files, and the file pickers inside install_extension/
// export_database), so those bypass the sidecar entirely. The commands whose security check
// is coupled to a prior pick (createBackup, verifyBackup, notes.import) also go through
// dedicated Rust commands that validate the single-use picked-path allowlist on the Rust side
// before forwarding to the sidecar's "trusted" variants — see the "Trusted commands" comment
// in sidecar/index.mjs for why that check couldn't just stay in service.ts for this shell.
// Everything else that has real session/data semantics goes through the generic sidecar_call,
// which forwards to the Node domain service (src/main/service.ts, unmodified) over a private
// stdin/stdout pipe. The updater has its own native commands (updates.rs) independent of the
// sidecar: signed auto-install on eligible builds, plus plain GitHub release discovery and a
// manual "open the release page" command on every other build (docs/UPDATES.md).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AnnouncementItem, DriftleafApi } from "../shared/ipc";

// announcement_status/announcement_check always return an object, with every field null until
// the first successful fetch — collapse that "nothing yet" shape to `null` for callers.
function normalizeAnnouncement(raw: Partial<AnnouncementItem> | null): AnnouncementItem | null {
  return raw && raw.guid != null && raw.title != null && raw.checkedAt != null
    ? {
        guid: raw.guid,
        title: raw.title,
        link: raw.link ?? null,
        pubDate: raw.pubDate ?? null,
        description: raw.description ?? null,
        checkedAt: raw.checkedAt,
      }
    : null;
}

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

export const tauriDriftleafApi: DriftleafApi = {
  vault: {
    pickDirectory: () => invoke<string | null>("pick_directory"),
    pickBackupDirectory: () => invoke<string | null>("pick_backup_directory"),
    pickBackupDestination: () => invoke<string | null>("pick_backup_destination"),
    createBackup: (destinationPath) => invoke<string>("create_backup", { destinationPath }),
    pickImportFiles: () => invoke<string[] | null>("pick_import_files"),
    create: (rootPath, passphrase, template) =>
      call("vault.create", rootPath, passphrase, template),
    unlock: (rootPath, passphrase) => call("vault.unlock", rootPath, passphrase),
    hasPassphrase: (rootPath) => call("vault.hasPassphrase", rootPath),
    healthCheck: () => call("vault.healthCheck"),
    verifyBackup: (rootPath, passphrase) => invoke("verify_backup", { rootPath, passphrase }),
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
    import: (filePaths, targetFolder) => invoke("import_files", { filePaths, targetFolder }),
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
    export: (id, format) => invoke<boolean>("export_database", { id, format }),
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
    install: () => invoke("install_extension"),
    samples: () => call("extensions.samples"),
    installSample: (sampleId) => call("extensions.installSample", sampleId),
    community: () => call("extensions.community"),
    previewCommunityExtension: (assetId) => call("extensions.previewCommunityExtension", assetId),
    installCommunityExtension: (assetId) => call("extensions.installCommunityExtension", assetId),
    installCommunityTemplate: (assetId) => call("extensions.installCommunityTemplate", assetId),
    setPermissions: (id, permissions, databaseIds) =>
      call("extensions.setPermissions", id, permissions, databaseIds),
    run: (id) => invoke("run_extension", { id }),
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
    status: () => invoke("update_status"),
    check: () => invoke("update_check"),
    download: () => invoke("update_download"),
    install: () => invoke("update_install"),
    openDownload: () => invoke("update_open_download"),
  },
  announcements: {
    status: () =>
      invoke<Partial<AnnouncementItem> | null>("announcement_status").then(normalizeAnnouncement),
    check: () =>
      invoke<Partial<AnnouncementItem> | null>("announcement_check").then(normalizeAnnouncement),
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
    // Rust registers the OS-level global shortcut (main.rs) and emits this event to the
    // main window on trigger, the same Ctrl/Cmd+Shift+N behavior the Electron build's
    // globalShortcut registration provided.
    onQuickCapture: (callback) => {
      const unlistenPromise = listen("driftleaf:quickCapture", () => callback());
      return () => void unlistenPromise.then((unlisten) => unlisten());
    },
    onUpdateStatus: (callback) => {
      const unlisten = listen<import("../shared/ipc").UpdateStatus>(
        "driftleaf:updateStatus",
        (event) => callback(event.payload),
      );
      return () => void unlisten.then((fn) => fn());
    },
    onAnnouncementStatus: (callback) => {
      const unlisten = listen<Partial<AnnouncementItem>>(
        "driftleaf:announcementStatus",
        (event) => callback(normalizeAnnouncement(event.payload)),
      );
      return () => void unlisten.then((fn) => fn());
    },
  },
};
