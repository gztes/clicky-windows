/**
 * Multi-monitor screenshot capture.
 * Ported from CompanionScreenCaptureUtility.swift.
 *
 * Two Windows-specific notes:
 *
 * 1. Clicky's own windows are kept out of the screenshots by calling
 *    `setContentProtection(true)` on them (see overlayWindows.ts). On Windows
 *    that sets WDA_EXCLUDEFROMCAPTURE, so the compositor omits those windows
 *    from any capture — the same outcome the macOS app got by passing its own
 *    windows to SCContentFilter's `excludingWindows`.
 *
 * 2. Windows screen coordinates use a top-left origin, exactly like the
 *    screenshot's own coordinate space. The macOS version had to flip the Y
 *    axis to get from screenshot space to AppKit space; here we don't.
 */

import { desktopCapturer, screen } from "electron";
import type { CapturedScreen } from "../shared/types";

/**
 * Longest edge of the screenshots we send to Claude. Matches the macOS app.
 * Bigger means Claude can point more precisely but costs more tokens and
 * makes the request slower.
 */
const MAX_SCREENSHOT_DIMENSION_PIXELS = 1280;

const JPEG_QUALITY = 0.8;

/**
 * Captures every connected display as a JPEG, ordered so the display the
 * cursor is on comes first (Claude is told to treat that one as primary).
 */
export async function captureAllScreens(): Promise<CapturedScreen[]> {
  const allDisplays = screen.getAllDisplays();
  const cursorScreenPoint = screen.getCursorScreenPoint();
  const displayUnderCursor = screen.getDisplayNearestPoint(cursorScreenPoint);

  // Ask for thumbnails big enough for the largest display, then downscale each
  // one to its own aspect-correct size below.
  const largestDisplayWidth = Math.max(...allDisplays.map((display) => display.size.width));
  const largestDisplayHeight = Math.max(...allDisplays.map((display) => display.size.height));

  const availableSources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: largestDisplayWidth, height: largestDisplayHeight },
    fetchWindowIcons: false,
  });

  if (availableSources.length === 0) {
    throw new Error("No display was available to capture.");
  }

  // Put the cursor's display first so it becomes "screen 1 (primary focus)".
  const displaysInCaptureOrder = [...allDisplays].sort((firstDisplay, secondDisplay) => {
    const firstIsCursorDisplay = firstDisplay.id === displayUnderCursor.id ? 1 : 0;
    const secondIsCursorDisplay = secondDisplay.id === displayUnderCursor.id ? 1 : 0;
    return secondIsCursorDisplay - firstIsCursorDisplay;
  });

  const capturedScreens: CapturedScreen[] = [];

  for (const [displayIndex, display] of displaysInCaptureOrder.entries()) {
    // desktopCapturer reports display_id as a string; Electron's Display.id is
    // a number. Match on the string form, and fall back to positional matching
    // for the single-monitor case where some drivers report an empty id.
    const matchingSource =
      availableSources.find((source) => source.display_id === String(display.id)) ??
      (displaysInCaptureOrder.length === 1 ? availableSources[0] : undefined);

    if (matchingSource === undefined) {
      console.warn(`No capture source matched display ${display.id}; skipping it.`);
      continue;
    }

    const resizedThumbnail = resizeThumbnailToMaxDimension(matchingSource.thumbnail, display);
    if (resizedThumbnail.isEmpty()) {
      console.warn(`Capture for display ${display.id} came back empty; skipping it.`);
      continue;
    }

    const thumbnailSize = resizedThumbnail.getSize();
    const isCursorScreen = display.id === displayUnderCursor.id;

    capturedScreens.push({
      imageBase64: resizedThumbnail.toJPEG(Math.round(JPEG_QUALITY * 100)).toString("base64"),
      label: buildScreenLabel(displayIndex, displaysInCaptureOrder.length, isCursorScreen),
      isCursorScreen,
      displayId: display.id,
      displayBounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
      screenshotWidthInPixels: thumbnailSize.width,
      screenshotHeightInPixels: thumbnailSize.height,
    });
  }

  if (capturedScreens.length === 0) {
    throw new Error("Failed to capture any screen.");
  }

  return capturedScreens;
}

/**
 * Scales a captured thumbnail so its longest edge is MAX_SCREENSHOT_DIMENSION_PIXELS,
 * preserving the display's aspect ratio. Never upscales a small display.
 */
function resizeThumbnailToMaxDimension(
  thumbnail: Electron.NativeImage,
  display: Electron.Display
): Electron.NativeImage {
  const displayAspectRatio = display.size.width / display.size.height;

  let targetWidth: number;
  let targetHeight: number;

  if (display.size.width >= display.size.height) {
    targetWidth = Math.min(MAX_SCREENSHOT_DIMENSION_PIXELS, display.size.width);
    targetHeight = Math.round(targetWidth / displayAspectRatio);
  } else {
    targetHeight = Math.min(MAX_SCREENSHOT_DIMENSION_PIXELS, display.size.height);
    targetWidth = Math.round(targetHeight * displayAspectRatio);
  }

  return thumbnail.resize({ width: targetWidth, height: targetHeight, quality: "good" });
}

/**
 * The label sent alongside each image. Claude uses the "primary focus" wording
 * and the screen number to decide which screen a `[POINT:...:screenN]` refers to,
 * so this text has to stay in sync with the system prompt.
 */
function buildScreenLabel(displayIndex: number, totalDisplayCount: number, isCursorScreen: boolean): string {
  if (totalDisplayCount === 1) {
    return "user's screen (cursor is here)";
  }
  if (isCursorScreen) {
    return `screen ${displayIndex + 1} of ${totalDisplayCount} — cursor is on this screen (primary focus)`;
  }
  return `screen ${displayIndex + 1} of ${totalDisplayCount} — secondary screen`;
}
