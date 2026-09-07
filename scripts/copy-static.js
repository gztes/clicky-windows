/**
 * Copies the renderer's HTML and CSS into dist/, next to the JavaScript that
 * tsc emits there. Keeping this as a tiny script means the project needs no
 * bundler at all — the renderers are plain <script> tags over compiled files.
 */

const fs = require("fs");
const path = require("path");

const projectRootDirectory = path.join(__dirname, "..");
const rendererSourceDirectory = path.join(projectRootDirectory, "src", "renderer");
const rendererOutputDirectory = path.join(projectRootDirectory, "dist", "renderer");

const STATIC_FILE_EXTENSIONS = [".html", ".css"];

function copyStaticFilesRecursively(sourceDirectory, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });

  for (const directoryEntry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, directoryEntry.name);
    const outputPath = path.join(outputDirectory, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      copyStaticFilesRecursively(sourcePath, outputPath);
      continue;
    }

    if (STATIC_FILE_EXTENSIONS.includes(path.extname(directoryEntry.name))) {
      fs.copyFileSync(sourcePath, outputPath);
    }
  }
}

copyStaticFilesRecursively(rendererSourceDirectory, rendererOutputDirectory);
console.log("Copied renderer HTML and CSS into dist/renderer");
