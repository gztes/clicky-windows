/**
 * The full-screen transparent overlay that hosts the blue cursor, the response
 * bubble, the waveform and the spinner. Ported from OverlayWindow.swift.
 *
 * The macOS app used one non-activating NSPanel per screen that joined all
 * Spaces and never took focus. The Windows equivalent is one frameless,
 * transparent, always-on-top BrowserWindow per display with mouse events
 * ignored, so clicks pass straight through to whatever is underneath.
 */

import { BrowserWindow, screen } from "electron";
import * as path from "path";
import { IpcChannels } from "../shared/ipcChannels";
import type { CompanionVoiceState, PointingTarget } from "../shared/types";

interface OverlayWindowEntry {
  displayId: number;
  browserWindow: BrowserWindow;
  displayBounds: Electron.Rectangle;
}

export class OverlayWindowManager {
  private overlayWindowEntries: OverlayWindowEntry[] = [];
  private isOverlayVisible = false;

  /** Creates one overlay window per connected display. */
  showOverlay(): void {
    if (this.overlayWindowEntries.length > 0) {
      this.setOverlayWindowsVisible(true);
      return;
    }

    for (const display of screen.getAllDisplays()) {
      this.overlayWindowEntries.push(this.createOverlayWindowForDisplay(display));
    }

    this.isOverlayVisible = true;
  }

  hideOverlay(): void {
    this.setOverlayWindowsVisible(false);
  }

  private setOverlayWindowsVisible(shouldBeVisible: boolean): void {
    for (const overlayEntry of this.overlayWindowEntries) {
      if (overlayEntry.browserWindow.isDestroyed()) {
        continue;
      }
      if (shouldBeVisible) {
        overlayEntry.browserWindow.showInactive();
      } else {
        overlayEntry.browserWindow.hide();
      }
    }
    this.isOverlayVisible = shouldBeVisible;
  }

  private createOverlayWindowForDisplay(display: Electron.Display): OverlayWindowEntry {
    const overlayBrowserWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Don't show until the renderer has painted, or the user sees a flash.
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/overlayPreload.js"),
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

    // "screen-saver" is the highest ordinary level, so the cursor stays above
    // full-screen apps the way the macOS overlay did by joining all Spaces.
    overlayBrowserWindow.setAlwaysOnTop(true, "screen-saver");
    overlayBrowserWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Clicks pass through to whatever is underneath. `forward: true` still lets
    // the renderer receive mousemove events, which we don't rely on but which
    // keeps hover-driven effects possible later.
    overlayBrowserWindow.setIgnoreMouseEvents(true, { forward: true });

    // The Windows counterpart of excluding our own windows from SCContentFilter:
    // WDA_EXCLUDEFROMCAPTURE keeps this window out of desktopCapturer's output,
    // so Clicky never sends Claude a screenshot of Clicky.
    overlayBrowserWindow.setContentProtection(true);

    void overlayBrowserWindow.loadFile(path.join(__dirname, "../renderer/overlay/index.html"));

    overlayBrowserWindow.once("ready-to-show", () => {
      overlayBrowserWindow.webContents.send(IpcChannels.overlayConfigure, {
        displayId: display.id,
        displayBounds: display.bounds,
      });
      overlayBrowserWindow.showInactive();
    });

    return {
      displayId: display.id,
      browserWindow: overlayBrowserWindow,
      displayBounds: display.bounds,
    };
  }

  /** Rebuilds the overlays after a monitor is plugged in or unplugged. */
  rebuildForDisplayChange(): void {
    const wasVisible = this.isOverlayVisible;
    this.destroyAllOverlayWindows();
    if (wasVisible) {
      this.showOverlay();
    }
  }

  destroyAllOverlayWindows(): void {
    for (const overlayEntry of this.overlayWindowEntries) {
      if (!overlayEntry.browserWindow.isDestroyed()) {
        // `closable: false` means close() is ignored, so destroy explicitly.
        overlayEntry.browserWindow.destroy();
      }
    }
    this.overlayWindowEntries = [];
    this.isOverlayVisible = false;
  }

  /** Sends a message to every overlay window. */
  private broadcastToAllOverlays(channelName: string, payload: unknown): void {
    for (const overlayEntry of this.overlayWindowEntries) {
      if (!overlayEntry.browserWindow.isDestroyed()) {
        overlayEntry.browserWindow.webContents.send(channelName, payload);
      }
    }
  }

  broadcastVoiceState(voiceState: CompanionVoiceState): void {
    this.broadcastToAllOverlays(IpcChannels.overlayVoiceStateChanged, voiceState);
  }

  broadcastAudioLevel(audioLevel: number): void {
    this.broadcastToAllOverlays(IpcChannels.overlayAudioLevelChanged, audioLevel);
  }

  /**
   * Tells each overlay where the mouse is, in that display's local coordinates,
   * so the blue cursor can sit next to the real pointer.
   */
  broadcastCursorPosition(): void {
    const cursorScreenPoint = screen.getCursorScreenPoint();
    const displayUnderCursor = screen.getDisplayNearestPoint(cursorScreenPoint);

    for (const overlayEntry of this.overlayWindowEntries) {
      if (overlayEntry.browserWindow.isDestroyed()) {
        continue;
      }
      overlayEntry.browserWindow.webContents.send(IpcChannels.overlayCursorPositionChanged, {
        // Only the display the pointer is actually on should draw the cursor.
        isCursorOnThisDisplay: overlayEntry.displayId === displayUnderCursor.id,
        localX: cursorScreenPoint.x - overlayEntry.displayBounds.x,
        localY: cursorScreenPoint.y - overlayEntry.displayBounds.y,
      });
    }
  }

  broadcastResponseText(responseText: string): void {
    this.broadcastToAllOverlays(IpcChannels.overlayShowResponseText, responseText);
  }

  /**
   * Sends the pointing target to the display it belongs to, converted into
   * that display's local coordinates. Other displays are told to stand down so
   * a stale cursor doesn't linger on the wrong monitor.
   */
  sendPointingTarget(pointingTarget: PointingTarget): void {
    for (const overlayEntry of this.overlayWindowEntries) {
      if (overlayEntry.browserWindow.isDestroyed()) {
        continue;
      }

      const isTargetDisplay = overlayEntry.displayId === pointingTarget.displayId;

      overlayEntry.browserWindow.webContents.send(IpcChannels.overlayFlyToPointingTarget, {
        isTargetDisplay,
        localX: pointingTarget.screenX - overlayEntry.displayBounds.x,
        localY: pointingTarget.screenY - overlayEntry.displayBounds.y,
        elementLabel: pointingTarget.elementLabel,
      });
    }
  }
}
