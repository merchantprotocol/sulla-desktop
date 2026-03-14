# Heartbeat System

The heartbeat system is an autonomous background agent loop that periodically triggers a full agent graph execution without human intervention. It allows Sulla to work independently on projects, respond to incoming messages, and make continuous progress on tasks even when no user is actively interacting with the application.

## Architecture Overview

The system consists of two core components:

- **HeartbeatService** (`pkg/rancher-desktop/agent/services/HeartbeatService.ts`) -- A singleton scheduler that runs a check every minute, determines whether a heartbeat is due based on the configured delay interval, and triggers execution when the time arrives.
- **HeartbeatNode** (`pkg/rancher-desktop/agent/nodes/HeartbeatNode.ts`) -- A graph node that gathers project and skills context, builds a rich autonomous prompt, and spawns a fresh AgentGraph sub-execution for each cycle. It loops until the agent reports DONE, BLOCKED, or hits the maximum cycle count (default 10).

### Execution Flow

1. `HeartbeatService` initializes on startup and aligns its scheduler to the next full minute.
2. Every 60 seconds, the scheduler checks whether `heartbeatEnabled` is true and whether enough time has elapsed since the last trigger (controlled by `heartbeatDelayMinutes`).
3. When a heartbeat is due, the service builds a prompt (injecting current time and timezone), then dispatches execution through the `GraphRegistry` to get or create an Overlord graph keyed to `'heartbeat'`.
4. The Overlord graph routes into `HeartbeatNode`, which:
   - Loads active projects from the ProjectRegistry (once per heartbeat run).
   - Loads available skills from the SkillsRegistry (once per heartbeat run).
   - Loads active agents context from the ActiveAgentsRegistry (every cycle).
   - Builds an autonomous prompt combining all context with the heartbeat directive.
   - Spawns a fresh `AgentGraph` with full tool access (file system, Docker, n8n, git, memory, calendar, playwright, skills, projects, and bridge tools).
   - Captures the agent's outcome (DONE/BLOCKED/CONTINUE) and stores a cycle summary.
5. The heartbeat graph's conditional edge decides whether to loop for another cycle or exit.

## Configuration

Two settings in `SullaSettingsModel` control the heartbeat:

| Setting | Type | Default | Description |
|---|---|---|---|
| `heartbeatEnabled` | boolean | `false` | Master toggle. When false, every scheduler check results in a skip. |
| `heartbeatDelayMinutes` | number | `30` | Minimum interval between heartbeat executions, in minutes. Clamped to a minimum of 1. |
| `heartbeatPrompt` | string | `''` | Base prompt text injected into every heartbeat execution. The service prepends current time and timezone automatically. |

### HeartbeatNode Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_HEARTBEAT_CYCLES` | 10 | Maximum number of agent cycles per heartbeat execution before the loop exits. |
| `HEARTBEAT_WS_CHANNEL` | `'heartbeat'` | WebSocket channel used for heartbeat status updates. |

## Event Types

The `HeartbeatService` maintains an in-memory event history (ring buffer, max 200 entries) that tracks every significant action. Each event has a timestamp, type, message, and optional duration/error/metadata fields.

| Event Type | When It Fires |
|---|---|
| `scheduler_started` | Once, when the HeartbeatService initializes. |
| `scheduler_check` | Every minute when the scheduler runs its check. Includes info about whether a heartbeat was triggered or how many minutes remain until the next one. |
| `heartbeat_skipped` | When the scheduler check runs but `heartbeatEnabled` is false. |
| `heartbeat_triggered` | When a heartbeat execution begins. |
| `heartbeat_completed` | When a heartbeat execution finishes successfully. Includes duration, cycle count, status, and current focus in metadata. |
| `heartbeat_error` | When the scheduler check or heartbeat execution fails with an exception. Includes the error message. |
| `heartbeat_already_running` | When a heartbeat trigger is attempted while a previous execution is still in progress. The new trigger is skipped. |

## Interaction with the Main Agent Graph

The heartbeat does not interfere with user-initiated agent conversations. It uses a separate execution path:

1. The `HeartbeatService` obtains a graph via `GraphRegistry.getOrCreateOverlordGraph('heartbeat', prompt)`, which creates or reuses an Overlord graph instance keyed specifically to heartbeat execution.
2. The `HeartbeatNode` spawns a fresh `AgentGraph` (via `createAgentGraph()`) for each cycle with its own thread ID (`heartbeat_agent_{timestamp}_{cycleNumber}`), so it operates in complete isolation from any user-facing agent threads.
3. The sub-agent runs with `isSubAgent: true` in its metadata, identifying it as a non-interactive execution.
4. If the sub-agent reports a `blocked` status, the blocker reason and unblock requirements are injected back into the heartbeat conversation as a system message, and the heartbeat continues to the next cycle so the orchestrator can decide how to handle it.

## Status and History API

The `HeartbeatService` exposes two methods for monitoring:

- `getStatus()` returns a `HeartbeatStatus` object with: `initialized`, `isExecuting`, `lastTriggerMs`, `schedulerRunning`, `totalTriggers`, `totalErrors`, `totalSkips`, and `uptimeMs`.
- `getHistory(limit?)` returns the most recent events (default 50, max 200 stored).
- `forceCheck()` can be called from the UI after a settings change to trigger an immediate scheduler check without waiting for the next minute boundary.

## How to Enable/Disable

### Enabling the Heartbeat

1. Set `heartbeatEnabled` to `true` in Sulla settings.
2. Optionally configure `heartbeatDelayMinutes` to control how frequently the agent runs (default is every 30 minutes).
3. Optionally set `heartbeatPrompt` to provide a base directive that guides what the autonomous agent focuses on.
4. The heartbeat will trigger on the next scheduler check after the configured delay has elapsed.

### Disabling the Heartbeat

1. Set `heartbeatEnabled` to `false` in Sulla settings.
2. The scheduler continues running its per-minute checks but records a `heartbeat_skipped` event each time and takes no action.
3. Any currently executing heartbeat will run to completion -- disabling the setting does not abort an in-progress execution.

### Lifecycle

- The service is created as a singleton via `getHeartbeatService()` and initialized by calling `initialize()`.
- To fully shut down the scheduler (e.g., on application exit), call `destroy()`, which clears the interval timer and resets the initialized flag.
