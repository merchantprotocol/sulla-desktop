# PRD: Voice/Audio System

**Status:** Draft
**Date:** 2026-03-20
**Owner:** Engineering

---

## 1. Overview

The Voice/Audio System enables hands-free interaction with Sulla through microphone recording, speech-to-text (STT), text-to-speech (TTS), and a state machine that orchestrates the full voice conversation loop. It supports three voice modes (voice, secretary, intake) with different flush behaviors, barge-in interruption, and round-trip latency tracking.

---

## Audio Driver First Policy

> **Canonical reference:** See [`AUDIO_POLICY.md`](./AUDIO_POLICY.md) for the full audio usage guide, IPC channel reference, and integration instructions.

The audio driver is the canonical microphone path for all of sulla-desktop. All microphone audio MUST go through the audio driver pipeline, which provides VAD (with hysteresis, frame counting, silence ratio), noise floor tracking, feedback loop detection, fan noise detection, spectral analysis, pitch detection, zero-crossing rate, temporal variance analysis, and gain/mute control.

Direct `getUserMedia` calls bypass all of this processing and should only be used for raw hardware diagnostics (the "Raw Mic Test" button in Audio Settings). See `AUDIO_POLICY.md` for the current list of bypass points that need migration.

---

## 2. Current Architecture

### 2.1 Frontend (`composables/voice/`)

| File | Responsibility |
|------|---------------|
| `VoiceRecorderService.ts` | Microphone stream acquisition, audio level monitoring, VAD silence detection, batch recording via MediaRecorder, browser SpeechRecognition fallback, non-speech filtering, transcription dispatch via IPC |
| `TTSPlayerService.ts` | TTS playback queue, sequential sentence playback, look-ahead prefetch, sequence counter for race condition prevention, content deduplication (10s window), browser SpeechSynthesis fallback |
| `VoicePipeline.ts` | State machine (IDLE / LISTENING / THINKING / SPEAKING), fragment accumulation, turn detection (silence / speaker change / time-based), interim bubble management, speak message detection via Vue message watcher, barge-in coordination, secretary analysis parsing |
| `useVoiceSession.ts` | Vue composable that creates all three services, bridges service events to Vue refs, polls `pipeline.state` (100ms) and `recordingDuration` (250ms), auto-disposes on component unmount |
| `VoiceLogger.ts` | Unified `[VOICE:COMPONENT:EVENT] key=value` logging to both DevTools console and persistent log files via IPC. Components: REC, VAD, STT, PIPE, TTS, TIMING |
| `TypedEventEmitter.ts` | Lightweight typed event system with `on()` returning unsubscribe functions. Base class for VoiceRecorderService and TTSPlayerService |

### 2.2 Backend (`agent/services/` + `agent/nodes/BaseNode.ts`)

| File / Method | Responsibility |
|--------------|---------------|
| `TranscriptionService.ts` | ElevenLabs Scribe V2 STT with Enterprise Gateway routing, retry with exponential backoff, 30s request timeout, diarization support |
| `TextToSpeechService.ts` | ElevenLabs Flash V2.5 TTS via streaming endpoint, configurable voice ID, retry with exponential backoff, 15s request timeout |
| `BaseNode.callLLMStreaming()` | Streams LLM tokens. In voice mode: progressive `<speak>` tag extraction, sentence boundary detection (skips abbreviations, requires 20+ char sentences), dispatches sentences via `wsSpeakDispatch()`. In non-voice mode: throttled text streaming to UI |
| `BaseNode.wsSpeakDispatch()` | Sends `speak_dispatch` WebSocket event with text and thread ID. Logs caller stack trace. The sole server-side path for TTS content |
| `BaseNode.extractAndDispatchSpeakTags()` | Post-completion `<speak>` extraction for non-voice mode. Extracts all `<speak>...</speak>` content from final response and dispatches via `wsSpeakDispatch()` |
| `AgentPersonaModel` (WebSocket handler) | Receives `speak_dispatch` events, creates messages with `kind='speak'` in the Vue messages array. These messages are filtered from chat display and exist solely to trigger TTS |
| `sullaEvents.ts` | IPC handlers: `audio-transcribe` (routes to TranscriptionService), `audio-speak` (routes to TextToSpeechService), `voice-log` (persists frontend voice events to SullaLogger), `audio-driver-connect/disconnect/status` (AudioDriverClient lifecycle) |
| `AudioDriverClient.ts` | Connects to the local audio-driver daemon over a Unix socket (`/tmp/audio-driver.sock`). Receives labeled audio chunks (speaker/system audio) and emits `chunk` events. Speaker chunks are forwarded to the gateway as channel 1 by `sullaEvents.ts` |

### 2.3 Data Flows

**STT Flow (Speech to Text) — via Audio Driver Pipeline:**
```
Microphone
  -> getUserMedia (in audio driver's tray panel renderer: audio-capture.js)
  -> AudioContext → GainNode (volume/mute) → AnalyserNode
  -> VAD pipeline (speaking detection, noise floor, spectral analysis, pitch, ZCR, variance)
  -> Broadcasts audio-driver:mic-vad via IPC (all windows receive speaking state)
  -> MediaRecorder (250ms WebM/Opus chunks)
  -> Unix socket → main process mic-socket.ts
  -> Gateway / Whisper STT
  -> TranscriptionResult { text, words[] with speaker_id }
  -> main process broadcasts gateway-transcript via IPC
  -> All windows receive transcript text
  -> VoicePipeline or consumer feature processes transcript
```

