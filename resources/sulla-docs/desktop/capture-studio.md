# Capture Studio

A multi-track audio/video recording app embedded in Sulla Desktop. Records screen, camera, microphone, and system audio independently — separate WebM files per source so the user can edit/mux in post.

**Status:** Shipping in v1.3.0 (released 2026-04-09). Local feature, no Cloud dependency.

## What it does

| Source | API | Notes |
|--------|-----|-------|
| Screen | Electron `desktopCapturer` | Multi-display support; quality presets 480p–4K (bitrate only, native resolution always) |
| Camera | `getUserMedia` | Device enumeration + switching; same quality presets |
| Microphone | Audio Driver subsystem | **Dual-path: raw (default) or noise-reduction (RNNoise + VAD)** |
| System audio | Audio Driver via BlackHole loopback (macOS) | **Broken on macOS 15** — needs alternative loopback |

Plus:
- **Scene layouts:** PiP, side-by-side, full-screen, camera-only, screen-only
- **Floating teleprompter:** word-by-word highlighting via VAD-driven Whisper.cpp STT (Jaccard fuzzy match handles deviation from script)
- **Capture event logging:** mouse clicks, key events, window focus changes, scroll — for click-replay during playback
- **Session playback:** tile overlay of all streams, synchronized scrubbing, waveform timeline

## File layout

Recordings land at `~/sulla/captures/{sessionId}/`:

```
~/sulla/captures/<sessionId>/
  manifest.json             # session metadata, stream list, timestamps, capture events
  screen.webm               # VP9 video, separate from camera
  camera.webm               # VP9 video
  mic.wav                   # PCM, 48kHz (raw or noise-reduced based on mode)
  speaker.webm              # Opus audio (system audio capture)
```

MediaRecorder writes 250ms chunks. Audio is **not muxed** into the video files — each stream is independent so the user can re-mix in their editor.

## Tech stack

- **Recording:** Web MediaRecorder API
- **Video codec:** VP9 (WebM container)
- **Audio codec:** Opus (WebM) for speaker; PCM (WAV) for mic
- **Disk I/O:** Node.js `fs.createWriteStream` (renderer has `nodeIntegration: true`)
- **STT (teleprompter):** Whisper.cpp (bundled binary, Homebrew fallback)
- **Audio processing:** RNNoise, custom VAD with hysteresis, spectral analysis (centroid, rolloff, ZCR, pitch)

## The Audio Driver — required reading

Capture Studio depends on the **Audio Driver subsystem** (built into Sulla Desktop, ported from a standalone tray app). It's a singleton with reference-counted lifecycle:

- `MicrophoneDriverController` and `SpeakerDriverController` manage independent lifecycles
- Multiple consumers (Capture Studio, Secretary Mode, voice chat) can request mic/speaker simultaneously
- 30+ IPC handlers under `audio-driver:*`
- PCM streamed over **Unix domain sockets** for low latency (no IPC serialization)
- Mic modes: `raw` (everything, for music/ambient) vs `noise-reduction` (VAD-gated, RNNoise-processed, for voice)

When Capture Studio opens, it auto-starts the audio driver. When recording starts, it increments the mic ref count; on stop, decrements. Other consumers (e.g., Secretary Mode) can still hold the mic without conflict.

## Use cases

1. **Meeting recording** — screen + camera + speaker audio
2. **Video tutorials** — screen + voiceover (raw or noise-reduced mic)
3. **Podcasting** — high-quality mic-only WAV
4. **Presentation** — screen + camera + teleprompter (eye-contact reading)
5. **Interviews** — multi-camera, speaker audio, edit in post
6. **Voice memo / dictation** — mic-only with VAD
7. **ASMR / music** — raw mic mode (unprocessed)

## Agent control — currently NONE

**The agent cannot control Capture Studio today.** No `capture-studio/*` tool category exists. Specifically:

- No tool to open the Capture Studio window (UI navigation gap)
- No tool to start / stop a recording
- No tool to switch scene layout
- No tool to add a source mid-recording
- No tool to query the last session

The IPC handlers are wrapped (with try/catch since v1.3.0), so adding agent tools would be straightforward — they just haven't shipped.

## What the agent CAN do

- Read recording files: `ls ~/sulla/captures/` to find sessions
- Read `manifest.json` to inspect what's in a session
- Use `function/function_run` with a Whisper-based function to transcribe a saved recording (no built-in batch transcription tool)

## When users ask about Capture Studio

- **"What is Capture Studio?"** — Multi-track recorder for screen + camera + mic + system audio. Each source saves to a separate file so you can edit them independently. Shipping in v1.3.0.
- **"Can you record this meeting for me?"** — No, the agent can't start it. Tell them to open Capture Studio (point them to the menu / shortcut).
- **"Where are my recordings?"** — `~/sulla/captures/<sessionId>/`. The agent can list and inspect manifests.
- **"Why is system audio not capturing?"** — On macOS 15, BlackHole is broken. Known issue. Mic capture still works.
- **"Can you transcribe this old recording?"** — Yes, via a custom function calling Whisper.cpp. Not a built-in tool.

## Recent fixes (v1.3.0 changelog)

- Fixed audio driver boot timeout
- Fixed camera stream flickering
- Stopped muxing mic into screen/camera files (separate now)
- Fixed camera preview live video
- Fixed audio meters and inline playback
- Auto-start audio driver when Capture Studio opens
- Defensive null guards on composable refs
- Wrapped capture studio IPC handlers in try/catch
- 55 reliability fixes total

## Known limitations

- **BlackHole on macOS 15:** broken. System audio capture won't work until alternative loopback is in place.
- **Browser STT broken** — uses Whisper.cpp instead.
- No agent control today (see above).

## Reference

- Main component: `pkg/rancher-desktop/pages/CaptureStudio.vue`
- Window entry: `pkg/rancher-desktop/entry/capture-studio.ts`
- Window opener: `openCaptureStudio()` in `pkg/rancher-desktop/window/index.ts`
- Tracking / IPC: `pkg/rancher-desktop/main/captureStudioTracking.ts`
- Sub-components: `pkg/rancher-desktop/pages/capture-studio/`
- Composables: `pkg/rancher-desktop/pages/capture-studio/composables/`
- Audio driver: `pkg/rancher-desktop/main/audio-driver/`
- Memory: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/project_capture_studio_mic_modes.md`, `project_audio_driver.md`, `project_audio_driver_api.md`
