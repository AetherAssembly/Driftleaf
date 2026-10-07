// Shared IPC contract between main and renderer. Keep this the single source of truth
// for channel names and payload/result shapes so both sides stay in sync.

export interface AppSettings {
  lastVaultPath: string | null;
  theme: "system" | "light" | "dark";
  editorFontSizePx: number;
  autosaveIntervalMs: number;
}

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
}

export interface AppDiagnostics {
  version: string;
  platform: string;
  osRelease: string;
  architecture: string;
  electron: string;
  chromium: string;
  displayServer: string;
  desktopEnvironment: string;
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
  };
  databases: {
    list(folderPath?: string): Promise<DatabaseMeta[]>;
    read(id: string): Promise<DatabaseData>;
    update(id: string, properties: DatabaseProperty[], rows: DatabaseRow[]): Promise<void>;
    createRow(databaseId: string): Promise<DatabaseRow>;
    deleteRow(databaseId: string, rowId: string): Promise<void>;
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
  settings: {
    read(): Promise<AppSettings>;
    patch(update: Partial<AppSettings>): Promise<AppSettings>;
  };
  diagnostics: {
    read(): Promise<AppDiagnostics>;
  };
  events: {
    // Fired by the global quick-capture hotkey (main/index.ts). Returns an unsubscribe fn.
    onQuickCapture(callback: () => void): () => void;
  };
}

// Main -> renderer push events (as opposed to IPC_CHANNELS, which are renderer -> main
// invoke/handle calls). Kept separate since these use ipcRenderer.on, not .invoke.
export const RENDERER_EVENTS = {
  quickCapture: "event:quickCapture",
} as const;

export const IPC_CHANNELS = {
  vaultPickDirectory: "vault:pickDirectory",
  vaultPickBackupDirectory: "vault:pickBackupDirectory",
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
  databasesList: "databases:list",
  databasesRead: "databases:read",
  databasesUpdate: "databases:update",
  databasesCreateRow: "databases:createRow",
  databasesDeleteRow: "databases:deleteRow",
  databasesDelete: "databases:delete",
  foldersCreate: "folders:create",
  foldersRename: "folders:rename",
  foldersDelete: "folders:delete",
  notesMove: "notes:move",
  searchQuery: "search:query",
  settingsRead: "settings:read",
  settingsPatch: "settings:patch",
  diagnosticsRead: "diagnostics:read",
} as const;