**Legacy STT Flow (Direct getUserMedia — being migrated):**
```
Microphone
  -> MediaStream (getUserMedia)
  -> AudioContext + AnalyserNode (VAD: RMS level monitoring at 100ms intervals)
  -> MediaRecorder (batch recording, webm/opus)
  -> VAD silence confirmed (threshold exceeded for vadSilenceDuration ms)
  -> MediaRecorder.stop() -> audioBlob
  -> IPC 'audio-transcribe' -> TranscriptionService
  -> ElevenLabs Scribe V2 (or Enterprise Gateway)
  -> TranscriptionResult { text, words[] with speaker_id }
  -> Non-speech filtering (strip [background noise], [singing], etc.)
  -> VoiceRecorderService emits 'fragment' event
  -> VoicePipeline.handleFragment() -> buffer accumulation, interim bubble update
  -> VoiceRecorderService emits 'silence' event (after transcription completes)
  -> VoicePipeline.handleSilence() -> flush()
  -> ChatInterface.send({ inputSource: 'microphone', voiceMode, pipelineSequence })
```

**Multi-Channel Audio Flow (Secretary Mode with Audio Driver):**
```
Audio Driver daemon (system audio capture)
  -> Unix socket /tmp/audio-driver.sock
  -> AudioDriverClient receives labeled chunks
  -> sullaEvents.ts 'audio-driver-connect' handler
  -> Speaker chunks forwarded to GatewayConnectionController.sendAudioChunk(data, channel=1)
  -> GatewayListenerService.sendAudio(data, channel=1) — prefixed with [0x01][channel] wire header
  -> Gateway WebSocket (binary frame)
  -> Gateway routes channel 1 to per-channel STT pipeline

Meanwhile, mic audio continues on channel 0 (original path, no header prefix).
Gateway session is created with a channel map: { "0": mic, "1": system_audio }.
```

**TTS Flow (Text to Speech):**
```
LLM streaming response
  -> BaseNode.callLLMStreaming() onToken callback
  -> contentBuffer accumulation
  -> <speak> tag open detected -> insideSpeakTag = true
  -> speakBuffer + sentenceBuffer accumulation
  -> Sentence boundary detection (. ! ? followed by whitespace, 20+ chars, not abbreviation)
     OR </speak> close tag detected
  -> BaseNode.wsSpeakDispatch(state, sentenceText)
  -> WebSocket 'speak_dispatch' event { type, data: { text, thread_id, timestamp } }
  -> AgentPersonaModel.handleMessage() case 'speak_dispatch'
  -> messages.push({ id: `${Date.now()}_speak`, kind: 'speak', content: text })
  -> VoicePipeline.detectSpeakMessages() (Vue deep watcher on messages array)
  -> processedSpeakIds dedup check
  -> TTSPlayerService.enqueue(text, messageId)
  -> Content dedup (10s window) + ID dedup
  -> playNext() -> IPC 'audio-speak' -> TextToSpeechService
  -> ElevenLabs Flash V2.5 streaming endpoint
  -> Audio buffer (mp3) returned
  -> HTMLAudioElement.play()
  -> Prefetch: next queued sentence fetched while current plays
```

---

## 2.4 Gateway Audio Format Contract

This section defines the exact audio format requirements for sending audio to the Enterprise Gateway. The gateway uses FFmpeg to normalize all incoming audio to PCM `s16le` 16kHz mono before forwarding to ElevenLabs. Getting the format wrong means FFmpeg produces garbage output and transcription fails silently.

**Canonical reference:** See `enterprise-gateway/docs/audio-protocol.md` for the full gateway specification.

### Gateway Target Format

All audio is converted to this format before reaching ElevenLabs:

| Property | Value |
|----------|-------|
| Encoding | PCM signed 16-bit little-endian (`s16le`) |
| Sample rate | 16,000 Hz |
| Channels | 1 (mono) |
| Byte rate | 32,000 bytes/sec |

### Channel 0 — Microphone (WebM/Opus)

**What we send:**

| Property | Value | Source |
|----------|-------|--------|
| Container | WebM | `MediaRecorder` default |
| Codec | Opus | `audio/webm;codecs=opus` MIME type |
| Sample rate | 48,000 Hz | Browser default |
| Channels | 1 (mono) | Single mic input |
| Chunk interval | 250ms | `MediaRecorder.start(250)` timeslice |
| Wire format | Raw binary WebSocket frame | No channel prefix (channel 0 default) |

**How the gateway processes it:**

FFmpeg auto-detects WebM from the EBML magic bytes (`0x1A 0x45 0xDF 0xA3`) in the first chunk, demuxes the WebM container, decodes Opus, resamples 48kHz → 16kHz, and outputs PCM `s16le`.

**Critical requirement — first chunk must contain the WebM header:**

The first 250ms chunk from `MediaRecorder` contains the WebM EBML header, codec initialization data, and the first audio cluster. FFmpeg needs this header to initialize the demuxer. If the first chunk is dropped (e.g., due to WebSocket backpressure exceeding the 64KB threshold in `GatewayListenerService`), FFmpeg cannot decode any subsequent chunks because they are WebM cluster continuations without a container header.

