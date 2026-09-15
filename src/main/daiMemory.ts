/**
 * Read/write access to DAI's markdown memory (`dai-brain`'s `memory/notes.md`),
 * per the founders' spec: "make DAI remember everything Clicky does for you —
 * it's just an MD file." No DAI service exists yet, so this talks to the file
 * directly rather than over HTTP — see research/dai-architecture.md's build
 * order and the 2026-09-15 session notes for why this is the lighter of the
 * two integration options, not the "Clicky becomes a DAI tool" rewrite.
 *
 * Every function here is defensive by design: DAI's memory being missing,
 * unreadable, or on a machine that doesn't have `dai-brain` at all must never
 * break Clicky's own voice loop. Failures are logged and swallowed, not thrown.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { daiMemoryDir } from "./config";

const NOTES_FILE_NAME = "notes.md";

/**
 * Recent notes DAI has accumulated, trimmed to a short excerpt suitable for
 * injecting into Clicky's system prompt. Empty string if DAI has no memory yet
 * or the file can't be read — callers should treat that as "no context available"
 * rather than an error.
 */
export function readDaiMemoryContext(): string {
  try {
    const notesPath = path.join(daiMemoryDir(), NOTES_FILE_NAME);
    const contents = readFileSync(notesPath, "utf8").trim();
    // Drop the "# DAI notes" heading MemoryStore writes on first use — only the
    // actual notes are useful context for a prompt.
    const withoutHeading = contents.replace(/^#.*\n+/, "").trim();
    return withoutHeading;
  } catch {
    return "";
  }
}

/**
 * Appends one note to DAI's memory, in the same `- <note>` bullet format
 * `dai-brain`'s own MemoryStore uses, so DAI can read it back later. Creates
 * the memory directory if it doesn't exist yet. Never throws — a failure here
 * should not interrupt the user's conversation with Clicky.
 */
export function appendDaiMemoryNote(note: string): void {
  const trimmedNote = note.trim();
  if (trimmedNote.length === 0) {
    return;
  }

  try {
    const dir = daiMemoryDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const notesPath = path.join(dir, NOTES_FILE_NAME);
    if (!existsSync(notesPath)) {
      appendFileSync(notesPath, "# DAI notes\n\n", "utf8");
    }
    appendFileSync(notesPath, `- ${trimmedNote}\n`, "utf8");
  } catch (error) {
    console.error("Could not write to DAI's memory:", error);
  }
}
