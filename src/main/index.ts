import { isCloseApproved, prepareWindowClose } from "./window-lifecycle";
import { app, BrowserWindow, globalShortcut, dialog } from "electron";
import path from "node:path";
import { closeExtensionWindows, registerIpcHandlers } from "./ipc";
import { RENDERER_EVENTS } from "../shared/ipc";
import { initializeUpdates } from "./updates";
import { createDriftleafService } from "./service";
import { createElectronHost } from "./electron-host";

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

if (process.platform === "linux") {
  app.setDesktopName("driftleaf.desktop");
}

let quitRequested = false;
// Tracked separately from BrowserWindow.getAllWindows()[0] so the host's dialogs always
// anchor to whichever window was created or focused most recently.
let latestWindow: BrowserWindow | null = null;

// Composition root: the one place that wires the Electron-independent service
// (src/main/service.ts) to real Electron capabilities (src/main/electron-host.ts). See
// docs/ELECTRON_MIGRATION_REVIEW.md, Phase 1.
const host = createElectronHost({
  getWindow: () => latestWindow,
  onSessionReset: () => closeExtensionWindows(),
});
const service = createDriftleafService(host);

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Driftleaf",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  latestWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const externalUrl = new URL(url);
      if (externalUrl.protocol === "https:") {
        void host.openExternal(externalUrl.href).catch((err: unknown) => {
          console.error("Failed to open external link:", err);
        });
      }
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!URL.canParse(url)) return;
    const destination = new URL(url);
    const current = URL.canParse(win.webContents.getURL())
      ? new URL(win.webContents.getURL())
      : null;
    if (current?.origin === destination.origin) return;
    if (destination.protocol === "http:" || destination.protocol === "https:") {
      event.preventDefault();
      if (destination.protocol === "https:") {
        void host.openExternal(destination.href).catch((err: unknown) => {
          console.error("Failed to open external link:", err);
        });
      }
    }
  });

  let closing = false;
  win.on("close", (event) => {
    if (isCloseApproved(win)) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void prepareWindowClose(win, () => service.vault.lock())
      .then(() => {
        if (quitRequested) app.quit();
        else win.close();
      })
      .catch((error: unknown) => {
        quitRequested = false;
        void dialog.showMessageBox(win, {
          type: "error",
          title: "Edits could not be saved",
          message: "Driftleaf stayed open to protect your edits.",
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        closing = false;
      });
  });
  registerIpcHandlers(win, service);

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
  initializeUpdates({ getSettings: () => host.settings.readSettings() });
  createWindow();

  // Quick-capture: works even when Driftleaf isn't focused, since it's the whole point —
  // jot something down without breaking flow in whatever app you were in. Registered once
  // at startup, not per-window: on macOS the app stays alive with zero windows after the
  // last one is closed, so a callback closing over that window would call methods on a
  // destroyed BrowserWindow the next time the shortcut fires. Looking the window up at call
  // time instead means it always targets whichever window is actually alive right now.
  const registered = globalShortcut.register("CommandOrControl+Shift+N", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(RENDERER_EVENTS.quickCapture);
  });
  if (!registered) {
    console.warn(
      "Failed to register the quick-capture shortcut (Ctrl/Cmd+Shift+N) — it may already be in use by another application.",
    );
  }
});

app.on("before-quit", () => {
  quitRequested = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