**No `audioFormat` metadata is sent for channel 0.** The gateway relies entirely on magic-byte detection. This is intentional — container formats like WebM are self-describing and FFmpeg can probe them without hints.

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 272-274: MIME type selection)
- `composables/voice/VoiceRecorderService.ts` (line 677: `MediaRecorder.start(250)`)
- `controllers/SecretaryModeController.ts` (lines 596-603: session creation with channel map)
- `agent/services/GatewayListenerService.ts` (lines 408-429: WebSocket send with backpressure check)

### Channel 1 — System Audio (Raw PCM)

**What we send:**

| Property | Value | Source |
|----------|-------|--------|
| Format | Raw PCM signed 16-bit little-endian (`s16le`) | Audio Driver daemon |
| Sample rate | 16,000 Hz | Audio Driver output |
| Channels | 1 (mono) | Audio Driver downmix |
| Wire format | `[0x01][0x01][PCM bytes...]` | Channel-tagged binary frame |

**How the gateway processes it:**

FFmpeg receives raw PCM `s16le` at 16kHz mono — this already matches the target format, so conversion is a passthrough. The gateway uses the `audioFormat` metadata from the session creation payload to configure FFmpeg's input flags.

**`audioFormat` metadata is required for channel 1** because raw PCM has no container header and FFmpeg cannot auto-detect it:

```json
{
  "1": {
    "label": "Caller",
    "source": "system_audio",
    "audioFormat": {
      "inputFormat": "s16le",
      "inputRate": 16000,
      "inputChannels": 1
    }
  }
}
```

**Source files:**
- `agent/services/AudioDriverClient.ts` (lines 27-42: Unix socket chunk parsing)
- `controllers/SecretaryModeController.ts` (lines 596-603: channel metadata)
- `main/sullaEvents.ts`: `audio-driver-connect` handler forwards speaker chunks to gateway

### Session Creation Payload

When starting a secretary mode session, the full session creation request looks like:

```json
POST /api/desktop/sessions
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "callerName": "Sulla Secretary",
  "userId": "{user_id}",
  "callId": "{unique_call_id}",
  "meta": {
    "audioSource": "desktop",
    "mode": "listen-only",
    "channels": {
      "0": { "label": "User", "source": "mic" },
      "1": {
        "label": "Caller",
        "source": "system_audio",
        "audioFormat": { "inputFormat": "s16le", "inputRate": 16000, "inputChannels": 1 }
      }
    }
  }
}
```

**Response includes `sessionId`** which is used to open the audio WebSocket:

```
wss://{gateway}/ws/audio/{sessionId}
```

### Wire Protocol Summary

```
Desktop MediaRecorder (WebM/Opus, 48kHz, mono)
  │  250ms chunks via ondataavailable
  │  ArrayBuffer conversion
  ▼
IPC: gateway-audio-send { audio: ArrayBuffer, channel: 0 }
  ▼
GatewayListenerService.sendAudio(buffer, channel=0)
  │  Backpressure check (skip if bufferedAmount > 64KB)
  │  Channel 0: send raw binary frame
  │  Channel 1+: prepend [0x01][channel] header
  ▼
WebSocket binary frame → wss://{gateway}/ws/audio/{sessionId}
  ▼
Gateway audioStreamHandler.js
  │  Detect frame type (binary vs JSON)
  │  Extract channel from 0x01 prefix if present
  ▼
Gateway AudioConverter (FFmpeg child process)
  │  WebM/Opus → PCM s16le 16kHz mono
  ▼
ElevenLabs WebSocket: { "user_audio_chunk": "<base64 PCM>" }
```

### Backpressure & Reliability

| Concern | Current Behavior | Risk |
|---------|-----------------|------|
| WebSocket backpressure | Chunks skipped when `bufferedAmount > 64KB` | First WebM chunk (with EBML header) could be dropped |
| FFmpeg crash mid-session | Gateway detects and restarts FFmpeg | New FFmpeg process won't have the WebM header from the original first chunk |
| Audio Driver disconnect | Desktop stops sending channel 1 | Channel 0 (mic) continues unaffected |

---

## 3. Problems / Complexity Issues

### P1: TTS data flow crosses 6 boundaries

The speak content passes through LLM output -> `BaseNode.callLLMStreaming` (extraction) -> `BaseNode.wsSpeakDispatch` (WebSocket send) -> `AgentPersonaModel` (message creation) -> `VoicePipeline.detectSpeakMessages` (array watching) -> `TTSPlayerService.enqueue` (playback). When TTS speaks wrong content, debugging requires tracing across all six boundaries in two processes (main + renderer) with no single controller or registry that knows the full chain.

### P2: Speak extraction is embedded in BaseNode

The `<speak>` tag parsing lives inside an `onToken` closure inside `callLLMStreaming()` inside BaseNode. It handles both streaming mode (progressive sentence dispatch) and non-streaming mode (`extractAndDispatchSpeakTags` post-completion) with separate code paths that can diverge. This logic is not independently testable, not reusable across node types, and not replaceable without modifying BaseNode.

### P3: No SpeakMessage type

Speak content flows as plain strings through WebSocket JSON with string `type` and `kind` fields. There is no typed interface, no validation at any boundary, and no guarantee that what was extracted is what gets played. The `speak_dispatch` WebSocket event is an untyped `{ type: string, data: any }` object.

### P4: VoicePipeline watches messages array for speak events

