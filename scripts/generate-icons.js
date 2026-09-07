/**
 * Draws the tray icon (the blue Clicky arrow) and writes it as a PNG.
 *
 * Written as a tiny hand-rolled PNG encoder rather than pulling in an image
 * library: the icon is a handful of flat shapes, and this keeps the project's
 * dependency list to just Electron, ws and the keyboard hook.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ICON_SIZE_PIXELS = 32;

/** Clicky's accent blue, #3380FF, plus a white outline for dark taskbars. */
const CURSOR_BLUE = [0x33, 0x80, 0xff];
const OUTLINE_WHITE = [0xff, 0xff, 0xff];

/**
 * The arrow as a polygon in a 0..1 space, so it scales to any icon size.
 * Roughly matches the SVG path used in the overlay.
 */
const ARROW_POLYGON_NORMALIZED = [
  [0.24, 0.1],
  [0.78, 0.52],
  [0.5, 0.58],
  [0.62, 0.85],
  [0.47, 0.9],
  [0.36, 0.63],
  [0.2, 0.76],
];

/** Standard even-odd point-in-polygon test. */
function isPointInsidePolygon(testX, testY, polygonPoints) {
  let isInside = false;

  for (
    let currentIndex = 0, previousIndex = polygonPoints.length - 1;
    currentIndex < polygonPoints.length;
    previousIndex = currentIndex++
  ) {
    const [currentX, currentY] = polygonPoints[currentIndex];
    const [previousX, previousY] = polygonPoints[previousIndex];

    const doesEdgeStraddleTestY = currentY > testY !== previousY > testY;
    if (!doesEdgeStraddleTestY) {
      continue;
    }

    const intersectionX =
      ((previousX - currentX) * (testY - currentY)) / (previousY - currentY) + currentX;

    if (testX < intersectionX) {
      isInside = !isInside;
    }
  }

  return isInside;
}

/** Builds raw RGBA pixels for the icon, anti-aliased by 3x3 supersampling. */
function renderIconPixels() {
  const scaledPolygon = ARROW_POLYGON_NORMALIZED.map(([normalizedX, normalizedY]) => [
    normalizedX * ICON_SIZE_PIXELS,
    normalizedY * ICON_SIZE_PIXELS,
  ]);

  // One extra byte per row for the PNG filter type.
  const rawImageData = Buffer.alloc(ICON_SIZE_PIXELS * (ICON_SIZE_PIXELS * 4 + 1));
  const SUPERSAMPLE_STEPS = 3;

  for (let pixelY = 0; pixelY < ICON_SIZE_PIXELS; pixelY++) {
    const rowStartOffset = pixelY * (ICON_SIZE_PIXELS * 4 + 1);
    rawImageData[rowStartOffset] = 0; // filter type: none

    for (let pixelX = 0; pixelX < ICON_SIZE_PIXELS; pixelX++) {
      let insideSampleCount = 0;
      let nearEdgeSampleCount = 0;

      for (let subY = 0; subY < SUPERSAMPLE_STEPS; subY++) {
        for (let subX = 0; subX < SUPERSAMPLE_STEPS; subX++) {
          const sampleX = pixelX + (subX + 0.5) / SUPERSAMPLE_STEPS;
          const sampleY = pixelY + (subY + 0.5) / SUPERSAMPLE_STEPS;

          if (isPointInsidePolygon(sampleX, sampleY, scaledPolygon)) {
            insideSampleCount++;
          } else if (isPointInsidePolygon(sampleX, sampleY, expandPolygon(scaledPolygon, 1.15))) {
            // Just outside the fill but inside the expanded shape: that's the outline.
            nearEdgeSampleCount++;
          }
        }
      }

      const totalSampleCount = SUPERSAMPLE_STEPS * SUPERSAMPLE_STEPS;
      const fillCoverage = insideSampleCount / totalSampleCount;
      const outlineCoverage = nearEdgeSampleCount / totalSampleCount;

      const [red, green, blue] = fillCoverage > 0 ? CURSOR_BLUE : OUTLINE_WHITE;
      const alpha = Math.round(Math.min(1, fillCoverage + outlineCoverage) * 255);

      const pixelOffset = rowStartOffset + 1 + pixelX * 4;
      rawImageData[pixelOffset] = red;
      rawImageData[pixelOffset + 1] = green;
      rawImageData[pixelOffset + 2] = blue;
      rawImageData[pixelOffset + 3] = alpha;
    }
  }

  return rawImageData;
}

/** Scales a polygon outward from its centroid, used to draw the outline. */
function expandPolygon(polygonPoints, scaleFactor) {
  const centroidX =
    polygonPoints.reduce((runningTotal, [pointX]) => runningTotal + pointX, 0) / polygonPoints.length;
  const centroidY =
    polygonPoints.reduce((runningTotal, [, pointY]) => runningTotal + pointY, 0) / polygonPoints.length;

  return polygonPoints.map(([pointX, pointY]) => [
    centroidX + (pointX - centroidX) * scaleFactor,
    centroidY + (pointY - centroidY) * scaleFactor,
  ]);
}

/** Wraps a chunk's data with its length, type and CRC, per the PNG spec. */
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

function encodePng(rawImageData) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const headerData = Buffer.alloc(13);
  headerData.writeUInt32BE(ICON_SIZE_PIXELS, 0);
  headerData.writeUInt32BE(ICON_SIZE_PIXELS, 4);
  headerData[8] = 8; // bit depth
  headerData[9] = 6; // colour type: RGBA
  headerData[10] = 0; // compression: deflate
  headerData[11] = 0; // filter: adaptive
  headerData[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    buildPngChunk("IHDR", headerData),
    buildPngChunk("IDAT", zlib.deflateSync(rawImageData)),
    buildPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const assetsDirectory = path.join(__dirname, "..", "assets");
fs.mkdirSync(assetsDirectory, { recursive: true });

const trayIconOutputPath = path.join(assetsDirectory, "trayIcon.png");
fs.writeFileSync(trayIconOutputPath, encodePng(renderIconPixels()));

console.log(`Wrote ${trayIconOutputPath} (${ICON_SIZE_PIXELS}x${ICON_SIZE_PIXELS})`);
