import type { BrowserWindow } from "electron";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";

// Popup guests use the same isolated preload as embedded browser tabs, in all frames.
export function browserRecordingPopupOptions(
  mainWindow: BrowserWindow,
  preload: string,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PASEO_BROWSER_PROFILE_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      preload,
    },
  };
}
