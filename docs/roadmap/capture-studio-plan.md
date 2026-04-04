# Sulla Desktop: Audio + Video Capture

## Vision

Sulla Desktop needs native audio and video capture for computer-use, agent observation, and recording workflows. This is the **capture layer only** -- recording screen, webcam, mic, and system audio as independent streams with synced timecodes.

The Descript-style transcript editor and Remotion compositor are a **separate project** running in its own container, built on top of the forked Remotion repo at `~/sulla/remotion/`. See [remotion-editor-plan.md](remotion-editor-plan.md) for that roadmap.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  SULLA DESKTOP (Electron)                            │
│                                                      │
│  Capture Service                                     │
│  ├── Screen capture (desktopCapturer + MediaRecorder)│
│  ├── Webcam capture (getUserMedia + MediaRecorder)   │
│  ├── Mic capture (audio-driver merged)               │
│  ├── System audio (audio-driver speaker channel)     │
│  └── Real-time transcription (Gateway, already wired)│
│                                                      │
│  Output: ~/sulla/captures/<session-id>/              │
│    screen.webm, webcam.webm, mic.wav, system.wav,   │
│    transcript.json, manifest.json                    │
├──────────────────────────────────────────────────────┤
│                    shared volume                     │
├──────────────────────────────────────────────────────┤
│  REMOTION EDITOR (separate container)                │
│  ~/sulla/remotion/                                   │
│  Reads capture sessions, provides transcript editor, │
│  composition, and rendering                          │
└──────────────────────────────────────────────────────┘
```

The two projects communicate through the filesystem: Sulla writes capture sessions to `~/sulla/captures/`, the Remotion editor reads them via bind mount.

---

## What Sulla Desktop Captures (up to 4 streams)

| Stream | Source | Format | Where captured |
|--------|--------|--------|----------------|
| Screen | `desktopCapturer` -> MediaRecorder | WebM/VP9 | Renderer process |
| Webcam | `getUserMedia({ video })` -> MediaRecorder | WebM/VP9 | Renderer process |
| Mic | Audio-driver daemon (mic channel) | PCM s16le 16kHz | Main process |
| System audio | Audio-driver daemon (speaker channel) | PCM s16le 16kHz | Main process |

---

## Why this belongs in Sulla Desktop

These capabilities aren't just for recording content -- they're infrastructure that computer-use and agents need:

- **Screen capture** -- agents doing computer-use need to see the screen. Currently this is CDP screenshots only (browser tabs). Native desktopCapturer gives full-screen visibility.
- **Webcam** -- agents observing meetings, secretary mode with video context, presence detection.
- **Mic + system audio** -- already partially wired (VoiceRecorderService + AudioDriverClient + Gateway). Completing this gives agents full audio context for any application, not just browser tabs.
- **Recording sessions** -- any of the above can be saved to disk for later review, training data, or handoff to the Remotion editor.

---

## Key Design Decisions

- **No large data over IPC.** Video streams write directly to disk from renderer via `fs.createWriteStream()`. Audio streams write from main process. Only file paths and control signals cross IPC.
- **Sync via shared start timestamp.** All streams record a `startedAt` epoch ms. Each stream file gets timing metadata in the manifest.
- **Audio-driver merge.** The audio-driver daemon continues running as a child process with socket IPC. AudioDriverClient (already exists) manages it. The standalone tray app UI becomes a Vue component inside Sulla.
- **Real-time transcription during capture.** Mic and system audio already stream to Gateway for word-level transcription. During a capture session, transcripts accumulate into `transcript.json` alongside recordings.
- **Capture is always available.** Even without recording, the capture service provides live streams for computer-use agents. Recording is an opt-in layer on top.

---

## Capture Session Output

```
~/sulla/captures/<session-id>/
  ├── manifest.json          # session metadata, stream list, timing
  ├── screen.webm            # screen recording
  ├── webcam.webm            # face recording
  ├── mic.wav                # microphone audio
  ├── system-audio.wav       # system/speaker audio
  └── transcript.json        # word-level transcript with timestamps
