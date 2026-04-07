# WebSocket Hub (Port 30118)

## Overview

The WebSocket Hub is Sulla's internal communication backbone. It is a lightweight WebSocket server deployed as a Kubernetes pod (`byrdziak/sulla-websocket:latest`) inside the Lima VM. The server listens on container port 8080, exposed to the host as a `NodePort` on **port 30118**.

Every major subsystem in Sulla -- the frontend chat UI, the backend agent dispatcher, the heartbeat loop, the scheduler, calendar events, and inter-agent messaging -- communicates through the hub using channel-based pub/sub over a single WebSocket endpoint at `ws://localhost:30118/`.

## Architecture

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    Lima VM (Kubernetes)                      │
 │                                                             │
 │   ┌─────────────────────────────────┐                       │
 │   │  ws-server pod (port 8080)      │                       │
 │   │  NodePort 30118                 │                       │
 │   │                                 │                       │
 │   │  Channel-based pub/sub broker   │                       │
 │   │  - subscribe / ack / ping       │                       │
 │   └────────────┬────────────────────┘                       │
 └────────────────┼────────────────────────────────────────────┘
                  │ ws://localhost:30118/
                  │
    ┌─────────────┼──────────────────────────────────┐
    │             │        Electron Main Process      │
    │  ┌──────────▼──────────┐                        │
    │  │ WebSocketClientService │  (singleton)         │
    │  │  - manages connections │                      │
    │  │  - per-channel sockets │                      │
    │  │  - ack / retry / heartbeat │                  │
    │  └──────────┬──────────┘                        │
    │             │                                   │
    │  ┌──────────┼──────────────────────────┐        │
    │  │          │     Consumers             │        │
    │  │  ┌───────┴────────┐                 │        │
    │  │  │ BackendGraph   │ sulla-desktop   │        │
    │  │  │ WebSocketSvc   │ workbench       │        │
    │  │  │                │ heartbeat       │        │
    │  │  │                │ calendar_event  │        │
    │  │  │                │ custom agents   │        │
    │  │  └────────────────┘                 │        │
    │  │  ┌────────────────┐                 │        │
    │  │  │ SchedulerSvc   │ sulla-desktop   │        │
    │  │  │                │ heartbeat       │        │
    │  │  └────────────────┘                 │        │
    │  │  ┌────────────────┐                 │        │
    │  │  │ CalendarClient │ calendar_event  │        │
    │  │  └────────────────┘                 │        │
    │  └─────────────────────────────────────┘        │
    └─────────────────────────────────────────────────┘
    ┌─────────────────────────────────────────────────┐
    │           Electron Renderer Process              │
    │  ┌────────────────────┐                          │
    │  │ FrontendGraph      │ sulla-desktop            │
    │  │ WebSocketSvc       │ (or custom channel)      │
    │  └────────────────────┘                          │
    │  ┌────────────────────┐                          │
    │  │ StartupProgress    │ probes ws://localhost:    │
    │  │ Controller         │ 30118 for readiness      │
    │  └────────────────────┘                          │
    └─────────────────────────────────────────────────┘
