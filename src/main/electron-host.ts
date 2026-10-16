// The real ServiceHost: wires the Electron-independent service (src/main/service.ts) to
// actual Electron dialogs, the settings directory, external links, and the updater. This
// is the only place in the migration path that should need to change when Electron is
// replaced — the service and its command logic do not import "electron" at all.
import { app, dialog, shell, type BrowserWindow } from "electron";
import os from "node:os";
import path from "node:path";
import type { DatabaseExportFormat } from "../shared/ipc";
import * as updatesModule from "./updates";
import { createSettingsStore } from "./settings-store";
import type { ServiceHost } from "./service-host";

export interface ElectronHostOptions {
  getWindow(): BrowserWindow | null;
  // Called when the active session is about to change; closes anything window-scoped
  // (extension windows) that was tied to the outgoing vault.
  onSessionReset(): void;
}

export function createElectronHost(options: ElectronHostOptions): ServiceHost {
  const settings = createSettingsStore(app.getPath("userData"));

  function requireWindow(): BrowserWindow {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) throw new Error("No Driftleaf window is available");
    return win;
  }

  return {
    settings,
    onSessionReset: options.onSessionReset,
    updates: {
      status: () => updatesModule.getUpdateStatus(),
      check: () => updatesModule.checkForUpdates(),
      download: () => updatesModule.downloadUpdate(),
      openDownload: () => updatesModule.openUpdateDownload(),
    },
    async pickDirectory() {
      const win = options.getWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
    async pickBackupDirectory() {
      const win = options.getWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "Choose a Driftleaf backup folder",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
    async pickBackupDestination() {
      const win = options.getWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "Choose where to save the backup",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
    async pickImportFiles() {
      const win = options.getWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Notes, tables, and zip archives", extensions: ["md", "csv", "json", "zip"] },
          { name: "Markdown", extensions: ["md"] },
          { name: "Tables (CSV / JSON)", extensions: ["csv", "json"] },
          { name: "Zip archive", extensions: ["zip"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths;
    },
    async pickExtensionFile() {
      const win = requireWindow();
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        title: "Choose a JavaScript extension",
        filters: [{ name: "JavaScript extension", extensions: ["js"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const filePath = result.filePaths[0];
      return { path: filePath, name: path.basename(filePath, path.extname(filePath)) };
    },
    async pickExportDestination(title: string, suggestedFileName: string, format: DatabaseExportFormat) {
      const win = requireWindow();
      const result = await dialog.showSaveDialog(win, {
        title: `Export ${title}`,
        defaultPath: path.join(os.homedir(), suggestedFileName),
        filters: [
          {
            name: format === "csv" ? "CSV spreadsheet" : "Driftleaf database JSON",
            extensions: [format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return null;
      return result.filePath;
    },
    async openExternal(url: string) {
      await shell.openExternal(url);
    },
    diagnosticsExtras() {
      return {
        version: app.getVersion(),
        electron: process.versions.electron ?? "Unknown",
        chromium: process.versions.chrome ?? "Unknown",
      };
    },
  };
}
