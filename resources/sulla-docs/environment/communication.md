# Sulla Desktop — Communication Flows

## Agent → Main Process (MCP Server)

Agent turns communicate with the Electron main process through Sulla's tool bridge. API-backed providers call tools through the graph runtime; CLI agent providers such as Claude Code and OpenAI Codex run inside Sulla VM and reach Sulla tools through the MCP/native bridge. Tool calls like `exec`, `browse_tools`, `browser/tab` etc. are handled here.

Flow:
```
Agent/model provider → tool bridge/MCP HTTP → Main Process → executes tool → returns result
```

---

## Main Process ↔ Vue Renderer (IPC)

The renderer uses `ipcRenderer.invoke()` for request/response. The main process registers handlers via `ipcMainProxy.handle()`.

Key IPC channels:
- `browser-tab-view:*` — Tab create/navigate/destroy/screenshot
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
  "type": "user_message",
  "timestamp": 0,
  "channel": "sulla-desktop",
  "data": { "threadId": "thread-abc123", "content": "do X" }
}
```

Agent responses flow back the same channel as assistant messages.

---

## Inter-Agent Messaging

Agents message each other by wrapping content in XML channel tags:
```
<channel:heartbeat>Are you online?</channel:heartbeat>
<channel:sulla-desktop>The status update for task #42 is ready.</channel:sulla-desktop>
```

**Rules:**
- Fire-and-forget — do NOT wait for a reply
- The system detects these tags and routes them automatically
- If no reply comes, the receiving agent hasn't responded — move on

Built-in channels: `sulla-desktop`, `heartbeat`, `mobile-relay`

---

## Terminal WebSocket (PTY)

Port `6108`. Provides shell access into Sulla VM.

```json
{ "type": "start", "command": "bash" }
{ "type": "resize", "cols": 80, "rows": 24 }
```

Raw terminal input is sent as plain bytes. Used by the terminal emulator in the UI.

---

## exec Tool (Agent → Sulla VM Shell)

When an agent calls `exec({ command: "..." })`, the main process spawns it inside Sulla VM via `sulla-runtime exec`.

Environment inside exec:
```bash
HOME=<guest-owned home>
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

Timeout: default 120s. Output capped at 160,000 chars per stdout/stderr stream by `meta/exec`.
