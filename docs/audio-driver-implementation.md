# Audio Driver Migration into Sulla Desktop

## Overview

> **Migration status: COMPLETE.** The audio driver has been fully integrated into sulla-desktop as a built-in subsystem. The audio driver is now the canonical microphone path for all of sulla-desktop. See [`AUDIO_POLICY.md`](./AUDIO_POLICY.md) for the authoritative audio usage guide, IPC channel reference, and integration instructions for new features.

The original goal was to merge the standalone `audio-driver` Electron tray app into `sulla-desktop` as a built-in subsystem. The audio-driver's implementation is authoritative — conflicting sulla-desktop code is removed first, then audio-driver code is ported as-is, then wired into sulla-desktop features.

## Source Projects

- **audio-driver**: `sulla/audio-driver`
- **sulla-desktop**: `sulla/sulla-desktop`

## Audio Driver Architecture (What We're Porting)

### Three-Layer Audio Routing (macOS)

1. **Loopback Driver** — Virtual audio driver (AudioDriverLoopback or BlackHole 2ch fallback) that mirrors system audio
2. **Audio Mirror (Aggregate Device)** — Multi-Output Device combining physical speakers + loopback driver
3. **CoreAudio Capture** — Swift helper using HALOutput AudioUnit to capture raw PCM from the loopback input

### Key Components

| Source File | Purpose |
|-------------|---------|
| `src/main/controller/lifecycle.js` | Orchestrates startup: detect driver → create mirror → start capture |
| `src/main/controller/ipc.js` | IPC handlers for toggle, device selection, auth, transcription, gateway streaming |
| `src/main/model/loopback.js` | Detects available loopback driver (AudioDriverLoopback or BlackHole) |
| `src/main/model/mirror.js` | Creates/destroys aggregate device, watches for output device changes |
| `src/main/model/speaker-capture.js` | Spawns Swift helper to capture loopback PCM, computes RMS metrics |
| `src/main/model/audio.js` | Tracks capture state (running/stopped), persists toggle state |
| `src/main/model/auth.js` | Gateway authentication |
| `src/main/service/gateway.js` | WebSocket client: lobby connection + session lifecycle + audio streaming |
| `src/main/platform/darwin/index.js` | Swift runner: detection, mirror creation, device control, volume management |
| `src/main/platform/darwin/create-mirror` | Compiled C binary for aggregate device creation/destruction |
| `src/main/platform/darwin/*.swift` | Swift scripts for CoreAudio operations |
| `src/main/view/tray.js` | Tray menu (will be replaced by sulla-desktop UI) |
| `src/main/view/panel.js` | Popover panel (will be replaced by sulla-desktop UI) |
| `src/renderer/controller/app.js` | UI wiring: meters, device selectors, call session management |
| `src/renderer/model/audio-capture.js` | Web Audio mic capture with mute/gain control |
| `src/renderer/model/vad.js` | Voice Activity Detection orchestrator |
| `src/renderer/model/call-session.js` | Call session state management |
| `src/renderer/view/meters.js` | Real-time RMS/peak level bar rendering |
| `src/main/preload.js` | IPC bridge exposing `window.audioDriver` API |

### Lifecycle Flow

```
App Start
  → lifecycle.activate()
    → loopback.detect()          // Find AudioDriverLoopback or BlackHole
    → mirror.create()            // Create aggregate device (speakers + loopback)
    → speakerCapture.start()     // Spawn Swift helper, capture PCM
    → renderer: mic capture      // Web Audio getUserMedia + VAD
    → gateway.connect()          // WebSocket to transcription gateway
    → gateway.startSession()     // Begin streaming mic + speaker audio

App Stop / Toggle Off
  → gateway.endSession()
  → speakerCapture.stop()
  → mirror.destroy()
```

---

## Phase 0: Remove Conflicting Code from Sulla Desktop

Remove or gut these files before porting. They will be replaced by audio-driver equivalents.

### Files to Remove

| File | Reason |
|------|--------|
| `pkg/rancher-desktop/composables/voice/VoiceRecorderService.ts` | Replaced by audio-driver's mic capture + VAD |
| `pkg/rancher-desktop/composables/voice/VoicePipeline.ts` | Replaced by audio-driver's lifecycle controller |
| `pkg/rancher-desktop/agent/services/TranscriptionService.ts` | Replaced by audio-driver's gateway streaming |
| `pkg/rancher-desktop/controllers/virtualAudioDetection.ts` | Audio-driver handles this natively via loopback detection |

### Files to Keep

| File | Reason |
|------|--------|
| `pkg/rancher-desktop/composables/voice/TTSPlayerService.ts` | Audio-driver doesn't do TTS — keep this |
| `pkg/rancher-desktop/composables/voice/VoiceLogger.ts` | Useful logging utility — keep |
| `pkg/rancher-desktop/pages/AudioSettings.vue` | Will be updated to show audio-driver controls |
| `pkg/rancher-desktop/pages/SecretaryMode.vue` | Will wire into audio-driver lifecycle |

### Imports to Clean Up

After removing the files above, find and remove all imports/references to them throughout sulla-desktop. Key locations:
- Any Vue component that imports VoiceRecorderService or VoicePipeline
- Any agent node that references TranscriptionService
- Store modules that reference voice recording state

---

## Phase 1: Port Native Assets

Copy audio-driver's native macOS platform code into sulla-desktop.

### Target Location

