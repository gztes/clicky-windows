/**
 * Preload bridge for the cursor overlay renderer.
 * The overlay only ever listens — it never sends anything back to main.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipcChannels";
import type { CompanionVoiceState } from "../shared/types";

interface CursorPositionMessage {
  isCursorOnThisDisplay: boolean;
  localX: number;
  localY: number;
}

interface PointingTargetMessage {
  isTargetDisplay: boolean;
  localX: number;
  localY: number;
  elementLabel: string | null;
}

contextBridge.exposeInMainWorld("clickyOverlay", {
  onConfigure: (
    handleConfigure: (configuration: { displayId: number; displayBounds: Electron.Rectangle }) => void
  ): void => {
    ipcRenderer.on(IpcChannels.overlayConfigure, (_event, configuration) => {
      handleConfigure(configuration);
    });
  },

  onVoiceStateChanged: (handleVoiceState: (voiceState: CompanionVoiceState) => void): void => {
    ipcRenderer.on(IpcChannels.overlayVoiceStateChanged, (_event, voiceState: CompanionVoiceState) => {
      handleVoiceState(voiceState);
    });
  },

  onAudioLevelChanged: (handleAudioLevel: (audioLevel: number) => void): void => {
    ipcRenderer.on(IpcChannels.overlayAudioLevelChanged, (_event, audioLevel: number) => {
      handleAudioLevel(audioLevel);
    });
  },

  onCursorPositionChanged: (
    handleCursorPosition: (cursorPosition: CursorPositionMessage) => void
  ): void => {
    ipcRenderer.on(IpcChannels.overlayCursorPositionChanged, (_event, cursorPosition) => {
      handleCursorPosition(cursorPosition);
    });
  },

  onShowResponseText: (handleResponseText: (responseText: string) => void): void => {
    ipcRenderer.on(IpcChannels.overlayShowResponseText, (_event, responseText: string) => {
      handleResponseText(responseText);
    });
  },

  onFlyToPointingTarget: (
    handlePointingTarget: (pointingTarget: PointingTargetMessage) => void
  ): void => {
    ipcRenderer.on(IpcChannels.overlayFlyToPointingTarget, (_event, pointingTarget) => {
      handlePointingTarget(pointingTarget);
    });
  },
});
