/**
 * The blue cursor companion, its speech bubble, waveform and spinner.
 * Ported from OverlayWindow.swift + CompanionResponseOverlay.swift.
 *
 * One instance of this renderer runs per display. Each is told its own display
 * bounds at startup, and every position it receives is already in that
 * display's local coordinate space, so nothing here has to know about the
 * virtual screen layout.
 */

/** How far the companion sits from the real mouse pointer, in pixels. */
const CURSOR_FOLLOW_OFFSET_X = 26;
const CURSOR_FOLLOW_OFFSET_Y = 26;

/**
 * Follow smoothing. Each frame the companion moves this fraction of the
 * remaining distance to its target, which gives the trailing, springy feel of
 * the macOS original rather than sticking rigidly to the pointer.
 */
const CURSOR_FOLLOW_SMOOTHING_FACTOR = 0.18;

/** Duration of the arc flight to a pointed-at element. */
const POINTING_FLIGHT_DURATION_MS = 900;

/** How long the companion holds its position at the target before returning. */
const POINTING_HOLD_DURATION_MS = 2600;

/** How long a spoken response stays on screen. */
const RESPONSE_TEXT_VISIBLE_DURATION_MS = 9000;

type OverlayMode = "following" | "flying" | "holding";

interface Point2D {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- element refs

const companionRootElement = document.getElementById("companion-root") as HTMLDivElement;
const cursorTriangleElement = document.getElementById("cursor-triangle") as HTMLDivElement;
const bubbleElement = document.getElementById("companion-bubble") as HTMLDivElement;
const bubbleTextElement = document.getElementById("companion-bubble-text") as HTMLDivElement;
const waveformElement = document.getElementById("companion-waveform") as HTMLDivElement;
const spinnerElement = document.getElementById("companion-spinner") as HTMLDivElement;
const waveformBarElements: HTMLDivElement[] = Array.from(
  waveformElement.querySelectorAll(".waveform-bar")
);

// ------------------------------------------------------------------- state

let isCursorOnThisDisplay = false;
let currentVoiceState: CompanionVoiceStateName = "idle";
let overlayMode: OverlayMode = "following";

/** Where the companion is drawn right now. */
let companionPosition: Point2D = { x: 0, y: 0 };
/** Where the companion wants to be — the mouse, offset — while following. */
let followTargetPosition: Point2D = { x: 0, y: 0 };

/** Smoothed audio level, so the waveform doesn't jitter frame to frame. */
let smoothedAudioLevel = 0;

// Flight animation state.
let flightStartPosition: Point2D = { x: 0, y: 0 };
let flightControlPosition: Point2D = { x: 0, y: 0 };
let flightEndPosition: Point2D = { x: 0, y: 0 };
let flightStartTimestampMs = 0;

let bubbleHideTimer: number | null = null;
let pointingHoldTimer: number | null = null;

// ------------------------------------------------------------------ helpers

/** Ease-in-out curve, matching the feel of the Swift animation's timing. */
function easeInOutCubic(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

/** Quadratic bezier — the arc the companion flies along, rather than a straight line. */
function quadraticBezierPoint(
  startPoint: Point2D,
  controlPoint: Point2D,
  endPoint: Point2D,
  progress: number
): Point2D {
  const inverseProgress = 1 - progress;
  return {
    x:
      inverseProgress * inverseProgress * startPoint.x +
      2 * inverseProgress * progress * controlPoint.x +
      progress * progress * endPoint.x,
    y:
      inverseProgress * inverseProgress * startPoint.y +
      2 * inverseProgress * progress * controlPoint.y +
      progress * progress * endPoint.y,
  };
}

function showBubbleWithText(bubbleText: string, visibleDurationMs: number): void {
  if (bubbleText.trim().length === 0) {
    return;
  }

  bubbleTextElement.textContent = bubbleText;
  bubbleElement.classList.add("is-visible");

  if (bubbleHideTimer !== null) {
    window.clearTimeout(bubbleHideTimer);
  }
  bubbleHideTimer = window.setTimeout(() => {
    bubbleElement.classList.remove("is-visible");
    bubbleHideTimer = null;
  }, visibleDurationMs);
}

/**
 * Keeps the bubble from running off the edge of the screen by flipping it to
 * the left of the companion when there isn't room on the right.
 */
function positionBubbleRelativeToCompanion(): void {
  const shouldFlipToLeft = companionPosition.x + 340 > window.innerWidth;
  bubbleElement.classList.toggle("is-flipped", shouldFlipToLeft);

  const shouldFlipAbove = companionPosition.y + 160 > window.innerHeight;
  bubbleElement.classList.toggle("is-above", shouldFlipAbove);
}

// -------------------------------------------------------------- render loop

function renderFrame(frameTimestampMs: number): void {
  if (overlayMode === "flying") {
    const elapsedMs = frameTimestampMs - flightStartTimestampMs;
    const rawProgress = Math.min(1, elapsedMs / POINTING_FLIGHT_DURATION_MS);
    const easedProgress = easeInOutCubic(rawProgress);

    companionPosition = quadraticBezierPoint(
      flightStartPosition,
      flightControlPosition,
      flightEndPosition,
      easedProgress
    );

    if (rawProgress >= 1) {
      overlayMode = "holding";
      // After the hold, drift back to following the real pointer.
      pointingHoldTimer = window.setTimeout(() => {
        overlayMode = "following";
        pointingHoldTimer = null;
      }, POINTING_HOLD_DURATION_MS);
    }
  } else if (overlayMode === "following") {
    // Exponential smoothing toward the pointer.
    companionPosition.x += (followTargetPosition.x - companionPosition.x) * CURSOR_FOLLOW_SMOOTHING_FACTOR;
    companionPosition.y += (followTargetPosition.y - companionPosition.y) * CURSOR_FOLLOW_SMOOTHING_FACTOR;
  }
  // In "holding" mode the companion stays exactly where it landed.

  companionRootElement.style.transform = `translate3d(${companionPosition.x}px, ${companionPosition.y}px, 0)`;
  positionBubbleRelativeToCompanion();

  if (currentVoiceState === "listening") {
    renderWaveformBars();
  }

  window.requestAnimationFrame(renderFrame);
}

function renderWaveformBars(): void {
  for (const [barIndex, waveformBarElement] of waveformBarElements.entries()) {
    // Stagger the bars so they don't all pulse in lockstep.
    const staggerPhase = Math.sin(Date.now() / 180 + barIndex * 0.9) * 0.35 + 0.65;
    const barHeightPixels = 3 + smoothedAudioLevel * 42 * staggerPhase;
    waveformBarElement.style.height = `${Math.max(3, Math.min(26, barHeightPixels))}px`;
  }
}

// --------------------------------------------------------- state transitions

/**
 * Shows exactly one of: waveform (listening), spinner (processing), or neither.
 * The triangle itself is hidden while the spinner is up, matching the Mac.
 */
function applyVoiceStateToOverlay(voiceState: CompanionVoiceStateName): void {
  currentVoiceState = voiceState;

  waveformElement.classList.toggle("is-visible", voiceState === "listening");
  spinnerElement.classList.toggle("is-visible", voiceState === "processing");
  cursorTriangleElement.classList.toggle("is-dimmed", voiceState === "processing");

  if (voiceState === "idle") {
    smoothedAudioLevel = 0;
  }
}

function beginFlightToPointingTarget(targetX: number, targetY: number, elementLabel: string | null): void {
  if (pointingHoldTimer !== null) {
    window.clearTimeout(pointingHoldTimer);
    pointingHoldTimer = null;
  }

  flightStartPosition = { x: companionPosition.x, y: companionPosition.y };
  flightEndPosition = { x: targetX, y: targetY };

  // Bow the arc perpendicular to the direction of travel so the flight curves
  // instead of sliding in a straight line.
  const midpointX = (flightStartPosition.x + flightEndPosition.x) / 2;
  const midpointY = (flightStartPosition.y + flightEndPosition.y) / 2;
  const deltaX = flightEndPosition.x - flightStartPosition.x;
  const deltaY = flightEndPosition.y - flightStartPosition.y;
  const flightDistance = Math.hypot(deltaX, deltaY);
  const arcHeight = Math.min(180, flightDistance * 0.28);

  // Perpendicular unit vector, guarding against a zero-length flight.
  const perpendicularX = flightDistance === 0 ? 0 : -deltaY / flightDistance;
  const perpendicularY = flightDistance === 0 ? 0 : deltaX / flightDistance;

  flightControlPosition = {
    x: midpointX + perpendicularX * arcHeight,
    y: midpointY + perpendicularY * arcHeight,
  };

  flightStartTimestampMs = performance.now();
  overlayMode = "flying";

  if (elementLabel !== null && elementLabel.length > 0) {
    showBubbleWithText(elementLabel, POINTING_FLIGHT_DURATION_MS + POINTING_HOLD_DURATION_MS);
  }
}

// ------------------------------------------------------------- wire up IPC

window.clickyOverlay.onCursorPositionChanged((cursorPosition) => {
  isCursorOnThisDisplay = cursorPosition.isCursorOnThisDisplay;

  // Hide the companion entirely on displays the pointer isn't on, unless it's
  // mid-flight to (or holding at) an element on this display.
  const shouldBeVisible = isCursorOnThisDisplay || overlayMode !== "following";
  companionRootElement.classList.toggle("is-hidden", !shouldBeVisible);

  if (!isCursorOnThisDisplay) {
    return;
  }

  followTargetPosition = {
    x: cursorPosition.localX + CURSOR_FOLLOW_OFFSET_X,
    y: cursorPosition.localY + CURSOR_FOLLOW_OFFSET_Y,
  };

  // On the very first position we get, snap rather than gliding in from (0,0).
  if (companionPosition.x === 0 && companionPosition.y === 0) {
    companionPosition = { ...followTargetPosition };
  }
});

window.clickyOverlay.onVoiceStateChanged((voiceState) => {
  applyVoiceStateToOverlay(voiceState);
});

window.clickyOverlay.onAudioLevelChanged((audioLevel) => {
  // Light smoothing so the bars breathe instead of flickering.
  smoothedAudioLevel = smoothedAudioLevel * 0.7 + Math.min(1, audioLevel * 4) * 0.3;
});

window.clickyOverlay.onShowResponseText((responseText) => {
  showBubbleWithText(responseText, RESPONSE_TEXT_VISIBLE_DURATION_MS);
});

window.clickyOverlay.onFlyToPointingTarget((pointingTarget) => {
  if (!pointingTarget.isTargetDisplay) {
    // The element is on another monitor — make sure this display's companion
    // isn't left holding a stale pointing pose.
    if (overlayMode !== "following") {
      overlayMode = "following";
    }
    return;
  }

  companionRootElement.classList.remove("is-hidden");
  beginFlightToPointingTarget(pointingTarget.localX, pointingTarget.localY, pointingTarget.elementLabel);
});

window.requestAnimationFrame(renderFrame);
