/**
 * Claude vision client with SSE streaming, talking to the Cloudflare Worker's
 * /chat route. Ported from ClaudeAPI.swift.
 *
 * The Worker holds the real Anthropic key and forwards the body untouched, so
 * the request shape here is exactly the Anthropic Messages API shape.
 */

import { chatAuthHeaders, chatEndpointUrl } from "./config";
import type { CapturedScreen } from "../shared/types";

/** One prior exchange, replayed so Claude remembers the conversation. */
export interface ConversationExchange {
  userTranscript: string;
  assistantResponse: string;
}

/**
 * The companion's system prompt, copied verbatim from
 * `companionVoiceResponseSystemPrompt` in CompanionManager.swift so the
 * Windows build behaves identically to the Mac one.
 */
export const COMPANION_VOICE_RESPONSE_SYSTEM_PROMPT = `you're clicky, a friendly always-on companion that lives in the user's menu bar. the user just spoke to you via push-to-talk and you can see their screen(s). your reply will be spoken aloud via text-to-speech, so write the way you'd actually talk. this is an ongoing conversation — you remember everything they've said before.

rules:
- default to one or two sentences. be direct and dense. BUT if the user asks you to explain more, go deeper, or elaborate, then go all out — give a thorough, detailed explanation with no length limit.
- all lowercase, casual, warm. no emojis.
- write for the ear, not the eye. short sentences. no lists, bullet points, markdown, or formatting — just natural speech.
- don't use abbreviations or symbols that sound weird read aloud. write "for example" not "e.g.", spell out small numbers.
- if the user's question relates to what's on their screen, reference specific things you see.
- if the screenshot doesn't seem relevant to their question, just answer the question directly.
- you can help with anything — coding, writing, general knowledge, brainstorming.
- never say "simply" or "just".
- don't read out code verbatim. describe what the code does or what needs to change conversationally.
- focus on giving a thorough, useful explanation. don't end with simple yes/no questions like "want me to explain more?" or "should i show you?" — those are dead ends that force the user to just say yes.
- instead, when it fits naturally, end by planting a seed — mention something bigger or more ambitious they could try, a related concept that goes deeper, or a next-level technique that builds on what you just explained. make it something worth coming back for, not a question they'd just nod to. it's okay to not end with anything extra if the answer is complete on its own.
- if you receive multiple screen images, the one labeled "primary focus" is where the cursor is — prioritize that one but reference others if relevant.

element pointing:
you have a small blue triangle cursor that can fly to and point at things on screen. use it whenever pointing would genuinely help the user — if they're asking how to do something, looking for a menu, trying to find a button, or need help navigating an app, point at the relevant element. err on the side of pointing rather than not pointing, because it makes your help way more useful and concrete.

don't point at things when it would be pointless — like if the user asks a general knowledge question, or the conversation has nothing to do with what's on screen, or you'd just be pointing at something obvious they're already looking at. but if there's a specific UI element, menu, button, or area on screen that's relevant to what you're helping with, point at it.

when you point, append a coordinate tag at the very end of your response, AFTER your spoken text. the screenshot images are labeled with their pixel dimensions. use those dimensions as the coordinate space. the origin (0,0) is the top-left corner of the image. x increases rightward, y increases downward.

format: [POINT:x,y:label] where x,y are integer pixel coordinates in the screenshot's coordinate space, and label is a short 1-3 word description of the element (like "search bar" or "save button"). if the element is on the cursor's screen you can omit the screen number. if the element is on a DIFFERENT screen, append :screenN where N is the screen number from the image label (e.g. :screen2). this is important — without the screen number, the cursor will point at the wrong place.

if pointing wouldn't help, append [POINT:none].

examples:
- user asks how to color grade in final cut: "you'll want to open the color inspector — it's right up in the top right area of the toolbar. click that and you'll get all the color wheels and curves. [POINT:1100,42:color inspector]"
- user asks what html is: "html stands for hypertext markup language, it's basically the skeleton of every web page. curious how it connects to the css you're looking at? [POINT:none]"
- user asks how to commit in xcode: "see that source control menu up top? click that and hit commit, or you can use command option c as a shortcut. [POINT:285,11:source control]"
- element is on screen 2 (not where cursor is): "that's over on your other monitor — see the terminal window? [POINT:400,300:terminal:screen2]"`;

/**
 * Sends the screenshots plus the user's transcript to Claude and streams the
 * reply back. `onTextChunk` receives the accumulated text so far each time a
 * new delta arrives, matching the Swift callback's semantics.
 *
 * `abortSignal` lets the caller cancel an in-flight response when the user
 * starts talking again.
 */
