/**
 * Text-to-speech. Ported from ElevenLabsTTSClient.swift.
 *
 * Four engines, tried in descending order of quality:
 *
 *   ElevenLabs   — what upstream Clicky uses. Needs an API key (or a Worker).
 *   Edge         — Microsoft's neural voices via the Read Aloud endpoint.
 *                  Free, no account, very good. Undocumented, and the spoken
 *                  text leaves the machine.
 *   Kokoro-82M   — a neural voice on-device. Opt in with CLICKY_LOCAL_VOICE,
 *                  and only worth it on a capable GPU (see config.ts).
 *   Windows      — the system speech engine. Always available, robotic.
 *
 * Each tier falls through to the next on failure, so a rate limit, an expired
 * key, or a dead endpoint degrades the voice rather than silencing Clicky.
 */

import {
  isEdgeVoiceEnabled,
  isElevenLabsConfigured,
  textToSpeechAuthHeaders,
  textToSpeechEndpointUrl,
} from "./config";
import { synthesizeEdgeSpeech } from "./edgeVoice";

/** Matches the model the macOS app used — low latency, good enough quality. */
const ELEVENLABS_MODEL_IDENTIFIER = "eleven_flash_v2_5";

export type SpeechPlan =
  /** Play these MP3 bytes through the audio renderer. */
  | { kind: "audio"; mp3AudioBuffer: Buffer; engineName: string }
  /** Fall back to an on-machine voice, chosen by the caller. */
  | { kind: "localVoice"; text: string };

/**
 * Produces whatever is needed to speak `text`, trying each engine in turn.
 *
 * A cancelled request is the user talking again rather than a failure, so it
 * propagates immediately instead of falling through to a lesser voice.
 */
export async function prepareSpeech(
  text: string,
  abortSignal: AbortSignal
): Promise<SpeechPlan> {
  if (isElevenLabsConfigured()) {
    try {
      return {
        kind: "audio",
        mp3AudioBuffer: await synthesizeElevenLabsAudio(text, abortSignal),
        engineName: "ElevenLabs",
      };
    } catch (elevenLabsError) {
      if (abortSignal.aborted) {
        throw elevenLabsError;
      }
      console.error("ElevenLabs failed, trying Edge:", elevenLabsError);
    }
  }

  if (isEdgeVoiceEnabled()) {
    try {
      return {
        kind: "audio",
        mp3AudioBuffer: await synthesizeEdgeSpeech(text, abortSignal),
        engineName: "Edge",
      };
    } catch (edgeError) {
      if (abortSignal.aborted) {
        throw edgeError;
      }
      console.error("Edge speech failed, falling back to a local voice:", edgeError);
    }
  }

  return { kind: "localVoice", text };
}

async function synthesizeElevenLabsAudio(
  text: string,
  abortSignal: AbortSignal
): Promise<Buffer> {
  const response = await fetch(textToSpeechEndpointUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "audio/mpeg",
      ...textToSpeechAuthHeaders(),
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_IDENTIFIER,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Text-to-speech failed (HTTP ${response.status}): ${errorBody}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
