# Capture Studio Tools

Headless control of Capture Studio components — teleprompter, microphone, desktop-audio loopback, screen enumeration, and screenshots. **All tools run in the main process (no Capture Studio tab needed)** so you can drive these from chat without the user opening the recorder window.

## What's NOT here (yet)

The renderer-side recorder (multi-track WebM via `MediaRecorder`, camera/screen stream acquisition via `getUserMedia` / `desktopCapturer` in the renderer) is intentionally out of scope for this tool surface. To start a full multi-source recording session today, the user still opens the Capture Studio window manually. The tools here cover everything that doesn't require renderer plumbing — which turns out to be most of what you need for: prompted reads, voice memos, system-audio transcription, screen captures, and AI-driven teleprompter sessions.

## Tool families

### Teleprompter — floating script overlay

Transparent, always-on-top window positioned near the webcam. Use for AI-driven reads, scripted demos, presentation cues.

| Tool | Purpose |
|------|---------|
| `sulla capture/teleprompter_open` | Open the window. Idempotent. |
| `sulla capture/teleprompter_close` | Close the window. No-op if already closed. |
| `sulla capture/teleprompter_status` | Is it currently open? |
| `sulla capture/teleprompter_script '{"text":"...","currentIndex":0}'` | Push script text. Splits on whitespace into words for per-word highlighting. Auto-opens if closed. `currentIndex` sets the starting highlighted word. |
| `sulla capture/teleprompter_style '{"fontSize":48,"highlightColor":"#0ff"}'` | Update visual style. Requires window open. `fontSize` 10–120. |

### Microphone — mic capture driver

Reference-counted mic capture. Multiple consumers (Capture Studio, Secretary Mode, this tool) can hold the mic simultaneously without fighting over it.

| Tool | Purpose |
|------|---------|
| `sulla capture/mic_start '{"formats":["webm-opus","pcm-s16le"]}'` | Start mic capture. Optional `formats` array (e.g. `["webm-opus","pcm-s16le"]`); defaults to driver's default set. On macOS, proactively requests microphone permission. |
| `sulla capture/mic_stop` | Release this agent's hold. Capture only fully stops when every consumer releases. |

### Speaker — desktop audio loopback

Captures whatever the system is playing. Useful for transcribing meeting audio, capturing app output, archiving played media.

| Tool | Purpose |
|------|---------|
| `sulla capture/speaker_start` | Start desktop-audio capture. Ref-counted like mic. |
| `sulla capture/speaker_stop` | Release this agent's hold. |

### Audio state

| Tool | Purpose |
|------|---------|
| `sulla capture/audio_state` | Report whether mic and speaker capture are running and which devices they're bound to. |

### Screens & screenshots

| Tool | Purpose |
|------|---------|
| `sulla capture/list_screens '{"kind":"screen"\|"window"\|"all"}'` | Enumerate displays + app windows via Electron's `desktopCapturer`. Returns `{id, name}` pairs. Filter by `kind` (default `all`). |
| `sulla capture/screenshot '{"sourceId":"..."}'` | Full-resolution PNG of the source. Omit `sourceId` for the primary display. Saves to `~/sulla/captures/screenshots/YYYY-MM-DD/` and returns the absolute path — use `meta/read_file` to inspect visually. |

## Common requests

### "Take a screenshot of my screen"
```bash
sulla capture/screenshot '{}'                  # primary display
```
Returns `{path: "~/sulla/captures/screenshots/2026-04-23/...png"}`. Open the path with `meta/read_file` for vision input.

### "Take a screenshot of just the Twenty CRM window"
```bash
sulla capture/list_screens '{"kind":"window"}'
# find the matching window id, then:
sulla capture/screenshot '{"sourceId":"window:1234:0"}'
```

### "Read me this script with the teleprompter"
```bash
sulla capture/teleprompter_script '{"text":"Hello everyone, today we are going to..."}'
# The window auto-opens, script appears, current word highlighted.
sulla capture/teleprompter_style '{"fontSize":56,"highlightColor":"#5096b3"}'    # tune appearance
sulla capture/teleprompter_close                                                 # done
```

### "Resume reading from word 42"
```bash
sulla capture/teleprompter_script '{"text":"...","currentIndex":42}'
```

### "Listen to my mic for the next minute"
```bash
sulla capture/mic_start '{"formats":["pcm-s16le"]}'
# ... do work ...
sulla capture/mic_stop
```
Other consumers (e.g., Secretary Mode if it's running) keep the mic alive after your stop call — that's intentional, the ref-count protects them.

### "Capture system audio"
```bash
sulla capture/speaker_start
sulla capture/audio_state                      # confirm bound to the right device
sulla capture/speaker_stop
```

### "Is anything capturing audio right now?"
```bash
sulla capture/audio_state
```

## Safety / permissions

- **macOS microphone permission** — `mic_start` triggers the OS prompt on first use. Until granted, capture won't deliver audio.
- **macOS screen recording permission** — required for `list_screens` and `screenshot` of full displays. Sulla Desktop should already have this from Capture Studio prior use; if not, the user gets a prompt.
- **System audio (`speaker_start`)** — depends on a working loopback device. BlackHole is broken on macOS 15 (per known-gaps); if the user is on macOS 15, this won't capture anything until alternative loopback ships.
- **Mic and speaker holds are ref-counted.** Always pair `*_start` with `*_stop` in the same agent run — leaked holds keep the device pinned.

## Where files end up

| What | Where |
|------|-------|
| Screenshots | `~/sulla/captures/screenshots/YYYY-MM-DD/<timestamp>.png` |
| Recordings (when started from the Capture Studio UI) | `~/sulla/captures/<sessionId>/` (separate WebM per source) |

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/capture/`
- Manifest: `pkg/rancher-desktop/agent/tools/capture/manifests.ts`
- Audio driver controllers: `pkg/rancher-desktop/main/audio-driver/controller/{Microphone,Speaker}DriverController.ts`
- Teleprompter window: `pkg/rancher-desktop/main/teleprompterWindow.ts`
- Capture Studio overview (the user-facing window): [`desktop/capture-studio.md`](../desktop/capture-studio.md)