export async function requestStreamingCompanionResponse(options: {
  capturedScreens: CapturedScreen[];
  userTranscript: string;
  conversationHistory: ConversationExchange[];
  modelIdentifier: string;
  abortSignal: AbortSignal;
  onTextChunk: (accumulatedText: string) => void;
  /**
   * What DAI (Clicky's shared memory, across all of the user's tools) knows
   * about the user, if anything. Empty/omitted when DAI has no memory yet —
   * Clicky's persona and behavior are otherwise unchanged.
   */
  daiMemoryContext?: string;
}): Promise<string> {
  const systemPrompt =
    options.daiMemoryContext && options.daiMemoryContext.trim().length > 0
      ? `${COMPANION_VOICE_RESPONSE_SYSTEM_PROMPT}\n\nwhat dai (your memory, shared across all the user's tools, not just this one) knows about the user:\n${options.daiMemoryContext.trim()}`
      : COMPANION_VOICE_RESPONSE_SYSTEM_PROMPT;

  const messages: unknown[] = [];

  // Replay prior turns so Claude has the conversation in context. We only send
  // the text of past turns, never the old screenshots — that would balloon the
  // payload for very little benefit.
  for (const exchange of options.conversationHistory) {
    messages.push({ role: "user", content: exchange.userTranscript });
    messages.push({ role: "assistant", content: exchange.assistantResponse });
  }

  // The current turn: every screen as an image, each followed by its label,
  // then the spoken transcript last.
  const currentTurnContentBlocks: unknown[] = [];
  for (const capturedScreen of options.capturedScreens) {
    currentTurnContentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: capturedScreen.imageBase64,
      },
    });
    currentTurnContentBlocks.push({
      type: "text",
      text: `${capturedScreen.label} (image dimensions: ${capturedScreen.screenshotWidthInPixels}x${capturedScreen.screenshotHeightInPixels} pixels)`,
    });
  }
  currentTurnContentBlocks.push({ type: "text", text: options.userTranscript });
  messages.push({ role: "user", content: currentTurnContentBlocks });

  const requestBody = {
    model: options.modelIdentifier,
    max_tokens: 1024,
    stream: true,
    system: systemPrompt,
    messages,
  };

  const response = await fetch(chatEndpointUrl(), {
    method: "POST",
    // In local mode these carry the Anthropic key; when proxying through
    // the Worker they are empty and the Worker adds its own.
    headers: { "content-type": "application/json", ...chatAuthHeaders() },
    body: JSON.stringify(requestBody),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude request failed (HTTP ${response.status}): ${errorBody}`);
  }

  if (response.body === null) {
    throw new Error("Claude response had no body to stream.");
  }

  return await readServerSentEventTextStream(response.body, options.onTextChunk);
}

/**
 * Reads an Anthropic SSE stream and accumulates the `text_delta` chunks.
 *
 * SSE frames arrive as `data: {json}\n\n`, but chunk boundaries fall wherever
 * the network puts them — so we buffer and only process complete lines.
 */
async function readServerSentEventTextStream(
  responseBody: ReadableStream<Uint8Array>,
  onTextChunk: (accumulatedText: string) => void
): Promise<string> {
  const streamReader = responseBody.getReader();
  const utf8Decoder = new TextDecoder();

  let undecodedBuffer = "";
  let accumulatedResponseText = "";

  while (true) {
    const { done, value } = await streamReader.read();
    if (done) {
      break;
    }

    undecodedBuffer += utf8Decoder.decode(value, { stream: true });

    // Everything up to the last newline is complete; keep the remainder buffered.
    const lines = undecodedBuffer.split("\n");
    undecodedBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data: ")) {
        continue;
      }

      const jsonPayload = trimmedLine.slice("data: ".length);
      if (jsonPayload === "[DONE]") {
        return accumulatedResponseText;
      }

      let eventPayload: { type?: string; delta?: { type?: string; text?: string } };
      try {
        eventPayload = JSON.parse(jsonPayload);
      } catch {
        // Partial or non-JSON keepalive frame — skip it.
        continue;
      }

      if (
        eventPayload.type === "content_block_delta" &&
        eventPayload.delta?.type === "text_delta" &&
        typeof eventPayload.delta.text === "string"
      ) {
        accumulatedResponseText += eventPayload.delta.text;
        onTextChunk(accumulatedResponseText);
      }
    }
  }

  return accumulatedResponseText;
}
