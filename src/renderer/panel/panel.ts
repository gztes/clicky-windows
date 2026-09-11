/**
 * The tray panel's UI logic.
 * Ported from CompanionPanelView.swift.
 *
 * The panel is a pure view over the state the main process publishes: it never
 * holds state of its own, it just re-renders whenever a new PanelState lands.
 */

/** Kept in sync with AVAILABLE_CLAUDE_MODELS in src/shared/types.ts. */
const SELECTABLE_CLAUDE_MODELS = [
  { identifier: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "faster, cheaper" },
  { identifier: "claude-opus-4-6", displayName: "Opus 4.6", description: "smarter, slower" },
];

/** The status line under the Clicky title, per voice state. */
const STATUS_TEXT_BY_VOICE_STATE: Record<CompanionVoiceStateName, string> = {
  idle: "Ready",
  listening: "Listening…",
  processing: "Thinking…",
  responding: "Speaking…",
};

const panelStatusDotElement = document.getElementById("panel-status-dot") as HTMLDivElement;
const panelStatusTextElement = document.getElementById("panel-status-text") as HTMLParagraphElement;
const setupNoticeElement = document.getElementById("setup-notice") as HTMLElement;
const speechModelNoticeElement = document.getElementById("speech-model-notice") as HTMLElement;
const speechModelTitleElement = document.getElementById("speech-model-title") as HTMLParagraphElement;
const speechModelBodyElement = document.getElementById("speech-model-body") as HTMLParagraphElement;
const speechModelProgressFillElement = document.getElementById(
  "speech-model-progress-fill"
) as HTMLDivElement;
const voiceSourceTextElement = document.getElementById("voice-source-text") as HTMLParagraphElement;
const microphoneNoticeElement = document.getElementById("microphone-notice") as HTMLElement;
const retryMicrophoneButton = document.getElementById("retry-microphone-button") as HTMLButtonElement;
const modelOptionsElement = document.getElementById("model-options") as HTMLDivElement;
const cursorToggleInput = document.getElementById("cursor-toggle-input") as HTMLInputElement;
const transcriptSectionElement = document.getElementById("transcript-section") as HTMLElement;
const transcriptTextElement = document.getElementById("transcript-text") as HTMLParagraphElement;
const errorSectionElement = document.getElementById("error-section") as HTMLElement;
const errorTextElement = document.getElementById("error-text") as HTMLParagraphElement;
const quitButton = document.getElementById("quit-button") as HTMLButtonElement;

/**
 * Builds the model picker once; selection is applied on every render.
 *
 * A compact segmented pill (see #model-options in panel.css), matching
 * CompanionPanelView.swift's modelPickerRow — single-word-scale labels, no
 * description line under each one. The description isn't lost, just moved
 * to a native tooltip via `title`, so hovering still shows "faster, cheaper"
 * without the row needing to be tall enough for two lines of text.
 */
function buildModelOptions(): void {
  for (const selectableModel of SELECTABLE_CLAUDE_MODELS) {
    const modelOptionButton = document.createElement("button");
    modelOptionButton.type = "button";
    modelOptionButton.className = "model-option";
    modelOptionButton.dataset.modelIdentifier = selectableModel.identifier;
    modelOptionButton.title = selectableModel.description;
    // textContent, never innerHTML, so a model name can never inject markup.
    modelOptionButton.textContent = selectableModel.displayName;

    modelOptionButton.addEventListener("click", () => {
      window.clickyPanel.setSelectedModel(selectableModel.identifier);
    });

    modelOptionsElement.appendChild(modelOptionButton);
  }
}

function renderPanelState(panelState: ClickyPanelState): void {
  panelStatusTextElement.textContent = STATUS_TEXT_BY_VOICE_STATE[panelState.voiceState];
  panelStatusDotElement.dataset.voiceState = panelState.voiceState;

  setupNoticeElement.classList.toggle("is-hidden", panelState.isClaudeConfigured);

  // Only nag about the microphone once the API key is in place, so the user
  // isn't shown two blocking notices at once on first launch.
  const shouldShowMicrophoneNotice =
    panelState.isClaudeConfigured && !panelState.hasMicrophonePermission;
  microphoneNoticeElement.classList.toggle("is-hidden", !shouldShowMicrophoneNotice);

  renderSpeechModelStatus(panelState.speechModelStatus);

  // Say which voice is speaking, and how to upgrade it. The system voice is
  // the default because it needs no account.
  if (panelState.isElevenLabsConfigured) {
    voiceSourceTextElement.textContent = "ElevenLabs (hosted)";
  } else if (panelState.localVoiceEngine === "kokoro") {
    voiceSourceTextElement.textContent = "Kokoro — on-device neural voice";
  } else {
    voiceSourceTextElement.textContent =
      "Windows voice — add ELEVENLABS_API_KEY for a better one";
  }

  for (const modelOptionButton of Array.from(
    modelOptionsElement.querySelectorAll<HTMLButtonElement>(".model-option")
  )) {
    const isSelectedModel =
      modelOptionButton.dataset.modelIdentifier === panelState.selectedModelIdentifier;
    modelOptionButton.classList.toggle("is-selected", isSelectedModel);
  }

  cursorToggleInput.checked = panelState.isClickyCursorEnabled;

  const hasTranscript =
    panelState.lastTranscript !== null && panelState.lastTranscript.trim().length > 0;
  transcriptSectionElement.classList.toggle("is-hidden", !hasTranscript);
  transcriptTextElement.textContent = panelState.lastTranscript ?? "";

  const hasError = panelState.lastErrorMessage !== null;
  errorSectionElement.classList.toggle("is-hidden", !hasError);
  errorTextElement.textContent = panelState.lastErrorMessage ?? "";
}

/**
 * Shows download progress for the local Whisper model, and only while it
 * matters — once the model is cached this never appears again.
 */
function renderSpeechModelStatus(speechModelStatus: ClickySpeechModelStatus): void {
  const shouldShowNotice =
    speechModelStatus.state === "loading" || speechModelStatus.state === "failed";
  speechModelNoticeElement.classList.toggle("is-hidden", !shouldShowNotice);

  if (speechModelStatus.state === "failed") {
    speechModelTitleElement.textContent = "Speech model failed to download";
    speechModelBodyElement.textContent =
      "Check your connection. Clicky will retry on the next push-to-talk.";
    speechModelProgressFillElement.style.width = "0%";
    return;
  }

  speechModelTitleElement.textContent = "Downloading speech model";
  speechModelBodyElement.textContent =
    "One-off download. Speech runs on your machine after this, offline.";
  speechModelProgressFillElement.style.width = `${speechModelStatus.progressPercent}%`;
}

cursorToggleInput.addEventListener("change", () => {
  window.clickyPanel.setCursorEnabled(cursorToggleInput.checked);
});

retryMicrophoneButton.addEventListener("click", () => {
  window.clickyPanel.requestMicrophonePermission();
});

quitButton.addEventListener("click", () => {
  window.clickyPanel.quitApplication();
});

buildModelOptions();
window.clickyPanel.onStateUpdated(renderPanelState);
void window.clickyPanel.requestState().then(renderPanelState);
