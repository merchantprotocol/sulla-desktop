# Agent Graph Message Flow

This document describes the current graph architecture, node types, routing logic,
state management, and message flow.

---

## 1) Node Types and Roles

There are four node types in the system. All extend `BaseNode`, which provides
LLM chat, tool execution, prompt enrichment, message budgeting, and WebSocket
communication.

| Node | ID | Purpose |
|---|---|---|
| **InputHandlerNode** | `input_handler` | First node in every pipeline. Sanitizes input, detects prompt injection, enforces rate limits, batch-summarizes old messages, and enforces a hard token budget (96k tokens). Never makes LLM calls except for eviction summarization. Always returns `{ type: 'next' }`. |
| **AgentNode** | `agent` | Independent single-thread executor. Builds a system prompt (agent directive + channel awareness + soul/environment enrichment), calls the LLM with full tool access, parses the response for structured completion wrappers (`AGENT_DONE`, `AGENT_BLOCKED`, `AGENT_CONTINUE`), pushes the assistant response to `state.messages`, and updates `state.metadata.agent` with the outcome. Returns `{ type: 'next' }` so the graph's conditional edge decides whether to loop or end. |
| **HeartbeatNode** | `heartbeat` | Autonomous execution node triggered by the heartbeat scheduler. Each cycle: loads active projects, available skills, and active agents context; builds a rich autonomous prompt; spawns a **fresh AgentGraph** (InputHandler + Agent) as a sub-agent; captures the sub-agent's outcome (DONE/BLOCKED/CONTINUE); and returns to the heartbeat graph's conditional edge for loop/exit. |
| **BaseNode** | (abstract) | Shared infrastructure: LLM provider resolution, tool registry access, `chat()` with streaming and tool-use loops, prompt enrichment (soul, awareness, environment, memory), message budget trimming, WebSocket message helpers, and state version bumping. All concrete nodes inherit from this. |

### Removed Nodes

The following nodes from the previous architecture no longer exist:
PlanRetrievalNode, PlannerNode, ReasoningNode, ActionNode, SkillCriticNode, OutputNode.
The system now uses a single AgentNode with full tool access instead of the
multi-stage plan-reason-act-critique pipeline.

---

## 2) Graph Topologies

Two graph configurations are created by factory functions in `Graph.ts`.

### AgentGraph (`createAgentGraph`)

The primary graph for user-facing conversations and sub-agent execution.

```text
[input_handler] ──(static edge)──> [agent]
                                      |
                           (conditional edge)
                                      |
                    +-----------------+-----------------+
                    |                 |                 |
              status=done      status=blocked    status=continue
              or workflow        or blocked       or had tool calls
              activated                                |
                    |                 |                 |
                    v                 v                 v
                  END               END            [agent] (loop)
```

**Conditional edge logic (agent -> ?):**

1. If `activeWorkflow.status === 'running'` -- end (workflow playbook takes over).
2. If agent status is `done` -- end.
3. If agent status is `blocked` -- end.
4. If agent status is `in_progress` with no tool calls and no wrapper -- send a
   one-time "wrapper nudge" system message and retry once, then end on second failure.
5. If agent status is `continue` or the agent made tool calls -- loop back to `agent`.

The agent loop count is tracked on `state.metadata.agentLoopCount`.
A safety limit of 40 consecutive same-node executions (`MAX_CONSECUTIVE_LOOP`)
is enforced by the Graph engine itself.

### HeartbeatGraph (`createHeartbeatGraph`)

The autonomous heartbeat loop for background agent execution.

```text
[input_handler] ──(static edge)──> [heartbeat]
                                       |
                            (conditional edge)
                                       |
                  +--------------------+--------------------+
                  |                    |                    |
           status=done          status=blocked       status=running
           or max cycles        or max cycles        and cycles < max
                  |                    |                    |
                  v                    v                    v
                END                  END              [heartbeat] (loop)
```

**Conditional edge logic (heartbeat -> ?):**

1. If heartbeat status is `done` -- end.
2. If heartbeat status is `blocked` -- end.
3. If cycle count >= max cycles (default 10) -- end.
4. Otherwise -- loop back to `heartbeat`.

Each heartbeat cycle spawns a fresh `AgentGraph` internally via
`createAgentGraph()`, giving the sub-agent its own isolated message thread
with full tool access.

---

## 3) Message Flow Through the System

### User Conversation (AgentGraph)

