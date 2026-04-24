# Sulla Desktop — Communication Flows

## Agent → Main Process (MCP Server)

Agents running as Claude Code processes communicate with the Electron main process via the **MCP server** (in-process HTTP). Tool calls like `exec`, `browse_tools`, `browser/tab` etc. are handled here.

Flow:
```
Agent (Claude Code in Lima) → MCP HTTP → Main Process → executes tool → returns result
```

---

## Main Process ↔ Vue Renderer (IPC)

The renderer uses `ipcRenderer.invoke()` for request/response. The main process registers handlers via `ipcMainProxy.handle()`.

Key IPC channels:
- `browser-tab:*` — Tab create/navigate/destroy/screenshot
- `vault:*` — Credential read/write
- `get-user-data-path` — App data directory
- `check-goals-onboarding`, `check-business-onboarding` — Identity file checks
- `app-quit` — Shutdown

---

## Chat Messages (WebSocket)

User chat → Vue renderer → WebSocket → `BackendGraphWebSocketService` → Graph execution → Agent spawned.

WebSocket message format:
```json
{
  "kind": "channel_message",
  "channelId": "sulla-desktop",
  "threadId": "thread-abc123",
  "senderId": "user",
  "message": "do X"
}
```

Agent responses flow back the same channel as assistant messages.

---

## Inter-Agent Messaging

Agents message each other by wrapping content in XML channel tags:
```
<channel:heartbeat>Are you online?</channel:heartbeat>
<channel:workbench>Update status for task #42.</channel:workbench>
```

**Rules:**
- Fire-and-forget — do NOT wait for a reply
- The system detects these tags and routes them automatically
- If no reply comes, the receiving agent hasn't responded — move on

Active channels: `sulla-desktop`, `workbench`, `heartbeat`, `mobile-relay`

---

## Terminal WebSocket (PTY)

Port `6108`. Provides shell access into Lima.

```json
{ "type": "start", "command": "bash" }
{ "type": "resize", "cols": 80, "rows": 24 }
```

Raw terminal input is sent as plain bytes. Used by the terminal emulator in the UI.

---

## exec Tool (Agent → Lima Shell)

When an agent calls `exec({ command: "..." })`, the main process spawns it inside Lima via `limactl shell 0`.

Environment inside exec:
```bash
HOME=/Users/<user>
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

Timeout: default 120s. Output capped at 200,000 chars.
