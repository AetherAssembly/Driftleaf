// Shared IPC contract between main and renderer. Keep this the single source of truth
// for channel names and payload/result shapes so both sides stay in sync.

export interface AppSettings {
  lastVaultPath: string | null;
  theme: Theme;
  editorFontSizePx: number;
  autosaveIntervalMs: number;
  checkUpdatesAutomatically: boolean;
}

export type Theme =
  | "system"
  | "light"
  | "dark"
  | "aquatic"
  | "mossy"
  | "sunset"
  | "space"
  | "cherry"
  | "arctic"
  | "amber";

export type VaultTemplateId = "blank" | "general" | "productivity" | "journal" | "study";

export type DatabasePropertyType =
  | "title"
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi_select"
  | "url"
  | "email"
  | "phone"
  | "status"
  | "people"
  | "files"
  | "formula"
  | "relation"
  | "rollup"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by";

export interface DatabaseProperty {
  id: string;
  name: string;
  type: DatabasePropertyType;
  formula?: string;
  relationDatabaseId?: string;
  rollupRelationPropertyId?: string;
  rollupTargetPropertyId?: string;
  rollupFunction?: "count" | "sum" | "average" | "min" | "max" | "show_original";
  options?: string[];
}

export type DatabaseCellValue = string | number | boolean | string[] | null;

export interface DatabaseRow {
  id: string;
  values: Record<string, DatabaseCellValue>;
  createdAt: number;
  updatedAt: number;
}

export type DatabaseViewType =
  | "table"
  | "board"
  | "calendar"
  | "gallery"
  | "list"
  | "timeline";

export interface DatabaseFilter {
  propertyId: string;
  operator: "contains" | "equals" | "is_empty" | "is_not_empty";
  value: string;
}

export interface DatabaseViewDefinition {
  id: string;
  name: string;
  type: DatabaseViewType;
  sortPropertyId?: string;
  sortDirection?: "ascending" | "descending";
  groupPropertyId?: string;
  datePropertyId?: string;
  endDatePropertyId?: string;
  filters?: DatabaseFilter[];
}

export interface DatabaseMeta {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: number;
}

export interface DatabaseData {
  meta: DatabaseMeta;
  properties: DatabaseProperty[];
  rows: DatabaseRow[];
  views?: DatabaseViewDefinition[];
  activeViewId?: string;
}

export type DatabaseExportFormat = "csv" | "json";

export interface AppDiagnostics {
  version: string;
  platform: string;
  osRelease: string;
  architecture: string;
  runtime: string;
  displayServer: string;
  desktopEnvironment: string;
}

export type UpdateStatusKind =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface UpdateStatus {
  state: UpdateStatusKind;
  currentVersion: string;
  availableVersion: string | null;
  downloadUrl: string | null;
  checkedAt: number | null;
  message: string;
  automaticInstall: boolean;
}

export interface VaultHealthCheck {
  name: string;
  status: "ok" | "warning" | "error";
  details: string;
}

export interface VaultHealthReport {
  checkedAt: number;
  checks: VaultHealthCheck[];
}

export interface NoteMeta {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: number;
}

export interface SearchResult {
  id: string;
  title: string;
  folderPath: string;
  snippet: string;
}

export interface NoteGraph {
  nodes: Pick<NoteMeta, "id" | "title" | "folderPath">[];
  edges: { sourceId: string; targetId: string }[];
  unlinkedMentions: { sourceId: string; targetId: string }[];
}

export type ExtensionPermission = "read_notes" | "read_graph" | "read_databases";

export interface ExtensionSummary {
  id: string;
  name: string;
  permissions: ExtensionPermission[];
  databaseIds: string[];
  sampleId?: string;
}

export interface ExtensionSample {
  id: string;
  name: string;
  description: string;
}

export interface CommunityReleaseItem {
  assetId: number;
  kind: "extension" | "template";
  name: string;
  version: string;
  description: string;
  repository: "Driftleaf-Extensions" | "Driftleaf-Templates";
  size: number;
}

export interface CommunityCatalog {
  items: CommunityReleaseItem[];
  errors: string[];
}

export type CanvasItemKind = "note" | "database";

export interface CanvasItem {
  id: string;
  kind: CanvasItemKind;
  targetId: string;
  x: number;
  y: number;
}

// Reported after every unlock: what reconcileVault() found and self-healed by cross-checking
// the manifest against the .enc files actually on disk (see src/main/vault.ts).
export interface VaultRecoveryReport {
  renamedLegacy: string[];
  removedDangling: string[];
  recoveredOrphans: string[];
}

export interface ImportResult {
  imported: number;
  importedDatabases: number;
  skipped: string[];
}

