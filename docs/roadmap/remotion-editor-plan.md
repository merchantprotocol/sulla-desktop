# Remotion Editor: Descript-Style Video Editing

## Vision

A Descript-style transcript-driven video editor, built on top of the forked Remotion repo at `~/sulla/remotion/`. Runs in its own container, reads capture sessions produced by Sulla Desktop, and provides transcript editing, multi-stream composition, and rendering.

This is a **separate project** from Sulla Desktop. Sulla handles capture (see [capture-studio-plan.md](capture-studio-plan.md)). This project handles everything after capture: editing, composing, and exporting.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  REMOTION EDITOR (container: remotion_studio)        │
│  Port 30310                                          │
│                                                      │
│  ├── Transcript Editor (Descript-style)              │
│  │   Edit text = edit video, non-destructive EDL     │
│  ├── Compositor                                      │
│  │   PiP, side-by-side, captions, overlays           │
│  └── Renderer                                        │
│      MP4/WebM export via headless Chrome             │
│                                                      │
│  Bind mounts:                                        │
│  ~/sulla/captures/  -> /app/captures  (read)         │
│  ~/sulla/remotion/  -> /app/projects  (read/write)   │
│  ~/sulla/remotion/output/ -> /app/out (write)        │
└──────────────────────────────────────────────────────┘
```

Sulla Desktop opens the editor as an iframe tab (existing pattern -- Remotion Studio already runs at port 30310 via Docker extension).

---

## Core Concept: Transcript-Driven Editing

The editor reads a capture session's `manifest.json` and `transcript.json`. The user sees their transcript as editable text. All edits are non-destructive -- source files are never modified.

### Editing operations

| User action | What happens |
|-------------|-------------|
| Select words in transcript | Corresponding video region highlights in preview |
| Delete words | Creates a "cut" -- time range excluded via EDL |
| Drag to reorder | Creates a "splice" -- rearranges segment order |
| Type replacement text | Marks segment for TTS re-synthesis (Overdub) |
| Click word | Playhead jumps to that timestamp |

### Edit Decision List (EDL)

```json
{
  "sessionId": "session-uuid",
  "cuts": [
    { "start": 12.4, "end": 15.1, "reason": "deleted" },
    { "start": 45.0, "end": 47.3, "reason": "filler-word" }
  ],
  "splices": [
    { "segments": [[0, 12.4], [15.1, 45.0], [47.3, 184.5]] }
  ],
  "overdubs": [],
  "layout": "picture-in-picture",
  "captions": { "enabled": true, "style": "word-highlight" }
}
```

### Built-in transcript tools

- Remove filler words ("um", "uh", "like") -- one click, uses word-level timestamps
- Remove silence gaps > N seconds
- Speaker labeling / color coding per channel
- Find and replace across transcript

---

## Remotion Composition Layer

### Project template: capture-editor

```
~/sulla/remotion/projects/capture-editor/
  ├── src/
  │   ├── Root.tsx                    # Composition definitions
  │   ├── CaptureComposition.tsx      # Main composition
  │   ├── layouts/
  │   │   ├── PictureInPicture.tsx    # Screen full + webcam corner
  │   │   ├── SideBySide.tsx          # Screen left + webcam right
  │   │   ├── SpeakerFocus.tsx        # Webcam full + screen small
  │   │   └── ScreenOnly.tsx          # Screen only, no webcam
  │   ├── overlays/
  │   │   ├── Captions.tsx            # Word-by-word animated captions
  │   │   ├── SpeakerLabel.tsx        # Name tags per speaker
  │   │   └── Watermark.tsx           # Brand overlay
  │   └── lib/
  │       ├── readManifest.ts         # Parse manifest.json from capture session
  │       ├── readEDL.ts              # Parse edits.json -> frame ranges
  │       └── timeToFrame.ts          # Timestamp <-> frame conversion
  └── package.json
```

### How rendering works

1. `CaptureComposition` receives manifest + EDL as `inputProps`
2. Calculates final duration from EDL splices (excluding cuts)
3. For each splice segment, renders chosen layout with correct time offsets into source WebM/WAV files
4. Overlays captions from transcript with word-level highlighting
5. Renders to MP4 via `npx remotion render` in the Docker container
6. Output lands in `~/sulla/remotion/output/`

### Why Remotion works for this

- Already forked and running in Docker with bind mounts
- React-based -- can build the editor UI as React components within Remotion Studio
- `<OffthreadVideo>` for efficient multi-stream video decoding
- Frame-precise composition -- can align 4 streams to exact frames
- Existing skill/rules library with 35+ patterns (animations, transitions, captions, audio-viz)
- Programmatic rendering -- agents can trigger exports

---

## Implementation Phases

### Phase 1: Capture Session Viewer

- Read `manifest.json` from `~/sulla/captures/`
- Session browser: list available capture sessions
- Basic playback: synchronized screen + webcam + audio
- Layout selector (PiP, side-by-side, screen-only)

### Phase 2: Transcript Editor UI

- Display word-level transcript from `transcript.json`
- Click word -> seek playhead to timestamp
- Select word range -> highlight corresponding video region
- Rich text editor (ProseMirror or Slate) with word-level spans

### Phase 3: Non-Destructive Editing

- Delete words -> create cuts in EDL
- Drag to reorder -> create splices in EDL
- Filler word removal (one-click, batch)
- Silence removal (configurable threshold)
- Undo/redo stack on EDL operations

### Phase 4: Composition + Export

- Apply EDL to Remotion composition
- Layout selection persisted in EDL
- Caption overlay with word-highlight animation
- Export button -> `npx remotion render` in container -> MP4
- Progress indicator during render

### Phase 5: Advanced Features

- Overdub: replace words with TTS re-synthesis (ElevenLabs voice cloning)
- Multi-session stitching (combine multiple capture sessions)
- Template library (intro/outro from existing Remotion templates)
- Agent-assisted editing ("remove all filler words", "add captions", "render as PiP")

---

## Integration with Sulla Desktop

Sulla Desktop interacts with the Remotion editor through:

1. **Filesystem** -- writes capture sessions to `~/sulla/captures/`, editor reads them
2. **Docker extension** -- starts/stops the Remotion Studio container
3. **iframe tab** -- opens the editor UI at `http://localhost:30310` in an Agent window tab
4. **Agent tools** -- agents can invoke editor operations via the existing Remotion skill

No direct IPC or API needed between Sulla and the editor -- the shared filesystem and existing Docker extension pattern handle everything.
