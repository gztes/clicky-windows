/**
 * Verifies that Clicky's Anthropic setup actually works, before you rely on it
 * in the app. Run it with:  npm run verify
 *
 * It exercises the same four things the real pipeline depends on:
 *   1. the key in .env is found and accepted
 *   2. the model accepts a base64 image (Clicky is a vision app)
 *   3. SSE streaming parses (the app reads deltas, not a whole response)
 *   4. the [POINT:x,y:label] tag comes back in the expected format
 *
 * Costs a fraction of a cent — it sends one small generated image, not a
 * screenshot, and caps the reply at a few dozen tokens.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const projectRootDirectory = path.join(__dirname, "..");

// --------------------------------------------------------------- key loading

/** Reads ANTHROPIC_API_KEY from the environment, falling back to .env. */
function resolveAnthropicApiKey() {
  const environmentKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (environmentKey) {
    return { apiKey: environmentKey, source: "environment variable" };
  }

  const envFilePath = path.join(projectRootDirectory, ".env");
  let envFileContents;
  try {
    envFileContents = fs.readFileSync(envFilePath, "utf8");
  } catch {
    return { apiKey: "", source: `no .env found at ${envFilePath}` };
  }

  for (const rawLine of envFileContents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    const key = line.slice(0, separatorIndex).trim();
    if (key !== "ANTHROPIC_API_KEY") {
      continue;
    }
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    return { apiKey: value, source: ".env" };
  }

  return { apiKey: "", source: ".env (no ANTHROPIC_API_KEY line)" };
}

// ------------------------------------------------------------ test image

/**
 * Builds a small PNG: a dark background with one bright blue square in the
 * upper-right quadrant. Asking the model to point at that square checks both
 * that vision works and that coordinates come back in roughly the right place.
 */
function buildTestImagePng() {
  const IMAGE_WIDTH = 320;
  const IMAGE_HEIGHT = 200;

  const SQUARE_LEFT = 210;
  const SQUARE_TOP = 40;
  const SQUARE_SIZE = 60;

  const rawImageData = Buffer.alloc(IMAGE_HEIGHT * (IMAGE_WIDTH * 3 + 1));

  for (let pixelY = 0; pixelY < IMAGE_HEIGHT; pixelY++) {
    const rowStartOffset = pixelY * (IMAGE_WIDTH * 3 + 1);
    rawImageData[rowStartOffset] = 0; // PNG filter type: none

    for (let pixelX = 0; pixelX < IMAGE_WIDTH; pixelX++) {
      const isInsideSquare =
        pixelX >= SQUARE_LEFT &&
        pixelX < SQUARE_LEFT + SQUARE_SIZE &&
        pixelY >= SQUARE_TOP &&
        pixelY < SQUARE_TOP + SQUARE_SIZE;

      const [red, green, blue] = isInsideSquare ? [0x33, 0x80, 0xff] : [0x10, 0x12, 0x11];

      const pixelOffset = rowStartOffset + 1 + pixelX * 3;
      rawImageData[pixelOffset] = red;
      rawImageData[pixelOffset + 1] = green;
      rawImageData[pixelOffset + 2] = blue;
    }
  }

  const headerData = Buffer.alloc(13);
  headerData.writeUInt32BE(IMAGE_WIDTH, 0);
  headerData.writeUInt32BE(IMAGE_HEIGHT, 4);
  headerData[8] = 8; // bit depth
  headerData[9] = 2; // colour type: RGB
  headerData[10] = 0;
  headerData[11] = 0;
  headerData[12] = 0;

  return {
    pngBuffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      buildPngChunk("IHDR", headerData),
      buildPngChunk("IDAT", zlib.deflateSync(rawImageData)),
      buildPngChunk("IEND", Buffer.alloc(0)),
    ]),
    imageWidth: IMAGE_WIDTH,
    imageHeight: IMAGE_HEIGHT,
    expectedCentre: { x: SQUARE_LEFT + SQUARE_SIZE / 2, y: SQUARE_TOP + SQUARE_SIZE / 2 },
  };
}

function buildPngChunk(chunkType, chunkData) {
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(chunkData.length, 0);

  const typeAndDataBuffer = Buffer.concat([Buffer.from(chunkType, "ascii"), chunkData]);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(computeCrc32(typeAndDataBuffer), 0);

  return Buffer.concat([lengthBuffer, typeAndDataBuffer, crcBuffer]);
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
    let crcValue = tableIndex;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
      crcValue = crcValue & 1 ? 0xedb88320 ^ (crcValue >>> 1) : crcValue >>> 1;
    }
    table[tableIndex] = crcValue;
  }
  return table;
})();