export interface DriftleafApi {
  vault: {
    pickDirectory(): Promise<string | null>;
    pickBackupDirectory(): Promise<string | null>;
    pickBackupDestination(): Promise<string | null>;
    createBackup(destinationPath: string): Promise<string>;
    pickImportFiles(): Promise<string[] | null>;
    create(rootPath: string, passphrase: string, template: VaultTemplateId): Promise<void>;
    unlock(rootPath: string, passphrase: string): Promise<VaultRecoveryReport>;
    hasPassphrase(rootPath: string): Promise<boolean>;
    healthCheck(): Promise<VaultHealthReport>;
    verifyBackup(rootPath: string, passphrase: string): Promise<VaultHealthReport>;
    lock(): Promise<void>;
  };
  notes: {
    list(folderPath?: string): Promise<NoteMeta[]>;
    listFolders(): Promise<string[]>;
    read(id: string): Promise<string>;
    write(id: string, content: string): Promise<void>;
    create(folderPath: string, title: string): Promise<NoteMeta>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    move(id: string, targetFolder: string): Promise<NoteMeta>;
    import(filePaths: string[], targetFolder: string): Promise<ImportResult>;
    graph(): Promise<NoteGraph>;
  };
  databases: {
    list(folderPath?: string): Promise<DatabaseMeta[]>;
    read(id: string): Promise<DatabaseData>;
    create(title: string, folderPath: string): Promise<DatabaseMeta>;
    rename(id: string, title: string): Promise<DatabaseMeta>;
    update(
      id: string,
      properties: DatabaseProperty[],
      rows: DatabaseRow[],
      views?: DatabaseViewDefinition[],
      activeViewId?: string,
    ): Promise<void>;
    createRow(databaseId: string): Promise<DatabaseRow>;
    deleteRow(databaseId: string, rowId: string): Promise<void>;
    export(id: string, format: DatabaseExportFormat): Promise<boolean>;
    delete(id: string): Promise<void>;
  };
  folders: {
    create(folderPath: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    delete(folderPath: string): Promise<string[]>;
  };
  search: {
    query(text: string): Promise<SearchResult[]>;
  };
  extensions: {
    list(): Promise<ExtensionSummary[]>;
    install(): Promise<ExtensionSummary | null>;
    samples(): Promise<ExtensionSample[]>;
    installSample(sampleId: string): Promise<ExtensionSummary>;
    community(): Promise<CommunityCatalog>;
    previewCommunityExtension(assetId: number): Promise<string>;
    installCommunityExtension(assetId: number): Promise<ExtensionSummary>;
    installCommunityTemplate(assetId: number): Promise<ImportResult>;
    setPermissions(
      id: string,
      permissions: ExtensionPermission[],
      databaseIds?: string[],
    ): Promise<void>;
    run(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  canvas: {
    read(): Promise<CanvasItem[]>;
    update(items: CanvasItem[]): Promise<void>;
  };
  settings: {
    read(): Promise<AppSettings>;
    patch(update: Partial<AppSettings>): Promise<AppSettings>;
  };
  diagnostics: {
    read(): Promise<AppDiagnostics>;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    install(): Promise<void>;
    openDownload(): Promise<void>;
  };
  events: {
    // Lifecycle listeners return unsubscribe functions.
    onCloseCancelled(callback: () => void): () => void;
    onBeforeClose(callback: () => Promise<void>): () => void;
    onQuickCapture(callback: () => void): () => void;
    onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  };
}

// Main -> renderer push events (as opposed to IPC_CHANNELS, which are renderer -> main
// invoke/handle calls). Kept separate since these use ipcRenderer.on, not .invoke.
export const RENDERER_EVENTS = {
  beforeClose: "event:beforeClose",
  closeCancelled: "event:closeCancelled",
  quickCapture: "event:quickCapture",
  updateStatus: "event:updateStatus",
} as const;

export const IPC_CHANNELS = {
  flushResult: "lifecycle:flushResult",
  vaultPickDirectory: "vault:pickDirectory",
  vaultPickBackupDirectory: "vault:pickBackupDirectory",
  vaultPickBackupDestination: "vault:pickBackupDestination",
  vaultCreateBackup: "vault:createBackup",
  vaultPickImportFiles: "vault:pickImportFiles",
  vaultCreate: "vault:create",
  vaultUnlock: "vault:unlock",
  vaultHasPassphrase: "vault:hasPassphrase",
  vaultHealthCheck: "vault:healthCheck",
  vaultVerifyBackup: "vault:verifyBackup",
  vaultLock: "vault:lock",
  notesList: "notes:list",
  notesListFolders: "notes:listFolders",
  notesRead: "notes:read",
  notesWrite: "notes:write",
  notesCreate: "notes:create",
  notesRename: "notes:rename",
  notesRemove: "notes:remove",
  notesImport: "notes:import",
  notesGraph: "notes:graph",
  databasesList: "databases:list",
  databasesRead: "databases:read",
  databasesCreate: "databases:create",
  databasesRename: "databases:rename",
  databasesUpdate: "databases:update",
  databasesCreateRow: "databases:createRow",
  databasesDeleteRow: "databases:deleteRow",
  databasesExport: "databases:export",
  databasesDelete: "databases:delete",
  foldersCreate: "folders:create",
  foldersRename: "folders:rename",
  foldersDelete: "folders:delete",
  notesMove: "notes:move",
  searchQuery: "search:query",
  settingsRead: "settings:read",
  settingsPatch: "settings:patch",
  diagnosticsRead: "diagnostics:read",
  updatesStatus: "updates:status",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesInstall: "updates:install",
  updatesOpenDownload: "updates:openDownload",
  extensionsList: "extensions:list",
  extensionsInstall: "extensions:install",
  extensionsSetPermissions: "extensions:setPermissions",
  extensionsRun: "extensions:run",
  extensionsRemove: "extensions:remove",
  extensionNotesList: "extension:notes:list",
  extensionNotesRead: "extension:notes:read",
  extensionGraph: "extension:graph",
  extensionsSamples: "extensions:samples",
  extensionsInstallSample: "extensions:installSample",
  extensionsCommunity: "extensions:community",
  extensionsCommunityPreview: "extensions:communityPreview",
  extensionsCommunityInstall: "extensions:communityInstall",
  templatesCommunityInstall: "templates:communityInstall",
  extensionDatabasesList: "extension:databases:list",
  extensionDatabaseRead: "extension:databases:read",
  canvasRead: "canvas:read",
  canvasUpdate: "canvas:update",
} as const;