```text
User message arrives via WebSocket
        |
        v
[InputHandlerNode]
  1. Sanitize latest user message (strip control chars, detect injection)
  2. Rate-limit check (min interval + burst window)
  3. Spam detection
  4. Trigger background conversation summarization if messages > 80
  5. Enforce token budget ceiling (96k tokens, newest-first retention)
  6. Store diagnostics on state.metadata.inputHandler
        |
        v
[AgentNode]
  1. Trim message budget (ensureMessageBudget)
  2. Build system prompt:
     - Agent base prompt (personality/directives)
     - Channel awareness (active agents registry)
     - Agent directive (progress communication rules, tool result narration)
     - Completion wrappers (DONE/BLOCKED/CONTINUE format)
     - Enrichment: soul, awareness, environment context
  3. Start live DOM stream (subscribe to HostBridge events)
  4. Execute LLM call with full tool access via chat()
     - chat() handles streaming, tool calls, tool_result appending
     - Tool calls loop until LLM stops calling tools
     - All messages (assistant + tool_result) persisted to state.messages
  5. Parse agent outcome from response wrappers
  6. Strip wrapper XML from user-visible text
  7. Push clean assistant response to state.messages
  8. Send response via WebSocket
  9. Update metadata: agent.status, agent.status_report, cycleComplete, etc.
        |
        v
[Conditional Edge]
  - DONE/BLOCKED -> graph ends, completion signal sent via WebSocket
  - CONTINUE or tool calls -> loop back to AgentNode
```

### Heartbeat (HeartbeatGraph)

```text
Heartbeat scheduler triggers
        |
        v
[InputHandlerNode] -- sanitize/budget the initial prompt
        |
        v
[HeartbeatNode]
  1. Load active projects (from ProjectRegistry, cached after first load)
  2. Load available skills (from SkillsRegistry, cached after first load)
  3. Load active agents context (from ActiveAgentsRegistry, refreshed each cycle)
  4. Build autonomous prompt:
     - heartbeatPrompt directive
     - Time context, cycle count
     - Projects list, skills list, agents list
     - Prior cycle summary + current focus (continuity)
     - Autonomous execution rules
  5. Spawn fresh AgentGraph:
     - Create isolated AgentGraphState with isSubAgent=true
     - Inject autonomous prompt as user message + parent state messages
     - Execute: input_handler -> agent loop
  6. Capture sub-agent outcome from agentState.metadata.agent
  7. If blocked: inject blocker context as system message into heartbeat
     thread (so next cycle can act on it)
  8. Update heartbeatStatus: done/blocked -> end, otherwise -> running
        |
        v
[Conditional Edge]
  - done/blocked/max cycles -> graph ends
  - running -> loop back to HeartbeatNode for next cycle
```

---

## 4) State Management

### BaseThreadState

All graphs operate on `BaseThreadState` (or extensions of it). Key fields:

```text
state.messages           ChatMessage[]   The single conversation thread.
                                         All nodes read from and write to
                                         this array directly.

state.metadata.threadId           string          Unique thread identifier.
state.metadata.wsChannel          string          WebSocket channel for this thread.
state.metadata.conversationId     string?         Conversation logger session ID.
state.metadata.action             enum            Current action type (use_tools, direct_answer, etc.).
state.metadata.cycleComplete      boolean         When true, graph loop exits.
state.metadata.waitingForUser     boolean         When true, graph pauses for user input.
state.metadata.isSubAgent         boolean         True for heartbeat/workflow sub-agents.
state.metadata.currentNodeId      string          Tracks which node is executing.
state.metadata.consecutiveSameNode number         Safety counter for loop detection.
state.metadata.iterations         number          Total node executions in this graph run.
state.metadata.llmModel           string          Which LLM model to use.
state.metadata.llmLocal           boolean         Whether to use local model.
state.metadata.activeWorkflow     WorkflowPlaybookState?  Active workflow playbook (if any).
state.metadata.options.abort      AbortService?   Abort controller for cancellation.
```

### AgentGraphState (extends BaseThreadState)

Adds `state.metadata.agent`:

```text
state.metadata.agent.status              'done' | 'blocked' | 'continue' | 'in_progress'
state.metadata.agent.status_report       string | null
state.metadata.agent.response            string | null  (full text on DONE)
state.metadata.agent.blocker_reason      string | null
state.metadata.agent.unblock_requirements string | null
state.metadata.agent.updatedAt           number
state.metadata.agentLoopCount            number
```

### HeartbeatThreadState (extends BaseThreadState)

Adds heartbeat-specific fields:

```text
state.metadata.activeProjects            string   Rendered project list.
state.metadata.availableSkills           string   Rendered skills list.
state.metadata.agentsContext             string   Active agents context block.
state.metadata.heartbeatCycleCount       number   Current cycle number.
state.metadata.heartbeatMaxCycles        number   Max cycles before stop (default 10).
state.metadata.heartbeatStatus           'running' | 'done' | 'blocked' | 'idle'
state.metadata.heartbeatLastCycleSummary string   Summary from last cycle.
state.metadata.currentFocus              string   What the agent decided to work on.
state.metadata.focusReason               string   Why it chose that focus.
```

