/**
 * Types for the APIs the preload scripts expose on `window`.
 *
 * This file deliberately has no imports or exports: the renderer TypeScript is
 * compiled with `"module": "None"` so each renderer file is a plain script that
 * a <script> tag can load directly, with no bundler in the pipeline.
 */

type CompanionVoiceStateName = "idle" | "listening" | "processing" | "responding";

interface ClickySpeechModelStatus {
  state: "idle" | "loading" | "ready" | "failed";
  progressPercent: number;
}

interface ClickyPanelState {
  voiceState: CompanionVoiceStateName;
  selectedModelIdentifier: string;
  isClickyCursorEnabled: boolean;
  hasMicrophonePermission: boolean;
  isClaudeConfigured: boolean;
  isElevenLabsConfigured: boolean;
  localVoiceEngine: "windows" | "kokoro";
  speechModelStatus: ClickySpeechModelStatus;
  lastTranscript: string | null;
  lastErrorMessage: string | null;
}

interface ClickyPanelApi {
  requestState(): Promise<ClickyPanelState>;
  onStateUpdated(handleStateUpdate: (panelState: ClickyPanelState) => void): void;
  setSelectedModel(modelIdentifier: string): void;
  setCursorEnabled(isEnabled: boolean): void;
  requestMicrophonePermission(): void;
  openExternalUrl(externalUrl: string): void;
  quitApplication(): void;
}

interface ClickyOverlayCursorPosition {
  isCursorOnThisDisplay: boolean;
  localX: number;
  localY: number;
}

interface ClickyOverlayPointingTarget {
  isTargetDisplay: boolean;
  localX: number;
  localY: number;
  elementLabel: string | null;
}

interface ClickyOverlayApi {
  onConfigure(
    handleConfigure: (configuration: {
      displayId: number;
      displayBounds: { x: number; y: number; width: number; height: number };
    }) => void
  ): void;
  onVoiceStateChanged(handleVoiceState: (voiceState: CompanionVoiceStateName) => void): void;
  onAudioLevelChanged(handleAudioLevel: (audioLevel: number) => void): void;
  onCursorPositionChanged(
    handleCursorPosition: (cursorPosition: ClickyOverlayCursorPosition) => void
  ): void;
  onShowResponseText(handleResponseText: (responseText: string) => void): void;
  onFlyToPointingTarget(
    handlePointingTarget: (pointingTarget: ClickyOverlayPointingTarget) => void
  ): void;
}

interface ClickyAudioApi {
  onStartCapture(handleStartCapture: () => void): void;
  onStopCapture(handleStopCapture: () => void): void;
  onPlayTtsBuffer(handlePlayTtsBuffer: (mp3AudioBytes: Uint8Array) => void): void;
  onSpeakLocally(handleSpeak: (text: string) => void): void;
  onStopPlayback(handleStopPlayback: () => void): void;
  onProbeMicrophonePermission(handleProbe: () => void): void;
  onPreloadModels(
    handlePreload: (options: { shouldPreloadVoiceModel: boolean }) => void
  ): void;
  sendAudioLevel(audioLevel: number): void;
  reportTranscriptReady(transcript: string): void;
  reportTranscriptionFailed(errorMessage: string): void;
  reportSpeechModelStatus(speechModelStatus: ClickySpeechModelStatus): void;
  reportCaptureFailed(errorMessage: string): void;
  reportMicrophonePermission(isGranted: boolean): void;
  reportPlaybackFinished(): void;
}

interface Window {
  clickyPanel: ClickyPanelApi;
  clickyOverlay: ClickyOverlayApi;
  clickyAudio: ClickyAudioApi;
}
