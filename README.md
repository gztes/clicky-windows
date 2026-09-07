# Clicky for Windows

A Windows port of [Clicky](https://github.com/farzaa/clicky) — an AI companion that
lives in your system tray, sees your screen, talks to you, and points at things.

The original is a macOS SwiftUI app. This is a from-scratch Electron + TypeScript
rewrite of the client, with the speech-to-text moved on-device.

```
hold Ctrl + Alt  →  speak  →  release
   → Whisper transcribes locally, on your machine
   → every monitor is screenshotted
   → Claude answers, seeing your screens
   → the answer is spoken aloud
   → the blue cursor flies to whatever Claude pointed at
```

**You need exactly one account: an Anthropic API key.** Everything else is
local, built into Windows, or optional.

---

## Setup

### Prerequisites

- Windows 10 version 2004 or newer
- Node.js 18+
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)

> **A Claude subscription is not an API key.** Claude Pro/Max covers claude.ai
> and Claude Code. The Messages API that Clicky calls is billed separately, with
> its own credit, on a console account. Same company, different wallet.

### Run it

```bash
npm install
npm run generate-icons

cp .env.example .env      # then put your key in it

npm start
```

Clicky appears in the system tray — no window, no taskbar entry. Click the tray
icon for the panel. Hold **Ctrl + Alt** and talk.

On first launch it downloads the Whisper speech model (~40MB, once). The panel
shows a progress bar while that happens. After that, transcription is fully
offline.

### What each key does

| Variable | Required? | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | The only thing Clicky can't work without |
| `ELEVENLABS_API_KEY` | No | Upgrades the voice. Without it, Clicky uses the Windows voice |
| `ELEVENLABS_VOICE_ID` | No | Which ElevenLabs voice to use |
| `CLICKY_EDGE_VOICE` | No | Edge neural voice, or `off` to stay fully offline (default `en-GB-SoniaNeural`) |
| `CLICKY_WINDOWS_VOICE` | No | Fallback Windows voice, matched loosely (e.g. `Zira`) |
| `CLICKY_LOCAL_VOICE` | No | Set to `kokoro` for an on-device neural voice — see below |
| `CLICKY_WORKER_URL` | No | Proxy through a Cloudflare Worker instead of calling APIs directly |

Clicky looks for `.env` next to the app, next to the executable, and in
`%APPDATA%\clicky-win\`, in that order. Real environment variables win over
the file, which is handy for a one-off:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
```

---

## Why there's no Cloudflare Worker in the default path

Upstream Clicky routes every API call through a Cloudflare Worker. That exists
because Clicky ships as a public download, and you cannot put API keys in a
binary that strangers install.

Running on your own machine, that indirection buys nothing: a gitignored file
that only your main process reads is at least as safe as the same key sitting on
a third-party edge network, and it removes an account, a deploy step, and a
service that can go down.

