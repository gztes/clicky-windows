/**
 * The central state machine — the Windows counterpart of CompanionManager.swift.
 *
 * Owns the whole push-to-talk pipeline:
 *
 *   hold Ctrl+Alt
 *     → capture microphone audio while held
 *   release Ctrl+Alt
 *     → transcribe locally with Whisper (no speech-to-text account, no upload)
 *     → screenshot every display
 *     → send transcript + screenshots to Claude (SSE)
 *     → strip the [POINT:...] tag, speak the rest via ElevenLabs
 *     → fly the blue cursor to the pointed-at element
 */

import { ipcMain, screen } from "electron";
import { AudioWindowManager } from "./audioWindow";
import { requestStreamingCompanionResponse, type ConversationExchange } from "./claudeClient";
import * as config from "./config";
import { appendDaiMemoryNote, readDaiMemoryContext } from "./daiMemory";
import { GlobalPushToTalkMonitor } from "./globalPushToTalk";
import { OverlayWindowManager } from "./overlayWindows";
import { PanelWindowManager } from "./panelWindow";
import { parsePointingCoordinates, resolvePointingTarget } from "./pointParser";
import { captureAllScreens } from "./screenCapture";
import { speakWithWindowsVoice, stopWindowsVoice } from "./systemVoice";
import { prepareSpeech } from "./ttsClient";
import { IpcChannels } from "../shared/ipcChannels";
import type { CompanionVoiceState, PanelState, SpeechModelStatus } from "../shared/types";

/** How many past exchanges to replay to Claude, matching the Mac's cap. */
const MAX_CONVERSATION_EXCHANGES = 10;

/** How often the overlay is told where the mouse is. ~60fps. */
const CURSOR_POSITION_POLL_INTERVAL_MS = 16;

/**
 * How long the overlay lingers after the interaction ends when the cursor is
 * toggled off ("transient cursor mode" in the Swift). Matches the 1s delay.
 */
const TRANSIENT_OVERLAY_HIDE_DELAY_MS = 1000;

export class CompanionManager {
  private readonly overlayWindowManager = new OverlayWindowManager();
  private readonly panelWindowManager = new PanelWindowManager();
  private readonly audioWindowManager = new AudioWindowManager();
  private readonly pushToTalkMonitor: GlobalPushToTalkMonitor;

  private voiceState: CompanionVoiceState = "idle";
  private lastTranscript: string | null = null;
  private lastErrorMessage: string | null = null;
  private hasMicrophonePermission = false;

  private conversationHistory: ConversationExchange[] = [];

  /** True from the moment the hotkey goes down until a transcript comes back. */
  private isCapturingSpeech = false;

  private speechModelStatus: SpeechModelStatus = { state: "idle", progressPercent: 0 };

  /** Aborts an in-flight Claude/TTS request when the user starts talking again. */
  private currentResponseAbortController: AbortController | null = null;

