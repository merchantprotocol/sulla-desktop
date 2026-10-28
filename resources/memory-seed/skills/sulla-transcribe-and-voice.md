---
slug: sulla-transcribe-and-voice
label: Troubleshoot voice capture and transcription
trigger_when: When voice mode hears nothing or the human wants an old recording transcribed.
trigger_actions: [fix microphone, check voice mode, transcribe recording, inspect audio capture]
trigger_phrases: [voice mode didn't pick anything up, microphone not working, transcribe this recording, transcribe an old recording, voice hears nothing, check my mic]
scope: [sulla-capture-studio, sulla-desktop]
---

**When:** First prove the audio device and permissions; then choose a transcription path.

**Do:**
1. Open Voice & audio: `sulla ui/open_tab '{"mode":"audio"}'`.
2. Inspect capture state: `sulla capture/audio_state '{}'`.
3. Start the mic permission/driver request: `sulla capture/mic_start '{}'`; check state again, then stop this agent's hold with `sulla capture/mic_stop '{}'` when finished.
4. For a new controlled sample, record mic audio with `sulla capture/recorder_start '{"mic":true}'`, check `sulla capture/recorder_status '{}'`, then finalize with `sulla capture/recorder_stop '{}'` and read the returned `manifest.json`.
5. For an old recording, locate its manifest and track in the returned session directory. There is no built-in batch transcription tool in Capture; discover an enabled speech-to-text integration with `sulla vault/list_accounts '{}'` and `sulla vault/is_enabled '{"account_id":"<account id>"}'`, then call its documented proxy/MCP tool only after verifying its schema.
6. If no speech integration is connected, say so and offer the human's local Whisper pipeline or connection of an integration; do not pretend transcription happened.

**Check:** `audio_state` must show the expected mic driver; a finalized manifest must name the actual track. Verify a transcript against the audio before saving it.

**Cleanup:** Release mic/speaker holds and keep recordings in their existing capture directory. Do not upload recordings without explicit approval.

**Traps:** Microphone and Screen Recording permissions are macOS controls. Capture tracks may be WAV, Opus/WebM, or video; never assume an extension or a single muxed file.
