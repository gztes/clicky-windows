/**
 * One-command setup for Clicky.  `npm run setup`
 *
 * Does the three things that otherwise trip people up on first boot:
 *   1. makes sure the tray icon exists (generates it if missing),
 *   2. makes sure a .env exists (copies it from .env.example),
 *   3. puts your Anthropic API key into that .env — asked for interactively,
 *      so you never have to open the file by hand.
 *
 * Then it offers to run the verify check, so you know it works before you
 * ever press Ctrl+Alt. Safe to run again any time; it only asks for what's
 * still missing.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
const envExamplePath = path.join(projectRoot, ".env.example");
const iconPath = path.join(projectRoot, "assets", "trayIcon.png");

const KEY_NAME = "ANTHROPIC_API_KEY";
const PLACEHOLDER = "sk-ant-...";

function log(line = "") {
  process.stdout.write(line + "\n");
}

/** Reads the current ANTHROPIC_API_KEY from the real environment, then .env. */
function currentKey() {
  const fromEnv = process.env[KEY_NAME]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const contents = fs.readFileSync(envPath, "utf8");
    for (const raw of contents.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      if (line.slice(0, i).trim() !== KEY_NAME) continue;
      return line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env yet
  }
  return "";
}

function looksUsable(key) {
  return key.length > 0 && !key.startsWith(PLACEHOLDER);
}

/**
 * Rewrites (or appends) the ANTHROPIC_API_KEY line in .env, leaving everything
 * else untouched. Works line-by-line so it is safe with CRLF files (.env.example
 * ships with Windows line endings), and preserves whichever ending is in use.
 */
function writeKeyToEnv(key) {
  let contents = "";
  try {
    contents = fs.readFileSync(envPath, "utf8");
  } catch {
    contents = "";
  }
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.length ? contents.split(/\r?\n/) : [];
  const newLine = `${KEY_NAME}=${key}`;

  const index = lines.findIndex((line) => new RegExp(`^\\s*${KEY_NAME}\\s*=`).test(line));
  if (index !== -1) {
    lines[index] = newLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    lines.push(newLine);
  }

  let output = lines.join(eol);
  if (!output.endsWith(eol)) {
    output += eol;
  }
  fs.writeFileSync(envPath, output, "utf8");
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function main() {
  log("\nClicky setup\n============\n");

  // 1. Tray icon -----------------------------------------------------------
  if (fs.existsSync(iconPath)) {
    log("• Tray icon    already generated");
  } else {
    try {
      execFileSync(process.execPath, [path.join(projectRoot, "scripts", "generate-icons.js")], {
        stdio: "ignore",
      });
      log("• Tray icon    generated");
    } catch {
      log("• Tray icon    could not generate (npm run generate-icons will retry)");
    }
  }

  // 2. .env file -----------------------------------------------------------
  if (fs.existsSync(envPath)) {
    log("• .env         found");
  } else if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    log("• .env         created from .env.example");
  } else {
    fs.writeFileSync(envPath, `${KEY_NAME}=${PLACEHOLDER}\n`, "utf8");
    log("• .env         created");
  }

  // 3. API key -------------------------------------------------------------
  if (looksUsable(currentKey())) {
    log("• API key      already set\n");
  } else {
    log("");
    log("Clicky needs an Anthropic API key (from https://console.anthropic.com).");
    log("This is API credit billed per request — a Claude Pro/Max subscription is a");
    log("different thing and will not work here.\n");
    const entered = await ask("Paste your ANTHROPIC_API_KEY (or press Enter to skip): ");
    if (looksUsable(entered)) {
      writeKeyToEnv(entered);
      log("\n• API key      saved to .env\n");
    } else {
      log(`\n• API key      skipped — add it to ${path.relative(projectRoot, envPath)} before starting.\n`);
      log("Setup finished. Run `npm start` once your key is in place.\n");
      return;
    }
  }

  // 4. Offer to verify -----------------------------------------------------
  const answer = (await ask("Test the key against Claude now? (Y/n): ")).toLowerCase();
  if (answer === "" || answer === "y" || answer === "yes") {
    log("");
    try {
      execFileSync(process.execPath, [path.join(projectRoot, "scripts", "verify-api-key.js")], {
        stdio: "inherit",
      });
    } catch {
      log("\nVerification did not pass. Fix the key above, then run `npm run verify` again.\n");
      return;
    }
  }

  log("\nAll set. Start Clicky with:  npm start\n");
}

main().catch((error) => {
  log(`\nSetup hit an error: ${error.message}`);
  process.exit(1);
});