```
pkg/rancher-desktop/main/audio-driver/
├── platform/
│   └── darwin/
│       ├── index.js              ← Swift runner (keep as JS)
│       ├── create-mirror         ← Compiled C binary
│       ├── create-mirror.c       ← C source
│       ├── capture-audio.swift   ← CoreAudio capture helper
│       ├── detect-driver.swift   ← Loopback driver detection
│       ├── list-devices.swift    ← Audio device enumeration
│       └── ... (other Swift scripts)
├── model/
│   ├── loopback.js               ← Loopback driver detection
│   ├── mirror.js                 ← Aggregate device management
│   ├── speaker-capture.js        ← Speaker audio capture
│   ├── audio.js                  ← Capture state tracking
│   └── auth.js                   ← Gateway auth
├── controller/
│   ├── lifecycle.js              ← Startup/shutdown orchestration
│   └── ipc.js                    ← IPC message handlers
├── service/
│   └── gateway.js                ← WebSocket gateway client
├── renderer/
│   ├── audio-capture.js          ← Mic capture (Web Audio)
│   ├── vad.js                    ← Voice activity detection
│   ├── call-session.js           ← Call session state
│   ├── meters.js                 ← Level meters
│   └── analyzers/                ← Audio analysis pipeline
│       └── ...
├── preload.js                    ← IPC bridge
└── logger.js                     ← Audio-driver logging
```

### Why Keep as JS (Not Convert to TS)

Port the audio-driver code as-is in JavaScript. This minimizes migration risk and keeps the code identical to what's tested and working. TypeScript conversion can happen later as a separate effort.

### Build Integration

- The `create-mirror` C binary must be compiled during `yarn build`, NOT at runtime
- Add a build script to sulla-desktop's build pipeline: `clang -framework CoreAudio -framework AudioToolbox create-mirror.c -o create-mirror`
- Update `electron-builder` config to include `pkg/rancher-desktop/main/audio-driver/platform/darwin/*` in `asarUnpack`
- Copy entitlements from audio-driver's `entitlements.mac.plist` into sulla-desktop's signing config

---

## Phase 2: Wire IPC Bridge

The audio-driver uses a preload script exposing `window.audioDriver` API to the renderer. This needs to be merged into sulla-desktop's existing preload.

### Steps

1. Review audio-driver's `src/main/preload.js` for all exposed methods
2. Add these IPC channels to sulla-desktop's existing preload script
3. Register the IPC handlers from audio-driver's `controller/ipc.js` in sulla-desktop's main process (background.ts)
4. Ensure the `window.audioDriver` namespace doesn't conflict with sulla-desktop's existing `window` APIs

---

## Phase 3: Wire Lifecycle into Secretary Mode

The audio-driver's `lifecycle.js` controller is the heart of the system. It orchestrates:
- Driver detection → mirror creation → capture start (activate)
- Capture stop → mirror destruction (deactivate)

This maps directly to Secretary Mode's always-listening behavior.

### Integration Points

1. **SecretaryMode.vue** — When secretary mode is enabled:
   - Call `lifecycle.activate()` to start the full audio capture pipeline
   - Show loopback driver status (detected/missing/fallback)
   - Show capture state (active/inactive)
   - Show real-time level meters for mic + speaker

2. **SecretaryMode.vue** — When secretary mode is disabled:
   - Call `lifecycle.deactivate()` to tear down cleanly

3. **AudioSettings.vue** — Add controls for:
   - Loopback driver status and installation prompt (BlackHole via Homebrew)
   - Speaker capture toggle (independent of mic)
   - Audio mirror status indicator

4. **Gateway integration** — The audio-driver's `gateway.js` service streams audio to the transcription gateway, which sends webhooks to GhostAgent's `GatewayWebhookController`. This creates Call records and dispatches `CallStatusChanged` events. This pipeline stays as-is.

### Volume Key Interception

When the audio mirror is active, volume keys control the aggregate device instead of the physical speakers. The audio-driver intercepts volume keys and redirects them to the original physical device. This must be wired into sulla-desktop's main process when secretary mode is active.

---

## Phase 4: Update UI Components

### Level Meters

Port audio-driver's `renderer/view/meters.js` (real-time RMS/peak bar rendering) into a Vue component for use in Secretary Mode and Audio Settings.

### Device Selection

Audio-driver enumerates devices via native CoreAudio. Wire this into AudioSettings.vue's existing device selection dropdowns, replacing the current Web Audio enumeration.

### Call Session UI

Port `renderer/model/call-session.js` state management. When a gateway session is active, show call status in the sulla-desktop UI (caller info, duration, transcription status).

---

## Phase 5: Build & Packaging

1. Add native binary compilation to sulla-desktop's build pipeline
2. Merge macOS entitlements (audio capture permissions)
3. Update electron-builder `asarUnpack` for native files
4. Test code signing with merged entitlements
5. Test DMG build end-to-end

---

## Phase 6: Deprecate Standalone Audio Driver

Once migration is verified:
1. Archive the audio-driver repo
2. Update any documentation referencing standalone audio-driver installation
3. Update GhostAgent's GatewayWebhookController caller_name default from 'Audio Driver' to 'Sulla Desktop'

---

## Execution Order

1. **Phase 0** — Remove conflicting code (clean slate)
2. **Phase 1** — Port native assets (verbatim copy)
3. **Phase 2** — Wire IPC bridge
4. **Phase 3** — Wire lifecycle into Secretary Mode
5. **Phase 4** — Update UI components
6. **Phase 5** — Build & packaging
7. **Phase 6** — Deprecate standalone

Each phase should be verified before moving to the next.