The Worker is still here in `worker/` and still supported. If you ever want to
hand this app to someone else, deploy it and set `CLICKY_WORKER_URL` — Clicky
then sends no key of its own.

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler deploy
```

## Voices, and what was actually measured

Clicky tries these in order, falling through on any failure so a dead endpoint
degrades the voice rather than silencing the app:

1. **ElevenLabs** — best quality, needs a key, ~100 replies/month free.
2. **Edge Read Aloud** — the default. Microsoft's neural voices, no account, no
   key, measured at 476–1700ms per reply. Undocumented endpoint, and the spoken
   text is sent to Microsoft (not your prompt, not your screenshots). Disable
   with `CLICKY_EDGE_VOICE=off`.
3. **Windows speech engine** — offline and instant, but robotic.
4. **Kokoro-82M on-device** — opt in with `CLICKY_LOCAL_VOICE=kokoro`.

Three findings worth recording, because each cost time to discover:

**Electron exposes no voices to `speechSynthesis`.** `getVoices()` returns an
empty list, so the obvious in-renderer approach silently produces no sound at
all, while `System.Speech` on the same machine reports seven installed voices.
That's why the Windows voice is driven from the main process by spawning
PowerShell (`src/main/systemVoice.ts`) rather than from the renderer. Text goes
in on stdin, never interpolated into the command — it's model output and will
contain quotes.

**The legacy Windows voices are unusably robotic**, and there is no local fix:
`System.Speech` sees only the old "Desktop" voices, and the WinRT API on this
machine exposes 18 voices that are all the same generation. No natural/neural
voices are installed, so Edge is what makes Clicky pleasant to listen to
without paying.

**Kokoro is too slow on integrated graphics.** Measured on an Intel Arc 140V:
~17s per sentence on WebAssembly, and ~10s on WebGPU, consistently, warm and
cold — it scales linearly with text length, so it isn't a warm-up cost. The code
is kept and works; it just needs a real GPU to be worth using. Don't enable it
expecting ElevenLabs quality at no latency cost.

## Why speech-to-text is local

Upstream uses AssemblyAI's streaming API. This port runs Whisper `tiny.en` in
the renderer through ONNX/WebAssembly instead, which means **no speech-to-text
account, no per-minute cost, and no audio ever leaving the machine.**

The tradeoff is honest: AssemblyAI streams, so its transcript is ready the
instant you release the keys. Whisper can't start until you stop talking, so a
short utterance adds roughly half a second. For push-to-talk that's a fair
trade for deleting a vendor.

Two things worth knowing if you touch this code:

- **Pin `@huggingface/transformers` to v3.** On v4 the 8-bit model fails to
  build an inference session at all — ONNX Runtime's quantise/dequantise
  optimiser throws `Missing required scale ... MatMulNBits` on the decoder,
  verified on a clean cache against both the `Xenova` and `onnx-community`
  repos. v3.8.1 loads the same weights fine. If you upgrade and transcription
  stops working, that's why; `dtype: "fp32"` is the escape hatch, at ~150MB
  instead of ~40MB.
- Swap `WHISPER_MODEL_IDENTIFIER` in `src/renderer/audio/audio.ts` for
  `onnx-community/whisper-base.en` if you want better accuracy at double the size.

---

## Permissions

Windows needs far less hand-holding than macOS here. There is no Accessibility
or Screen Recording consent flow — only the microphone matters:

**Settings → Privacy & security → Microphone → Let desktop apps access your microphone**

If that's off, the panel shows a "Microphone blocked" notice with a retry button.

---

## How the port maps to the original

| Clicky (macOS) | Clicky for Windows |
|---|---|
| `NSStatusItem` | Electron `Tray` |
| Borderless `NSPanel` dropdown | Frameless always-on-top `BrowserWindow`, hidden on blur |
| Non-activating overlay `NSPanel` per screen | Transparent click-through `BrowserWindow` per display |
| ScreenCaptureKit + `excludingWindows` | `desktopCapturer` + `setContentProtection(true)` |
| Listen-only CGEvent tap (ctrl + option) | `uiohook-napi` keyboard hook (Ctrl + Alt) |
| AssemblyAI streaming websocket | Whisper via ONNX/WASM, on-device |
| `AVAudioEngine` → PCM16 | Web Audio `AudioWorklet` → Float32 |
| `AVAudioPlayer` | `HTMLAudioElement`, or the Windows engine via PowerShell |
| Cloudflare Worker proxy | Direct API calls with a local `.env` |
| `UserDefaults` | JSON file in Electron's `userData` |
| SwiftUI + `DS` design tokens | HTML/CSS using the same colour values |

Three things are genuinely simpler on Windows:

- **No coordinate flip.** macOS AppKit uses a bottom-left origin, so the Swift
  had to invert Y when converting Claude's screenshot coordinates to screen
  coordinates. Windows is top-left origin, like the screenshots — that whole
  conversion disappears.
- **No TCC permissions.** No Accessibility or Screen Recording prompts, and no
  risk of invalidating them (upstream's warning about never running `xcodebuild`
  from the terminal has no equivalent here).
- **No signing team** needed to run a debug build.

And two are harder:

- **Push-to-talk needs a native hook.** Electron's `globalShortcut` only fires on
  key *press* and swallows the accelerator. Hold-to-talk needs press *and*
  release, without stealing the keys from the app you're working in — hence
  `uiohook-napi`.
- **Web Audio and WASM are renderer-only**, so capture, transcription and
  playback all live in a hidden window (`src/renderer/audio/`).

### One consequence worth knowing

Clicky's own windows call `setContentProtection(true)`, which on Windows sets
`WDA_EXCLUDEFROMCAPTURE`. That's what stops Clicky from sending Claude a
screenshot of Clicky. It also means **the overlay won't appear in your own
screenshots or screen recordings** — if you record a demo, the blue cursor will
be invisible in it. Comment out the `setContentProtection` calls in
`src/main/overlayWindows.ts` if you need to film it.

---

## Project structure

```
src/
  main/                     # Electron main process
    index.ts                  # entry point, app lifecycle, single-instance guard
    companionManager.ts       # the state machine — port of CompanionManager.swift
    claudeClient.ts           # Claude SSE streaming + the system prompt
    ttsClient.ts              # ElevenLabs, falling back to the Windows voice
    screenCapture.ts          # multi-monitor screenshots
    globalPushToTalk.ts       # Ctrl+Alt keyboard hook
    pointParser.ts            # [POINT:x,y:label:screenN] parsing + coordinate mapping
    overlayWindows.ts         # one transparent overlay per display
    panelWindow.ts            # tray dropdown panel
    audioWindow.ts            # hidden audio host, with a ready-queue for IPC
    systemVoice.ts            # Windows speech engine, driven over stdin
    trayManager.ts            # system tray icon
    config.ts                 # .env loading, endpoints, persisted preferences
  preload/                  # contextBridge APIs, one per window type
  renderer/
    overlay/                  # the blue cursor, bubble, waveform, spinner
    panel/                    # tray panel UI
    audio/                    # capture + local Whisper + speech playback
  shared/                   # types and IPC channel names
worker/                     # optional Cloudflare Worker proxy (unchanged from upstream)
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Build and run |
| `npm run build` | Compile TypeScript, bundle the audio renderer, copy HTML/CSS |
| `npm run typecheck` | Type-check all three projects without emitting |
| `npm run generate-icons` | Regenerate the tray icon PNG |

The audio renderer is bundled with esbuild (it imports `@huggingface/transformers`);
the panel and overlay are plain compiled scripts with no bundler. Note the bundle
is **IIFE, not ESM** — `<script type="module">` does not load over `file://`.

## Licence

MIT, same as upstream Clicky.
