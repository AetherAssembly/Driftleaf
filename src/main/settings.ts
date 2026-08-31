import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export interface AppSettings {
  lastVaultPath: string | null;
  theme: "system" | "light" | "dark";
  editorFontSizePx: number;
  autosaveIntervalMs: number;
}

const DEFAULTS: AppSettings = {
  lastVaultPath: null,
  theme: "system",
  editorFontSizePx: 15,
  autosaveIntervalMs: 500,
};

// Mirrors the bounds SettingsModal.tsx's number inputs enforce in the UI — a direct
// ipcRenderer.invoke("settings:patch", ...) call bypassing the UI shouldn't be able to
// persist a value the UI itself would never let a user set (e.g. a zero/negative autosave
// interval, which would fire the debounced save on essentially every keystroke).
const FONT_SIZE_RANGE = { min: 12, max: 24 };
const AUTOSAVE_RANGE = { min: 200, max: 5000 };

function clamp(value: number, range: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export async function readSettings(): Promise<AppSettings> {
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

export function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const run = patchQueue.catch(() => DEFAULTS).then(() => applyPatch(patch));
  patchQueue = run;
  return run;
}

async function applyPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const next = { ...current, ...patch };
  next.editorFontSizePx = clamp(next.editorFontSizePx, FONT_SIZE_RANGE, DEFAULTS.editorFontSizePx);
  next.autosaveIntervalMs = clamp(next.autosaveIntervalMs, AUTOSAVE_RANGE, DEFAULTS.autosaveIntervalMs);

  const filePath = settingsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  // Same atomic temp-file+rename pattern as the vault's writes (see vault.ts) — a process
  // kill mid-write can no longer leave settings.json truncated/unparseable.
  const tmpPath = path.join(path.dirname(filePath), `.settings.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
  await rename(tmpPath, filePath);
  return next;
}
