# Secretary Mode

A live meeting transcription + note-taking assistant. Listens to **both sides** of a conversation (mic + system audio), transcribes locally, extracts action items / decisions / insights about every 30 seconds, lets the user ask Sulla questions mid-meeting ("Hey Sulla, …" or the private chat box), and saves the notes as markdown when the session ends.

**Status: SHIPPED.** Local feature. Cloud routing for offline/idle agents is the aspirational Phase 2.

## What it does

1. Captures **mic audio** (channel 0) and **system/speaker audio** (channel 1) via the Audio Driver
2. Transcribes both with the local whisper.cpp pipeline (or Grok STT if the user selected it in Audio settings), in ~2 second chunks. Speakers are labeled by channel: **You** (mic) vs **Caller** (system audio) — there is no per-person diarization
3. Renders a **live transcript** in the left pane (You / Caller bubbles); consecutive speech from the same side is merged
4. First analysis ~15s in, then every 30 seconds: sends the new transcript segment (with speaker labels, plus up to ~12k chars of earlier context) to the agent with `inputSource: 'secretary-analysis'`
5. Agent returns a `<secretary_analysis>` block with `<actions>`, `<decisions>`, `<facts>`, `<conclusions>` lists
6. The right pane shows **Action Items** (actions), **Decisions** (decisions), **Insights** (facts + conclusions), and **Commentary** (Sulla's answers). Duplicates across analyses are dropped
7. The user can:
   - Type into the chat box to ask Sulla privately — kept out of the meeting transcript and never spoken aloud
   - Say **"Hey Sulla, …"** into their own mic — the command is collected until a ~2.5s pause, answered normally, shown in Commentary and spoken via TTS (unless muted). Only the user's mic can trigger it; a remote participant saying "hey Sulla" is ignored
   - **Barge-in:** TTS is cut as soon as the user speaks again
8. On **END**, the notes are saved to `~/sulla/meetings/YYYY-MM-DD-HHMM-meeting.md` (action items, decisions, insights, Sulla's answers, full transcript). The file is re-saved once the final analysis lands. **OPEN NOTES** reveals it in Finder

If the microphone permission is denied or transcription can't start (no whisper model), the session does not start and the welcome screen shows why. If system-audio capture fails, the session runs mic-only and shows a warning bar.

## How it activates

1. **Keyboard shortcut:** `Cmd+Shift+S` (macOS) / `Ctrl+Shift+S` (Windows)
2. **Tray menu:** "Secretary Mode"
3. **Agent tools:** `sulla secretary/start` (opens/focuses the tab and starts listening), `sulla secretary/stop`, `sulla secretary/status` (`{ listening, tabId }`)
4. **Tab:** `sulla ui/open_tab` with mode `secretary` opens the tab without starting a session

## Architecture

| Layer | File | Role |
|-------|------|------|
| UI | `pkg/rancher-desktop/pages/SecretaryMode.vue` | Transcript + notes panes, mute, level bars, timer, chat box, notes saving; serializes all agent requests on the tab's chat thread |
| Controller | `pkg/rancher-desktop/controllers/SecretaryModeController.ts` | Session lifecycle, wake word, barge-in, audio levels, analysis loop (one request at a time), transcript merge, notes markdown |
| Agent extractor | `pkg/rancher-desktop/agent/controllers/SecretaryExtractor.ts` | `parseSecretaryAnalysis()`; strips accidental `<speak>` tags on analysis turns |
| Mode routing | `agent/nodes/BaseNode.ts`, `AgentNode.ts` | Only `secretary-analysis` turns run in secretary (extraction) mode; `secretary-wake` / `secretary-chat` get normal replies |
| Transcription | `pkg/rancher-desktop/main/audio-driver/service/whisper-transcribe.ts` | Mic + speaker chunks → `gateway-transcript` events |
| State + notes | `pkg/rancher-desktop/main/secretaryModeState.ts` | Listening cache for the agent tools; `secretary-mode:save-notes` / `reveal-notes` (writes only inside `~/sulla/meetings`) |

## Privacy posture

- Audio capture and whisper transcription are local (Grok STT, if selected, sends audio to xAI)
- Meeting analysis prompts go through whichever LLM the user's account is connected to
- Notes are saved locally in `~/sulla/meetings/`; the analysis turns also live in the Secretary tab's chat history

## When users ask about Secretary Mode

- **"What is Secretary Mode?"** → Live meeting transcription + auto-extracted action items / decisions. `Cmd+Shift+S` to start, or ask Sulla to start it.
- **"Can you take notes for this meeting?"** → Run `sulla secretary/start`. It transcribes both sides and extracts action items about every 30 seconds.
- **"Can I ask you questions during the meeting?"** → Yes — say "Hey Sulla, …" or type in the chat box.
- **"Where are my meeting notes?"** → `~/sulla/meetings/` — one markdown file per session.
- **"Does it work when my laptop is closed?"** → Not yet (Cloud-routed Phase 2).
- **"Can you record the audio too?"** → No — transcription only. Use Capture Studio for audio recording.
- **"Can it tell the other participants apart?"** → Not yet — it separates you (mic) from everyone else (system audio).

## Known limits

- No per-person diarization on the system-audio side
- The last ~2 seconds of speech before END may not be transcribed
- The agent has no tool to search past meeting notes yet — read the files in `~/sulla/meetings/`