```

### manifest.json

```json
{
  "id": "session-uuid",
  "createdAt": "2026-04-04T17:30:00Z",
  "duration": 184.5,
  "streams": {
    "screen":       { "file": "screen.webm", "startOffset": 0, "duration": 184.5 },
    "webcam":       { "file": "webcam.webm", "startOffset": 0.12, "duration": 184.3 },
    "mic":          { "file": "mic.wav", "startOffset": 0, "duration": 184.5, "sampleRate": 16000 },
    "systemAudio":  { "file": "system-audio.wav", "startOffset": 0.05, "duration": 184.4, "sampleRate": 16000 }
  },
  "transcript": "transcript.json"
}
```

### transcript.json

```json
{
  "words": [
    { "word": "Hello", "start": 0.0, "end": 0.45, "speaker": "user", "channel": 0, "confidence": 0.98 },
    { "word": "world", "start": 0.48, "end": 0.92, "speaker": "user", "channel": 0, "confidence": 0.95 }
  ],
  "segments": [
    { "start": 0.0, "end": 15.2, "speaker": "user", "channel": 0 },
    { "start": 15.5, "end": 42.1, "speaker": "caller", "channel": 1 }
  ]
}
```

---

## Merging Audio-Driver into Sulla Desktop

The audio-driver is currently a standalone Electron tray app at `~/Sites/sulla/audio-driver`.

| Current (audio-driver) | Merged (sulla-desktop) |
|------------------------|----------------------|
| Separate Electron app | Panel/tab in Sulla Desktop |
| Own tray icon | Uses Sulla's existing tray |
| `src/main/platform/darwin/` native code | Moves to `pkg/rancher-desktop/platform/darwin/` |
| Socket daemon (create-mirror, capture helpers) | Same daemon, launched by AudioDriverClient (already exists) |
| Renderer UI (index.html, style.css) | Becomes a Vue component in Sulla |
| Standalone `just build-mac` packaging | Part of Sulla Desktop's electron-builder |

### What moves

- `src/main/platform/darwin/*` (native C binaries, swift scripts) -- pre-built, bundled as extraResources
- `src/main/controller/lifecycle.js` logic -- absorbed into existing AudioDriverClient
- Renderer HTML/CSS -- rewritten as Vue component (matches Sulla's stack)
- Config, auth -- uses Sulla's existing auth/settings

### What stays the same

- The daemon process (create-mirror, capture helpers) -- still runs as child process
- Socket protocol -- AudioDriverClient already speaks it
- Audio pipeline (mic + system audio -> PCM) -- unchanged

---

## Implementation Phases

### Phase 1: Audio-Driver Merge

- Move native platform code into sulla-desktop as extraResources
- Convert audio-driver UI -> Vue component
- Wire into existing AudioDriverClient + audio settings page
- Remove standalone Electron app dependency

### Phase 2: Screen + Webcam Capture

- New `ScreenCaptureService.ts` composable (dual MediaRecorder, fs.createWriteStream)
- Main-process IPC for macOS permissions (`screen`, `camera`), source enumeration
- `desktopCapturer.getSources()` in main process, stream acquisition in renderer
- Webcam via `getUserMedia({ video: { deviceId } })`
- Live preview (two `<video>` elements playing the MediaStreams)

### Phase 3: Capture Session Recording

- Session manager: creates `~/sulla/captures/<session-id>/` directory
- Coordinates start/stop across all active streams
- Video: renderer writes WebM to disk via `fs.createWriteStream()`
- Audio: main process writes PCM from audio-driver, converts to WAV on stop
- Generates `manifest.json` with timing metadata
- Menu entry + keyboard shortcut (`CmdOrCtrl+Shift+R`)

### Phase 4: Live Transcription During Capture

- Gateway already does real-time word-level transcription (wired)
- Accumulate words into `transcript.json` during recording
- Show live transcript overlay in capture UI
- Word-level timestamps synced to session `startedAt`

### Phase 5: Agent Integration

- Agent tools: `capture_screenshot`, `start_recording`, `stop_recording`
- Agents can access live screen/webcam streams for computer-use observation
- Capture sessions available as context for agent reasoning
- Screenshots on demand (still image from any active stream)

---

## IPC Contract

### Renderer -> Main (invoke)

```
screen-capture:get-sources       () => Source[]
screen-capture:check-permissions () => { screen: Status, camera: Status }
screen-capture:request-permission (type: 'screen' | 'camera') => boolean
screen-capture:start-session     (config: SessionConfig) => { sessionId, paths }
screen-capture:stop-session      (sessionId) => ManifestData
screen-capture:get-save-dir      () => string
screen-capture:set-save-dir      (dir) => void
```

### Main -> Renderer (send)

```
screen-capture:permission-changed  { type, status }
screen-capture:transcript-word     { word, start, end, speaker, channel }
```

No video or audio data crosses IPC. The `start-session` handler returns file paths; the renderer opens write streams to those paths directly.

---

## Key Technical Risks

| Risk | Mitigation |
|------|-----------|
| 4 simultaneous streams = high CPU/disk | Cap webcam at 720p, screen at native, audio is tiny. Stream to disk, don't buffer in memory |
| WebM timestamps drift between streams | Shared `performance.now()` at start, per-stream offset in manifest |
| Large video files over IPC | Never. Write to disk directly from where the stream is captured |
| macOS screen permission | Detect via `systemPreferences.getMediaAccessStatus('screen')`, guide user to System Preferences |
| Audio-driver daemon not installed | Graceful degradation -- capture mic via getUserMedia, skip system audio channel |
