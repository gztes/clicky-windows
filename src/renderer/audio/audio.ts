/**
 * Microphone capture, local speech-to-text, and speech playback.
 *
 * Replaces three pieces of the macOS app at once:
 *   BuddyDictationManager.swift               → microphone capture
 *   AssemblyAIStreamingTranscriptionProvider  → local Whisper instead
 *   ElevenLabsTTSClient.swift (playback half)  → MP3 or Windows system voice
 *
 * Everything here runs in a hidden window because getUserMedia, WebAssembly,
 * audio playback and speechSynthesis are all renderer-only APIs.
 *
 * Transcription is local: Whisper runs in-process through ONNX/WebAssembly, so
 * no audio ever leaves the machine and no speech-to-text account is needed. The
 * model is downloaded once on first use and cached by the browser afterwards.
 */

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

console.log("audio host: script starting");

/** Whisper is trained on 16 kHz mono audio, so we capture at exactly that. */
const TARGET_SAMPLE_RATE_HZ = 16000;

/**
 * Which Whisper checkpoint to run.
 *
 * `tiny.en` quantised to 8-bit is ~40MB and transcribes a few seconds of speech
 * in well under a second on CPU. `base.en` is roughly double the size and
 * meaningfully more accurate. Push-to-talk utterances are short and the wait is
 * felt directly, so tiny is the better default; swap this for
 * "onnx-community/whisper-base.en" if you want the accuracy instead.
 *
 * The onnx-community repos are the ones kept current for transformers.js v3+;
 * the older Xenova ones ship a 4-bit decoder this runtime cannot load.
 */
const WHISPER_MODEL_IDENTIFIER = "onnx-community/whisper-tiny.en";

/**
 * Ignore anything shorter than this — a stray tap of the hotkey produces a few
 * milliseconds of noise that Whisper will happily hallucinate words from.
 */
const MINIMUM_UTTERANCE_DURATION_SECONDS = 0.35;

/** Refuse to transcribe more than this, to bound memory and latency. */
const MAXIMUM_UTTERANCE_DURATION_SECONDS = 120;

/**
 * Kokoro-82M: a small neural text-to-speech model that runs on-device, the
 * same way Whisper does. It is what lets Clicky have a decent voice without an
 * ElevenLabs account, without a per-character bill, and without sending the
 * text of its replies anywhere.
 */
const KOKORO_MODEL_IDENTIFIER = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * Which Kokoro voice to speak with. The catalogue includes American voices
 * (af_heart, af_bella, am_michael) and British ones (bf_emma, bm_george).
 * `af_heart` is the highest-rated in Kokoro's own grading, so it is the
 * default; swap it for `bf_emma` or `bm_george` if you would rather Clicky
 * sounded British.
 */
const KOKORO_VOICE_IDENTIFIER = "af_heart";

/**
 * The AudioWorklet processor, compiled in as a string and loaded from a blob
 * URL. A worklet module has to be fetched from a URL, and a blob keeps it in
 * this one file rather than adding a separate asset to copy at build time.
 *
 * It forwards the raw Float32 samples and an RMS level for the waveform.
 */
const PCM_CAPTURE_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inputChannels = inputs[0];
    if (!inputChannels || inputChannels.length === 0) {
      return true;
    }

    const monoSamples = inputChannels[0];
    if (!monoSamples || monoSamples.length === 0) {
      return true;
    }

    let sumOfSquares = 0;
    for (let sampleIndex = 0; sampleIndex < monoSamples.length; sampleIndex++) {
      sumOfSquares += monoSamples[sampleIndex] * monoSamples[sampleIndex];
    }

    // Copy before posting — the input buffer is reused by the audio engine.
    this.port.postMessage({
      samples: new Float32Array(monoSamples),
      level: Math.sqrt(sumOfSquares / monoSamples.length),
    });

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

let activeAudioContext: AudioContext | null = null;
let activeMicrophoneStream: MediaStream | null = null;
let activeWorkletNode: AudioWorkletNode | null = null;

/** Every chunk captured during the current push-to-talk press. */
let capturedAudioChunks: Float32Array[] = [];
let capturedSampleCount = 0;

let activeTextToSpeechAudioElement: HTMLAudioElement | null = null;
let activeTextToSpeechObjectUrl: string | null = null;