Instead of receiving speak events directly via a typed channel, VoicePipeline uses a Vue `watch(messages, { deep: true })` watcher to scan the entire messages array on every mutation, looking for entries with `kind === 'speak'`. This is indirect, fragile (depends on mutation ordering), and creates timing dependencies between message array updates and TTS dispatch.

### P5: useVoiceSession polls state

The composable polls `pipeline.state` every 100ms and `recorder.recordingDuration` every 250ms using `setInterval` instead of receiving events. This adds latency (up to 100ms for state changes) and CPU overhead (continuous polling even when idle). The `TypedEventEmitter` base class already supports event-driven updates.

### P6: VAD, recording, and transcription co-located in VoiceRecorderService

One 589-line class handles microphone acquisition, audio level monitoring (20x/sec), VAD silence detection (RMS threshold at 100ms intervals), batch recording via MediaRecorder, browser SpeechRecognition, transcription dispatch, non-speech filtering, and speaker extraction. These are separate concerns with different testing and replacement needs.

### P7: No end-to-end correlation ID

A voice turn has no single ID that flows from speech detection through transcription, flush, LLM call, speak extraction, and TTS playback. The pipeline has a `currentSequence` counter and VoiceLogger has timing milestones, but these are local to the frontend. The backend has no awareness of the pipeline sequence. Log correlation across frontend and backend is manual.

---

## 4. Must Have (existing features that must continue working)

### 4.1 Microphone Recording with Level Meter and Duration Timer

**As a user, I want to see a real-time audio level meter and recording timer so that I know my microphone is active and picking up my voice.**

- `VoiceRecorderService` acquires a `MediaStream` via `getUserMedia` with optional device selection
- Audio level is computed from `AnalyserNode.getByteTimeDomainData()` at 50ms intervals, normalized to 0-100 scale, emitted as `levelChange` events
- Recording duration is formatted as `M:SS` and updated every 1000ms
- Level meter and timer are displayed to the left of the stop button

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 279-319: level monitor, lines 258-275: timer)
- `composables/voice/useVoiceSession.ts` (lines 96-110: duration polling bridge)

### 4.2 VAD (Voice Activity Detection)

**As a user, I want Sulla to automatically detect when I start and stop speaking so I don't have to press a button for each utterance.**

- RMS-based VAD running at 100ms intervals on the `AnalyserNode`
- Configurable silence threshold (default: 20) and silence duration (default: 800ms)
- 400ms initial grace period to avoid false silence detection at segment start
- Speech onset emits `speechStart` event (triggers barge-in if TTS is playing)
- Silence confirmed emits segment flush -> transcription

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 514-588: VAD implementation)

### 4.3 Speech-to-Text via ElevenLabs Scribe V2

**As a user, I want my speech accurately transcribed so that Sulla understands what I said.**

- Batch mode: MediaRecorder produces audio segments (webm/opus), sent via IPC `audio-transcribe` to `TranscriptionService`
- ElevenLabs Scribe V2 model with optional diarization (per-word speaker IDs)
- Enterprise Gateway routing when configured (proxies to ElevenLabs server-side)
- Retry with exponential backoff (3 attempts, 500ms initial delay)
- 30-second request timeout
- Returns `TranscriptionResult { text, words[] }` with speaker attribution

**Source files:**
- `agent/services/TranscriptionService.ts`
- `main/sullaEvents.ts` (line 1045: `audio-transcribe` handler)

### 4.4 Speech-to-Text via Browser SpeechRecognition (Fallback)

**As a user, I want voice input to work even without an ElevenLabs API key by falling back to my browser's built-in speech recognition.**

- Uses `window.SpeechRecognition` or `window.webkitSpeechRecognition`
- Continuous mode with interim results
- Configurable language (`sttLanguage` setting, default: `en-US`)
- Low-confidence result rejection (confidence < 0.4)
- Non-English character rejection for English mode (CJK/Korean character detection)
- Auto-restart on `onend` for continuous listening
- Falls back to ElevenLabs mode if browser recognition encounters network/permission errors

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 323-421: browser STT)

### 4.5 Non-Speech Filtering

**As a user, I want background noise, music, and singing to be ignored so that only my actual words are sent to the AI.**

- ElevenLabs Scribe V2 labels non-speech as `[background noise]`, `[singing]`, `[music]`, etc.
- All bracketed labels are stripped: `raw.replace(/\[.*?\]/g, '').trim()`
- If no real speech remains after stripping, the fragment is discarded and `silence` is emitted
- Filtered events are logged via `logTranscriptionFiltered()`

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 465-478: non-speech filtering)

### 4.6 Text-to-Speech via ElevenLabs Flash V2.5

**As a user, I want Sulla to speak her responses aloud with a natural-sounding voice.**

- ElevenLabs TTS streaming endpoint with `eleven_flash_v2_5` model (lowest latency)
- Configurable voice ID (default: Jessica, `cgSgspJ2msm6clMCkdW9`)
- Voice settings: stability 0.5, similarity_boost 0.75, optimize_streaming_latency 3
- Returns MP3 audio buffer
- Retry with exponential backoff (3 attempts, 500ms initial delay)
- 15-second request timeout

**Source files:**
- `agent/services/TextToSpeechService.ts`
- `main/sullaEvents.ts` (line 1057: `audio-speak` handler)

### 4.7 TTS Queue with Sequential Sentence Playback

**As a user, I want Sulla's spoken response to play sentences in order without overlap so it sounds like natural speech.**

