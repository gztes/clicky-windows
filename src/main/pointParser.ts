/**
 * Parses the `[POINT:...]` tag Claude appends to its responses, and converts
 * the parsed screenshot-pixel coordinate into a Windows screen coordinate the
 * overlay can fly the cursor to.
 *
 * Ported from `CompanionManager.parsePointingCoordinates` in the macOS app.
 * The regex is character-for-character the same pattern; only the syntax
 * differs (Swift's NSRegularExpression vs JavaScript's RegExp).
 */

import type { CapturedScreen, PointingParseResult, PointingTarget } from "../shared/types";

/**
 * Matches, anchored to the end of the response:
 *   [POINT:none]
 *   [POINT:123,456]
 *   [POINT:123,456:save button]
 *   [POINT:123,456:save button:screen2]
 */
const POINT_TAG_PATTERN =
  /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/;

export function parsePointingCoordinates(responseText: string): PointingParseResult {
  const match = POINT_TAG_PATTERN.exec(responseText);

  if (match === null) {
    // No tag at all — Claude just answered without pointing.
    return {
      spokenText: responseText,
      coordinate: null,
      elementLabel: null,
      screenNumber: null,
    };
  }

  // Everything before the tag is what actually gets spoken aloud.
  const spokenText = responseText.slice(0, match.index).trim();

  const capturedX = match[1];
  const capturedY = match[2];

  // `[POINT:none]` matches the pattern but captures no coordinates.
  if (capturedX === undefined || capturedY === undefined) {
    return { spokenText, coordinate: null, elementLabel: "none", screenNumber: null };
  }

  const capturedElementLabel = match[3];
  const capturedScreenNumber = match[4];

  return {
    spokenText,
    coordinate: { x: Number(capturedX), y: Number(capturedY) },
    elementLabel: capturedElementLabel !== undefined ? capturedElementLabel.trim() : null,
    screenNumber: capturedScreenNumber !== undefined ? Number(capturedScreenNumber) : null,
  };
}

/**
 * Turns a parsed point into an absolute Windows screen coordinate.
 *
 * Claude works in the screenshot's pixel space (top-left origin, e.g. 1280x720).
 * Windows' virtual screen space is also top-left origin, which means — unlike
 * the macOS original — there is no Y-axis flip to undo here. We only need to
 * scale from screenshot pixels to display pixels and add the display's origin.
 *
 * Returns null when Claude didn't point, or when we can't identify the screen.
 */
export function resolvePointingTarget(
  parseResult: PointingParseResult,
  capturedScreens: CapturedScreen[]
): PointingTarget | null {
  if (parseResult.coordinate === null) {
    return null;
  }

  // Prefer the screen Claude named; otherwise assume the screen the cursor is on.
  const targetScreen =
    parseResult.screenNumber !== null &&
    parseResult.screenNumber >= 1 &&
    parseResult.screenNumber <= capturedScreens.length
      ? capturedScreens[parseResult.screenNumber - 1]
      : capturedScreens.find((capturedScreen) => capturedScreen.isCursorScreen);

  if (targetScreen === undefined) {
    return null;
  }

  // Clamp into the screenshot's coordinate space in case Claude overshoots.
  const clampedX = Math.max(0, Math.min(parseResult.coordinate.x, targetScreen.screenshotWidthInPixels));
  const clampedY = Math.max(0, Math.min(parseResult.coordinate.y, targetScreen.screenshotHeightInPixels));

  const horizontalScale = targetScreen.displayBounds.width / targetScreen.screenshotWidthInPixels;
  const verticalScale = targetScreen.displayBounds.height / targetScreen.screenshotHeightInPixels;

  return {
    screenX: targetScreen.displayBounds.x + clampedX * horizontalScale,
    screenY: targetScreen.displayBounds.y + clampedY * verticalScale,
    displayId: targetScreen.displayId,
    elementLabel: parseResult.elementLabel,
  };
}
