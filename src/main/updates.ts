import { app, BrowserWindow, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppSettings, UpdateStatus } from "../shared/ipc";
import { RENDERER_EVENTS } from "../shared/ipc";

const RELEASES_API = "https://api.github.com/repos/AetherAssembly/Driftleaf/releases?per_page=30";
const RELEASES_PAGE = "https://github.com/AetherAssembly/Driftleaf/releases";
const IS_BETA = app.getVersion().includes("-");
const AUTOMATIC_INSTALL =
  app.isPackaged &&
  ((process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR) ||
    (process.platform === "darwin" && __DRIFTLEAF_MAC_AUTO_UPDATE__));
let initialized = false;
let checkInFlight: Promise<UpdateStatus> | null = null;

let status: UpdateStatus = {
  state: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadUrl: null,
  checkedAt: null,
  message: "Updates have not been checked yet.",
  automaticInstall: AUTOMATIC_INSTALL,
};

function publish(next: UpdateStatus): UpdateStatus {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(RENDERER_EVENTS.updateStatus, status);
  }
  return status;
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (match[4]) {
    parts.push(-1);
    for (const part of match[4].split(".")) {
      parts.push(/^\d+$/.test(part) ? Number(part) : 0);
    }
  } else {
    parts.push(0);
  }
  return parts;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("The update service returned an invalid version tag");
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function baseStatus(
  state: UpdateStatus["state"],
  message: string,
  availableVersion = status.availableVersion,
  downloadUrl = status.downloadUrl,
): UpdateStatus {
  return {
    ...status,
    state,
    availableVersion,
    downloadUrl,
    checkedAt: Date.now(),
    message,
  };
}

async function checkManualUpdates(): Promise<UpdateStatus> {
  const response = await fetch(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Driftleaf",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub release check failed (HTTP ${response.status})`);
  }
  const releases: unknown = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list");
  const candidates = releases.filter(
    (release): release is {
      draft: boolean;
      prerelease: boolean;
      tag_name: string;
      html_url: string;
      assets: { name: string; browser_download_url: string }[];
    } =>
      !!release &&
      typeof release === "object" &&
      !("draft" in release && release.draft) &&
      "prerelease" in release &&
      release.prerelease === IS_BETA &&
      typeof release.tag_name === "string" &&
      typeof release.html_url === "string" &&
      Array.isArray(release.assets),
  );
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = candidates[0];
  if (!latest) {
    return publish(baseStatus("up-to-date", "No published update is available for this release channel.", null, null));
  }
  if (compareVersions(latest.tag_name, status.currentVersion) <= 0) {
    return publish(baseStatus("up-to-date", "Driftleaf is up to date.", null, null));
  }

  const assetPattern =
    process.platform === "darwin"
      ? /\.dmg$/i
      : process.platform === "win32"
        ? /-setup-.*\.exe$/i
        : /\.AppImage$/i;
  const downloadUrl =
    latest.assets.find((asset) => assetPattern.test(asset.name))?.browser_download_url ??
    latest.html_url ??
    RELEASES_PAGE;
  return publish(
    baseStatus(
      "available",
      `Driftleaf ${latest.tag_name.replace(/^v/, "")} is available. Download it from the release page.`,
      latest.tag_name.replace(/^v/, ""),
      downloadUrl,
    ),
  );
}

export interface InitializeUpdatesOptions {
  getSettings(): Promise<AppSettings>;
}

export function initializeUpdates(options: InitializeUpdatesOptions): void {
  if (initialized) return;
  initialized = true;

  if (AUTOMATIC_INSTALL) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => {
      publish(baseStatus("checking", "Checking for updates…"));
    });
    autoUpdater.on("update-available", (info) => {
      publish(
        baseStatus(
          "available",
          `Driftleaf ${info.version} is available to download.`,
          info.version,
          null,
        ),
      );
    });
    autoUpdater.on("update-not-available", () => {
      publish(baseStatus("up-to-date", "Driftleaf is up to date.", null, null));
    });
    autoUpdater.on("download-progress", (progress) => {
      publish(baseStatus("downloading", `Downloading update: ${Math.round(progress.percent)}%`));
    });
    autoUpdater.on("update-downloaded", (info) => {
      publish(
        baseStatus(
          "downloaded",
          `Driftleaf ${info.version} is ready to install.`,
          info.version,
          null,
        ),
      );
    });
    autoUpdater.on("error", (error) => {
      publish(baseStatus("error", `Update check failed: ${error.message}`));
    });
  } else {
    publish({
      ...status,
      state: "idle",
      message:
        process.platform === "linux" || process.env.PORTABLE_EXECUTABLE_DIR
          ? "Linux updates are detected here; download and install the release manually."
          : "macOS updates are detected here. Automatic installation will be enabled after app signing is configured.",
    });
  }

  if (app.isPackaged) {
    void options.getSettings().then((settings) => {
      if (!settings.checkUpdatesAutomatically) return;
      const timer = setTimeout(() => void checkForUpdates(), 5_000);
      timer.unref();
    });
  }
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function checkForUpdates(): Promise<UpdateStatus> {
  if (checkInFlight) return checkInFlight;
  publish(baseStatus("checking", "Checking for updates…"));
  const request =
    AUTOMATIC_INSTALL && app.isPackaged
      ? autoUpdater
          .checkForUpdates()
          .then((result) =>
            result
              ? status
              : baseStatus("up-to-date", "Driftleaf is up to date.", null, null),
          )
      : checkManualUpdates();
  checkInFlight = request
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return publish(baseStatus("error", `Update check failed: ${message}`));
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!AUTOMATIC_INSTALL || !app.isPackaged) {
    throw new Error("This platform uses manual update downloads");
  }
  if (status.state !== "available") throw new Error("There is no update ready to download");
  publish(baseStatus("downloading", "Downloading update…"));
  try {
    await autoUpdater.downloadUpdate();
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publish(baseStatus("error", `Update download failed: ${message}`));
    throw new Error(`Update download failed: ${message}`, { cause: error });
  }
}

export function installUpdate(): void {
  if (!AUTOMATIC_INSTALL || !app.isPackaged || status.state !== "downloaded") {
    throw new Error("No downloaded update is ready to install");
  }
  autoUpdater.quitAndInstall(false, true);
}

export async function openUpdateDownload(): Promise<void> {
  if (!status.downloadUrl || !URL.canParse(status.downloadUrl)) {
    throw new Error("No update download URL is available");
  }
  const url = new URL(status.downloadUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "objects.githubusercontent.com")
  ) {
    throw new Error("The update download URL is not trusted");
  }
  await shell.openExternal(url.href);
}