- FIFO queue in `TTSPlayerService`
- Sequential playback via `playNext()` with re-entrancy lock (`playing` flag)
- Each sentence: IPC `audio-speak` -> audio buffer -> `Blob` -> `URL.createObjectURL` -> `HTMLAudioElement.play()`
- `onended` triggers next sentence; `onerror` skips to next
- URL revoked after playback to prevent memory leaks

**Source files:**
- `composables/voice/TTSPlayerService.ts` (lines 146-254: playNext)

### 4.8 TTS Prefetch

**As a user, I want minimal gaps between sentences so Sulla's speech sounds fluent.**

- While current sentence plays, next queued sentence is fetched in parallel via `prefetch()`
- Prefetch result cached as `{ text, result }` and used by `playNext()` if text matches
- If `playNext()` finds an in-flight prefetch for its text, it waits up to 5 seconds
- Prefetch failures are non-fatal (logged but don't break playback)
- `AbortController` cancels prefetch on `stop()`

**Source files:**
- `composables/voice/TTSPlayerService.ts` (lines 262-290: prefetch)

### 4.9 TTS Deduplication

**As a user, I want Sulla to never repeat the same sentence back-to-back due to duplicate messages.**

- ID-based dedup: `processedIds` set tracks message IDs that have been enqueued
- Content-based dedup: `recentContent` set with 10-second TTL prevents identical text within a window
- Deduplicated items are logged via `logTTSDedup()`

**Source files:**
- `composables/voice/TTSPlayerService.ts` (lines 71-93: enqueue with dedup)

### 4.10 TTS Browser SpeechSynthesis Fallback

**As a user, I want to hear Sulla's responses even if the ElevenLabs API is unavailable.**

- `browserFallback()` uses `window.speechSynthesis` and `SpeechSynthesisUtterance`
- Triggered when IPC `audio-speak` throws an error
- Logged via `logTTSFallback()`

**Source files:**
- `composables/voice/TTSPlayerService.ts` (lines 298-313: browser fallback)

### 4.11 Voice Pipeline State Machine

**As a user, I want a clear visual indicator of whether Sulla is listening, thinking, or speaking so I know when to talk.**

State transitions:
```
IDLE ──(speechStart)──> LISTENING
LISTENING ──(flush)──> THINKING
THINKING ──(speak detected)──> SPEAKING
SPEAKING ──(queue empty)──> IDLE
THINKING ──(graph complete)──> IDLE or LISTENING (if buffer has content)
SPEAKING/THINKING ──(speechStart: barge-in)──> LISTENING
```

- State drives UI indicators and event handling behavior
- Flush timer runs only in LISTENING state (interval varies by mode)
- All transitions logged via `logPipelineState(from, to)`

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 228-240: transitionTo, lines 248-342: event handlers)

### 4.12 Barge-In

**As a user, I want to interrupt Sulla while she's speaking so I can redirect the conversation.**

- When VAD detects `speechStart` during SPEAKING or THINKING state:
  - `TTSPlayerService.stop()` — clears queue, pauses audio, cancels prefetch, increments sequence counter
  - `ChatInterface.stop()` — aborts in-progress graph run
  - Transitions to LISTENING
- Logged via `logBargeIn()`

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 248-269: handleSpeechStart barge-in)

### 4.13 Interim Voice Bubble

**As a user, I want to see my words appear in the chat as I speak so I know my speech is being captured.**

- A synthetic message with `id='__voice_interim__'` and `kind='voice_interim'` is inserted into the messages array
- Updated on each transcription fragment with accumulated text
- Removed on flush (before the real user message is sent)

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 400-424: interim bubble management)

### 4.14 Speaker Change Detection

**As a user in a multi-speaker environment, I want Sulla to flush and respond when a different person starts talking.**

- `TranscriptionService` returns per-word `speaker_id` via ElevenLabs diarization
- `VoiceRecorderService.extractPrimarySpeaker()` determines the dominant speaker per segment
- `VoicePipeline.handleFragment()` compares incoming `speakerId` to `currentSpeaker`
- On speaker change: flush current buffer before appending new speaker's text
- Logged via `logSpeakerChange(from, to)`

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 288-301: speaker change in handleFragment)
- `composables/voice/VoiceRecorderService.ts` (lines 491-510: extractPrimarySpeaker)

### 4.15 Voice Modes

**As a user, I want different voice interaction styles depending on my context — conversational, observational, or guided intake.**

| Mode | Flush Interval | Behavior |
|------|---------------|----------|
| `voice` | 5,000ms (safety backstop) | Primary flush on silence-after-transcription. Full bidirectional voice conversation |
| `secretary` | 30,000ms | Long-listen mode. Accumulates extended speech. Parses `<secretary_analysis>` tags. Silent output (no TTS, `<speak>` tags stripped) |
| `intake` | 15,000ms | Guided Q&A with longer accumulation windows |

- Mode is a Vue ref, watched by VoicePipeline to restart flush timer on change
- Secretary/intake modes strip `<speak>` tags from LLM output in BaseNode

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 48-55: flush intervals, lines 130-137: mode watcher)
- `agent/nodes/BaseNode.ts` (lines 1131-1138: mode-specific post-processing)

### 4.16 Secretary Analysis Parsing

**As a user in secretary mode, I want Sulla to extract structured actions, facts, and conclusions from the conversation.**

