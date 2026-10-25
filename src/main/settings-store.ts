// Pure settings persistence: no Electron import, so this can run inside the
// Electron-independent service (src/main/service.ts) and in Node-only tests.
// Electron-bound code injects a directory (e.g. app.getPath("userData")); see
// src/main/electron-host.ts.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "../shared/ipc";

export type { AppSettings } from "../shared/ipc";

const DEFAULTS: AppSettings = {
  lastVaultPath: null,
  theme: "system",
  editorFontSizePx: 15,
  autosaveIntervalMs: 500,
  checkUpdatesAutomatically: true,
};

// Mirrors the bounds SettingsModal.tsx's number inputs enforce in the UI — a direct
// settings.patch() call bypassing the UI shouldn't be able to persist a value the UI
// itself would never let a user set (e.g. a zero/negative autosave interval, which
// would fire the debounced save on essentially every keystroke).
const FONT_SIZE_RANGE = { min: 12, max: 24 };
const AUTOSAVE_RANGE = { min: 200, max: 5000 };

function clamp(value: number, range: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export interface SettingsStore {
  readSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export function createSettingsStore(baseDir: string): SettingsStore {
  function settingsFilePath(): string {
    return path.join(baseDir, "settings.json");
  }

  async function readSettings(): Promise<AppSettings> {
    try {
      const raw = await readFile(settingsFilePath(), "utf-8");
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  // Serializes patch calls so two near-simultaneous settings.patch() calls (e.g. a theme
  // toggle racing the lastVaultPath update that fires on every unlock) do a proper
  // read-modify-write instead of a lost update, where whichever write lands last silently
  // discards the other's change.
  let patchQueue: Promise<AppSettings> = Promise.resolve(DEFAULTS);

  function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const run = patchQueue.catch(() => DEFAULTS).then(() => applyPatch(patch));
    patchQueue = run;
    return run;
  }

  async function applyPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await readSettings();
    const next = { ...current, ...patch };
    next.editorFontSizePx = clamp(
      next.editorFontSizePx,
      FONT_SIZE_RANGE,
      DEFAULTS.editorFontSizePx,
    );
    next.autosaveIntervalMs = clamp(
      next.autosaveIntervalMs,
      AUTOSAVE_RANGE,
      DEFAULTS.autosaveIntervalMs,
    );
    if (typeof next.checkUpdatesAutomatically !== "boolean") {
      next.checkUpdatesAutomatically = DEFAULTS.checkUpdatesAutomatically;
    }

    const filePath = settingsFilePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    // Same atomic temp-file+rename pattern as the vault's writes (see vault.ts) — a process
    // kill mid-write can no longer leave settings.json truncated/unparseable.
    const tmpPath = path.join(path.dirname(filePath), `.settings.json.tmp-${randomUUID()}`);
    await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
    await rename(tmpPath, filePath);
    return next;
  }

  return { readSettings, patchSettings };
}
