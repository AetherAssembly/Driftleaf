import { app, BrowserWindow, globalShortcut } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc";
import { RENDERER_EVENTS } from "../shared/ipc";

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

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

  registerIpcHandlers(win);

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
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
