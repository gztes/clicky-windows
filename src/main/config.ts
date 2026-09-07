/**
 * Runtime configuration, API keys, and lightweight persistence.
 *
 * Clicky for Windows runs in "local mode": the main process calls Anthropic and
 * ElevenLabs directly, with keys read from a local `.env` file. The upstream
 * macOS app routed everything through a Cloudflare Worker because it ships as a
 * public download and can't put keys in a binary strangers install. Running on
 * your own machine, that indirection buys nothing — a gitignored file only your
 * main process reads is at least as safe, and one less service to trust.
 *
 * The Worker is still supported: set CLICKY_WORKER_URL and requests route
 * through it instead, with no key needed locally. See worker/ in this repo.
 */

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_CLAUDE_MODEL_IDENTIFIER } from "../shared/types";

/** ElevenLabs voice used when none is configured — upstream Clicky's default. */
const FALLBACK_ELEVENLABS_VOICE_ID = "kPzsL2i3teMYv0FxEYQ6";

interface PersistedSettings {
  selectedModelIdentifier: string;
  isClickyCursorEnabled: boolean;
}

const defaultSettings: PersistedSettings = {
  selectedModelIdentifier: DEFAULT_CLAUDE_MODEL_IDENTIFIER,
  isClickyCursorEnabled: true,
};

let cachedSettings: PersistedSettings | null = null;
let cachedEnvironmentFileValues: Record<string, string> | null = null;

// ------------------------------------------------------------- .env loading

/**
 * Parses a `.env` file: `KEY=value` per line, `#` comments, optional quotes.
 *
 * Hand-rolled rather than pulling in `dotenv`, because the format we need is
 * this small and the dependency list is worth keeping short.
 */
function parseEnvironmentFile(fileContents: string): Record<string, string> {
  const parsedValues: Record<string, string> = {};

  for (const rawLine of fileContents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    // Strip one matching pair of surrounding quotes, if present.
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) {
      value = value.slice(1, -1);
    }

    if (key.length > 0) {
      parsedValues[key] = value;
    }
  }

  return parsedValues;
}

/**
 * Where to look for `.env`, most specific first.
 *
 * In development that's the project root. Once packaged there is no project
 * root, so the userData folder is the place a user can actually edit.
 */
function candidateEnvironmentFilePaths(): string[] {
  return [
    path.join(app.getAppPath(), ".env"),
    path.join(path.dirname(app.getPath("exe")), ".env"),
    path.join(app.getPath("userData"), ".env"),
  ];
}

function environmentFileValues(): Record<string, string> {
  if (cachedEnvironmentFileValues !== null) {
    return cachedEnvironmentFileValues;
  }

  for (const candidatePath of candidateEnvironmentFilePaths()) {
    try {
      const fileContents = fs.readFileSync(candidatePath, "utf8");
      cachedEnvironmentFileValues = parseEnvironmentFile(fileContents);
      console.log(`Loaded configuration from ${candidatePath}`);
      return cachedEnvironmentFileValues;
    } catch {
      // Not at this path — try the next one.
    }
  }

  cachedEnvironmentFileValues = {};
  return cachedEnvironmentFileValues;
}

/** A real process environment variable wins over anything in the .env file. */
function configuredValue(key: string): string {
  const processValue = process.env[key]?.trim();
  if (processValue !== undefined && processValue.length > 0) {
    return processValue;
  }
  return (environmentFileValues()[key] ?? "").trim();
}

/** Forces the next read to re-open the .env, so edits apply without a restart. */
export function reloadConfiguration(): void {
  cachedEnvironmentFileValues = null;
}

// ------------------------------------------------------------------ API keys

export function anthropicApiKey(): string {
  return configuredValue("ANTHROPIC_API_KEY");
}

export function elevenLabsApiKey(): string {
  return configuredValue("ELEVENLABS_API_KEY");
}

export function elevenLabsVoiceId(): string {
  return configuredValue("ELEVENLABS_VOICE_ID") || FALLBACK_ELEVENLABS_VOICE_ID;
}

/**
 * Optional Cloudflare Worker base URL. When set, Clicky proxies through it and
 * no local API key is needed. When empty, Clicky calls the APIs directly.
 */
export function workerBaseUrl(): string {
  return configuredValue("CLICKY_WORKER_URL").replace(/\/+$/, "");
}

export function isUsingWorkerProxy(): boolean {
  return workerBaseUrl().length > 0;
}

/**
 * True when Clicky has what it needs to reach Claude — either a Worker to
 * proxy through, or a local Anthropic key. This gates push-to-talk.
 */
