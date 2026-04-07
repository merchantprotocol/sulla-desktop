# Voice System — Production Roadmap


## Phase 2: UX & Polish

- [x] Voice mode indicator — persistent visual state showing "you're in voice mode"
- [x] VAD sensitivity slider in Audio Settings (expose threshold/silence duration)
- [x] Audio input/output device selection in settings
- [x] Language selection for STT (browser mode hardcoded to en-US)
- [x] Voice preview/test button in Audio Settings
- [x] Recording duration timer
- [x] Audio level meter / waveform visualization during recording
- [x] Keyboard shortcut for voice mode toggle (Ctrl+Shift+V / Cmd+Shift+V)
- [x] Toast notifications for voice-specific errors

## Phase 3: Streaming TTS Pipeline (Biggest UX Win)

- [x] Implement ElevenLabs streaming TTS endpoint (chunked audio playback)
- [x] Intercept LLM token stream in BaseNode, buffer to sentence boundaries
- [x] Extract `<speak>` content progressively as tokens arrive
- [x] Fire TTS per sentence chunk while LLM is still generating
- [x] Start audio playback within ~300ms of first sentence completion
- [x] Handle barge-in interruption mid-stream (cancel remaining TTS chunks + LLM generation)

## Phase 4: Advanced

- [ ] Noise floor calibration for VAD (auto-adapt to environment)
- [ ] ElevenLabs voice parameters exposed in settings (stability, similarity_boost, pitch, rate)
- [ ] Multi-provider support (additional TTS/STT providers beyond ElevenLabs)
- [ ] Conversation mode UI (distinct phone-call-like voice state)
- [ ] Wake word detection (hands-free activation)
- [ ] Speaker verification / voice biometrics

## Phase 5: Audio Driver Migration

Migrate all remaining direct `getUserMedia` callers to use the audio driver pipeline. See [`docs/AUDIO_POLICY.md`](docs/AUDIO_POLICY.md) for the canonical audio usage policy.

- [ ] Migrate Capture Studio mic capture (`pages/capture-studio/composables/useMicCapture.ts`) to use audio driver pipeline
- [ ] Migrate Secretary Mode mic capture (`controllers/SecretaryModeController.ts`) to use audio driver pipeline
- [ ] Remove direct `getUserMedia` from voice session composable (already uses `audio-driver:mic-vad` for VAD, but `VoiceRecorderService` still maintains its own mic stream)
- [ ] Document all exemptions from audio-driver-first policy (currently only Raw Mic Test in `AudioSettings.vue`)