- Watches messages for `<secretary_analysis>` XML blocks containing `<actions>`, `<facts>`, `<conclusions>` sub-tags
- Parses bulleted list items within each sub-tag
- Invokes `onSecretaryResult` callback with typed `SecretaryAnalysis` object
- Marks parsed messages to avoid re-processing (`__secretary_parsed_${m.id}`)

**Source files:**
- `composables/voice/VoicePipeline.ts` (lines 139-162: secretary watcher, lines 429-437: extractListItems helper)

### 4.17 Microphone Release on Stop

**As a user, I want the microphone indicator in my OS to disappear when I stop recording.**

- `VoiceRecorderService.stop()` calls `mediaStream.getTracks().forEach(t => t.stop())` and nulls the stream reference
- `AudioContext` is closed
- `dispose()` is the final cleanup — releases everything including handlers

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 152-161: stop cleanup, lines 179-205: dispose)

### 4.18 Round-Trip Latency Logging

**As a developer, I want to measure the full round-trip latency from speech to audio so I can identify performance bottlenecks.**

Timing milestones (all via `VoiceLogger.ts`):
1. `TIMING:SPEECH_START` — VAD detects speech (resets all timing)
2. `TIMING:STT_DONE` — STT returns text (logs `sttMs`)
3. `TIMING:FLUSH` — Pipeline flushes buffer (logs `bufferMs`, `totalMs`)
4. `TIMING:FIRST_SPEAK` — First speak message detected (logs `llmMs`, `totalMs`)
5. `TIMING:ROUND_TRIP` — First TTS audio plays (logs `sttMs`, `bufferMs`, `llmMs`, `ttsGenMs`, `roundTripMs`)

**Source files:**
- `composables/voice/VoiceLogger.ts` (lines 262-324: timing functions)

### 4.19 Configurable Audio Settings

**As a user, I want to configure my microphone, language, voice, and sensitivity settings.**

Settings stored via `SullaSettingsModel` and loaded by `VoiceRecorderService.loadSettings()`:
- `audioTranscriptionMode` — `'browser'` | `'elevenlabs'` | `'gateway'` (default: `'elevenlabs'`)
- `audioVadSilenceThreshold` — VAD RMS threshold (default: 20)
- `audioVadSilenceDuration` — Silence ms before flush (default: 800)
- `audioSttLanguage` — STT language code (default: `'en-US'`)
- `audioInputDeviceId` — Specific microphone device ID (default: `''` = system default)
- `audioTtsVoice` — ElevenLabs voice ID (validated as 15+ char alphanumeric)

**Source files:**
- `composables/voice/VoiceRecorderService.ts` (lines 209-215: loadSettings)
- `agent/services/TextToSpeechService.ts` (lines 123-138: getConfiguredVoice)

### 4.20 Progressive Speak Extraction During Streaming

**As a user, I want to hear Sulla's response as she generates it, not wait for the full response to complete.**

- In voice mode, `BaseNode.callLLMStreaming()` progressively extracts `<speak>` tag content token-by-token
- Sentence boundary detection dispatches complete sentences (20+ chars, ending with `.` `!` `?` followed by whitespace)
- Abbreviation detection prevents false splits on `Dr.`, `Mr.`, `Mrs.`, `vs.`, `etc.`, and 14 other patterns
- `</speak>` close tag dispatches any remaining buffered content
- Post-stream flush catches sentences that didn't end with boundary punctuation
- Each dispatched sentence triggers a separate TTS request, enabling playback to begin while the LLM is still generating

**Source files:**
- `agent/nodes/BaseNode.ts` (lines 1416-1542: callLLMStreaming, lines 1555-1588: tryDispatchSentence)

---

## 5. Should Have (improvements needed)

### 5.1 SpeakController (Priority: High)

**As a developer debugging TTS issues, I want a single SpeakController class so that I can read one file to understand how LLM output becomes audio.**

**As a user, I want Sulla to only speak the words intended for me, not her internal reasoning.**

**Problem:** Speak extraction logic is spread across `BaseNode.callLLMStreaming()` (streaming extraction in an `onToken` closure), `BaseNode.extractAndDispatchSpeakTags()` (post-completion extraction), and `BaseNode.wsSpeakDispatch()` (WebSocket dispatch). These three methods have separate code paths that can diverge. (See Problem P1, P2)

**Proposal:**

Create a `SpeakController` class that owns the entire speak lifecycle:

1. **Input:** Receives raw LLM output (streaming tokens or complete response)
2. **Extraction:** One implementation of `<speak>` tag parsing, sentence boundary detection, and abbreviation handling — used for both streaming and non-streaming modes
3. **Typing:** Creates typed `SpeakMessage` objects (not raw strings) with fields: `id`, `text`, `turnId`, `sentenceIndex`, `timestamp`, `source` (streaming | post-completion)
4. **Dispatch:** Sends to frontend via a clear channel (WebSocket `speak_dispatch` event with typed payload)
5. **Logging:** Logs the full chain with correlation ID at each step

**Replaces:**
- `BaseNode.callLLMStreaming()` `onToken` closure (speak extraction portion only; token streaming remains in BaseNode)
- `BaseNode.extractAndDispatchSpeakTags()`
- `BaseNode.wsSpeakDispatch()`

**Acceptance criteria:**
- All speak extraction logic lives in one file
- Both streaming and non-streaming extraction use the same parsing code
- Unit tests cover: tag extraction, sentence splitting, abbreviation handling, edge cases (empty tags, nested tags, unclosed tags)
- Existing TTS behavior is unchanged from the user's perspective

