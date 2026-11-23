// Electron-independent domain service: owns branch/session state and every command in
// the DriftleafApi contract except extensions.run and the extension-context "read" channels,
// which inherently need a real BrowserWindow/webContents and stay in the Electron adapter
// (src/main/ipc.ts). Desktop-specific capabilities (dialogs, external links, settings
// directory, updater) are injected via ServiceHost (src/main/service-host.ts) instead of
// importing "electron" directly, so this module — and therefore branch/session/save logic —
// can be constructed and exercised in plain Node, with or without Electron running.
// See docs/ELECTRON_MIGRATION_REVIEW.md, Phase 1.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireBranchLock, type BranchLock } from "./branch-lock";
import { SerialQueue } from "../shared/serial-queue";
import type {
  AppDiagnostics,
  AppSettings,
  BranchPersonalization,
  CanvasItem,
  DatabaseExportFormat,
  DatabaseProperty,
  DatabaseRow,
  DatabaseViewDefinition,
  DriftleafApi,
  ExtensionPermission,
  ImportResult,
  TrashItem,
  VaultTemplateId,
} from "../shared/ipc";
import type { ServiceHost } from "./service-host";
import * as vaultModule from "./vault";
import type { Vault } from "./vault";
import * as searchModule from "./search";
import type { SearchIndex } from "./search";
import { exportDatabase } from "./database-export";
import { exportBranchPlaintext } from "./branch-export";
import { downloadCommunityAsset, listCommunityReleases } from "./community-catalog";

interface Session {
  vault: Vault | null;
  index: SearchIndex | null;
  branchLock: BranchLock | null;
  // Incremented every time a vault is successfully opened. Not currently load-bearing for
  // correctness (the serial queue below already totally orders every command against lock),
  // but gives adapters and tests an explicit, inspectable session identity to assert against
  // as more command sources (sidecar, extensions) are added in later phases.
  generation: number;
}

export type DriftleafService = Omit<DriftleafApi, "events" | "extensions" | "updates" | "announcements"> & {
  extensions: Omit<DriftleafApi["extensions"], "run">;
  // Installing an update is window-bound (flush renderer, drain queue, relaunch) and stays
  // a special case in the Electron adapter; see UpdatesHost in service-host.ts.
  updates: Omit<DriftleafApi["updates"], "install">;
  __internal: {
    requireVault(): Vault;
    currentVault(): Vault | null;
    currentIndex(): SearchIndex | null;
    generation(): number;
    // Lets the Electron adapter's own window-bound handlers (extensions.run, extension
    // context reads) share this service's op queue and error translation instead of
    // duplicating them.
    runSerializedCommand<T>(fn: () => Promise<T> | T): Promise<T>;
  };
};

// Translates raw Node fs error codes into messages a user can act on. Thrown errors from a
// command reject the caller's promise with the message intact, so this is the one place
// worth doing the translation rather than in every command.
//
// Deliberately not `err instanceof Error`: the packaged sidecar (and the test harness) load
// this module in its own vm realm, while vault.ts and Node's fs run in the host realm, so
// every error they throw is an instance of a *different* Error constructor. With an
// instanceof check none of them matched: the fs translations below never ran, and every
// message was re-wrapped as String(err), reaching the user as "Error: Incorrect passphrase".
function friendlyError(err: unknown): Error {
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") return new Error("Disk is full. Free up space and try again.");
    if (code === "EACCES" || code === "EPERM") {
      return new Error("Permission denied. Check that Driftleaf can write to this folder.");
    }
    if (code === "ENOENT")
      return new Error("A branch file is missing. The branch folder may have moved.");
    return err as Error;
  }
  return new Error(String(err));
}

