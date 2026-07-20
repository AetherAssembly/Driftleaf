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

  // Quick-capture: works even when Driftleaf isn't focused, since it's the whole point —
  // jot something down without breaking flow in whatever app you were in.
  globalShortcut.register("CommandOrControl+Shift+N", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(RENDERER_EVENTS.quickCapture);
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(createWindow);

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
