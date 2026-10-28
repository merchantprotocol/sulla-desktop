---
slug: sulla-record-with-capture-studio
label: Record with Capture Studio
trigger_when: When a user asks to record, locate, or verify a Capture Studio screen, camera, microphone, system-audio, or multi-track session.
trigger_actions: [record screen, record camera, capture microphone, capture system audio, start recording]
trigger_phrases: [record, recording, Capture Studio, screen capture, teleprompter, where are my recordings, find my recording]
scope: [sulla-capture-studio]
---

**When:** The user wants a local recording or Capture Studio source controlled by the agent.

**Do:**
1. Enumerate displays or windows when needed: `sulla capture/list_screens '{}'`.
2. Start the requested sources and recorder in one call, for example: `sulla capture/recorder_start '{"screen":true,"mic":true,"speaker":true}'`. Use a returned source ID for a specific screen or window.
3. Check progress with `sulla capture/recorder_status '{}'`.
4. Stop and finalize with `sulla capture/recorder_stop '{}'`.
5. Read the returned session's `manifest.json`; use it as the authority for track names and formats.
6. To locate an existing session, use the returned capture directory and list its manifests; do not assume a filename or extension.
7. For a missing recording, check `sulla capture/recorder_status '{}'` and the manifest before claiming it was lost.

**Check:** Confirm `recorder_status` transitions to idle after stop and that the final manifest names every expected track.

**Cleanup:** Release microphone/speaker holds when done and leave session files in Capture Studio storage; do not delete sessions without approval.

**Traps:** Recordings are independent tracks, not necessarily one muxed movie. Screen Recording and microphone permissions can block a source.

**Don't:**
- Assume system audio works without macOS Screen Recording permission.
- Assume recordings are muxed or that a fixed extension identifies every track.