/** The loaded Whisper pipeline, or the in-flight promise that is loading it. */
let speechRecognitionPipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** The loaded Kokoro voice, or the in-flight promise that is loading it. */
let textToSpeechModelPromise: Promise<KokoroTTS> | null = null;

// ----------------------------------------------------------- speech-to-text

/**
 * Loads Whisper, downloading the model on first call and reusing it after.
 *
 * Kept as a single shared promise so that a second push-to-talk during the
 * initial download waits for the same load instead of starting another one.
 */
function loadSpeechRecognitionPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (speechRecognitionPipelinePromise !== null) {
    return speechRecognitionPipelinePromise;
  }

  window.clickyAudio.reportSpeechModelStatus({ state: "loading", progressPercent: 0 });

  speechRecognitionPipelinePromise = pipeline(
    "automatic-speech-recognition",
    WHISPER_MODEL_IDENTIFIER,
    {
      // 8-bit: about 40MB, and no measurable accuracy loss on short speech.
      //
      // Worth knowing if you ever bump the dependency: on transformers.js v4
      // this same setting fails to build a session at all — ONNX Runtime's
      // quantise/dequantise optimiser throws "Missing required scale ...
      // MatMulNBits" on the decoder, on a clean cache and on both the Xenova
      // and onnx-community repos. v3.8.1 loads it fine. If you upgrade to v4
      // and transcription stops working, that's why; fp32 is the escape hatch.
      dtype: "q8",
      // WebAssembly rather than WebGPU: it runs anywhere, and a few seconds of
      // speech through tiny.en is fast enough on CPU that GPU setup isn't
      // worth the extra failure mode.
      device: "wasm",
      progress_callback: (progressEvent: { status?: string; progress?: number }) => {
        if (progressEvent.status === "progress" && typeof progressEvent.progress === "number") {
          window.clickyAudio.reportSpeechModelStatus({
            state: "loading",
            progressPercent: Math.round(progressEvent.progress),
          });
        }
      },
    }
  )
    .then((loadedPipeline) => {
      window.clickyAudio.reportSpeechModelStatus({ state: "ready", progressPercent: 100 });
      return loadedPipeline as AutomaticSpeechRecognitionPipeline;
    })
    .catch((loadError: unknown) => {
      // Clear the cached promise so a later attempt can retry the download
      // rather than being stuck with a permanently rejected one.
      speechRecognitionPipelinePromise = null;
      console.error(
        "speech model failed to load:",
        loadError instanceof Error ? `${loadError.message}
${loadError.stack}` : String(loadError)
      );
      window.clickyAudio.reportSpeechModelStatus({ state: "failed", progressPercent: 0 });
      throw loadError;
    });

  return speechRecognitionPipelinePromise;
}

/** Joins the captured chunks into the single contiguous buffer Whisper wants. */
function concatenateCapturedAudio(): Float32Array {
  const combinedSamples = new Float32Array(capturedSampleCount);
  let writeOffset = 0;

  for (const audioChunk of capturedAudioChunks) {
    combinedSamples.set(audioChunk, writeOffset);
    writeOffset += audioChunk.length;
  }

  return combinedSamples;
}

async function transcribeCapturedAudio(): Promise<void> {
  const capturedDurationSeconds = capturedSampleCount / TARGET_SAMPLE_RATE_HZ;
  const combinedSamples = concatenateCapturedAudio();

  capturedAudioChunks = [];
  capturedSampleCount = 0;

  if (capturedDurationSeconds < MINIMUM_UTTERANCE_DURATION_SECONDS) {
    // Too short to be speech — report an empty transcript so the main process
    // returns to idle instead of asking Claude about a keystroke.
    window.clickyAudio.reportTranscriptReady("");
    return;
  }

  const samplesToTranscribe =
    capturedDurationSeconds > MAXIMUM_UTTERANCE_DURATION_SECONDS
      ? combinedSamples.subarray(0, MAXIMUM_UTTERANCE_DURATION_SECONDS * TARGET_SAMPLE_RATE_HZ)
      : combinedSamples;

  try {
    const speechRecognitionPipeline = await loadSpeechRecognitionPipeline();
    const recognitionResult = await speechRecognitionPipeline(samplesToTranscribe, {
      // Small Whisper models are prone to hallucinated repetition loops —
      // getting stuck repeating a phrase — especially on quiet or noisy audio.
      // These discourage the decoder from looping; cleanUpRepeatedPhrases below
      // is the backstop for when a loop gets through anyway.
      repetition_penalty: 1.3,
      no_repeat_ngram_size: 3,
    });

    // The pipeline returns either one result or an array of them depending on
    // the options used; normalise both shapes to a single string.
    const recognisedText = Array.isArray(recognitionResult)
      ? recognitionResult.map((chunk) => chunk.text).join(" ")
      : recognitionResult.text;

    window.clickyAudio.reportTranscriptReady(cleanUpWhisperOutput(recognisedText));
  } catch (transcriptionError) {
    const errorMessage =
      transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError);
    window.clickyAudio.reportTranscriptionFailed(errorMessage);
  }
}

