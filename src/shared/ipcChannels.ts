/**
 * Every IPC channel name in one place, so a typo in a string literal can't
 * silently break a message path between processes.
 */
export const IpcChannels = {
  // ---- Panel renderer → main ----
  panelRequestState: "panel:request-state",
  panelSetSelectedModel: "panel:set-selected-model",
  panelSetCursorEnabled: "panel:set-cursor-enabled",
  panelRequestMicrophonePermission: "panel:request-microphone-permission",
  panelQuitApplication: "panel:quit-application",
  panelOpenExternalUrl: "panel:open-external-url",

  // ---- Main → panel renderer ----
  panelStateUpdated: "panel:state-updated",

  // ---- Main → overlay renderers ----
  overlayVoiceStateChanged: "overlay:voice-state-changed",
  overlayAudioLevelChanged: "overlay:audio-level-changed",
  overlayCursorPositionChanged: "overlay:cursor-position-changed",
  overlayShowResponseText: "overlay:show-response-text",
  overlayFlyToPointingTarget: "overlay:fly-to-pointing-target",
  overlayConfigure: "overlay:configure",

  // ---- Audio renderer → main ----
  audioLevelSample: "audio:level-sample",
  /** Whisper finished; carries the recognised text. */
  audioTranscriptReady: "audio:transcript-ready",
  audioTranscriptionFailed: "audio:transcription-failed",
  /** Whisper model download/warm-up progress, shown in the panel. */
  audioSpeechModelStatus: "audio:speech-model-status",
  audioCaptureFailed: "audio:capture-failed",
  audioPlaybackFinished: "audio:playback-finished",
  audioMicrophonePermissionResult: "audio:microphone-permission-result",

  // ---- Main → audio renderer ----
  audioStartCapture: "audio:start-capture",
  audioStopCapture: "audio:stop-capture",
  audioPlayTtsBuffer: "audio:play-tts-buffer",
  /** Speak on-device (Kokoro, falling back to the Windows voice). */
  audioSpeakLocally: "audio:speak-locally",
  audioStopPlayback: "audio:stop-playback",
  audioProbeMicrophonePermission: "audio:probe-microphone-permission",
  audioPreloadSpeechModel: "audio:preload-speech-model",
} as const;
