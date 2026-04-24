# Sulla Desktop — Architecture

## Overview

Sulla Desktop is an Electron application with three distinct execution environments:

| Layer | Where it runs | What lives there |
|-------|--------------|-----------------|
| Electron Main Process | Host macOS/Linux | Service orchestration, IPC handlers, Lima control, vault, MCP server |
| Lima VM | Linux guest (QEMU) | Docker containers: Postgres, Redis, Python/Node/Shell runtimes |
| Vue Renderer | Electron window | Chat UI, AgentRoutines, workflow canvas |

Agents run as Claude Code processes spawned by the main process. They communicate back to the main process via the MCP server (in-process HTTP) and WebSocket.

---

## Electron Main Process

Entry point: `pkg/rancher-desktop/sulla.ts`

**Initialization order:**

```
1. onMainProxyLoad()              — Early startup (no DB/Redis yet)
   ├── Tools API HTTP    :3000    — Authenticated tool call endpoint (token in chat-api-token.json)
   ├── Backend API       :6107    — Internal extension/install API (Basic auth)
   ├── Terminal WebSocket :6108   — PTY into Lima
   └── IPC handlers registered

2. Lima VM boots

3. instantiateSullaStart()        — After Lima is up
   ├── bootstrapSullaHome()       — Creates ~/sulla/ directory tree
   └── ServiceLifecycleManager.startAll()
       ├── postgres      :30116   — PostgreSQL in Lima container
       ├── redis         :30117   — Redis in Lima container
       ├── database-manager
       ├── scheduler
       ├── heartbeat
       ├── workflow-scheduler
       ├── chat-server
       ├── mcp-server-host        — In-process HTTP, agent tool calls land here
       ├── vault
       ├── model-provider
       ├── integrations
       └── oauth
```

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