/**
 * Trims Whisper's characteristic artefacts.
 *
 * On silence or noise it commonly emits bracketed stage directions like
 * "[BLANK_AUDIO]" or "(clears throat)", which would otherwise be sent to Claude
 * as if the user had said them.
 */
function cleanUpWhisperOutput(rawText: string): string {
  const withoutStageDirections = rawText
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // A result that was nothing but stage directions is not speech.
  if (/^[\s.,!?-]*$/.test(withoutStageDirections)) {
    return "";
  }

  return collapseRepeatedPhrases(withoutStageDirections);
}

/**
 * Backstop for Whisper's hallucination loops: on quiet or noisy audio it can
 * get stuck repeating the same short phrase for the rest of the transcript —
 * e.g. "I'm not in my sense. I'm not in my sense. I'm not in my sense. ..."
 * `repetition_penalty`/`no_repeat_ngram_size` on the pipeline call discourage
 * this at generation time, but aren't a hard guarantee, so this catches
 * whatever gets through: if a short sentence repeats three or more times in a
 * row, keep only the first occurrence.
 */
function collapseRepeatedPhrases(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g);
  if (sentences === null || sentences.length < 3) {
    return text;
  }

  const normalise = (sentence: string) => sentence.trim().toLowerCase().replace(/[.,!?]+$/, "");

  const collapsed: string[] = [];
  let previousNormalised: string | null = null;
  let repeatRunLength = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    const normalised = normalise(trimmed);
    if (normalised === previousNormalised) {
      repeatRunLength++;
      // Drop this repeat once the same sentence has shown up 3 times in a row.
      if (repeatRunLength >= 2) continue;
    } else {
      repeatRunLength = 0;
    }

    collapsed.push(trimmed);
    previousNormalised = normalised;
  }

  return collapsed.join(" ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------- microphone capture

async function startMicrophoneCapture(): Promise<void> {
  if (activeAudioContext !== null) {
    return;
  }

  capturedAudioChunks = [];
  capturedSampleCount = 0;

  try {
    activeMicrophoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    window.clickyAudio.reportMicrophonePermission(true);

    // Asking for a 16 kHz context makes Chromium resample for us, so we never
    // have to write a resampler by hand — and it is exactly what Whisper wants.
    const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE_HZ });
    activeAudioContext = audioContext;

    const workletBlobUrl = URL.createObjectURL(
      new Blob([PCM_CAPTURE_WORKLET_SOURCE], { type: "application/javascript" })
    );
    await audioContext.audioWorklet.addModule(workletBlobUrl);
    URL.revokeObjectURL(workletBlobUrl);

    const microphoneSourceNode = audioContext.createMediaStreamSource(activeMicrophoneStream);
    const pcmCaptureWorkletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
    activeWorkletNode = pcmCaptureWorkletNode;

    pcmCaptureWorkletNode.port.onmessage = (workletMessage: MessageEvent) => {
      const { samples, level } = workletMessage.data as { samples: Float32Array; level: number };
      capturedAudioChunks.push(samples);
      capturedSampleCount += samples.length;
      window.clickyAudio.sendAudioLevel(level);
    };

    microphoneSourceNode.connect(pcmCaptureWorkletNode);

    // The worklet produces no output, but Chromium only pulls audio through a
    // node graph that reaches the destination. Routing through a silent gain
    // node keeps the graph alive without playing the mic back to the user.
    const silentGainNode = audioContext.createGain();
    silentGainNode.gain.value = 0;
    pcmCaptureWorkletNode.connect(silentGainNode);
    silentGainNode.connect(audioContext.destination);
  } catch (captureError) {
    const errorMessage = captureError instanceof Error ? captureError.message : String(captureError);
    window.clickyAudio.reportMicrophonePermission(false);
    window.clickyAudio.reportCaptureFailed(errorMessage);
    teardownMicrophoneCapture();
  }
}

