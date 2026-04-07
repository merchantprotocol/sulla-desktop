# Audio Driver First Policy

**Status:** Active
**Date:** 2026-04-06

This document is the authoritative reference for how audio works in sulla-desktop. All features that consume microphone audio must follow the policies defined here.

---

## Audio Driver First Policy

All microphone audio in sulla-desktop MUST go through the audio driver pipeline. The audio driver is a built-in subsystem (ported from the standalone `audio-driver` Electron tray app) that provides a comprehensive audio analysis and capture stack.

### What the Audio Driver Provides

- **VAD (Voice Activity Detection)** — hysteresis-based detection with frame counting, silence ratio tracking, and configurable thresholds
- **Noise floor tracking** — adaptive noise floor estimation for dynamic environments
- **Feedback loop detection** — identifies and suppresses audio feedback
- **Fan noise detection** — spectral pattern matching for mechanical noise
- **Spectral analysis** — centroid, rolloff, and frequency distribution
- **Pitch detection** — fundamental frequency estimation
- **Zero-crossing rate (ZCR)** — temporal signal analysis
- **Temporal variance analysis** — signal stability measurement
- **Gain/mute control** — software volume and mute via GainNode

### When Direct `getUserMedia` Is Acceptable

Direct `getUserMedia` should only be used for raw hardware diagnostics — specifically the "Raw Mic Test" button in Audio Settings. This intentionally bypasses all processing to verify the physical microphone works at the hardware/OS level.

---

## Architecture Summary

### Mic Path

```
getUserMedia
  → AudioContext
  → GainNode (volume/mute control)
  → AnalyserNode
  → VAD pipeline (speaking detection, noise floor, spectral features)
  → MediaRecorder (250ms WebM/Opus chunks)
  → Unix socket
  → main process mic-socket.ts
  → gateway / whisper
```

### Speaker Path

```
BlackHole loopback
  → CoreAudio Swift capture helper
  → main process
  → speaker-socket.ts
  → gateway
```

### VAD Data Flow

The tray panel renderer runs the full VAD analysis pipeline and broadcasts results via IPC:

```
Tray panel renderer (audio-capture.js + vad.js + analyzers/)
  → Computes: speaking state, RMS level, noise floor, spectral centroid,
    spectral rolloff, ZCR, temporal variance, pitch, fan noise flag
  → Broadcasts audio-driver:mic-vad via IPC
  → All windows receive speaking state, noise floor, spectral features
```

### Transcript Flow

```
Gateway / whisper produce transcript events
  → main process receives transcript
  → Broadcasts gateway-transcript via IPC
  → All windows receive transcript text
```

---

## IPC Channel Reference

### Lifecycle

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:start-capture` | renderer → main | Start the audio capture pipeline |
| `audio-driver:stop-capture` | renderer → main | Stop the audio capture pipeline |
| `audio-driver:toggle` | renderer → main | Toggle capture on/off |
| `audio-driver:get-state` | renderer → main | Query current running state |
| `audio-driver:state` | main → renderer | Running state broadcast |

### Audio Data

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:mic-vad` | renderer → main → all windows | VAD events: speaking, level, fanNoise, noiseFloor, zcr, variance, pitch, centroid |
| `audio-driver:speaker-level` | main → renderer | Speaker RMS, peak, ZCR, and variance |

### Gateway Streaming

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:gateway-start` | renderer → main | Start streaming audio to gateway |
| `audio-driver:gateway-stop` | renderer → main | Stop streaming audio to gateway |
| `audio-driver:gateway-send` | renderer → main | Send audio chunk to gateway |

### Test Recording

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:test-record-start` | renderer → main | Start a test recording through the pipeline |
| `audio-driver:test-record-stop` | renderer → main | Stop the test recording |
| `audio-driver:test-recording-stopped` | main → renderer | Confirmation that test recording has stopped |

### Volume Control

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:volume-changed` | main → renderer | Volume level changed notification |
| `audio-driver:speaker-volume-up` | renderer → main | Increase speaker volume |
| `audio-driver:speaker-volume-down` | renderer → main | Decrease speaker volume |
| `audio-driver:speaker-mute-toggle` | renderer → main | Toggle speaker mute |

### Local STT (Whisper)

| Channel | Direction | Description |
|---------|-----------|-------------|
| `audio-driver:whisper-status` | main → renderer | Whisper engine status |
| `audio-driver:whisper-result` | main → renderer | Whisper transcription result |
| `audio-driver:transcribe-start` | renderer → main | Start local transcription |
| `audio-driver:transcribe-stop` | renderer → main | Stop local transcription |

### Cross-Cutting

| Channel | Direction | Description |
|---------|-----------|-------------|
| `gateway-transcript` | main → all windows | Transcript events from gateway or whisper |
| `gateway-status` | main → all windows | Gateway connection status |

---

## Current Bypass Points (Technical Debt)

The following files currently bypass the audio driver and access `getUserMedia` directly. Each is listed with its migration status:

### 1. `pages/capture-studio/composables/useMicCapture.ts`

**Status:** Should be migrated

Capture Studio mic capture uses its own `getUserMedia` call and audio processing. This should be migrated to consume `audio-driver:mic-vad` events and use the audio driver's recording pipeline.

### 2. `controllers/SecretaryModeController.ts`

**Status:** Should be migrated

Secretary Mode mic capture has its own `getUserMedia` and MediaRecorder setup. This should be migrated to use the audio driver pipeline, which already handles the same mic-to-gateway flow.

### 3. `pages/AudioSettings.vue` — Raw Mic Test section

**Status:** EXEMPT (intentional)

The Raw Mic Test button intentionally bypasses the audio driver to test the physical microphone at the hardware/OS level. This is a diagnostic tool and is the only acceptable direct `getUserMedia` usage.

### 4. `main/trayPanel/renderer/model/audio-capture.js`

**Status:** Correct usage

This IS the audio driver's mic capture implementation. It is the canonical `getUserMedia` call that feeds the entire audio driver pipeline.

---

## How to Integrate

Step-by-step guide for new features that need microphone audio:

### Step 1: Listen for VAD Events

Listen for `audio-driver:mic-vad` IPC events to receive speaking state and audio levels. The event payload includes:

```typescript
{
  speaking: boolean,
  level: number,        // RMS level (0-1)
  noiseFloor: number,   // Adaptive noise floor
  fanNoise: boolean,    // Fan noise detected
  zcr: number,          // Zero-crossing rate
  variance: number,     // Temporal variance
  pitch: number,        // Fundamental frequency (Hz)
  centroid: number      // Spectral centroid (Hz)
}
```

### Step 2: No Activation Needed

The audio driver auto-starts on boot. There is no need to call start/activate for basic VAD consumption. The pipeline is always running when sulla-desktop is open.

### Step 3: Recording

For recording through the pipeline, use `audio-driver:test-record-start` and `audio-driver:test-record-stop`. The audio driver handles MediaRecorder, chunking, and encoding.

### Step 4: Transcription

For speech-to-text, use either:
- `audio-driver:gateway-start` — streams to the Enterprise Gateway for cloud STT
- `audio-driver:transcribe-start` — uses the local Whisper engine for on-device STT

### Step 5: Never Call `getUserMedia` Directly

For any conversation, recording, or transcription feature, never call `navigator.mediaDevices.getUserMedia()` directly. Always go through the audio driver pipeline. The only exception is the Raw Mic Test diagnostic in Audio Settings.
