# Claude Code Computer Use Bridge — Capture Studio as the Host MCP Surface

## Overview

Let Claude Code — Anthropic's CLI — drive the macOS host even though it runs inside Sulla Desktop's Lima VM. The bridge is an MCP server hosted by the Electron main process that exposes the `computer_20251124` tool surface (screenshot, click, type, scroll, zoom) to the guest. Capture Studio provides the screenshot path; a small native addon provides input injection; the guest connects over `host.lima.internal` loopback.

This is a distinct feature from the generic Computer Use Agent (`computer-use-agent.md`). That feature builds a Sulla-native agent loop with grid overlays. This feature wires Claude Code specifically into the host desktop and reuses Sulla's capture pipeline as the substrate.

## Why

Sulla Desktop already spawns Claude Code inside Lima via `limactl shell claude` (see `pkg/rancher-desktop/main/claudeCodeTest.ts`). That pattern is a dead end for computer use: the VM is a Linux guest with no handle to the macOS window server, Accessibility API, or Core Graphics. Without a bridge:

- The Claude Code built-in `computer-use` MCP (macOS-only) cannot load inside the guest
- `xdotool` inside the guest would drive a nonexistent X server, not the host
- The agent can read and write files in the mounted home dir, and reach the network, but cannot see or control the desktop

A host-side MCP server solves this without giving up the VM's isolation for other workloads. Only the narrow `computer_use` tool surface crosses the boundary.

## Why Capture Studio Is Load-Bearing

Every computer-use implementation has to solve three problems: screen capture, coordinate scaling, and input injection. Sulla has already solved the first two for a different purpose (recording) — and solved them better than most computer-use demos.

1. **Screen capture with context** — `pkg/rancher-desktop/pages/capture-studio/composables/useMediaSources.ts` already handles multi-display selection, native resolution acquisition, and quality presets (480p / 720p / 1080p / 4K). An MCP `screenshot` action is a thin wrapper.
2. **Model-aware coordinate scaling** — Capture Studio already renders at a chosen resolution while knowing the native framebuffer. That is exactly the transform Claude's computer use needs:
   - Claude Opus 4.7 — clip long edge to 2576px (1:1 for most displays)
   - Claude Sonnet 4.6 / Haiku 4.5 — clip long edge to 1568px
   The bridge receives coordinates in the downscaled frame from Claude, translates back to native pixels for `CGEventPost`.
3. **Audio as a first-class agent input** — no off-the-shelf computer-use stack offers this. The existing audio driver (mic via WebM/Opus, speaker via CoreAudio loopback, RNNoise + VAD) can feed transcribed audio into the same turn as a screenshot. "Act on what the person on the call just asked" becomes answerable in one tool call.
4. **Teleprompter overlay for human-in-the-loop** — the floating UI already built for Capture Studio can render Claude's next action before it fires, giving visible agent reasoning and a natural confirmation surface.
5. **Sandboxing pattern already drafted** — the AppleScript tool's `APP_REGISTRY` gate (`pkg/rancher-desktop/agent/tools/applescript/applescript_execute.ts`) ports directly to computer use: the user pre-authorizes which apps Claude may click into. Same pattern as `computer-use-settings.md`.

## Two Deployment Paths

### Path A — Host-Resident Claude Code (zero-build)

Drop the Lima hop. Spawn the host's `claude` binary directly as a child process of Electron main, with stdio piped back to the Sulla UI. Claude Code v2.1.85+ ships a built-in `computer-use` MCP server for macOS on Pro/Max plans; it handles screenshot and input injection itself. Sulla gains nothing architecturally but gets working computer use immediately.

Use when the user is on a Pro/Max plan and does not need VM isolation between Claude's file access and the rest of their home directory.

### Path B — Guest-Resident Claude Code + Host MCP (this feature)

Keep Claude Code in Lima, put the computer-use surface on the host, connect them over loopback. The guest stays sandboxed; only the MCP tool surface reaches the host. This is also the only path that takes advantage of Capture Studio.

