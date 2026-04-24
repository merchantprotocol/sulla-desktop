# Secretary Mode

A live meeting transcription + note-taking assistant. Listens to **both sides** of a conversation (mic + system audio), transcribes in real time with speaker diarization, extracts action items / decisions / insights every 30 seconds, and lets the user interject with "Hey Sulla" to ask the agent questions mid-meeting.

**Status: SHIPPED.** Triggered by `Cmd+Shift+S` (macOS) / `Ctrl+Shift+S` (Windows) or the tray menu. Local feature today; Cloud routing for offline/idle agents is the aspirational Phase 2.

## What it does

1. Captures **mic audio** (channel 0, WebM/Opus) and **speaker audio** (channel 1, PCM s16le) via the Audio Driver
2. Streams both to the gateway transcription service (with speaker diarization — who said what)
3. Renders a **live transcript** in the left pane (Speaker / You bubbles, like an iMessage thread)
4. Every 30 seconds, sends the new transcript segments to the agent with the `SECRETARY_SYSTEM_PROMPT`
5. Agent returns a `<secretary_analysis>` block with structured `<actions>`, `<facts>`, `<conclusions>` lists
6. The right pane shows: **Action Items**, **Decisions**, **Insights**, **Commentary** — auto-updating
7. User can:
   - Type into the chat input to ask Sulla privately during the session
   - Say **"Hey Sulla, ..."** to trigger an agent response by voice (wake word detection)
   - Sulla responds via TTS — and **bargein logic** cuts the TTS as soon as the user speaks again

## How it activates

Three paths:

1. **Keyboard shortcut:** `Cmd+Shift+S` (macOS) / `Ctrl+Shift+S` (Windows)
2. **Tray menu:** "Secretary Mode" item — defined at `pkg/rancher-desktop/main/tray.ts:65-82`
3. **Tab IPC:** `agent-command { command: 'open-tab', mode: 'secretary' }` — but the agent has no tool to send this IPC today (UI navigation gap)

## Architecture

| Layer | File | Role |
|-------|------|------|
| UI | `pkg/rancher-desktop/pages/SecretaryMode.vue` | Terminal-themed view: live transcript, notes panel, mute/unmute, audio level bars, session timer, chat input |
| Controller | `pkg/rancher-desktop/controllers/SecretaryModeController.ts` | Session lifecycle, wake-word detection, barge-in, audio level monitoring, 30s analysis loop, turn-taking transcript merge (consecutive same-speaker utterances merged with pause detection) |
| Agent extractor | `pkg/rancher-desktop/agent/controllers/SecretaryExtractor.ts` | Parses `<secretary_analysis>` blocks from agent responses; strips accidental `<speak>` tags so the agent doesn't TTS the meeting notes |
| Audio | Audio Driver (`pkg/rancher-desktop/main/audio-driver/`) | Mic + speaker capture, VAD, RNNoise; same subsystem Capture Studio uses |
| Gateway | `pkg/rancher-desktop/main/audio-driver/service/gateway.ts` | WebSocket to transcription service; lobby connection + per-session audio/listener channels |

The 30-second analysis is tagged with `inputSource: 'secretary-analysis'` (or `'secretary-wake'` for wake-word triggers) and `voiceMode: 'secretary'`. The agent's system prompt is enriched by `SecretaryExtractor.enrichPrompt()` with meeting-specific instructions.

## Cloud / Relay relationship

Secretary Mode creates a **gateway session** on start (`SecretaryModeController.ts:143-145` via `desktop-session-start` IPC). Today this just connects to the local transcription gateway. The same infrastructure is used by `desktopRelay.ts` (the WebSocket client to `wss://sulla-workers.jonathon-44b.workers.dev`), which means the wiring exists for **Phase 2:** route an idle session to a Cloud-hosted agent so meetings keep being transcribed/analyzed even when the user closes the laptop.

That's the "secretary mode handles incoming conversations regardless of whether the user's machine is on" vision. Today: **local only**, but the path is paved.

## Wake word — "Hey Sulla"

Pattern matching in the controller catches "hey sulla" / "ok sulla" / "hi sulla" prefixes in the live transcript. When detected:
1. Session enters command-input mode briefly
2. The text after the wake word is sent to the agent as a chat message with `inputSource: 'secretary-wake'`
3. Agent responds; if `voiceMode: 'secretary'`, the response is TTS'd back to the user
4. **Barge-in:** if the user speaks while Sulla is talking, TTS is cut immediately

## Output: meeting notes

The agent's analysis returns:

```xml
<secretary_analysis>
  <actions>
    - Send Sarah the Q3 forecast by Friday
    - Schedule follow-up with the design team next week
  </actions>
  <facts>
    - Budget for Q4 is locked at $200k
    - Launch date moved to Nov 15
  </facts>
  <conclusions>
    - The team is going with the simpler architecture
  </conclusions>
</secretary_analysis>
```

The extractor splits these into **Action Items** (todos), **Decisions** (facts), **Insights** (conclusions), and **Commentary** (free-form). The right pane updates in real time as new analysis arrives.

## Privacy posture

- All audio capture is local on the user's machine
- Transcription goes to the gateway (currently a Cloudflare Workers endpoint via WebSocket); diarization happens server-side
- Meeting analysis prompts go through whichever LLM the user's account is connected to (Anthropic, etc.)
- Nothing is stored long-term outside the user's chat history unless they explicitly save / export

## When users ask about Secretary Mode

- **"What is Secretary Mode?"** → Live meeting transcription + auto-extracted action items / decisions. `Cmd+Shift+S` to start.
- **"Can you take notes for this meeting?"** → "Yes — open Secretary Mode (`Cmd+Shift+S`). I'll transcribe both sides and extract action items every 30 seconds."
- **"Can I ask you questions during the meeting?"** → "Yes — say 'Hey Sulla, ...' or type into the chat panel. I'll respond by voice (or you can read the answer)."
- **"Does it work when my laptop is closed?"** → "Not yet — that's the Cloud-routed Phase 2. Today it needs the laptop open."
- **"Can you record the audio too?"** → "No — Secretary Mode is transcription-only. For audio recording, use Capture Studio (separate feature)."
- **"Where are my meeting notes?"** → "In your chat history with Sulla — there's no dedicated notes archive yet (gap)."

## Agent control — partial

The agent **cannot start or stop Secretary Mode** today (UI gap). But once it's running:
- The agent is the LLM analyzing the transcript every 30s — that's its primary role
- The agent can be invoked mid-session via wake word or chat
- The agent has no structured query tool to retrieve past meeting analyses

## Reference

- UI: `pkg/rancher-desktop/pages/SecretaryMode.vue`
- Controller: `pkg/rancher-desktop/controllers/SecretaryModeController.ts`
- Extractor: `pkg/rancher-desktop/agent/controllers/SecretaryExtractor.ts`
- Tray entry: `pkg/rancher-desktop/main/tray.ts:65-82`
- Gateway: `pkg/rancher-desktop/main/audio-driver/service/gateway.ts`
- Desktop relay (Cloud bridge): `pkg/rancher-desktop/main/desktopRelay.ts`
- Audio driver: `pkg/rancher-desktop/main/audio-driver/`
