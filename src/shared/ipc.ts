// Shared IPC contract between main and renderer. Keep this the single source of truth
// for channel names and payload/result shapes so both sides stay in sync.

export interface AppSettings {
  lastVaultPath: string | null;
  theme: "system" | "light" | "dark";
  editorFontSizePx: number;
  autosaveIntervalMs: number;
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

export interface DriftleafApi {
  vault: {
    pickDirectory(): Promise<string | null>;
    create(rootPath: string, passphrase: string): Promise<void>;
    unlock(rootPath: string, passphrase: string): Promise<void>;
    hasPassphrase(rootPath: string): Promise<boolean>;
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
}

export const IPC_CHANNELS = {
  vaultPickDirectory: "vault:pickDirectory",
  vaultCreate: "vault:create",
  vaultUnlock: "vault:unlock",
  vaultHasPassphrase: "vault:hasPassphrase",
  vaultLock: "vault:lock",
  notesList: "notes:list",
  notesListFolders: "notes:listFolders",
  notesRead: "notes:read",
  notesWrite: "notes:write",
  notesCreate: "notes:create",
  notesRename: "notes:rename",
  notesRemove: "notes:remove",
  foldersCreate: "folders:create",
  foldersRename: "folders:rename",
  foldersDelete: "folders:delete",
  notesMove: "notes:move",
  searchQuery: "search:query",
  settingsRead: "settings:read",
  settingsPatch: "settings:patch",
} as const;
