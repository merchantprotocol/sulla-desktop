---
slug: sulla-record-with-capture-studio
label: Record with Capture Studio
trigger_when: When a user asks to record the screen, camera, microphone, system audio, or a multi-track session.
trigger_actions: [record screen, record camera, capture microphone, capture system audio, start recording]
trigger_phrases: [record, recording, Capture Studio, screen capture, teleprompter]
scope: [sulla-capture-studio]
---

**When:** The user wants a local recording or Capture Studio source controlled by the agent.

**Do:**
1. Enumerate displays or windows when needed: `sulla capture/list_screens '{}'`.
2. Start the requested sources and recorder in one call, for example: `sulla capture/recorder_start '{"screen":true,"mic":true,"speaker":true}'`. Use a returned source ID for a specific screen or window.
3. Check progress with `sulla capture/recorder_status '{}'`.
4. Stop and finalize with `sulla capture/recorder_stop '{}'`.
5. Read the returned session's `manifest.json`; use it as the authority for track names and formats.

**Don't:**
- Assume system audio works without macOS Screen Recording permission.
- Assume recordings are muxed or that a fixed extension identifies every track.
