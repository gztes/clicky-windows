/**
 * Speech through the Windows speech engine, driven from the main process.
 *
 * Why not the renderer's `speechSynthesis`: Electron ships no speech service,
 * so `speechSynthesis.getVoices()` returns an empty list and nothing is ever
 * spoken. Verified on this machine — zero voices exposed, while `System.Speech`
 * reports seven installed. So we talk to the Windows engine directly instead.
 *
 * The text is passed on stdin, never interpolated into the command line: it is
 * model output, it routinely contains apostrophes and quotes, and building a
 * PowerShell string out of it would be both fragile and an injection risk.
 */

import { spawn, type ChildProcess } from "child_process";
import { windowsVoiceName } from "./config";

/**
 * Reads all of stdin and speaks it. `Rate` is on a -10..10 scale where 0 is
 * default; a touch above that stops the desktop voices sounding ponderous.
 */
const SPEAK_FROM_STDIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speechSynthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speechSynthesizer.Rate = 1

# Optional voice preference, matched loosely so "Zira" finds "Microsoft Zira
# Desktop". An unknown name is ignored rather than fatal — better a wrong voice
# than no speech at all.
$preferredVoice = $env:CLICKY_WINDOWS_VOICE
if ($preferredVoice) {
  $match = $speechSynthesizer.GetInstalledVoices() |
    Where-Object { $_.VoiceInfo.Name -like "*$preferredVoice*" } |
    Select-Object -First 1
  if ($match) { $speechSynthesizer.SelectVoice($match.VoiceInfo.Name) }
}

$textToSpeak = [Console]::In.ReadToEnd()
if ($textToSpeak.Trim().Length -gt 0) { $speechSynthesizer.Speak($textToSpeak) }
$speechSynthesizer.Dispose()
`;

let activeSpeechProcess: ChildProcess | null = null;

/**
 * Speaks `text` aloud, calling `onFinished` when playback ends — whether it
 * completed, failed, or was interrupted. The callback firing exactly once is
 * what returns Clicky's state machine to idle, so it must never be skipped.
 */
export function speakWithWindowsVoice(text: string, onFinished: () => void): void {
  stopWindowsVoice();

  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    onFinished();
    return;
  }

  let speechProcess: ChildProcess;
  try {
    speechProcess = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SPEAK_FROM_STDIN_SCRIPT],
      {
        windowsHide: true,
        // The voice preference travels as an environment variable rather than
        // inside the script, keeping user-supplied text out of the command.
        env: { ...process.env, CLICKY_WINDOWS_VOICE: windowsVoiceName() },
      }
    );
  } catch (spawnError) {
    console.error("Could not start the Windows speech engine:", spawnError);
    onFinished();
    return;
  }

  activeSpeechProcess = speechProcess;

  let hasReportedFinished = false;
  const reportFinishedOnce = () => {
    if (hasReportedFinished) {
      return;
    }
    hasReportedFinished = true;
    if (activeSpeechProcess === speechProcess) {
      activeSpeechProcess = null;
    }
    onFinished();
  };

  speechProcess.on("error", (processError) => {
    console.error("Windows speech engine failed:", processError);
    reportFinishedOnce();
  });
  speechProcess.on("close", reportFinishedOnce);

  speechProcess.stdin?.on("error", () => {
    // The process can exit before we finish writing; that's a normal race when
    // playback is interrupted, and `close` will still report completion.
  });
  speechProcess.stdin?.end(trimmedText, "utf8");
}

/** Stops any in-progress speech immediately. Safe to call when nothing is speaking. */
export function stopWindowsVoice(): void {
  if (activeSpeechProcess === null) {
    return;
  }
  const processToStop = activeSpeechProcess;
  activeSpeechProcess = null;
  processToStop.kill();
}