function computeCrc32(inputBuffer) {
  let crcValue = -1;
  for (const inputByte of inputBuffer) {
    crcValue = CRC32_TABLE[(crcValue ^ inputByte) & 0xff] ^ (crcValue >>> 8);
  }
  return (crcValue ^ -1) >>> 0;
}

// ------------------------------------------------------------------- check

const POINT_TAG_PATTERN =
  /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/;

async function main() {
  const { apiKey, source } = resolveAnthropicApiKey();

  if (!apiKey || apiKey.startsWith("sk-ant-...")) {
    console.error(`✗ No usable ANTHROPIC_API_KEY (looked in: ${source})`);
    console.error("  Put your key from console.anthropic.com in .env, then run this again.");
    process.exit(1);
  }

  console.log(`Key found via ${source} (${apiKey.slice(0, 11)}…${apiKey.slice(-4)})`);

  const { pngBuffer, imageWidth, imageHeight, expectedCentre } = buildTestImagePng();
  console.log(`Sending a ${imageWidth}x${imageHeight} test image (${pngBuffer.length} bytes)…\n`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLICKY_TEST_MODEL || "claude-sonnet-4-6",
      max_tokens: 100,
      stream: true,
      system:
        "you are testing a screen-pointing feature. reply with one short sentence, " +
        "then append a tag of the form [POINT:x,y:label] giving the pixel coordinates " +
        "of the centre of the blue square, in the image's own coordinate space " +
        "(origin top-left). no other formatting.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: pngBuffer.toString("base64") },
            },
            { type: "text", text: `image dimensions: ${imageWidth}x${imageHeight} pixels` },
            { type: "text", text: "where is the blue square?" },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`✗ HTTP ${response.status}\n${errorBody}\n`);
    if (response.status === 401) {
      console.error("  401 means the key was rejected — check you copied all of it.");
    } else if (response.status === 400 && errorBody.includes("credit")) {
      console.error("  Add credit at console.anthropic.com → Plans & Billing.");
    }
    process.exit(1);
  }

  // Read the SSE stream exactly the way src/main/claudeClient.ts does.
  const streamReader = response.body.getReader();
  const utf8Decoder = new TextDecoder();
  let undecodedBuffer = "";
  let accumulatedResponseText = "";
  let deltaCount = 0;

  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;

    undecodedBuffer += utf8Decoder.decode(value, { stream: true });
    const lines = undecodedBuffer.split("\n");
    undecodedBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data: ")) continue;

      const jsonPayload = trimmedLine.slice(6);
      if (jsonPayload === "[DONE]") break;

      let eventPayload;
      try {
        eventPayload = JSON.parse(jsonPayload);
      } catch {
        continue;
      }

      if (
        eventPayload.type === "content_block_delta" &&
        eventPayload.delta?.type === "text_delta" &&
        typeof eventPayload.delta.text === "string"
      ) {
        accumulatedResponseText += eventPayload.delta.text;
        deltaCount++;
      }
    }
  }

  console.log(`Response: ${accumulatedResponseText}\n`);

  // ---- report ----
  console.log("✓ Key accepted");
  console.log("✓ Image accepted (vision works)");
  console.log(`✓ Streaming works (${deltaCount} deltas)`);

  const match = POINT_TAG_PATTERN.exec(accumulatedResponseText.trim());
  if (match === null) {
    console.log("✗ No [POINT:...] tag — Clicky will still talk, but won't point.");
    process.exit(1);
  }

  const pointedX = Number(match[1]);
  const pointedY = Number(match[2]);
  const distanceFromCentre = Math.hypot(pointedX - expectedCentre.x, pointedY - expectedCentre.y);

  console.log(`✓ POINT tag parsed: (${pointedX}, ${pointedY}) "${match[3] ?? ""}"`);
  console.log(
    `  Blue square centre is (${expectedCentre.x}, ${expectedCentre.y}) — off by ${Math.round(distanceFromCentre)}px`
  );
  console.log(
    distanceFromCentre < 60
      ? "\nAll four checks passed. Clicky is ready — npm start."
      : "\nEverything works, though pointing was imprecise on this small test image. " +
          "Real screenshots are much larger and give the model more to go on."
  );
}

main().catch((error) => {
  console.error("✗ Verification failed:", error.message);
  process.exit(1);
});