### 5.2 Turn Correlation ID (Priority: High)

**As a developer, I want a `turnId` correlation so I can grep one ID and see the full journey of a voice turn from speech to audio.**

**Problem:** A voice turn has no single ID that flows end-to-end. The frontend has `pipelineSequence` and VoiceLogger has timing milestones, but the backend has no awareness of these. Log correlation across frontend and backend is manual. (See Problem P7)

**Proposal:**

1. Generate a `turnId` (UUID or compact ID) when `VoicePipeline.flush()` creates a new turn
2. Pass `turnId` through `ChatInterface.send()` metadata
3. Include `turnId` in graph state metadata so BaseNode can access it
4. Include `turnId` in every `speak_dispatch` WebSocket event
5. Include `turnId` in `TTSPlayerService` enqueue and playback logs
6. Include `turnId` in all VoiceLogger timing events

**Result:** `grep "turnId=abc123"` shows every event for one voice turn:
```
[VOICE:PIPE:FLUSH] turnId=abc123 seq=5 mode=voice text="What time is it?"
[VOICE:LLM:SPEAK_OPEN] turnId=abc123
[VOICE:LLM:SPEAK_SENTENCE] turnId=abc123 text="It's currently 3:45 PM."
[VOICE:WS:SPEAK_DISPATCH] turnId=abc123 text="It's currently 3:45 PM."
[VOICE:PIPE:SPEAK_DETECTED] turnId=abc123 messageId=1710936000_speak
[VOICE:TTS:ENQUEUE] turnId=abc123 text="It's currently 3:45 PM."
[VOICE:TTS:PLAY_START] turnId=abc123 seq=0
[VOICE:TIMING:ROUND_TRIP] turnId=abc123 roundTripMs=1850
```

**Acceptance criteria:**
- `turnId` appears in every voice-related log entry for that turn
- Frontend and backend logs both contain the same `turnId`
- No changes to user-facing behavior

### 5.3 Direct Speak Event Delivery (Priority: Medium)

**As a developer, I want VoicePipeline to receive speak events directly so that TTS dispatch doesn't depend on Vue reactivity timing.**

**Problem:** VoicePipeline uses `watch(this.messages, { deep: true })` to scan the entire messages array on every mutation, looking for `kind === 'speak'` entries. This is indirect and creates timing dependencies. (See Problem P4)

**Proposal:**

1. `AgentPersonaModel` emits a typed event (or calls a callback) when it receives a `speak_dispatch` WebSocket event, in addition to (or instead of) pushing to the messages array
2. `VoicePipeline` subscribes to this event directly instead of (or in addition to) watching the messages array
3. The messages array push is retained for display purposes (speak messages are filtered from chat display but may be needed for history)

**Acceptance criteria:**
- TTS is triggered by direct event, not by array mutation detection
- No race conditions between message push and TTS dispatch
- Barge-in timing is unchanged or improved

### 5.4 Separate VAD from VoiceRecorderService (Priority: Medium)

**As a developer, I want VAD to be independently testable so I can verify silence detection logic without a real microphone.**

**Problem:** `VoiceRecorderService` (589 lines) handles microphone acquisition, audio level monitoring, VAD, batch recording, browser STT, transcription dispatch, and non-speech filtering in a single class. (See Problem P6)

**Proposal:**

Create a `VADService` class that:
1. Accepts an `AnalyserNode` (or raw audio data) as input
2. Emits `speechStart` and `silenceConfirmed` events with configurable threshold and duration
3. Is independently instantiable and testable (no microphone dependency)
4. Is used by `VoiceRecorderService` via composition

`VoiceRecorderService` retains: stream acquisition, MediaRecorder management, transcription dispatch. VAD logic is delegated to `VADService`.

**Acceptance criteria:**
- `VADService` can be unit-tested with synthetic audio level data
- `VoiceRecorderService` delegates all VAD decisions to `VADService`
- No changes to user-facing behavior (same thresholds, same timing)

### 5.5 Event-Driven useVoiceSession (Priority: Medium)

**As a developer, I want state updates to be event-driven so they arrive immediately without polling overhead.**

**Problem:** `useVoiceSession` polls `pipeline.state` every 100ms and `recorder.recordingDuration` every 250ms using `setInterval`. This adds up to 100ms latency for state changes and runs continuously even when idle. (See Problem P5)

**Proposal:**

1. Add a `stateChange` event to `VoicePipeline` (it already has access to `TypedEventEmitter` via its services, or it can extend `TypedEventEmitter` itself)
2. Have `VoicePipeline.transitionTo()` emit the event with the new state
3. `useVoiceSession` subscribes to this event and updates `pipelineState` ref immediately
4. Add a `durationChange` event to `VoiceRecorderService` (emitted from the recording timer interval)
5. `useVoiceSession` subscribes to this event instead of polling

**Acceptance criteria:**
- No `setInterval` polling in `useVoiceSession`
- State changes are reflected in Vue refs within one tick
- CPU overhead is reduced when voice is idle

### 5.6 Typed WebSocket Messages (Priority: Low)

**As a developer, I want WebSocket messages to be validated against typed interfaces so that malformed messages fail loudly instead of silently.**

**Problem:** WebSocket messages are untyped `{ type: string, data: any }` objects. A typo in a field name or wrong data shape causes silent failures. (See Problem P3)

