---
slug: sulla-capture-studio
kind: system
name: Capture Studio
parent: sulla
aliases: [Capture Studio, capture, screen recording, teleprompter]
---

## Overview
Capture Studio is a local multi-track recorder in Sulla Desktop. It can capture screen, camera, microphone, and system audio as independent tracks, with scene layouts, a teleprompter, event logging, and synchronized playback. Recordings are stored under `~/sulla/captures/<sessionId>/`; the manifest is authoritative for filenames and formats. Capture Studio does not require Cloud.

## Facts
- The main UI is `pkg/sulla-desktop/pages/CaptureStudio.vue`; the window entry is `pkg/sulla-desktop/entry/capture-studio.ts`.
- Microphone capture uses the shared ref-counted Audio Driver; `raw` and `noise-reduction` modes are supported by the driver.
- System audio uses Electron native loopback first and BlackHole only as fallback; Screen Recording permission may be required.
- Video is recorded as VP9/WebM when supported; microphone and fallback audio are WAV, while native speaker capture is Opus/WebM.
- `capture/recorder_start` acquires requested sources and starts recording; `capture/recorder_stop` finalizes tracks and `manifest.json`.
- `capture/list_screens` returns source IDs for `capture/screenshot` or `capture/screen_set`; `capture/recorder_status` reports state without opening the studio.
- Capture tools include teleprompter, mic and speaker lifecycle, screen and camera selection, quality, recorder, status, and screenshot operations; verify current parameters with `sulla meta/browse_tools '{"category":"capture"}'`.
- There is no built-in batch transcription tool in the capture category; a custom function can call the local Whisper pipeline.

## Rules
- DO: Read the session manifest before assuming a track filename. Why: native and fallback audio use different extensions.
- DON'T: claim that Capture Studio records a single muxed video. Why: streams are independent for post-production.
