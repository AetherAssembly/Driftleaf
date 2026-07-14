import { app } from "electron";
import { readFile, writeFile } from "node:fs/promises";
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

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const next = { ...current, ...patch };
  await writeFile(settingsFilePath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
