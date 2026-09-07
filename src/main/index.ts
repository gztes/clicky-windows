/**
 * Application entry point.
 * Ported from leanring_buddyApp.swift + CompanionAppDelegate.
 *
 * Like the Mac app, Clicky has no main window and no taskbar presence — it
 * lives entirely in the system tray. `LSUIElement=true` on macOS becomes
 * "never create a visible window, and skipTaskbar on the ones we do create".
 */

import { app, ipcMain, shell } from "electron";
import { CompanionManager } from "./companionManager";
import { TrayManager } from "./trayManager";
import { IpcChannels } from "../shared/ipcChannels";

const companionManager = new CompanionManager();
const trayManager = new TrayManager();

function startClicky(): void {
  app.whenReady().then(() => {
    trayManager.create(companionManager.panelWindows);
    companionManager.start();

    ipcMain.on(IpcChannels.panelQuitApplication, () => {
      app.quit();
    });

    ipcMain.on(IpcChannels.panelOpenExternalUrl, (_event, externalUrl: string) => {
      // Only ever hand http(s) links to the OS browser, never arbitrary schemes.
      if (/^https?:\/\//i.test(externalUrl)) {
        void shell.openExternal(externalUrl);
      }
    });
  });

  // A tray app must stay alive with no windows open. Electron only auto-quits
  // on this event when nothing is listening for it, so registering a handler
  // that deliberately does nothing is what keeps Clicky running in the tray.
  app.on("window-all-closed", () => {
    // Intentionally empty — see above.
  });

  app.on("before-quit", () => {
    companionManager.stop();
    trayManager.destroy();
  });
}

// Only one Clicky may run at a time. A second launch would install a second
// keyboard hook, double every push-to-talk session, and fight over the same
// userData directory (which shows up as "Unable to create cache" errors).
//
// `app.quit()` does not take effect immediately — "ready" still fires before
// the process exits — so the entire startup path has to sit behind this guard,
// not just the quit call. Otherwise the losing instance briefly starts a
// keyboard hook and a tray icon before dying.
const didAcquireSingleInstanceLock = app.requestSingleInstanceLock();

if (!didAcquireSingleInstanceLock) {
  app.quit();
} else {
  // Launching Clicky again while it's running is a reasonable way for someone
  // to ask for the panel, so treat it as "open the panel" rather than a no-op.
  app.on("second-instance", () => {
    trayManager.showPanel();
  });

  startClicky();
}
