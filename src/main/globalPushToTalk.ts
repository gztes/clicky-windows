/**
 * System-wide push-to-talk monitor.
 * Ported from GlobalPushToTalkShortcutMonitor.swift.
 *
 * Why not Electron's built-in `globalShortcut`: it only fires on key *press*
 * and it swallows the accelerator. Push-to-talk needs press AND release, and
 * must not steal the keys from whatever app the user is working in. So we use
 * uiohook-napi, a low-level listen-only keyboard hook — the direct Windows
 * counterpart of the macOS CGEvent tap with `.listenOnly`.
 *
 * The shortcut is Ctrl + Alt (either side), matching the Mac's ctrl + option.
 */

import { uIOhook, UiohookKey } from "uiohook-napi";

/** Keycodes that count as "the control key", left or right. */
const CONTROL_KEYCODES: ReadonlySet<number> = new Set([UiohookKey.Ctrl, UiohookKey.CtrlRight]);

/** Keycodes that count as "the alt key", left or right. */
const ALT_KEYCODES: ReadonlySet<number> = new Set([UiohookKey.Alt, UiohookKey.AltRight]);

export interface PushToTalkCallbacks {
  onShortcutPressed: () => void;
  onShortcutReleased: () => void;
}

export class GlobalPushToTalkMonitor {
  private readonly callbacks: PushToTalkCallbacks;

  private isControlKeyDown = false;
  private isAltKeyDown = false;

  /**
   * Whether the full chord is currently held. Guards against the repeat
   * keydown events Windows sends while a key is held, which would otherwise
   * start a new dictation session on every repeat.
   */
  private isShortcutCurrentlyPressed = false;

  private isHookRunning = false;

  constructor(callbacks: PushToTalkCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.isHookRunning) {
      return;
    }

    uIOhook.on("keydown", (keyboardEvent) => {
      this.updateModifierState(keyboardEvent.keycode, true);
      this.evaluateShortcutTransition();
    });

    uIOhook.on("keyup", (keyboardEvent) => {
      this.updateModifierState(keyboardEvent.keycode, false);
      this.evaluateShortcutTransition();
    });

    try {
      uIOhook.start();
      this.isHookRunning = true;
      console.log("Push-to-talk: keyboard hook started (hold Ctrl + Alt to talk)");
    } catch (error) {
      console.error("Push-to-talk: could not start the keyboard hook:", error);
    }
  }

  stop(): void {
    if (!this.isHookRunning) {
      return;
    }

    try {
      uIOhook.stop();
    } catch (error) {
      console.error("Push-to-talk: could not stop the keyboard hook:", error);
    }

    this.isHookRunning = false;
    this.isControlKeyDown = false;
    this.isAltKeyDown = false;
    this.isShortcutCurrentlyPressed = false;
  }

  private updateModifierState(keycode: number, isKeyDown: boolean): void {
    if (CONTROL_KEYCODES.has(keycode)) {
      this.isControlKeyDown = isKeyDown;
    } else if (ALT_KEYCODES.has(keycode)) {
      this.isAltKeyDown = isKeyDown;
    }
  }

  /** Emits a transition only when the chord's held/not-held state actually changes. */
  private evaluateShortcutTransition(): void {
    const isChordHeldNow = this.isControlKeyDown && this.isAltKeyDown;

    if (isChordHeldNow === this.isShortcutCurrentlyPressed) {
      return;
    }

    this.isShortcutCurrentlyPressed = isChordHeldNow;

    if (isChordHeldNow) {
      this.callbacks.onShortcutPressed();
    } else {
      this.callbacks.onShortcutReleased();
    }
  }
}