Use when isolation matters, when the user wants Claude's audio context fed alongside clicks, or when the user is not on Pro/Max (the built-in MCP is plan-gated).

The rest of this document specifies Path B.

## Architecture

```
Lima VM (Linux)                        macOS Host
┌─────────────────────┐                ┌──────────────────────────────────┐
│  claude code        │                │  sulla-desktop (Electron main)   │
│  ├─ MCP client ─────┼─ stdio over ──►│  ├─ MCP server: computer_use     │
│  │                  │  limactl SSH   │  │  ├─ screenshot ← Capture Studio│
│  │                  │  or TCP over   │  │  ├─ click/type ← CGEventPost   │
│  │                  │  host.lima     │  │  └─ zoom/scroll ← native      │
│  └─ agent loop      │  .internal     │  ├─ Capture Studio (screen/audio)│
│                     │                │  └─ Audio Driver (mic/speaker)   │
└─────────────────────┘                └──────────────────────────────────┘
```

### Transport

Two viable options for guest ↔ host MCP:

1. **stdio over `limactl shell`** — the host launches the guest's Claude Code with an MCP server entry that pipes stdio back out through `limactl shell`. Simplest auth (process inheritance) but couples the MCP server lifecycle to the shell session.
2. **TCP on `host.lima.internal:PORT`** (recommended) — host MCP server listens on `127.0.0.1:PORT`, Lima forwards the guest's `host.lima.internal:PORT` to it. Auth is a pre-shared HMAC token written into the guest's `~/.mcp.json` at Lima provisioning time. Decoupled lifecycle, survives shell reconnects, and the same server can serve Path A clients.

### MCP Server Shape

Implements the `computer_20251124` tool surface (latest as of April 2026):

| Action | Implementation |
|--------|----------------|
| `screenshot` | Capture Studio pipeline → PNG → base64. Resolution chosen by model header (2576px Opus 4.7, 1568px others) |
| `mouse_move` | `CGEventCreateMouseEvent(kCGEventMouseMoved)` + `CGEventPost` |
| `left_click` / `right_click` / `middle_click` | `kCGEventLeft/Right/OtherMouseDown` + `Up` pair |
| `double_click` / `triple_click` | Set `kCGMouseEventClickState` on the down event |
| `type` | `CGEventKeyboardSetUnicodeString` + key down/up. Unicode-safe |
| `key` | Parse combo (`cmd+shift+4`), press modifiers, tap target, release modifiers |
| `scroll` | `CGEventCreateScrollWheelEvent2` (pixel-unit scroll) |
| `left_click_drag` | Down at from, moves along interpolated path, up at to |
| `left_mouse_down` / `left_mouse_up` | Raw half-events for dragging with intervening actions |
| `hold_key` | Down + sleep + up with early-abort on kill switch |
| `wait` | Bounded `setTimeout` |
| `zoom` (Opus 4.7 only) | Return a cropped high-res region of the last screenshot |

### Native Input Addon

Do not use `nut-js` or `robotjs`. Both have a track record of breaking on macOS point releases and neither is actively maintained against Apple Silicon quirks.

Write a minimal N-API addon (~150 LOC Obj-C++) wrapping `CGEventPost`. Two non-obvious gotchas to handle:

- **Event source choice**: use `CGEventSourceCreate(kCGEventSourceStateHIDSystemState)`, not `kCGEventSourceStatePrivate`. The private source will silently drop events in sandboxed Mac Catalyst apps and some password managers.
- **Session event tap**: post events to `kCGSessionEventTap`, not `kCGHIDEventTap`. The HID tap bypasses secure-input mode, which is what some apps use to block automation; posting there either fails silently or triggers security warnings.

### Coordinate Scaling

Single source of truth lives in the MCP server. When Claude sends coordinates `(x, y)` in a downscaled frame:

