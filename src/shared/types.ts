/**
 * Shared types used across the main process, preload scripts, and renderers.
 *
 * Ported from the macOS Clicky's CompanionManager state machine. The voice
 * state names are kept identical to the Swift original so behaviour is easy
 * to compare between the two codebases.
 */

/** Mirrors `CompanionVoiceState` in CompanionManager.swift. */
export type CompanionVoiceState = "idle" | "listening" | "processing" | "responding";

/** The Claude models the user can pick between in the panel. */
export const AVAILABLE_CLAUDE_MODELS = [
  { identifier: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "faster, cheaper" },
  { identifier: "claude-opus-4-6", displayName: "Opus 4.6", description: "smarter, slower" },
] as const;

export const DEFAULT_CLAUDE_MODEL_IDENTIFIER = "claude-sonnet-4-6";

/**
 * One captured display, ready to send to Claude.
 *
 * `screenshotWidthInPixels` is the size of the image Claude actually sees, and
 * `displayBounds` is where that display lives in Windows' virtual screen space.
 * We need both because Claude returns coordinates in screenshot pixel space and
 * the overlay needs them in screen space.
 */
export interface CapturedScreen {
  /** Base64-encoded JPEG (no data: prefix) — what gets sent to Claude. */
  imageBase64: string;
  /** Human-readable label telling Claude which screen this is. */
  label: string;
  /** True when the mouse cursor is currently on this display. */
  isCursorScreen: boolean;
  /** Electron's display id, used to match this capture back to a display. */
  displayId: number;
  /** Position and size of this display in Windows' virtual screen coordinates. */
  displayBounds: { x: number; y: number; width: number; height: number };
  screenshotWidthInPixels: number;
  screenshotHeightInPixels: number;
}

/** Result of parsing a `[POINT:x,y:label:screenN]` tag out of Claude's response. */
export interface PointingParseResult {
  /** Response text with the tag stripped — this is what gets spoken aloud. */
  spokenText: string;
  /** Pixel coordinate in the screenshot's space, or null for `[POINT:none]`. */
  coordinate: { x: number; y: number } | null;
  /** Short description of the element, e.g. "save button". */
  elementLabel: string | null;
  /** 1-based screen number, or null to default to the cursor's screen. */
  screenNumber: number | null;
}

/** Where the cursor should fly to, in Windows virtual-screen coordinates. */
export interface PointingTarget {
  screenX: number;
  screenY: number;
  displayId: number;
  elementLabel: string | null;
}

/**
 * Progress of the local Whisper model. The model is downloaded once on first
 * use (~40MB) and cached afterwards, so the panel needs to show that it is
 * happening rather than appearing to hang on the first push-to-talk.
 */
export interface SpeechModelStatus {
  state: "idle" | "loading" | "ready" | "failed";
  progressPercent: number;
}

/** State the panel renderer needs to draw itself. */
export interface PanelState {
  voiceState: CompanionVoiceState;
  selectedModelIdentifier: string;
  isClickyCursorEnabled: boolean;
  hasMicrophonePermission: boolean;
  /** Whether Clicky can reach Claude — a local API key, or a Worker URL. */
  isClaudeConfigured: boolean;
  /** False means Clicky speaks with one of the local engines below. */
  isElevenLabsConfigured: boolean;
  /** Which engine speaks when ElevenLabs isn't configured. */
  localVoiceEngine: "windows" | "kokoro";
  speechModelStatus: SpeechModelStatus;
  lastTranscript: string | null;
  lastErrorMessage: string | null;
}
