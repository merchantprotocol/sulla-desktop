# Sulla Desktop — Architecture

## Overview

Sulla Desktop is an Electron application with three distinct execution environments:

| Layer | Where it runs | What lives there |
|-------|--------------|-----------------|
| Electron Main Process | Host macOS/Linux | Service orchestration, IPC handlers, Lima control, vault, MCP server |
| Lima VM | Linux guest (QEMU) | Docker containers: Postgres, Redis, Python/Node/Shell runtimes |
| Vue Renderer | Electron window | Chat UI, AgentRoutines, workflow canvas |

Agent turns run through Sulla's own graph + model-provider layer, not a single hardcoded model. Some providers are API-backed (Anthropic, OpenAI); command-line providers (Claude Code, OpenAI Codex) spawn CLI processes inside Lima and stream results back through the same graph. Tool calls route through the Sulla Tools API / in-process MCP server, and channel messages return over WebSocket. Around every actionable turn, a **subconscious layer** recalls memory before the reply and writes observations after — see [`environment/subconscious.md`](subconscious.md).

---

## Electron Main Process

Entry point: `pkg/rancher-desktop/sulla.ts`

**Startup order.** Early HTTP/IPC surface comes up first (before DB/Redis), then Lima boots, then `instantiateSullaStart()` registers services with the `ServiceLifecycleManager`, which topologically sorts by declared dependency and starts them in order.

```
1. Early startup (no DB/Redis yet)
   ├── Tools API HTTP    :3000    — Authenticated tool-call endpoint (token in chat-api-token.json)
   ├── Backend API       :6107    — Internal extension/install API (Basic auth)
   ├── Terminal WebSocket :6108   — PTY into Lima
   └── IPC handlers registered

2. Lima VM boots

3. instantiateSullaStart() → bootstrapSullaHome() (creates ~/sulla/ tree)
   → ServiceLifecycleManager.startAll(), which registers (deps in parens):
       ├── backend-ws              ()                      — BackendGraphWebSocketService (chat transport)
       ├── model-provider-ipc      ()                      — model-provider IPC handlers (early, so UI can query)
       ├── postgres                ()   persistOnRestart   — waits for the Lima Postgres connection
       ├── redis                   ()   persistOnRestart   — waits for the Lima Redis connection
       ├── database-manager        (postgres)              — runs migrations, brings models online
       ├── scheduler               (database-manager)      — calendar/alarm SchedulerService
       ├── heartbeat               (database-manager,redis)— autonomous operator loop
       ├── workflow-scheduler      (database-manager)      — arms routine cron triggers
       ├── chat-server             (database-manager)      — chat completions API server
       ├── mcp-server-host         ()                      — in-process MCP HTTP; agent tool calls land here
       ├── vault                   (database-manager)      — unlocks the credential vault
       ├── model-provider          (database-manager,redis)— provider inventory; invalidates LLM caches on change
       ├── integrations            (vault)                 — loads integration configs
       ├── oauth                   (database-manager,vault)— resumes OAuth refresh timers
       ├── file-search             ()                      — warms the file-search index
       └── host-access-sync        (database-manager,redis)— reconciles the host-access gate from disk
```

`postgres` and `redis` are marked `persistOnRestart` — a backend restart re-uses the live connections instead of tearing them down.

---

## Lima VM

Lima runs Alpine Linux as a QEMU guest. The host macOS home directory is mounted into Lima at the **same absolute path** via virtiofs/9p.

**Key mount:** `~` (entire macOS home) is mounted writable into Lima.

This means `~/sulla/` on the Mac and `~/sulla/` inside Lima are the **same files**. No copying needed — Lima sees them natively.

**Docker containers inside Lima:**

| Container | Port (host) | Purpose |
|-----------|-------------|---------|
| sulla_postgres | 30116 | PostgreSQL database |
| sulla_redis | 30117 | Redis key-value store (no persistence) |
| python_runtime | 30118 | Executes Python custom functions |
| shell_runtime | 30119 | Executes Shell custom functions |
| node_runtime | 30120 | Executes Node.js custom functions |

All function containers mount `~/sulla/functions/` read-only.

**`sulla` CLI** lives at `/usr/local/bin/sulla` inside Lima. Always invoke via `exec({ command: "sulla ..." })`.

**VM-first execution:** Agents should keep everyday shell work inside Lima via `exec`. Use `meta/exechost` only when the parent host MUST be used (host-only apps/daemons). Home is mounted into Lima at the same path, so host project files are already reachable without leaving the sandbox.

---

## Vue Renderer

The renderer cannot access the filesystem directly. All file ops go through IPC to the main process. Chat messages are sent over WebSocket to the BackendGraphWebSocketService.

---

## App Resources Path

In the **packaged app** (DMG/installer):
```
Sulla Desktop.app/Contents/Resources/resources/
```

In **development**:
```
/Users/<user>/Sites/sulla/sulla-desktop/resources/
```

Accessed in code via `paths.resources`. This directory is **mounted into Lima** alongside `~` — so anything in `resources/sulla-docs/` is readable inside Lima at the same absolute path.

---

## WebSocket Channels

The BackendGraphWebSocketService routes messages by channel name:

| Channel | Consumer |
|---------|---------|
| `sulla-desktop` | Frontend chat agent |
| `workbench` | Workbench editor agent |
| `heartbeat` | Autonomous heartbeat agent |
| `mobile-relay` | Paired mobile device |
| `calendar_event` | Calendar trigger |

Messages keyed by `${channelId}|${threadId}` for concurrent execution.