```
nativeX = x * (nativeWidth / scaledWidth)
nativeY = y * (nativeHeight / scaledHeight)
```

Store the `(nativeWidth, nativeHeight, scaledWidth, scaledHeight)` tuple alongside each screenshot response so the transform uses the scaled frame Claude actually saw, not the current display state (which may have changed between screenshot and click).

### Multimodal Screenshot Response

Extend the `screenshot` tool result beyond the standard Anthropic shape to include optional audio context:

```json
{
  "image": "<base64 PNG>",
  "audio_context": {
    "speaker_transcript": "...",
    "mic_transcript": "...",
    "elapsed_seconds": 4.2
  }
}
```

Claude will ignore fields it does not expect, so this stays compatible with the standard tool spec. When Capture Studio has an active audio session, the MCP server attaches the last N seconds of speaker/mic transcripts (from Whisper.cpp already in the pipeline).

## Permissions and Entitlements

### macOS Entitlements

Package.json build config currently declares `entitlements: null`. Add:

```xml
<!-- packaging/entitlements.plist -->
<plist>
  <dict>
    <!-- For CGEventPost into other apps -->
    <key>com.apple.security.automation.apple-events</key><true/>
    <!-- For screencapture -->
    <key>com.apple.security.device.camera</key><true/>
  </dict>
</plist>
```

Point `build.mac.entitlements` and `entitlementsInherit` at this file.

### TCC Runtime Prompts

On first invocation of a tool that needs Accessibility:

```objc
NSDictionary *opts = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
```

If denied, deep-link to System Settings:

```
x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility
```

Screen Recording is already requested by Capture Studio; no new prompt needed.

### Per-App Gating (Inherits from Computer Use Settings)

The existing `computer-use-settings.md` feature specifies an `APP_REGISTRY` where the user pre-authorizes which apps Sulla may target. The Claude Code bridge honors the same registry: if Claude tries to click into an app whose bundle ID is not enabled, the click is rejected with a structured error the agent can reason about ("App not authorized — ask the user to enable it in Computer Use Settings").

Bundle ID at click coordinates is resolved via `CGWindowListCopyWindowInfo` — pick the topmost non-transparent window containing `(x, y)` and read its `kCGWindowOwnerName` / `kCGWindowOwnerPID`.

## Safety and Guardrails

Reuses the guardrail primitives from `computer-use-agent.md` (kill switch, action log, rate limiting, restricted regions, confirmation mode) — they live in the MCP server and apply uniformly to Path A and Path B clients.

Additions specific to this bridge:

- **Token rotation** — the HMAC token in the guest's `~/.mcp.json` rotates on every Sulla Desktop launch. Prevents a stale VM snapshot from retaining host access.
- **Guest origin check** — the MCP server verifies the requesting connection is from the Lima subnet (`192.168.5.0/24` by default) or localhost. Rejects arbitrary LAN connections.
- **Teleprompter preview** — before executing any write action, the intended action is rendered in the teleprompter overlay for ~500ms (configurable). Gives the user visual confirmation without blocking on a dialog.

## Relationship to Existing Systems

- **`claudeCodeTest.ts`** — current "throwaway test path" is replaced by a proper managed Claude Code process with MCP wiring. The spawn pattern (`limactl shell`) stays the same for Path B; for Path A it becomes a direct child process.
- **MCP Bridge** (`pkg/rancher-desktop/agent/integrations/mcp/Bridge.ts`) — already handles multiple MCP server connections. The host-side `computer_use` MCP registers through the same bridge. Sulla's own agent (the one from `computer-use-agent.md`) and Claude Code both consume the same MCP surface.
- **Capture Studio** — this feature is the first non-recording consumer of its screen capture path. The useMediaSources composable may need a headless mode that captures without mounting the Vue UI.
- **Audio Driver** — provides optional `audio_context` attachment on screenshot responses. No new capture path needed; just a read from the existing transcript buffer.
- **AppleScript Tool / Computer Use Settings** — shares the `APP_REGISTRY` gate. A user who has already authorized Calendar for AppleScript control does not need to re-authorize it for computer-use clicks.