/** Stops the microphone and hands whatever was recorded to Whisper. */
function stopMicrophoneCaptureAndTranscribe(): void {
  teardownMicrophoneCapture();
  void transcribeCapturedAudio();
}

function teardownMicrophoneCapture(): void {
  if (activeWorkletNode !== null) {
    activeWorkletNode.port.onmessage = null;
    activeWorkletNode.disconnect();
    activeWorkletNode = null;
  }

  if (activeMicrophoneStream !== null) {
    for (const mediaTrack of activeMicrophoneStream.getTracks()) {
      mediaTrack.stop();
    }
    activeMicrophoneStream = null;
  }

  if (activeAudioContext !== null) {
    void activeAudioContext.close();
    activeAudioContext = null;
  }

  // Level returns to zero so the overlay's waveform settles flat.
  window.clickyAudio.sendAudioLevel(0);
}

// -------------------------------------------------------------- speech out

/**
 * Loads the local Kokoro voice, downloading it once and reusing it after.
 *
 * Kept as a single shared promise so overlapping requests wait on one load
 * rather than each starting their own.
 */
function loadTextToSpeechModel(): Promise<KokoroTTS> {
  if (textToSpeechModelPromise !== null) {
    return textToSpeechModelPromise;
  }

  // Try the GPU first and fall back to CPU. On WebAssembly this model takes
  // upwards of fifteen seconds to synthesise a sentence, which is far too slow
  // to speak a reply; WebGPU is what makes it viable.
  textToSpeechModelPromise = KokoroTTS.from_pretrained(KOKORO_MODEL_IDENTIFIER, {
    // WebGPU wants full precision; the q8 weights are shaped for the CPU path.
    dtype: "fp32",
    device: "webgpu",
  })
    .then((webGpuModel) => {
      console.log("audio host: voice running on WebGPU");
      return webGpuModel;
    })
    .catch(async (webGpuError: unknown) => {
      console.warn(
        "audio host: WebGPU unavailable, falling back to CPU —",
        webGpuError instanceof Error ? webGpuError.message : String(webGpuError)
      );
      const cpuModel = await KokoroTTS.from_pretrained(KOKORO_MODEL_IDENTIFIER, {
        dtype: "q8",
        device: "wasm",
      });
      console.log("audio host: voice running on CPU (slow)");
      return cpuModel;
    })
    .catch((loadError: unknown) => {
    // Clear the cached promise so a later reply can retry rather than being
    // stuck with a permanently rejected one.
    textToSpeechModelPromise = null;
    console.error(
      "voice model failed to load:",
      loadError instanceof Error ? loadError.message : String(loadError)
    );
    throw loadError;
  });

  return textToSpeechModelPromise;
}

/** Starts the voice download without speaking, so the first reply isn't delayed. */
async function preloadTextToSpeechModel(): Promise<void> {
  try {
    await loadTextToSpeechModel();
    console.log("audio host: voice model ready");
  } catch {
    // Non-fatal: speakLocally falls back to the Windows system voice.
    console.warn("audio host: voice model unavailable, will use the Windows voice");
  }
}

function playTextToSpeechAudio(mp3AudioBytes: Uint8Array): void {
  stopAllPlayback();

  // Copy into a fresh ArrayBuffer. The bytes arrive over IPC backed by a
  // Node Buffer's pooled memory, which Blob won't accept directly.
  const mp3ArrayBuffer = new ArrayBuffer(mp3AudioBytes.byteLength);
  new Uint8Array(mp3ArrayBuffer).set(mp3AudioBytes);

  playAudioBlob(new Blob([mp3ArrayBuffer], { type: "audio/mpeg" }));
}

/**
 * Speaks without any hosted service. Tries the local Kokoro voice first and
 * falls back to the built-in Windows voice if the model isn't available, so
 * Clicky is never left silent.
 */