```

## WebSocketClientService

**File:** `pkg/rancher-desktop/agent/services/WebSocketClientService.ts`

The `WebSocketClientService` is a singleton that manages all WebSocket connections from the Electron app to the hub. Each logical channel gets its own `WebSocketConnection` instance.

Key behaviors:

- **Channel subscription** -- On connect, the client sends a `subscribe` message with the channel name. The hub routes subsequent messages only to subscribers of that channel.
- **Automatic reconnect** -- Exponential backoff with jitter (up to 45 s), max 1200 attempts.
- **Heartbeat** -- A `ping` message is sent every 30 seconds on the `heartbeat` channel.
- **Reliable delivery** -- Every outbound message is tracked in a pending map. The hub (or receiver) sends an `ack` with the `originalId`. If no ack arrives within the timeout (9 s, with backoff), the message is retried. Messages older than 240 s are dropped.
- **Debug tap** -- An optional ring buffer (500 messages) records all inbound/outbound traffic per connection, exposed via `debug-ws-messages` IPC for the Monitor Dashboard.

Access the singleton:

```ts
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';
const ws = getWebSocketClientService();
```

## Channels

A **channel** is a named topic. Each channel maps to a separate WebSocket connection to the hub. Services subscribe to the channels they care about.

| Channel | Subscribers | Purpose |
|---------|------------|---------|
| `sulla-desktop` | FrontendGraphWebSocketService, BackendGraphWebSocketService, SchedulerService | Primary chat channel between the UI and the default agent |
| `workbench` | BackendGraphWebSocketService | Workflow/workbench editor agent communication |
| `heartbeat` | BackendGraphWebSocketService, SchedulerService | Autonomous heartbeat agent loop; also used for keepalive pings |
| `calendar_event` | BackendGraphWebSocketService, CalendarClient | Calendar event scheduling, cancellation, rescheduling |
| Custom agent IDs | BackendGraphWebSocketService (dynamic) | One channel per custom agent defined in `~/sulla/agents/` |

## Message Format

All messages are JSON with this structure:

```ts
interface WebSocketMessage {
  type: string;       // message type (see table below)
  data: unknown;      // payload, varies by type
  id: string;         // UUID v4, unique per message
  originalId?: string; // present on ack messages, references the original message id
  timestamp: number;  // Date.now() epoch ms
  channel?: string;   // target channel name
}
```

## Message Types

### Protocol Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `subscribe` | Client -> Hub | Subscribe to a channel. Sent automatically on connect. |
| `ack` | Bidirectional | Acknowledge receipt of a message. Contains `originalId`. |
| `ping` | Client -> Hub | Keepalive heartbeat, sent every 30 s on the `heartbeat` channel. |

### Application Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `user_message` | Inbound to agent | User or inter-agent text input. `data.content` holds the message text. May include `data.threadId` for conversation continuity and `data.metadata` for origin tracking. |
| `assistant_message` | Agent -> Frontend | Agent response. `data.content` and `data.role` (`"assistant"`). |
| `system_message` | Agent -> Frontend | System-level notification (errors, status). `data` is a string. |
| `thread_created` | Agent -> Frontend | Notifies the frontend of a new thread ID (`data.threadId`). |
| `stop_run` | Frontend -> Agent | Abort the currently running agent execution on this channel. |
| `continue_run` | Frontend -> Agent | Resume a paused agent graph from the `agent` node. |
| `new_conversation` | Frontend -> Agent | Reset conversation state. If `data.threadId` is provided, that thread is removed from the GraphRegistry. |
| `scheduler_ack` | Agent -> Scheduler | Acknowledges that a scheduler-triggered event was received. `data.eventId` identifies the calendar event. |

### Calendar Channel Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `scheduled` | CalendarClient -> Hub | A new calendar event was created; the SchedulerService picks it up. |
| `cancel` | CalendarClient -> Hub | A calendar event was deleted; the SchedulerService cancels the job. |
| `reschedule` | CalendarClient -> Hub | A calendar event was updated; the SchedulerService reschedules it. |

## Key Services

### BackendGraphWebSocketService

**File:** `pkg/rancher-desktop/agent/services/BackendGraphWebSocketService.ts`

The main-process agent dispatcher. It subscribes to `sulla-desktop`, `workbench`, `heartbeat`, `calendar_event`, and all custom agent channels. When a `user_message` arrives, it resolves the correct agent persona via `GraphRegistry`, creates or reuses an `AgentGraph` for the thread, and executes the graph. It handles `stop_run` (abort) and `new_conversation` (reset) as well.

### FrontendGraphWebSocketService

**File:** `pkg/rancher-desktop/agent/services/FrontendGraphWebSocketService.ts`

The renderer-process counterpart. It connects to a single channel (default `sulla-desktop`), handles incoming `user_message` events, and executes the agent graph in the renderer. Supports `switchChannel()` for multi-agent UIs. Registers/deregisters itself in the ActiveAgentsRegistry.

### SchedulerService

**File:** `pkg/rancher-desktop/agent/services/SchedulerService.ts`

Uses `node-schedule` to fire calendar events at their scheduled times. When an event fires, the scheduler sends a `user_message` to the `sulla-desktop` channel (frontend-first), waits up to 3 s for a `scheduler_ack`, and falls back to the `heartbeat` channel (backend) if the frontend does not respond.

### StartupProgressController

**File:** `pkg/rancher-desktop/pages/agent/StartupProgressController.ts`

Probes `ws://localhost:30118/` during app startup. A successful WebSocket connection means the Kubernetes services are running and the startup overlay can be dismissed.

### send_notification_to_human Tool

**File:** `pkg/rancher-desktop/agent/tools/bridge/send_notification_to_human.ts`

An agent tool that displays a desktop notification popup to the human. The notification persists on-screen for 5 minutes past any mouse or keyboard activity, ensuring important messages are not missed.

## Health Monitoring

The debug event handler in `pkg/rancher-desktop/main/sullaDebugEvents.ts` exposes several IPC endpoints for monitoring the hub:

| IPC Handle | Purpose |
|-----------|---------|
| `debug-health-check` | TCP probe on port 30118 (and other services) |
| `debug-ws-stats` | Connection stats: connected state, reconnect attempts, pending messages, subscribed channels |
| `debug-ws-tap` | Enable/disable message logging ring buffer |
| `debug-ws-messages` | Retrieve recent logged messages (requires tap enabled) |
| `debug-active-agents` | List all registered agents from the ActiveAgentsRegistry |

## File-Based Logging

All WebSocket infrastructure events are logged to disk via **SullaLogger** (`pkg/rancher-desktop/agent/services/SullaLogger.ts`). Log files are written to `~/sulla/logs/`:

| File | Contents |
|------|----------|
| `websocket.log` | Connection lifecycle (open/close/error), reconnect attempts with backoff timing, heartbeat probes, message queue (QUEUED/SENDING/ACK/EXPIRED), hub readiness probes, suspend/resume events |
| `persona.log` | Channel subscriptions, message delivery attempts and results, send failures |
| `frontend-graph.log` | Inbound message routing, graph execution starts/completions, thread creation |

These are plain text with ISO timestamps and can be tailed in real time:

```bash
tail -f ~/sulla/logs/websocket.log
```

To investigate a "message went into a black hole" scenario, check `websocket.log` for the QUEUED entry and whether a matching ACK or EXPIRED follows.

## Deployment

The WebSocket server is defined in `pkg/rancher-desktop/assets/sulla-deployments.yaml`:

- **Image:** `byrdziak/sulla-websocket:latest`
- **Container port:** 8080
- **NodePort:** 30118
- **Resources:** 128-256 Mi memory, up to 500m CPU
- **Health checks:** TCP readiness probe (10 s initial delay, 5 s period) and liveness probe (30 s initial delay, 10 s period)