export function isClaudeConfigured(): boolean {
  return isUsingWorkerProxy() || anthropicApiKey().length > 0;
}

/**
 * True when high-quality ElevenLabs speech is available. When false, Clicky
 * falls back to the Windows system voice, which needs no account.
 */
export function isElevenLabsConfigured(): boolean {
  return isUsingWorkerProxy() || elevenLabsApiKey().length > 0;
}

/**
 * Which engine speaks when ElevenLabs isn't configured.
 *
 * "windows" drives the Windows speech engine from the main process. Instant and
 * always available, but the installed desktop voices are robotic.
 *
 * "kokoro" runs a neural voice on-device in the audio renderer. It sounds far
 * better, but it is only worth it on a machine with a capable GPU: measured at
 * roughly ten seconds per sentence on an Intel Arc 140V via WebGPU, which is
 * unusable for a push-to-talk companion. Opt in with CLICKY_LOCAL_VOICE=kokoro.
 */
/**
 * Which Edge neural voice to speak with. British by default, since it reads
 * more naturally than the American voices for most of what Clicky says.
 * Others worth trying: en-GB-RyanNeural, en-US-AriaNeural, en-US-GuyNeural.
 *
 * Set to "off" to disable Edge speech entirely and stay fully offline.
 */
export function edgeVoiceName(): string {
  return configuredValue("CLICKY_EDGE_VOICE") || "en-GB-SoniaNeural";
}

/**
 * Whether to use Edge's Read Aloud service for speech.
 *
 * It is the best free voice available, but it is an undocumented endpoint and
 * the spoken text does leave the machine. Disable with CLICKY_EDGE_VOICE=off.
 */
export function isEdgeVoiceEnabled(): boolean {
  return edgeVoiceName().toLowerCase() !== "off";
}

/**
 * Which installed Windows voice to speak with, matched loosely — "Zira" finds
 * "Microsoft Zira Desktop". Empty means the system default, which is usually
 * David. Run `Get-InstalledVoices` guidance in the README to list them.
 */
export function windowsVoiceName(): string {
  return configuredValue("CLICKY_WINDOWS_VOICE");
}

export function localVoiceEngine(): "windows" | "kokoro" {
  return configuredValue("CLICKY_LOCAL_VOICE").toLowerCase() === "kokoro" ? "kokoro" : "windows";
}

// ----------------------------------------------------------------- endpoints

export function chatEndpointUrl(): string {
  return isUsingWorkerProxy() ? `${workerBaseUrl()}/chat` : "https://api.anthropic.com/v1/messages";
}

export function textToSpeechEndpointUrl(): string {
  return isUsingWorkerProxy()
    ? `${workerBaseUrl()}/tts`
    : `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId()}`;
}

/**
 * Auth headers for the chat request. Empty when proxying, because the Worker
 * holds the key and adds them on the way out.
 */
export function chatAuthHeaders(): Record<string, string> {
  if (isUsingWorkerProxy()) {
    return {};
  }
  return {
    "x-api-key": anthropicApiKey(),
    "anthropic-version": "2023-06-01",
  };
}

export function textToSpeechAuthHeaders(): Record<string, string> {
  if (isUsingWorkerProxy()) {
    return {};
  }
  return { "xi-api-key": elevenLabsApiKey() };
}

// ------------------------------------------------------------ persisted prefs

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "clicky-settings.json");
}

function settings(): PersistedSettings {
  if (cachedSettings === null) {
    try {
      const rawFileContents = fs.readFileSync(settingsFilePath(), "utf8");
      cachedSettings = { ...defaultSettings, ...(JSON.parse(rawFileContents) as Partial<PersistedSettings>) };
    } catch {
      // No settings file yet (first launch) or it's corrupt — use defaults.
      cachedSettings = { ...defaultSettings };
    }
  }
  return cachedSettings;
}

function persistSettingsToDisk(): void {
  try {
    fs.writeFileSync(settingsFilePath(), JSON.stringify(settings(), null, 2), "utf8");
  } catch (error) {
    console.error("Could not save settings:", error);
  }
}

export function selectedModelIdentifier(): string {
  return settings().selectedModelIdentifier;
}

export function setSelectedModelIdentifier(modelIdentifier: string): void {
  settings().selectedModelIdentifier = modelIdentifier;
  persistSettingsToDisk();
}

export function isClickyCursorEnabled(): boolean {
  return settings().isClickyCursorEnabled;
}

export function setClickyCursorEnabled(isEnabled: boolean): void {
  settings().isClickyCursorEnabled = isEnabled;
  persistSettingsToDisk();
}