  private cursorPositionPollTimer: NodeJS.Timeout | null = null;
  private transientOverlayHideTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.pushToTalkMonitor = new GlobalPushToTalkMonitor({
      onShortcutPressed: () => this.handlePushToTalkPressed(),
      onShortcutReleased: () => this.handlePushToTalkReleased(),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.audioWindowManager.create();
    this.registerIpcHandlers();
    this.pushToTalkMonitor.start();

    if (config.isClickyCursorEnabled()) {
      this.overlayWindowManager.showOverlay();
    }

    this.startCursorPositionPolling();

    // Rebuild overlays when a monitor is plugged in, unplugged, or rearranged.
    screen.on("display-added", () => this.overlayWindowManager.rebuildForDisplayChange());
    screen.on("display-removed", () => this.overlayWindowManager.rebuildForDisplayChange());
    screen.on("display-metrics-changed", () => this.overlayWindowManager.rebuildForDisplayChange());

    // Ask the audio renderer whether the mic is usable, so the panel can show
    // a prompt instead of failing silently on the first press. At the same time
    // start fetching the Whisper model, so the first push-to-talk doesn't sit
    // waiting on a cold download.
    setTimeout(() => {
      this.audioWindowManager.probeMicrophonePermission();
      this.audioWindowManager.preloadModels(config.localVoiceEngine() === "kokoro");
      this.speakStartupTestPhraseIfRequested();
    }, 1500);
  }

  /**
   * Speaks a phrase at launch when CLICKY_TEST_VOICE is set, so the voice and
   * its synthesis latency can be checked without doing a full push-to-talk
   * round trip. Purely a development affordance; unset, it does nothing.
   */
  private speakStartupTestPhraseIfRequested(): void {
    const testPhrase = process.env.CLICKY_TEST_VOICE?.trim();
    if (!testPhrase) {
      return;
    }
    console.log(`Speaking test phrase: "${testPhrase}"`);
    this.audioWindowManager.speakLocally(testPhrase);

    // Speak it again once the first has finished. The first synthesis pays for
    // ONNX graph compilation, so only the second reflects real-world latency.
    setTimeout(() => this.audioWindowManager.speakLocally(testPhrase), 30000);
  }

  stop(): void {
    stopWindowsVoice();
    this.pushToTalkMonitor.stop();
    this.stopCursorPositionPolling();
    this.overlayWindowManager.destroyAllOverlayWindows();
    this.audioWindowManager.destroy();
  }

  get panelWindows(): PanelWindowManager {
    return this.panelWindowManager;
  }

  // ------------------------------------------------------------- state fan-out

  private setVoiceState(newVoiceState: CompanionVoiceState): void {
    if (this.voiceState === newVoiceState) {
      return;
    }
    this.voiceState = newVoiceState;
    this.overlayWindowManager.broadcastVoiceState(newVoiceState);
    this.publishPanelState();
  }

  private currentPanelState(): PanelState {
    return {
      voiceState: this.voiceState,
      selectedModelIdentifier: config.selectedModelIdentifier(),
      isClickyCursorEnabled: config.isClickyCursorEnabled(),
      hasMicrophonePermission: this.hasMicrophonePermission,
      isClaudeConfigured: config.isClaudeConfigured(),
      isElevenLabsConfigured: config.isElevenLabsConfigured(),
      localVoiceEngine: config.localVoiceEngine(),
      speechModelStatus: this.speechModelStatus,
      lastTranscript: this.lastTranscript,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  private publishPanelState(): void {
    this.panelWindowManager.sendToPanel(IpcChannels.panelStateUpdated, this.currentPanelState());
  }

  private reportError(errorMessage: string): void {
    console.error(errorMessage);
    this.lastErrorMessage = errorMessage;
    this.setVoiceState("idle");
    this.publishPanelState();
  }

  // ------------------------------------------------------- cursor position feed

  private startCursorPositionPolling(): void {
    if (this.cursorPositionPollTimer !== null) {
      return;
    }
    this.cursorPositionPollTimer = setInterval(() => {
      this.overlayWindowManager.broadcastCursorPosition();
    }, CURSOR_POSITION_POLL_INTERVAL_MS);
  }

  private stopCursorPositionPolling(): void {
    if (this.cursorPositionPollTimer !== null) {
      clearInterval(this.cursorPositionPollTimer);
      this.cursorPositionPollTimer = null;
    }
  }

  // ------------------------------------------------------------- push-to-talk

  private handlePushToTalkPressed(): void {
    if (!config.isClaudeConfigured()) {
      this.reportError("Add ANTHROPIC_API_KEY to your .env before using push-to-talk.");
      return;
    }

    // A new utterance cancels whatever Clicky was in the middle of saying.
    this.cancelInFlightResponse();
    this.cancelTransientOverlayHide();

    // In transient mode the overlay is normally hidden; fade it in for the
    // duration of this interaction.
    if (!config.isClickyCursorEnabled()) {
      this.overlayWindowManager.showOverlay();
    }

    // Guards against Windows' auto-repeat keydown events restarting capture
    // mid-utterance.
    if (this.isCapturingSpeech) {
      return;
    }

    this.isCapturingSpeech = true;
    this.lastErrorMessage = null;
    this.setVoiceState("listening");
    this.audioWindowManager.startMicrophoneCapture();
  }

  private handlePushToTalkReleased(): void {
    if (!this.isCapturingSpeech) {
      return;
    }

    this.isCapturingSpeech = false;

    // Whisper runs locally, so "processing" now covers transcription as well as
    // the Claude call. The renderer replies on audioTranscriptReady when done.
    this.setVoiceState("processing");
    this.audioWindowManager.stopMicrophoneCapture();
  }

  /** Called when local Whisper has finished transcribing the utterance. */
  private handleTranscriptReady(transcript: string): void {
    const trimmedTranscript = transcript.trim();

    if (trimmedTranscript.length === 0) {
      // Silence, a stray keypress, or audio Whisper found no words in — go
      // quiet rather than asking Claude about nothing.
      this.setVoiceState("idle");
      this.scheduleTransientOverlayHideIfNeeded();
      return;
    }

    this.lastTranscript = trimmedTranscript;
    this.publishPanelState();
    void this.sendTranscriptToClaudeWithScreenshots(trimmedTranscript);
  }

  // ---------------------------------------------------------- response pipeline

  private cancelInFlightResponse(): void {
    this.currentResponseAbortController?.abort();
    this.currentResponseAbortController = null;
    this.audioWindowManager.stopTextToSpeechPlayback();
    stopWindowsVoice();
  }

  /**
   * The heart of it: screenshot → Claude → strip the point tag → speak → point.
   * Mirrors `sendTranscriptToClaudeWithScreenshot` in CompanionManager.swift.
   */
  private async sendTranscriptToClaudeWithScreenshots(transcript: string): Promise<void> {
    const responseAbortController = new AbortController();
    this.currentResponseAbortController = responseAbortController;

    this.setVoiceState("processing");

    try {
      const capturedScreens = await captureAllScreens();
      if (responseAbortController.signal.aborted) {
        return;
      }

      const fullResponseText = await requestStreamingCompanionResponse({
        capturedScreens,
        userTranscript: transcript,
        conversationHistory: this.conversationHistory,
        modelIdentifier: config.selectedModelIdentifier(),
        abortSignal: responseAbortController.signal,
        daiMemoryContext: readDaiMemoryContext(),
        onTextChunk: () => {
          // The Mac deliberately shows no streaming text — the spinner stays up
          // until the voice starts. Kept identical here.
        },
      });

      if (responseAbortController.signal.aborted) {
        return;
      }

      const parseResult = parsePointingCoordinates(fullResponseText);
      const spokenText = parseResult.spokenText;

      // Remember this exchange, with the point tag stripped so it can't
      // confuse later turns. Trim to the most recent N.
      this.conversationHistory.push({ userTranscript: transcript, assistantResponse: spokenText });
      if (this.conversationHistory.length > MAX_CONVERSATION_EXCHANGES) {
        this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_EXCHANGES);
      }

      // "Make DAI remember everything Clicky does for you" — report the exchange
      // back to DAI's shared memory. Best-effort; never blocks or breaks the loop.
      appendDaiMemoryNote(`[clicky] user asked: "${transcript}" — clicky replied: "${spokenText}"`);

      const pointingTarget = resolvePointingTarget(parseResult, capturedScreens);

      // Drop the spinner before the cursor flies, otherwise the spinner covers
      // the triangle and the flight animation is invisible. Same ordering bug
      // the Swift comments call out.
      if (pointingTarget !== null) {
        this.setVoiceState("idle");
        this.overlayWindowManager.sendPointingTarget(pointingTarget);
        console.log(
          `Pointing at (${Math.round(pointingTarget.screenX)}, ${Math.round(pointingTarget.screenY)}) — "${pointingTarget.elementLabel ?? "element"}"`
        );
      }

      this.overlayWindowManager.broadcastResponseText(spokenText);

      await this.speakResponse(spokenText, responseAbortController);
    } catch (pipelineError) {
      if (responseAbortController.signal.aborted) {
        return;
      }
      this.reportError(
        `Response failed: ${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`
      );
    } finally {
      if (this.currentResponseAbortController === responseAbortController) {
        this.currentResponseAbortController = null;
      }
    }
  }

  private async speakResponse(
    spokenText: string,
    responseAbortController: AbortController
  ): Promise<void> {
    if (spokenText.trim().length === 0) {
      this.setVoiceState("idle");
      this.scheduleTransientOverlayHideIfNeeded();
      return;
    }

    const speechPlan = await prepareSpeech(spokenText, responseAbortController.signal);
    if (responseAbortController.signal.aborted) {
      return;
    }

    // The spinner stays up until audio actually starts, so the state only
    // becomes "responding" once the voice is handed off to the renderer.
    this.setVoiceState("responding");

    if (speechPlan.kind === "audio") {
      console.log(`Speaking with ${speechPlan.engineName}`);
      this.audioWindowManager.playTextToSpeechAudio(speechPlan.mp3AudioBuffer);
    } else if (config.localVoiceEngine() === "kokoro") {
      this.audioWindowManager.speakLocally(speechPlan.text);
    } else {
      // The Windows engine runs in this process, so it reports completion
      // through a callback rather than the audio renderer's IPC message.
      speakWithWindowsVoice(speechPlan.text, () => {
        this.setVoiceState("idle");
        this.scheduleTransientOverlayHideIfNeeded();
      });
    }
  }

  // -------------------------------------------------------- transient overlay

  private scheduleTransientOverlayHideIfNeeded(): void {
    if (config.isClickyCursorEnabled()) {
      return;
    }
    this.cancelTransientOverlayHide();
    this.transientOverlayHideTimer = setTimeout(() => {
      this.overlayWindowManager.hideOverlay();
      this.transientOverlayHideTimer = null;
    }, TRANSIENT_OVERLAY_HIDE_DELAY_MS);
  }

  private cancelTransientOverlayHide(): void {
    if (this.transientOverlayHideTimer !== null) {
      clearTimeout(this.transientOverlayHideTimer);
      this.transientOverlayHideTimer = null;
    }
  }

  // -------------------------------------------------------------- IPC handlers

  private registerIpcHandlers(): void {
    ipcMain.handle(IpcChannels.panelRequestState, () => this.currentPanelState());

    ipcMain.on(IpcChannels.panelSetSelectedModel, (_event, modelIdentifier: string) => {
      config.setSelectedModelIdentifier(modelIdentifier);
      this.publishPanelState();
    });

    ipcMain.on(IpcChannels.panelSetCursorEnabled, (_event, isEnabled: boolean) => {
      config.setClickyCursorEnabled(isEnabled);
      this.cancelTransientOverlayHide();
      if (isEnabled) {
        this.overlayWindowManager.showOverlay();
      } else {
        this.overlayWindowManager.hideOverlay();
      }
      this.publishPanelState();
    });

    ipcMain.on(IpcChannels.panelRequestMicrophonePermission, () => {
      this.audioWindowManager.probeMicrophonePermission();
    });

    // ---- from the audio renderer ----

    ipcMain.on(IpcChannels.audioTranscriptReady, (_event, transcript: string) => {
      this.handleTranscriptReady(transcript);
    });

    ipcMain.on(IpcChannels.audioTranscriptionFailed, (_event, errorMessage: string) => {
      this.reportError(`Transcription failed: ${errorMessage}`);
    });

    ipcMain.on(IpcChannels.audioSpeechModelStatus, (_event, speechModelStatus: SpeechModelStatus) => {
      // Only log meaningful transitions, not every progress tick.
      if (speechModelStatus.state !== this.speechModelStatus.state) {
        console.log(`Whisper model: ${speechModelStatus.state}`);
      }
      this.speechModelStatus = speechModelStatus;
      this.publishPanelState();
    });

    ipcMain.on(IpcChannels.audioLevelSample, (_event, audioLevel: number) => {
      this.overlayWindowManager.broadcastAudioLevel(audioLevel);
    });

    ipcMain.on(IpcChannels.audioMicrophonePermissionResult, (_event, isGranted: boolean) => {
      this.hasMicrophonePermission = isGranted;
      this.publishPanelState();
    });

    ipcMain.on(IpcChannels.audioCaptureFailed, (_event, errorMessage: string) => {
      this.hasMicrophonePermission = false;
      this.isCapturingSpeech = false;
      this.reportError(`Microphone capture failed: ${errorMessage}`);
    });

    ipcMain.on(IpcChannels.audioPlaybackFinished, () => {
      this.setVoiceState("idle");
      this.scheduleTransientOverlayHideIfNeeded();
    });
  }
}