async function speakLocally(text: string): Promise<void> {
  stopAllPlayback();

  try {
    const textToSpeechModel = await loadTextToSpeechModel();
    const synthesisStartedAt = performance.now();
    const generatedAudio = await textToSpeechModel.generate(text, {
      voice: KOKORO_VOICE_IDENTIFIER,
    });
    console.log(
      `audio host: synthesised ${text.length} chars in ${Math.round(performance.now() - synthesisStartedAt)}ms`
    );

    playAudioBlob(generatedAudio.toBlob());
  } catch {
    // Already logged in loadTextToSpeechModel. There is no in-renderer fallback:
    // Electron ships no speech service, so speechSynthesis exposes zero voices
    // (verified on this machine). The Windows engine lives in the main process
    // instead — see src/main/systemVoice.ts — and is the default. Reaching here
    // means Kokoro was explicitly opted into and then failed, so report the
    // playback as finished rather than leaving the state machine stuck.
    console.warn("audio host: no voice available for this reply");
    window.clickyAudio.reportPlaybackFinished();
  }
}

/** Shared playback path for both ElevenLabs MP3 and locally generated WAV. */
function playAudioBlob(audioBlob: Blob): void {
  activeTextToSpeechObjectUrl = URL.createObjectURL(audioBlob);

  const audioElement = new Audio(activeTextToSpeechObjectUrl);
  activeTextToSpeechAudioElement = audioElement;

  // Both a clean finish and a decode failure must return the app to idle,
  // otherwise the spinner would hang forever on a bad audio payload.
  audioElement.onended = () => {
    releaseTextToSpeechResources();
    window.clickyAudio.reportPlaybackFinished();
  };
  audioElement.onerror = () => {
    releaseTextToSpeechResources();
    window.clickyAudio.reportPlaybackFinished();
  };

  void audioElement.play().catch(() => {
    releaseTextToSpeechResources();
    window.clickyAudio.reportPlaybackFinished();
  });
}

function stopAllPlayback(): void {
  if (activeTextToSpeechAudioElement !== null) {
    activeTextToSpeechAudioElement.pause();
    // Drop the handlers first so pausing can't fire the "finished" report and
    // knock a newly started response back to idle.
    activeTextToSpeechAudioElement.onended = null;
    activeTextToSpeechAudioElement.onerror = null;
  }
  releaseTextToSpeechResources();
}

function releaseTextToSpeechResources(): void {
  activeTextToSpeechAudioElement = null;
  if (activeTextToSpeechObjectUrl !== null) {
    URL.revokeObjectURL(activeTextToSpeechObjectUrl);
    activeTextToSpeechObjectUrl = null;
  }
}

// ------------------------------------------------------------- permissions

/**
 * Checks whether the microphone is usable without starting a real capture,
 * so the panel can show a prompt before the first push-to-talk.
 */
async function probeMicrophonePermission(): Promise<void> {
  try {
    const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const mediaTrack of probeStream.getTracks()) {
      mediaTrack.stop();
    }
    window.clickyAudio.reportMicrophonePermission(true);
  } catch {
    window.clickyAudio.reportMicrophonePermission(false);
  }
}

// ------------------------------------------------------------- wire up IPC

window.clickyAudio.onStartCapture(() => {
  void startMicrophoneCapture();
});
window.clickyAudio.onStopCapture(() => stopMicrophoneCaptureAndTranscribe());
window.clickyAudio.onPlayTtsBuffer((mp3AudioBytes) => playTextToSpeechAudio(mp3AudioBytes));
window.clickyAudio.onSpeakLocally((text) => {
  void speakLocally(text);
});
window.clickyAudio.onStopPlayback(() => stopAllPlayback());
window.clickyAudio.onProbeMicrophonePermission(() => {
  void probeMicrophonePermission();
});

// Start fetching the model at launch so the first push-to-talk isn't stuck
// waiting on a cold download.
window.clickyAudio.onPreloadModels(({ shouldPreloadVoiceModel }) => {
  console.log("audio host: preloading transcription model");

  // Transcription is the blocking one — its status drives the panel's progress
  // bar, and nothing works without it.
  void loadSpeechRecognitionPipeline().catch(() => {
    // Already reported through reportSpeechModelStatus; nothing to add here.
  });

  // The voice model is only fetched when it is the chosen engine. It is a large
  // download, and the default Windows voice needs none of it.
  if (shouldPreloadVoiceModel) {
    console.log("audio host: preloading voice model");
    void preloadTextToSpeechModel();
  }
});

console.log("audio host: ready");