### ThreadStateStore (Persistence)

Thread state is persisted via `ThreadStateStore`, which provides:

- **Redis-backed storage** (primary): States saved with 1-hour TTL under
  `sulla:threadstate:<threadId>`. Uses `structuredClone` for deep copy on
  save/load.
- **In-memory fallback**: `Map<string, BaseThreadState>` used when Redis
  is unavailable (desktop/development mode).
- **ProcessingCoordinator**: Redis-based distributed locking for
  service-level coordination. Uses `SET NX EX` pattern with 30-second TTL
  to prevent concurrent processing of the same thread.

Functions: `saveThreadState()`, `loadThreadState()`, `deleteThreadState()`.

---

## 5) Stream Buffering (StreamBufferManager)

Handles partial speech transcripts from voice/streaming input. Singleton
pattern via `StreamBufferManager.getInstance()`.

**Buffering strategy:**

| Condition | Action |
|---|---|
| Active speaking | Buffer continuously, no processing |
| Speech pause (1.5s) | Evaluate if complete thought (sentence-ending punctuation or request pattern) |
| Extended silence (3s) | Force flush and process |
| Max buffer time (15s) | Force process regardless |
| Min processing length | 20 chars minimum before considering processing |

**Buffer lifecycle:**

1. `addSpeechChunk(threadId, chunk, isComplete)` -- accumulates chunks in memory.
2. Pause detection via `setTimeout` triggers `handleSpeechPause()`.
3. When ready to process: stores buffer content in Redis
   (`stream_buffer:<threadId>`) for serverless handoff.
4. `forceFlushBuffer(threadId)` available for emergency processing.
5. `getBufferStatus(threadId)` for monitoring (exists, content, age, state).

---

## 6) Graph Engine Internals

### Execution Loop (`Graph.execute`)

```text
1. Set entry point node as currentNodeId
2. Initialize conversation logging + training data session
3. Loop:
   a. Check abort signal (throwIfAborted)
   b. Check cycleComplete flag -> break
   c. Check waitingForUser at input_handler -> break
   d. Execute current node -> get NodeResult { state, decision }
   e. Check abort signal again
   f. Resolve next node via resolveNext(currentNodeId, decision, state)
   g. Track consecutive same-node count (safety limit: 40)
   h. If next is 'end' or endpoint with end decision -> break
   i. Update currentNodeId
4. Process workflow playbook (if active)
5. Log graph completion
6. Send WebSocket completion signal: { type: 'transfer_data', content: 'graph_execution_complete' }
```

### Node Decision Types

Nodes return one of these decisions; the Graph engine interprets them:

| Decision | Behavior |
|---|---|
| `{ type: 'end' }` | Graph execution stops. |
| `{ type: 'goto', nodeId }` | Jump directly to a specific node. |
| `{ type: 'continue' }` | Re-execute the same node. |
| `{ type: 'next' }` | Follow the configured edge (static or conditional). |
| `{ type: 'revise' }` | Go back to a reviser node (legacy, rarely used). |

In practice, both InputHandlerNode and AgentNode always return `{ type: 'next' }`,
so all routing is handled by the conditional edges defined in the factory functions.

### Workflow Playbook Integration

After the main agent loop completes, the Graph checks for
`state.metadata.activeWorkflow`. If a workflow playbook is active and running,
the Graph processes its DAG:

- **Structural nodes** (triggers, conditions, merges): processed mechanically.
- **Agent nodes**: spawn sub-agents via `executeSubAgent()` with before/after
  orchestrator prompts.
- **Tool-call nodes**: validate params via orchestrator, then execute directly.
- **Router/condition decisions**: inject prompt and re-enter the agent loop.
- **Parallel branches**: fire all sub-agents concurrently via `Promise.allSettled`.
- **Sub-workflows**: push parent onto a workflow stack and process child.
- **Transfers**: clean break to a new workflow definition.
- **Wait nodes**: simple `setTimeout` delay.

---

## 7) Entry Points

| Factory Function | Creates | Used By |
|---|---|---|
| `createAgentGraph()` | InputHandler + Agent loop | User conversations, workflow sub-agents, HeartbeatNode sub-agent spawning |
| `createHeartbeatGraph()` | InputHandler + Heartbeat loop | Heartbeat scheduler for autonomous background execution |
| `createGeneralGraph()` | Alias for `createAgentGraph()` | Back-compat |
| `createOverlordGraph()` | Alias for `createHeartbeatGraph()` | Back-compat |
