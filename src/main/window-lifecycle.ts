import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS, RENDERER_EVENTS } from "../shared/ipc";

const approved = new WeakSet<BrowserWindow>();
const preparing = new WeakMap<BrowserWindow, Promise<void>>();

export function isCloseApproved(win: BrowserWindow): boolean {
  return approved.has(win);
}

export function cancelWindowClose(win: BrowserWindow): void {
  approved.delete(win);
  if (!win.isDestroyed()) win.webContents.send(RENDERER_EVENTS.closeCancelled);
}

export function prepareWindowClose(win: BrowserWindow, drain: () => Promise<void>): Promise<void> {
  if (approved.has(win)) return Promise.resolve();
  const existing = preparing.get(win);
  if (existing) return existing;
  const request = new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: string) => {
      clearTimeout(timer);
      ipcMain.removeListener(IPC_CHANNELS.flushResult, listener);
      if (error) reject(new Error(error));
      else resolve();
    };
    const listener = (event: Electron.IpcMainEvent, requestId: string, error?: string) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        requestId !== id
      )
        return;
      finish(error);
    };
    const timer = setTimeout(
      () => finish("Saving did not finish. The window has been kept open; please retry."),
      30_000,
    );
    ipcMain.on(IPC_CHANNELS.flushResult, listener);
    win.webContents.send(RENDERER_EVENTS.beforeClose, id);
  })
    .then(drain)
    .then(() => {
      approved.add(win);
    })
    .catch((error: unknown) => {
      cancelWindowClose(win);
      throw error;
    })
    .finally(() => preparing.delete(win));
  preparing.set(win, request);
  return request;
}
