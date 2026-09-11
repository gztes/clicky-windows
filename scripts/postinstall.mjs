/**
 * Runs automatically after `npm install`. Does the boring, non-interactive
 * groundwork so the very next command can be `npm start`:
 *   - generates the tray icon (otherwise the tray shows a blank square),
 *   - creates a .env from .env.example if you don't have one yet.
 *
 * It never prompts and never fails the install: anything that goes wrong here
 * is recoverable with `npm run setup`, so this stays quiet and exits cleanly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconPath = path.join(projectRoot, "assets", "trayIcon.png");
const envPath = path.join(projectRoot, ".env");
const envExamplePath = path.join(projectRoot, ".env.example");

try {
  if (!fs.existsSync(iconPath)) {
    execFileSync(process.execPath, [path.join(projectRoot, "scripts", "generate-icons.js")], {
      stdio: "ignore",
    });
  }
} catch {
  // generate-icons is also part of `npm run build`, so this is not fatal.
}

try {
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
} catch {
  // `npm run setup` will create it interactively.
}

process.exit(0);
