/**
 * Preload bridge for the control panel renderer.
 * Exposes a narrow, typed API instead of handing the renderer `ipcRenderer`.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipcChannels";
import type { PanelState } from "../shared/types";

contextBridge.exposeInMainWorld("clickyPanel", {
  requestState: (): Promise<PanelState> => ipcRenderer.invoke(IpcChannels.panelRequestState),

  onStateUpdated: (handleStateUpdate: (panelState: PanelState) => void): void => {
    ipcRenderer.on(IpcChannels.panelStateUpdated, (_event, panelState: PanelState) => {
      handleStateUpdate(panelState);
    });
  },

  setSelectedModel: (modelIdentifier: string): void => {
    ipcRenderer.send(IpcChannels.panelSetSelectedModel, modelIdentifier);
  },

  setCursorEnabled: (isEnabled: boolean): void => {
    ipcRenderer.send(IpcChannels.panelSetCursorEnabled, isEnabled);
  },

  requestMicrophonePermission: (): void => {
    ipcRenderer.send(IpcChannels.panelRequestMicrophonePermission);
  },

  openExternalUrl: (externalUrl: string): void => {
    ipcRenderer.send(IpcChannels.panelOpenExternalUrl, externalUrl);
  },

  quitApplication: (): void => {
    ipcRenderer.send(IpcChannels.panelQuitApplication);
  },
});
