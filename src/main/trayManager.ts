/**
 * The system tray icon — the Windows counterpart of macOS's NSStatusItem.
 * Ported from the NSStatusItem half of MenuBarPanelManager.swift.
 *
 * Left-click toggles the floating panel. Right-click opens a small native
 * context menu, which Windows users expect from a tray icon even though the
 * Mac version had no equivalent.
 */

import { Menu, Tray, app, nativeImage } from "electron";
import * as path from "path";
import type { PanelWindowManager } from "./panelWindow";

export class TrayManager {
  private trayIcon: Tray | null = null;
  private panelWindowManager: PanelWindowManager | null = null;

  create(panelWindowManager: PanelWindowManager): void {
    this.panelWindowManager = panelWindowManager;

    const trayIconImage = nativeImage.createFromPath(
      path.join(__dirname, "../../assets/trayIcon.png")
    );

    this.trayIcon = new Tray(trayIconImage);
    this.trayIcon.setToolTip("Clicky — hold Ctrl + Alt to talk");

    this.trayIcon.on("click", () => {
      if (this.trayIcon === null) {
        return;
      }
      panelWindowManager.togglePanelNearTray(this.trayIcon.getBounds());
    });

    this.trayIcon.on("right-click", () => {
      this.trayIcon?.popUpContextMenu(
        Menu.buildFromTemplate([
          {
            label: "Open Clicky",
            click: () => {
              if (this.trayIcon !== null) {
                panelWindowManager.showPanelNearTray(this.trayIcon.getBounds());
              }
            },
          },
          { type: "separator" },
          { label: "Quit Clicky", click: () => app.quit() },
        ])
      );
    });
  }

  /** Opens the panel at the tray icon, for callers that have no tray bounds. */
  showPanel(): void {
    if (this.trayIcon === null || this.panelWindowManager === null) {
      return;
    }
    this.panelWindowManager.showPanelNearTray(this.trayIcon.getBounds());
  }

  destroy(): void {
    this.trayIcon?.destroy();
    this.trayIcon = null;
  }
}
