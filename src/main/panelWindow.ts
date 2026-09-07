/**
 * The floating control panel that drops out of the tray icon.
 * Ported from MenuBarPanelManager.swift + CompanionPanelView.swift.
 *
 * macOS used a borderless non-activating NSPanel anchored to the NSStatusItem.
 * Here it's a frameless always-on-top BrowserWindow positioned near the tray,
 * hidden on blur — same behaviour, same dark aesthetic.
 */

import { BrowserWindow, screen } from "electron";
import * as path from "path";

const PANEL_WIDTH_PIXELS = 340;
const PANEL_HEIGHT_PIXELS = 460;

/** Gap between the panel and the edge of the screen, matching the Mac's inset. */
const PANEL_SCREEN_EDGE_MARGIN_PIXELS = 8;

export class PanelWindowManager {
  private panelBrowserWindow: BrowserWindow | null = null;

  ensurePanelWindowExists(): BrowserWindow {
    if (this.panelBrowserWindow !== null && !this.panelBrowserWindow.isDestroyed()) {
      return this.panelBrowserWindow;
    }

    const panelBrowserWindow = new BrowserWindow({
      width: PANEL_WIDTH_PIXELS,
      height: PANEL_HEIGHT_PIXELS,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/panelPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // The preload scripts import shared modules by relative path, which the
        // sandboxed preload loader cannot resolve (it only exposes a minimal
        // require). Disabling the sandbox gives preload real Node resolution.
        // The renderer itself stays isolated: contextIsolation is on and
        // nodeIntegration is off, so page code still gets no Node access.
        sandbox: false,
      },
    });

    // Keep the panel out of Clicky's own screenshots, same as the overlay.
    panelBrowserWindow.setContentProtection(true);

    void panelBrowserWindow.loadFile(path.join(__dirname, "../renderer/panel/index.html"));

    // Clicking anywhere outside dismisses the panel — the Windows equivalent of
    // the macOS global click-outside monitor.
    panelBrowserWindow.on("blur", () => {
      panelBrowserWindow.hide();
    });

    this.panelBrowserWindow = panelBrowserWindow;
    return panelBrowserWindow;
  }

  /** Shows the panel tucked into the corner nearest the tray icon. */
  showPanelNearTray(trayIconBounds: Electron.Rectangle): void {
    const panelBrowserWindow = this.ensurePanelWindowExists();
    const displayNearTray = screen.getDisplayNearestPoint({
      x: trayIconBounds.x,
      y: trayIconBounds.y,
    });
    const workArea = displayNearTray.workArea;

    // Centre the panel under the tray icon, then pull it back inside the work
    // area so it never hangs off the edge on a taskbar at any screen edge.
    const idealHorizontalPosition = Math.round(
      trayIconBounds.x + trayIconBounds.width / 2 - PANEL_WIDTH_PIXELS / 2
    );
    const clampedHorizontalPosition = Math.max(
      workArea.x + PANEL_SCREEN_EDGE_MARGIN_PIXELS,
      Math.min(
        idealHorizontalPosition,
        workArea.x + workArea.width - PANEL_WIDTH_PIXELS - PANEL_SCREEN_EDGE_MARGIN_PIXELS
      )
    );

    // Tray at the bottom (the usual case) means the panel opens upward.
    const isTrayNearBottomOfScreen = trayIconBounds.y > workArea.y + workArea.height / 2;
    const verticalPosition = isTrayNearBottomOfScreen
      ? workArea.y + workArea.height - PANEL_HEIGHT_PIXELS - PANEL_SCREEN_EDGE_MARGIN_PIXELS
      : workArea.y + PANEL_SCREEN_EDGE_MARGIN_PIXELS;

    panelBrowserWindow.setPosition(clampedHorizontalPosition, verticalPosition, false);
    panelBrowserWindow.show();
    panelBrowserWindow.focus();
  }

  togglePanelNearTray(trayIconBounds: Electron.Rectangle): void {
    if (this.panelBrowserWindow !== null && this.panelBrowserWindow.isVisible()) {
      this.panelBrowserWindow.hide();
      return;
    }
    this.showPanelNearTray(trayIconBounds);
  }

  hidePanel(): void {
    if (this.panelBrowserWindow !== null && !this.panelBrowserWindow.isDestroyed()) {
      this.panelBrowserWindow.hide();
    }
  }

  sendToPanel(channelName: string, payload: unknown): void {
    if (this.panelBrowserWindow !== null && !this.panelBrowserWindow.isDestroyed()) {
      this.panelBrowserWindow.webContents.send(channelName, payload);
    }
  }
}
