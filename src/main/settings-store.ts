// Pure settings persistence: no Electron import, so this can run inside the
// Electron-independent service (src/main/service.ts) and in Node-only tests.
// Electron-bound code injects a directory (e.g. app.getPath("userData")); see
// src/main/electron-host.ts.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { AUTO_LOCK_MINUTES_OPTIONS, type AppSettings } from "../shared/ipc";
import { validateAccentColor, validateCustomCss } from "../shared/theme-customization";

export type { AppSettings } from "../shared/ipc";

const DEFAULTS: AppSettings = {
  lastVaultPath: null,
  theme: "system",
  accentColor: null,
  customCss: "",
  editorFontSizePx: 15,
  autosaveIntervalMs: 500,
  typewriterScrolling: false,
  checkUpdatesAutomatically: true,
  autoLockMinutes: 0,
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
      const settings = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
      if (typeof settings.typewriterScrolling !== "boolean") {
        settings.typewriterScrolling = DEFAULTS.typewriterScrolling;
      }
      try {
        settings.accentColor = validateAccentColor(settings.accentColor);
      } catch {
        settings.accentColor = DEFAULTS.accentColor;
      }
      try {
        settings.customCss = validateCustomCss(settings.customCss);
      } catch {
        settings.customCss = DEFAULTS.customCss;
      }
      return settings;
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
    next.accentColor = validateAccentColor(next.accentColor);
    next.customCss = validateCustomCss(next.customCss);
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
    if (typeof next.typewriterScrolling !== "boolean") {
      next.typewriterScrolling = DEFAULTS.typewriterScrolling;
    }
    if (typeof next.checkUpdatesAutomatically !== "boolean") {
      next.checkUpdatesAutomatically = DEFAULTS.checkUpdatesAutomatically;
    }
    if (!(AUTO_LOCK_MINUTES_OPTIONS as readonly number[]).includes(next.autoLockMinutes)) {
      next.autoLockMinutes = DEFAULTS.autoLockMinutes;
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
