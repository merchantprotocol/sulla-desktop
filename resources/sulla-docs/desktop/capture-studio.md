# Capture Studio

A multi-track audio/video recording app embedded in Sulla Desktop. Records screen, camera, microphone, and system audio independently — separate WebM files per source so the user can edit/mux in post.

**Status:** Shipping in v1.3.0 (released 2026-04-09). Local feature, no Cloud dependency.

## What it does

| Source | API | Notes |
|--------|-----|-------|
| Screen | Electron `desktopCapturer` | Multi-display support; quality presets 480p–4K (bitrate only, native resolution always) |
| Camera | `getUserMedia` | Device enumeration + switching; same quality presets |
| Microphone | Audio Driver subsystem | **Dual-path: raw (default) or noise-reduction (RNNoise + VAD)** |
| System audio | Electron native loopback (`getDisplayMedia`; ScreenCaptureKit on macOS 13+) | BlackHole/CoreAudio remains a fallback where native loopback is unavailable |

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

When native loopback is unavailable, the BlackHole fallback writes
`speaker.wav` instead. The manifest is authoritative: every captured stream
includes `type`, `filename`, `format`, `startOffset`, and byte count, so the
Sulla Video Editor does not depend on a hard-coded extension.

MediaRecorder writes 250ms chunks. Audio is **not muxed** into the video files — each stream is independent so the user can re-mix in their editor.

## Tech stack

- **Recording:** Web MediaRecorder API
- **Video codec:** VP9 (WebM container)
- **Audio codec:** Opus (WebM) for native speaker capture; PCM (WAV) for mic and BlackHole fallback
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

Capture Studio reads the shared audio-driver state when it opens, but it does
not change the Mac's output device. System audio is acquired lazily when the
source is enabled: native Electron loopback first, then the ref-counted
BlackHole driver only if native capture is unavailable. Other consumers (for
example Secretary Mode) can still hold mic or speaker drivers without conflict.

## Use cases

1. **Meeting recording** — screen + camera + speaker audio
2. **Video tutorials** — screen + voiceover (raw or noise-reduced mic)
3. **Podcasting** — high-quality mic-only WAV
4. **Presentation** — screen + camera + teleprompter (eye-contact reading)
5. **Interviews** — multi-camera, speaker audio, edit in post
6. **Voice memo / dictation** — mic-only with VAD
7. **ASMR / music** — raw mic mode (unprocessed)

## Agent control

A `capture/` tool category now exists with **13 tools** for headless control of the Capture Studio components. See [`tools/capture.md`](../tools/capture.md) for the full reference.

**What the agent CAN do today via `capture/*`:**
- **Teleprompter:** open / close / status / push script with per-word highlight position / restyle
  - `capture/teleprompter_open`, `_close`, `_status`, `_script`, `_style`
- **Microphone:** start / stop capture (ref-counted, plays well with Secretary Mode), report state
  - `capture/mic_start`, `mic_stop`, `audio_state`
- **Desktop audio:** prepare/release native loopback capture, with BlackHole fallback
  - `capture/speaker_start`, `speaker_stop`
- **Screens:** enumerate displays + windows, capture full-resolution PNG screenshots to `~/sulla/captures/screenshots/YYYY-MM-DD/`
  - `capture/list_screens`, `capture/screenshot`

**What the agent still CAN'T do:**
- Add or replace a camera/screen source in the middle of an active recording
- Query the last session via a dedicated tool (use `meta/exec` with `ls ~/sulla/captures/` and read `manifest.json`)

**File-side discovery still works the old way:**
- Read recording files: `ls ~/sulla/captures/` to find sessions
- Read `manifest.json` to inspect a session
- Pipe a saved recording through a Whisper-based custom function to transcribe (no built-in batch transcription tool yet)

## When users ask about Capture Studio

- **"What is Capture Studio?"** — Multi-track recorder for screen + camera + mic + system audio. Each source saves to a separate file so you can edit them independently. Shipping in v1.3.0.
- **"Can you record this meeting for me?"** — Yes. Use `capture/recorder_start` with the requested sources; Capture Studio opens automatically. Use `capture/recorder_stop` to flush every track and publish the manifest.
- **"Where are my recordings?"** — `~/sulla/captures/<sessionId>/`. The agent can list and inspect manifests.
- **"Why is system audio not capturing?"** — Check Screen Recording permission. Native ScreenCaptureKit loopback is the primary path; Capture Studio falls back to BlackHole when native loopback cannot be acquired.
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

- Native loopback requires Screen Recording permission on macOS. The OS prompt still needs a person to approve it.
- **Browser STT broken** — uses Whisper.cpp instead.

## Reference

- Main component: `pkg/rancher-desktop/pages/CaptureStudio.vue`
- Window entry: `pkg/rancher-desktop/entry/capture-studio.ts`
- Window opener: `openCaptureStudio()` in `pkg/rancher-desktop/window/index.ts`
- Tracking / IPC: `pkg/rancher-desktop/main/captureStudioTracking.ts`
- Sub-components: `pkg/rancher-desktop/pages/capture-studio/`
- Composables: `pkg/rancher-desktop/pages/capture-studio/composables/`
- Audio driver: `pkg/rancher-desktop/main/audio-driver/`
- Memory: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/project_capture_studio_mic_modes.md`, `project_audio_driver.md`, `project_audio_driver_api.md`
