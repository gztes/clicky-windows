/**
 * Preload bridge for the hidden audio renderer — microphone capture and local
 * Whisper transcription in, speech playback out.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipcChannels";
import type { SpeechModelStatus } from "../shared/types";

contextBridge.exposeInMainWorld("clickyAudio", {
  // ---- main → renderer ----

  onStartCapture: (handleStartCapture: () => void): void => {
    ipcRenderer.on(IpcChannels.audioStartCapture, () => handleStartCapture());
  },

  onStopCapture: (handleStopCapture: () => void): void => {
    ipcRenderer.on(IpcChannels.audioStopCapture, () => handleStopCapture());
  },

  onPlayTtsBuffer: (handlePlayTtsBuffer: (mp3AudioBytes: Uint8Array) => void): void => {
    ipcRenderer.on(IpcChannels.audioPlayTtsBuffer, (_event, mp3AudioBytes: Uint8Array) => {
      handlePlayTtsBuffer(mp3AudioBytes);
    });
  },

  onSpeakLocally: (handleSpeak: (text: string) => void): void => {
    ipcRenderer.on(IpcChannels.audioSpeakLocally, (_event, text: string) => {
      handleSpeak(text);
    });
  },

  onStopPlayback: (handleStopPlayback: () => void): void => {
    ipcRenderer.on(IpcChannels.audioStopPlayback, () => handleStopPlayback());
  },

  onProbeMicrophonePermission: (handleProbe: () => void): void => {
    ipcRenderer.on(IpcChannels.audioProbeMicrophonePermission, () => handleProbe());
  },

  onPreloadModels: (
    handlePreload: (options: { shouldPreloadVoiceModel: boolean }) => void
  ): void => {
    ipcRenderer.on(IpcChannels.audioPreloadSpeechModel, (_event, options) => {
      handlePreload(options);
    });
  },

  // ---- renderer → main ----

  sendAudioLevel: (audioLevel: number): void => {
    ipcRenderer.send(IpcChannels.audioLevelSample, audioLevel);
  },

  reportTranscriptReady: (transcript: string): void => {
    ipcRenderer.send(IpcChannels.audioTranscriptReady, transcript);
  },

  reportTranscriptionFailed: (errorMessage: string): void => {
    ipcRenderer.send(IpcChannels.audioTranscriptionFailed, errorMessage);
  },

  reportSpeechModelStatus: (speechModelStatus: SpeechModelStatus): void => {
    ipcRenderer.send(IpcChannels.audioSpeechModelStatus, speechModelStatus);
  },

  reportCaptureFailed: (errorMessage: string): void => {
    ipcRenderer.send(IpcChannels.audioCaptureFailed, errorMessage);
  },

  reportMicrophonePermission: (isGranted: boolean): void => {
    ipcRenderer.send(IpcChannels.audioMicrophonePermissionResult, isGranted);
  },

  reportPlaybackFinished: (): void => {
    ipcRenderer.send(IpcChannels.audioPlaybackFinished);
  },
});
