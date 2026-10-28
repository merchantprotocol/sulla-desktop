---
slug: sulla-secretary-mode
kind: system
name: Secretary Mode
parent: sulla
aliases: [Secretary Mode, meeting transcription, meeting notes, Cmd+Shift+S]
---

## Overview
Secretary Mode is a local live meeting transcription and note-taking feature. It captures microphone and system audio, labels them You and Caller, transcribes with the local Whisper pipeline (or the selected Grok STT path), and periodically extracts actions, decisions, facts, and conclusions. On end, notes are saved under `~/sulla/meetings/`.

## Facts
- Start with `sulla secretary/start`, stop with `sulla secretary/stop`, and inspect `{ listening, tabId }` with `sulla secretary/status`; `sulla ui/open_tab '{"mode":"secretary"}'` opens the tab without starting.
- `Cmd+Shift+S` on macOS (`Ctrl+Shift+S` on Windows) and the tray menu also open Secretary Mode.
- Analysis runs first after roughly 15 seconds and then about every 30 seconds through `inputSource: 'secretary-analysis'`; wake commands and private chat use normal replies.
- Say “Hey Sulla” into the microphone or type in the private chat box; only mic speech can issue wake commands, and mute silences speech output without disabling commands.
- If system audio fails, the session can continue mic-only with a warning; if mic permission or transcription startup fails, the session does not start.
- The UI and controller are `pkg/sulla-desktop/pages/SecretaryMode.vue` and `pkg/sulla-desktop/controllers/SecretaryModeController.ts`; notes are guarded by `pkg/sulla-desktop/main/secretaryModeState.ts`.

## Rules
- DO: Keep the Desktop app and audio pipeline running during a live session. Why: capture is local.
- DON'T: promise audio recording or past-notes search from Secretary Mode. Why: use Capture Studio for recording and Files search for saved notes.
