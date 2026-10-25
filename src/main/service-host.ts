// The seam between the Electron-independent domain service (src/main/service.ts) and
// whatever desktop shell hosts it. Electron's implementation lives in
// src/main/electron-host.ts; a test/in-process implementation can satisfy the same
// interface without importing "electron" at all, which is what lets the same command
// contract be exercised with and without Electron (see docs/ELECTRON_MIGRATION_REVIEW.md,
// Phase 1).
import type { DatabaseExportFormat, UpdateStatus } from "../shared/ipc";
import type { SettingsStore } from "./settings-store";

// Installing an update is inherently window-bound (it must flush the renderer, drain the
// op queue, then close/relaunch) — it stays a special case in the Electron adapter
// (src/main/ipc.ts), not a host-delegated command, the same way extensions.run does.
export interface UpdatesHost {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  openDownload(): Promise<void>;
}

export interface DiagnosticsExtras {
  version: string;
  runtime: string;
}

export interface PickedExtensionFile {
  path: string;
  name: string;
}

export interface ServiceHost {
  settings: SettingsStore;
  updates: UpdatesHost;
  pickDirectory(): Promise<string | null>;
  pickBackupDirectory(): Promise<string | null>;
  pickBackupDestination(): Promise<string | null>;
  pickImportFiles(): Promise<string[] | null>;
  pickExtensionFile(): Promise<PickedExtensionFile | null>;
  pickExportDestination(
    title: string,
    suggestedFileName: string,
    format: DatabaseExportFormat,
  ): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  diagnosticsExtras(): DiagnosticsExtras;
  // Called whenever the active session is about to be replaced or cleared (a new vault is
  // about to become current, or lock is clearing it). Lets the host release anything it owns
  // that was scoped to the outgoing session — Electron's implementation closes extension
  // windows, since their IPC context is only valid for the vault they were opened against.
  onSessionReset(): void;
}