## Implementation Phases

### Phase 1 — Native Input Addon

- N-API addon wrapping `CGEventPost` with HIDSystemState source + SessionEventTap
- Mouse move, click (left/right/middle, single/double/triple), scroll
- Keyboard: Unicode type, key combos, hold_key with abort
- Drag as down + interpolated moves + up
- Accessibility permission check + System Settings deep-link
- Unit tests against a dummy target app (TextEdit)

Prioritize this first. The MCP scaffolding is boring; `CGEventPost` has the real unknowns.

### Phase 2 — MCP Server (Host)

- `computer_20251124` tool surface on `127.0.0.1:PORT`
- HMAC auth, origin check, token rotation
- Coordinate scaling with per-screenshot transform tuple
- `screenshot` reuses Capture Studio media sources (headless mode if needed)
- Integration with `APP_REGISTRY` for per-app gating
- Rate limiter, kill switch global shortcut, action log

### Phase 3 — Guest Wiring

- Lima provisioning writes `~/.mcp.json` with `host.lima.internal:PORT` and current HMAC token
- Token rotation on Sulla Desktop launch (re-sync to guest before spawning Claude Code)
- Replace `claudeCodeTest.ts` test harness with a production Claude Code manager
- Streaming NDJSON output into Sulla's chat UI
- Session resumption across Sulla Desktop restarts

### Phase 4 — Multimodal and Polish

- `audio_context` attachment on screenshot responses
- Teleprompter preview for write actions
- Observer mode (user watches Claude work with cursor highlight)
- Multi-display support (display selection per session)
- Zoom tool for Opus 4.7 (crop + return high-res region)
- Path A toggle (host-resident Claude Code for Pro/Max users who want the built-in MCP)

## File Structure (Proposed)

```
pkg/rancher-desktop/
  main/
    claudeCode/
      host.ts                     — Path A: direct child process manager
      guestBridge.ts              — Path B: Lima-aware Claude Code manager
      tokenSync.ts                — HMAC rotation + guest .mcp.json sync
    computerUse/
      mcpServer.ts                — MCP server exposing computer_20251124
      coordinateScaler.ts         — Native ↔ scaled frame transforms
      screenshotSource.ts         — Headless Capture Studio adapter
      audioContextAttacher.ts     — Pulls recent transcripts for attachment
      appRegistryGate.ts          — Bundle-ID lookup + APP_REGISTRY check
      killSwitch.ts               — Global shortcut to halt all computer use
  native/
    computer-input/               — N-API addon (CGEventPost wrapper)
      binding.gyp
      src/
        computer_input.mm         — Obj-C++: CGEvent, AXIsProcessTrusted
        session_event_tap.mm      — Tap/source configuration
      index.ts                    — TS bindings
  packaging/
    entitlements.plist            — New: apple-events + camera entitlements
```

## Open Questions

- **Path A vs Path B default** — should new users land on Path A (host-resident, simpler, requires Pro/Max) or Path B (guest-resident, isolated, works on any plan)? Proposed default: detect plan and pick, but always offer a toggle in Preferences.
- **Zoom implementation** — Opus 4.7's `zoom` expects a re-capture at higher fidelity in a cropped region. For a multi-display setup, do we zoom into the last-screenshotted display or the currently-focused one? Proposed: the display the previous action targeted.
- **Audio context opt-in** — attaching transcripts changes agent behavior and has privacy implications. Proposed: off by default, single toggle in Preferences, with clear indicator in the teleprompter when active.
- **Secure input fields** — when macOS secure input is active (password fields, Terminal with secure keyboard entry), `CGEventPost` keyboard events are dropped silently. Should the MCP server detect this state and return a structured error, or let Claude figure it out from the screenshot? Proposed: detect and return error with remediation hint.