export function createDriftleafService(host: ServiceHost): DriftleafService {
  const session: Session = { vault: null, index: null, branchLock: null, generation: 0 };

  // Async vault operations and locking share one queue. Each operation retains the
  // key and index until its file I/O and index maintenance have both finished.
  const vaultOpQueue = new SerialQueue();

  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    return vaultOpQueue.run(fn);
  }

  function requireVault(): Vault {
    if (!session.vault) throw new Error("No branch is unlocked");
    return session.vault;
  }

  // Wraps a command so any thrown fs error is translated before it crosses the host
  // boundary, instead of the caller having to guess what a raw Error.message means.
  function wrapped<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R> | R,
  ): (...args: Args) => Promise<R> {
    return async (...args: Args) => {
      try {
        return await fn(...args);
      } catch (err) {
        throw friendlyError(err);
      }
    };
  }

  // Serializes the entire operation, including reads and index maintenance, and resolves
  // requireVault() (inside fn) only once this call's turn in the queue arrives — never before.
  function serializedCommand<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R> | R,
  ): (...args: Args) => Promise<R> {
    return wrapped((...args: Args) => serialized(async () => fn(...args)));
  }

  // The renderer is only supposed to import files it selected via vault.pickImportFiles's
  // native OS dialog, never an arbitrary path it constructs itself — this tracks the most
  // recent picker result as a single-use allowlist so notes.import can enforce that even if
  // the renderer-side code is compromised (XSS, a malicious dependency) and calls the command
  // directly with attacker-chosen paths.
  let lastPickedImportPaths: Set<string> | null = null;
  let lastPickedBackupPath: string | null = null;
  let lastPickedBackupDestination: string | null = null;

  async function openSession(vault: Vault): Promise<void> {
    const sessionStart = Date.now();
    // Build the index against a fresh, not-yet-committed index handle first — session.vault/
    // session.index are only assigned once indexing actually succeeds. Assigning them up front
    // meant a failed unlock (buildIndex throwing) still left the service holding a "live"
    // vault + key internally even though the caller was told unlock failed.
    const index = searchModule.openIndex();
    try {
      await searchModule.buildIndex(index, vault);
    } catch (err) {
      index.db.close();
      vault.key.fill(0);
      throw err;
    }
    session.vault?.key.fill(0);
    session.index?.db.close();
    host.onSessionReset();
    session.vault = vault;
    session.index = index;
    session.generation += 1;
    const sessionDuration = Date.now() - sessionStart;
    if (process.env.DEBUG_SEARCH) {
      console.log(`[service] openSession (unlock + index build): ${sessionDuration}ms`);
    }
  }

  // Called inside the operation queue, before unlock's reconciliation can write.
  async function startSession<T>(
    rootPath: string,
    create: boolean,
    load: (canonicalPath: string) => Promise<{ vault: Vault; result: T }>,
  ): Promise<T> {
    if (session.vault) throw new Error("Lock the current branch before opening another one");
    const branchLock = await acquireBranchLock(rootPath, create);
    let vault: Vault | undefined;
    try {
      const loaded = await load(branchLock.rootPath);
      vault = loaded.vault;
      await host.settings.patchSettings({ lastVaultPath: branchLock.rootPath });
      await openSession(vault);
      session.branchLock = branchLock;
      return loaded.result;
    } catch (error) {
      vault?.key.fill(0);
      branchLock.release();
      throw error;
    }
  }

  function lockSession(): Promise<void> {
    return serialized(async () => {
      host.onSessionReset();
      session.vault?.key.fill(0);
      try {
        session.index?.db.close();
      } finally {
        session.vault = null;
        session.index = null;
        session.branchLock?.release();
        session.branchLock = null;
      }
    });
  }

  const service: DriftleafService = {
    vault: {
      pickDirectory: () => host.pickDirectory(),
      pickBackupDirectory: async () => {
        lastPickedBackupPath = null;
        const picked = await host.pickBackupDirectory();
        lastPickedBackupPath = picked;
        return picked;
      },
      pickBackupDestination: async () => {
        lastPickedBackupDestination = null;
        const picked = await host.pickBackupDestination();
        lastPickedBackupDestination = picked;
        return picked;
      },
      createBackup: serializedCommand(async (destinationPath: string) => {
        const selectedDestination = lastPickedBackupDestination;
        lastPickedBackupDestination = null;
        if (!selectedDestination || destinationPath !== selectedDestination) {
          throw new Error("Choose the backup destination using the folder picker first");
        }
        const vault = requireVault();
        return vaultModule.createVaultBackup(vault, selectedDestination);
      }),
      pickImportFiles: async () => {
        const picked = await host.pickImportFiles();
        lastPickedImportPaths = picked ? new Set(picked) : null;
        return picked;
      },
      create: serializedCommand((rootPath: string, passphrase: string, template: VaultTemplateId) =>
        startSession(rootPath, true, async (canonicalPath) => ({
          vault: await vaultModule.createVault(canonicalPath, passphrase, template),
          result: undefined,
        })),
      ),
      unlock: serializedCommand((rootPath: string, passphrase: string) =>
        startSession(rootPath, false, async (canonicalPath) => {
          const { vault, recovery } = await vaultModule.unlockVault(canonicalPath, passphrase);
          return { vault, result: recovery };
        }),
      ),
      hasPassphrase: serializedCommand((rootPath: string) => vaultModule.vaultHasPassphrase(rootPath)),
      healthCheck: serializedCommand(async () => {
        const report = await vaultModule.inspectVault(requireVault());
        if (session.index) {
          const indexedCount = (
            session.index.db.prepare("SELECT COUNT(*) AS count FROM notes_fts").get() as {
              count: number;
            }
          ).count;
          const noteCount = vaultModule.listNotes(requireVault()).length;
          report.checks.push({
            name: "Search index",
            status: indexedCount === noteCount ? "ok" : "warning",
            details:
              indexedCount === noteCount
                ? `${indexedCount} note(s) are indexed for search.`
                : `Search contains ${indexedCount} of ${noteCount} indexed note(s).`,
          });
        }
        return report;
      }),
      verifyBackup: serializedCommand((rootPath: string, passphrase: string) => {
        if (!lastPickedBackupPath || rootPath !== lastPickedBackupPath) {
          throw new Error("Choose the backup folder using the folder picker before verifying it");
        }
        return vaultModule.verifyVaultBackup(rootPath, passphrase);
      }),
      changePassphrase: serializedCommand(
        async (currentPassphrase: string, newPassphrase: string) => {
          await vaultModule.changeVaultPassphrase(
            requireVault(),
            currentPassphrase,
            newPassphrase,
          );
        },
      ),
      exportPlaintext: serializedCommand(async () => {
        const vault = requireVault();
        const destination = await host.pickBackupDestination();
        if (!destination) return null;
        return exportBranchPlaintext(vault, destination);
      }),
      lock: () => lockSession(),
    },
    personalization: {
      read: serializedCommand(() => vaultModule.readPersonalization(requireVault())),
      update: serializedCommand((value: BranchPersonalization) =>
        vaultModule.updatePersonalization(requireVault(), value),
      ),
    },
    trash: {
      list: serializedCommand(() => vaultModule.listTrash(requireVault())),
      restore: serializedCommand(async (kind: TrashItem["kind"], id: string) => {
        if (kind !== "note" && kind !== "database") throw new Error("Unknown Trash item type");
        const vault = requireVault();
        const restored = await vaultModule.restoreTrashItem(vault, kind, id);
        if (!session.index) return;
        for (const item of restored) {
          if (item.kind !== "note") continue;
          // The restore itself has already been written. A note that cannot be read back
          // is still restored (and reported by the health check); it just is not searchable.
          try {
            const content = await vaultModule.readNote(vault, item.meta.id);
            searchModule.reindexNote(session.index, item.meta, content);
          } catch {
            /* left unindexed */
          }
        }
      }),
      purge: serializedCommand(async (kind: TrashItem["kind"], id: string) => {
        if (kind !== "note" && kind !== "database") throw new Error("Unknown Trash item type");
        await vaultModule.purgeTrashItem(requireVault(), kind, id);
      }),
      empty: serializedCommand(() => vaultModule.emptyTrash(requireVault())),
    },
    attachments: {
      add: serializedCommand(async (name: string, mimeType: string, dataBase64: string) => {
        const vault = requireVault();
        if (typeof dataBase64 !== "string") throw new Error("Invalid attachment data");
        // Reject oversized input before decoding it into a second, larger buffer.
        if (dataBase64.length > Math.ceil(vaultModule.ATTACHMENT_MAX_BYTES / 3) * 4 + 4) {
          throw new Error(
            `Attachments can be at most ${Math.floor(vaultModule.ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB`,
          );
        }
        return vaultModule.addAttachment(vault, name, mimeType, Buffer.from(dataBase64, "base64"));
      }),
      read: serializedCommand(async (id: string) => {
        const { meta, data } = await vaultModule.readAttachment(requireVault(), id);
        return { meta, dataBase64: data.toString("base64") };
      }),
      list: serializedCommand(() => vaultModule.listAttachments(requireVault())),
      listUsage: serializedCommand(() => vaultModule.listAttachmentUsage(requireVault())),
      remove: serializedCommand(async (id: string) => {
        await vaultModule.removeAttachment(requireVault(), id);
      }),
      saveCopy: serializedCommand(async (id: string) => {
        const { meta, data } = await vaultModule.readAttachment(requireVault(), id);
        const destinationPath = await host.pickSaveDestination(`Save ${meta.name}`, meta.name);
        if (!destinationPath) return false;
        const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;
        try {
          await writeFile(temporaryPath, data, { flag: "wx" });
          await rename(temporaryPath, destinationPath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          throw error;
        }
        return true;
      }),
      unused: serializedCommand(async () => {
        const unused = await vaultModule.findUnusedAttachments(requireVault());
        return { count: unused.length, bytes: unused.reduce((sum, item) => sum + item.size, 0) };
      }),
      removeUnused: serializedCommand(async () => {
        const { removed, bytes } = await vaultModule.removeUnusedAttachments(requireVault());
        return { count: removed, bytes };
      }),
    },
    notes: {
      list: (folderPath?: string) => Promise.resolve(vaultModule.listNotes(requireVault(), folderPath)),
      listFolders: () => Promise.resolve(vaultModule.listFolders(requireVault())),
      read: serializedCommand((id: string) => vaultModule.readNote(requireVault(), id)),
      write: serializedCommand(async (id: string, content: string) => {
        const vault = requireVault();
        await vaultModule.writeNote(vault, id, content);
        const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
        if (meta && session.index) searchModule.reindexNote(session.index, meta, content);
      }),
      create: serializedCommand(async (folderPath: string, title: string) => {
        const vault = requireVault();
        const meta = await vaultModule.createNote(vault, folderPath, title);
        if (session.index) searchModule.reindexNote(session.index, meta, "");
        return meta;
      }),
      rename: serializedCommand(async (id: string, title: string) => {
        const vault = requireVault();
        await vaultModule.renameNote(vault, id, title);
        const meta = vaultModule.listNotes(vault).find((n) => n.id === id);
        if (meta && session.index) {
          const content = await vaultModule.readNote(vault, id);
          searchModule.reindexNote(session.index, meta, content);
        }
      }),
      remove: serializedCommand(async (id: string) => {
        const vault = requireVault();
        await vaultModule.deleteNote(vault, id);
        if (session.index) searchModule.removeFromIndex(session.index, id);
      }),
      move: serializedCommand(async (id: string, targetFolder: string) => {
        const vault = requireVault();
        const meta = await vaultModule.moveNote(vault, id, targetFolder);
        if (session.index) {
          const content = await vaultModule.readNote(vault, id);
          searchModule.reindexNote(session.index, meta, content);
        }
        return meta;
      }),
      import: serializedCommand(async (filePaths: string[], targetFolder: string) => {
        const vault = requireVault();
        // Only import paths that actually came back from this session's most recent
        // vault.pickImportFiles call — a caller invoking this command directly with paths it
        // made up itself (bypassing the OS file picker) shouldn't be able to pull arbitrary
        // files off disk into the vault. Single-use: consumed immediately so it can't be
        // replayed against a later, unrelated import call.
        const allowed = lastPickedImportPaths;
        lastPickedImportPaths = null;
        const safePaths = filePaths.filter((p) => allowed?.has(p));
        const rejectedPaths = filePaths.filter((p) => !allowed?.has(p));

        const result = await vaultModule.importFiles(vault, safePaths, targetFolder);
        if (session.index) {
          for (const meta of result.imported) {
            const content = await vaultModule.readNote(vault, meta.id);
            searchModule.reindexNote(session.index, meta, content);
          }
        }
        const skipped = [
          ...result.skipped,
          ...rejectedPaths.map((p) => `${path.basename(p)} (not selected via the file picker)`),
        ];
        const importResult: ImportResult = {
          imported: result.imported.length,
          importedDatabases: result.importedDatabases.length,
          skipped,
        };
        return importResult;
      }),
      graph: serializedCommand(() => {
        if (!session.index) throw new Error("No branch is unlocked");
        return searchModule.buildNoteGraph(session.index);
      }),
    },
    databases: {
      list: (folderPath?: string) =>
        Promise.resolve(vaultModule.listDatabases(requireVault(), folderPath)),
      read: serializedCommand((id: string) => vaultModule.readDatabase(requireVault(), id)),
      create: serializedCommand((title: string, folderPath: string) => {
        const vault = requireVault();
        return vaultModule.createDatabase(
          vault,
          title,
          folderPath,
          [{ id: randomUUID(), name: "Title", type: "title" }],
          [],
        );
      }),
      rename: serializedCommand((id: string, title: string) => {
        const vault = requireVault();
        return vaultModule.renameDatabase(vault, id, title);
      }),
      update: serializedCommand(
        async (
          id: string,
          properties: DatabaseProperty[],
          rows: DatabaseRow[],
          views?: DatabaseViewDefinition[],
          activeViewId?: string,
        ) => {
          const vault = requireVault();
          await vaultModule.updateDatabase(vault, id, properties, rows, views, activeViewId);
        },
      ),
      createRow: serializedCommand((id: string) => {
        const vault = requireVault();
        return vaultModule.createDatabaseRow(vault, id);
      }),
      deleteRow: serializedCommand(async (id: string, rowId: string) => {
        const vault = requireVault();
        await vaultModule.deleteDatabaseRow(vault, id, rowId);
      }),
      export: serializedCommand(async (id: string, format: DatabaseExportFormat) => {
        if (format !== "csv" && format !== "json") {
          throw new Error("Unsupported database export format");
        }
        const { title, content } = await exportDatabase(requireVault(), id, format);
        const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 100);
        const destinationPath = await host.pickExportDestination(
          title,
          `${safeTitle || "database"}.${format}`,
          format,
        );
        if (!destinationPath) return false;
        const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;
        try {
          await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
          await rename(temporaryPath, destinationPath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          throw error;
        }
        return true;
      }),
      delete: serializedCommand(async (id: string) => {
        const vault = requireVault();
        await vaultModule.deleteDatabase(vault, id);
      }),
    },
    folders: {
      create: serializedCommand(async (folderPath: string) => {
        const vault = requireVault();
        await vaultModule.createFolder(vault, folderPath);
      }),
      rename: serializedCommand(async (oldPath: string, newPath: string) => {
        const vault = requireVault();
        await vaultModule.renameFolder(vault, oldPath, newPath);
        if (session.index) await searchModule.buildIndex(session.index, vault);
      }),
      delete: serializedCommand(async (folderPath: string) => {
        const vault = requireVault();
        const deletedIds = await vaultModule.deleteFolder(vault, folderPath);
        if (session.index) {
          deletedIds.forEach((id) => searchModule.removeFromIndex(session.index!, id));
        }
        return deletedIds;
      }),
    },
    search: {
      query: (text: string) => {
        if (!session.index) return Promise.resolve([]);
        return Promise.resolve(searchModule.search(session.index, text));
      },
    },
    extensions: {
      list: serializedCommand(() => vaultModule.listExtensions(requireVault())),
      install: serializedCommand(async () => {
        const vault = requireVault();
        const picked = await host.pickExtensionFile();
        if (!picked) return null;
        if (path.extname(picked.path).toLowerCase() !== ".js") {
          throw new Error("Choose a JavaScript (.js) extension file");
        }
        const source = await readUtf8Extension(picked.path);
        return vaultModule.installExtension(vault, picked.name, source);
      }),
      samples: () => Promise.resolve(vaultModule.listExtensionSamples()),
      installSample: serializedCommand((sampleId: string) => {
        const vault = requireVault();
        return vaultModule.installExtensionSample(vault, sampleId);
      }),
      community: serializedCommand(() => listCommunityReleases()),
      previewCommunityExtension: serializedCommand(async (assetId: number) => {
        const { bytes } = await downloadCommunityAsset(assetId, "extension");
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("The extension release asset is not valid UTF-8 JavaScript");
        }
      }),
      installCommunityExtension: serializedCommand(async (assetId: number) => {
        const vault = requireVault();
        const { item, bytes } = await downloadCommunityAsset(assetId, "extension");
        let source: string;
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("The extension release asset is not valid UTF-8 JavaScript");
        }
        return vaultModule.installExtension(vault, item.name, source);
      }),
      installCommunityTemplate: serializedCommand(async (assetId: number) => {
        const vault = requireVault();
        const { item, bytes } = await downloadCommunityAsset(assetId, "template");
        const result = await vaultModule.importTemplateArchive(vault, bytes, item.name);
        if (session.index) {
          for (const meta of result.imported) {
            const content = await vaultModule.readNote(vault, meta.id);
            searchModule.reindexNote(session.index, meta, content);
          }
        }
        const importResult: ImportResult = {
          imported: result.imported.length,
          importedDatabases: result.importedDatabases.length,
          skipped: result.skipped,
        };
        return importResult;
      }),
      setPermissions: serializedCommand(
        async (id: string, permissions: ExtensionPermission[], databaseIds: string[] = []) => {
          const vault = requireVault();
          await vaultModule.setExtensionPermissions(vault, id, permissions, databaseIds);
        },
      ),
      remove: serializedCommand(async (id: string) => {
        const vault = requireVault();
        await vaultModule.removeExtension(vault, id);
      }),
    },
    canvas: {
      read: serializedCommand(() => vaultModule.readCanvas(requireVault())),
      update: serializedCommand(async (items: CanvasItem[]) => {
        const vault = requireVault();
        await vaultModule.updateCanvas(vault, items);
      }),
    },
    settings: {
      read: () => host.settings.readSettings(),
      patch: wrapped((patch: Partial<AppSettings>) => host.settings.patchSettings(patch)),
    },
    diagnostics: {
      read: () => Promise.resolve(buildDiagnostics(host)),
    },
    updates: {
      status: () => Promise.resolve(host.updates.status()),
      check: wrapped(() => host.updates.check()),
      download: wrapped(() => host.updates.download()),
      openDownload: wrapped(() => host.updates.openDownload()),
    },
    __internal: {
      requireVault,
      currentVault: () => session.vault,
      currentIndex: () => session.index,
      generation: () => session.generation,
      runSerializedCommand: <T>(fn: () => Promise<T> | T): Promise<T> =>
        serialized(async () => fn()).catch((err: unknown) => {
          throw friendlyError(err);
        }),
    },
  };

  return service;
}

async function readUtf8Extension(filePath: string): Promise<string> {
  const fileInfo = await stat(filePath);
  if (fileInfo.size > 512 * 1024) throw new Error("Extension files must be smaller than 512 KB");
  const sourceBytes = await readFile(filePath);
  if (sourceBytes.length > 512 * 1024) {
    throw new Error("Extension files must be smaller than 512 KB");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    throw new Error("Extension files must contain valid UTF-8 JavaScript");
  }
}

function buildDiagnostics(host: ServiceHost): AppDiagnostics {
  const extras = host.diagnosticsExtras();
  const sessionType =
    process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || !!process.env.WAYLAND_DISPLAY
      ? "Wayland"
      : process.env.XDG_SESSION_TYPE?.toLowerCase() === "x11" || !!process.env.DISPLAY
        ? "X11"
        : "Not detected";
  return {
    version: extras.version,
    platform: process.platform,
    osRelease: os.release(),
    architecture: process.arch,
    runtime: extras.runtime,
    displayServer: sessionType,
    desktopEnvironment:
      process.env.XDG_CURRENT_DESKTOP ?? process.env.XDG_SESSION_DESKTOP ?? "Not detected",
  };
}