**Proposal:**

1. Define TypeScript interfaces for each WebSocket message type used by the voice system:
   - `SpeakDispatchMessage { type: 'speak_dispatch', data: { text: string, thread_id: string, timestamp: number, turnId?: string } }`
   - `ChatMessage { type: 'chat_message', data: { ... } }`
2. Create a `validateMessage(raw: unknown): TypedMessage` function that validates shape and throws on invalid structure
3. Use the validator on both send (`wsSpeakDispatch`) and receive (`AgentPersonaModel.handleMessage`)

**Acceptance criteria:**
- All voice-related WebSocket messages have TypeScript interfaces
- Invalid messages throw errors with descriptive messages
- Existing valid messages pass validation without changes

---

## 6. Nice to Have (future enhancements)

### 6.1 WebRTC Streaming STT

**As a user, I want near-real-time transcription so I can see my words appear instantly instead of waiting for silence detection.**

Replace batch recording (VAD -> segment -> upload -> transcribe) with WebRTC streaming to a transcription service. This would eliminate the VAD silence delay and provide word-by-word interim results. ElevenLabs supports WebSocket-based streaming STT.

### 6.2 Multiple Voice Selection UI

**As a user, I want to choose from different voices so I can pick one that I prefer.**

Add a voice picker UI that lists available ElevenLabs voices (fetched via API) and allows selection. Currently the voice is configured as a raw ID string in settings.

### 6.3 Voice Activity Visualization

**As a user, I want to see a waveform visualization so I can visually confirm my microphone is working.**

Add an audio waveform display (using `AnalyserNode` frequency data) to the recording UI. The `AudioContext` and `AnalyserNode` already exist in `VoiceRecorderService`.

### 6.4 Conversation Replay

**As a user, I want to replay a voice conversation turn by turn so I can review what was said.**

Store TTS audio buffers alongside speak messages. Add a playback UI that replays each turn's audio in sequence. Requires audio caching strategy (memory and/or disk).

### 6.5 Local TTS Model Support

**As a user, I want Sulla to speak without requiring an internet connection or API key.**

Support local TTS models (e.g., Piper, Coqui) as an alternative to ElevenLabs. Would run in the Lima VM or as a native binary. Eliminates API latency and cost.

### 6.6 Push-to-Talk Mode

**As a user, I want a push-to-talk option so I can control exactly when Sulla listens instead of relying on VAD.**

Add a toggle between VAD mode and push-to-talk mode. In push-to-talk: recording starts on button press, stops on release, and the segment is immediately flushed for transcription. Useful in noisy environments where VAD produces false positives.

---

## 7. File Reference

### Frontend (renderer process)
| Path | Lines |
|------|-------|
| `pkg/rancher-desktop/composables/voice/VoiceRecorderService.ts` | 589 |
| `pkg/rancher-desktop/composables/voice/TTSPlayerService.ts` | 314 |
| `pkg/rancher-desktop/composables/voice/VoicePipeline.ts` | 437 |
| `pkg/rancher-desktop/composables/voice/useVoiceSession.ts` | 178 |
| `pkg/rancher-desktop/composables/voice/VoiceLogger.ts` | 337 |
| `pkg/rancher-desktop/composables/voice/TypedEventEmitter.ts` | 52 |
| `pkg/rancher-desktop/composables/voice/index.ts` | 8 |

### Backend (main process)
| Path | Lines |
|------|-------|
| `pkg/rancher-desktop/agent/services/TranscriptionService.ts` | 273 |
| `pkg/rancher-desktop/agent/services/TextToSpeechService.ts` | 139 |
| `pkg/rancher-desktop/agent/services/AudioDriverClient.ts` | 373 |
| `pkg/rancher-desktop/agent/nodes/BaseNode.ts` | ~2000 (voice-relevant: lines 1389-1588, 1635-1665, 1869-1928) |
| `pkg/rancher-desktop/agent/database/models/AgentPersonaModel.ts` | ~850 (voice-relevant: lines 605-835) |
| `pkg/rancher-desktop/main/sullaEvents.ts` | ~1100 (voice-relevant: lines 1040-1095) |

### IPC Channels
| Channel | Direction | Purpose |
|---------|-----------|---------|
| `audio-transcribe` | Renderer -> Main | Send audio buffer for STT |
| `audio-speak` | Renderer -> Main | Send text for TTS, receive audio buffer |
| `voice-log` | Renderer -> Main | Persist frontend voice events to log files |
| `audio-driver-connect` | Renderer -> Main | Connect to local audio-driver daemon for speaker audio capture |
| `audio-driver-disconnect` | Renderer -> Main | Disconnect from audio-driver daemon |
| `audio-driver-status` | Renderer -> Main | Query audio-driver install/connection status |
| `sulla-settings-get` | Renderer -> Main | Read audio configuration |

### WebSocket Events
| Event Type | Direction | Purpose |
|-----------|-----------|---------|
| `speak_dispatch` | Main -> Renderer | Deliver speak text for TTS playback |
| `chat_message` (kind='speak') | Main -> Renderer | Legacy speak delivery (redirected to speak_dispatch) |
| `chat_message` (kind='streaming') | Main -> Renderer | Non-voice mode progressive text display |

### Ports
| Port | Service |
|------|---------|
| 6108 | Terminal WebSocket Server |
| 30118 | Agent WebSocket (speak_dispatch events) |
