/**
 * A hidden, never-shown window whose only job is audio.
 *
 * Why a window at all: microphone capture (getUserMedia + AudioWorklet), local
 * Whisper transcription (WebAssembly), and speech playback are all Web APIs
 * that only exist in a renderer. The macOS app could use AVAudioEngine and
 * AVAudioPlayer directly from its main actor; on Electron we need a renderer to
 * host them. Keeping it separate from the overlay means the audio pipeline
 * can't be disturbed by the overlay being hidden or rebuilt when monitors
 * change.
 */

import { BrowserWindow } from "electron";
import * as path from "path";
import { IpcChannels } from "../shared/ipcChannels";

interface QueuedAudioMessage {
  channelName: string;
  payload?: unknown;
}

export class AudioWindowManager {
  private audioBrowserWindow: BrowserWindow | null = null;

  /**
   * A hidden window loads lazily — Chromium gives it no rendering priority, so
   * its scripts can take a second or more to start executing. Anything sent
   * before that point is silently dropped, because the renderer hasn't
   * registered its IPC handlers yet. So messages are queued until the page
   * reports that it has finished loading, then replayed in order.
   */
  private hasFinishedLoading = false;
  private queuedMessages: QueuedAudioMessage[] = [];

  create(): void {
    if (this.audioBrowserWindow !== null && !this.audioBrowserWindow.isDestroyed()) {
      return;
    }

    this.hasFinishedLoading = false;
    this.queuedMessages = [];

    const audioBrowserWindow = new BrowserWindow({
      width: 320,
      height: 200,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/audioPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // The preload scripts import shared modules by relative path, which the
        // sandboxed preload loader cannot resolve (it only exposes a minimal
        // require). Disabling the sandbox gives preload real Node resolution.
        // The renderer itself stays isolated: contextIsolation is on and
        // nodeIntegration is off, so page code still gets no Node access.
        sandbox: false,
        // Chromium throttles timers and audio processing in hidden windows.
        // Push-to-talk has to keep capturing while the window is never shown,
        // so background throttling must be off.
        backgroundThrottling: false,
      },
    });

    this.audioBrowserWindow = audioBrowserWindow;

    // This window is never visible, so anything it logs or throws would
    // otherwise vanish. Forward it to the main log where it can be seen.
    audioBrowserWindow.webContents.on(
      "console-message",
      (_event, _level, message, lineNumber, sourceId) => {
        console.log(`[audio] ${message} (${sourceId}:${lineNumber})`);
      }
    );

    audioBrowserWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`[audio] preload failed at ${preloadPath}:`, error);
    });

    audioBrowserWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(`[audio] window failed to load: ${errorDescription} (${errorCode})`);
    });

    audioBrowserWindow.webContents.on("did-finish-load", () => {
      this.hasFinishedLoading = true;
      this.flushQueuedMessages();
    });

    void audioBrowserWindow.loadFile(path.join(__dirname, "../renderer/audio/index.html"));
  }

  private flushQueuedMessages(): void {
    const messagesToSend = this.queuedMessages;
    this.queuedMessages = [];

    for (const queuedMessage of messagesToSend) {
      this.sendToAudioRenderer(queuedMessage.channelName, queuedMessage.payload);
    }
  }

  private sendToAudioRenderer(channelName: string, payload?: unknown): void {
    if (this.audioBrowserWindow === null || this.audioBrowserWindow.isDestroyed()) {
      return;
    }

    if (!this.hasFinishedLoading) {
      this.queuedMessages.push({ channelName, payload });
      return;
    }

    this.audioBrowserWindow.webContents.send(channelName, payload);
  }

  startMicrophoneCapture(): void {
    this.sendToAudioRenderer(IpcChannels.audioStartCapture);
  }

  stopMicrophoneCapture(): void {
    this.sendToAudioRenderer(IpcChannels.audioStopCapture);
  }

  /** Hands the renderer an MP3 body to play (ElevenLabs). */
  playTextToSpeechAudio(mp3AudioBuffer: Buffer): void {
    this.sendToAudioRenderer(IpcChannels.audioPlayTtsBuffer, mp3AudioBuffer);
  }

  /** Speaks on-device, when ElevenLabs isn't configured. */
  speakLocally(text: string): void {
    this.sendToAudioRenderer(IpcChannels.audioSpeakLocally, text);
  }

  stopTextToSpeechPlayback(): void {
    this.sendToAudioRenderer(IpcChannels.audioStopPlayback);
  }

  probeMicrophonePermission(): void {
    this.sendToAudioRenderer(IpcChannels.audioProbeMicrophonePermission);
  }

  /**
   * Kicks off the model downloads at launch, so the first push-to-talk doesn't
   * sit waiting on a cold fetch.
   *
   * `shouldPreloadVoiceModel` is false unless Kokoro is the chosen voice — it
   * is a large download, and fetching it for a user who speaks through the
   * Windows engine would be pure waste.
   */
  preloadModels(shouldPreloadVoiceModel: boolean): void {
    this.sendToAudioRenderer(IpcChannels.audioPreloadSpeechModel, {
      shouldPreloadVoiceModel,
    });
  }

  destroy(): void {
    if (this.audioBrowserWindow !== null && !this.audioBrowserWindow.isDestroyed()) {
      this.audioBrowserWindow.destroy();
    }
    this.audioBrowserWindow = null;
    this.hasFinishedLoading = false;
    this.queuedMessages = [];
  }
}
