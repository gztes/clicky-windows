/**
 * Neural speech through Microsoft Edge's Read Aloud service.
 *
 * This is the same endpoint Edge uses to read pages aloud. It needs no API key
 * and no account, and the voices are near-ElevenLabs quality — which makes it
 * the best-sounding option Clicky can offer for free.
 *
 * Two things to be clear about:
 *
 *  - It is an undocumented endpoint, not a supported public API. It may change
 *    or stop working without notice, so every call falls back to the Windows
 *    voice rather than leaving Clicky silent.
 *  - The text being spoken is sent to Microsoft. That is Clicky's own reply,
 *    not your prompt and not your screenshots — but it does leave the machine.
 *    Set CLICKY_EDGE_VOICE=off to disable it.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { edgeVoiceName } from "./config";

/**
 * Give up if the service hasn't produced audio in this long. Without a cap a
 * hung websocket would leave Clicky stuck on the spinner indefinitely.
 */
const EDGE_SYNTHESIS_TIMEOUT_MS = 12000;

/**
 * Synthesises `text` and resolves with MP3 bytes, which the audio renderer
 * plays through exactly the same path as ElevenLabs audio.
 */
export async function synthesizeEdgeSpeech(
  text: string,
  abortSignal: AbortSignal
): Promise<Buffer> {
  const textToSpeechClient = new MsEdgeTTS();

  await textToSpeechClient.setMetadata(
    edgeVoiceName(),
    OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
  );

  try {
    return await collectAudioStream(textToSpeechClient, text, abortSignal);
  } finally {
    // Always close the websocket, including on timeout or abort, so a failed
    // reply can't leak a connection.
    try {
      textToSpeechClient.close();
    } catch {
      // Already closed, or never opened — nothing useful to do.
    }
  }
}

function collectAudioStream(
  textToSpeechClient: MsEdgeTTS,
  text: string,
  abortSignal: AbortSignal
): Promise<Buffer> {
  return new Promise<Buffer>((resolveWithAudio, rejectWithError) => {
    const { audioStream } = textToSpeechClient.toStream(text);
    const audioChunks: Buffer[] = [];

    let hasSettled = false;

    const settleOnce = (settleAction: () => void) => {
      if (hasSettled) {
        return;
      }
      hasSettled = true;
      clearTimeout(synthesisTimeoutTimer);
      abortSignal.removeEventListener("abort", handleAbort);
      audioStream.destroy();
      settleAction();
    };

    const synthesisTimeoutTimer = setTimeout(() => {
      settleOnce(() =>
        rejectWithError(new Error(`Edge speech timed out after ${EDGE_SYNTHESIS_TIMEOUT_MS}ms`))
      );
    }, EDGE_SYNTHESIS_TIMEOUT_MS);

    const handleAbort = () => {
      settleOnce(() => rejectWithError(new Error("Edge speech was cancelled")));
    };
    abortSignal.addEventListener("abort", handleAbort, { once: true });

    audioStream.on("data", (audioChunk: Buffer) => audioChunks.push(audioChunk));

    audioStream.on("end", () => {
      const combinedAudio = Buffer.concat(audioChunks);
      // An empty body means the service accepted the request but gave nothing
      // back — treat that as a failure so the caller falls back, rather than
      // "playing" silence and reporting success.
      if (combinedAudio.length === 0) {
        settleOnce(() => rejectWithError(new Error("Edge speech returned no audio")));
        return;
      }
      settleOnce(() => resolveWithAudio(combinedAudio));
    });

    audioStream.on("error", (streamError: Error) => {
      settleOnce(() => rejectWithError(streamError));
    });
  });
}
