# PRD: Workflow System

**Status:** Draft
**Date:** 2026-03-20
**Author:** Engineering
**Scope:** DAG-based playbook engine that orchestrates multi-step agent tasks with sub-agent spawning, decision routing, loops, parallel execution, and n8n integration.

---

## 1. Overview

The Workflow System is Sulla Desktop's automation engine. It defines, schedules, and executes multi-step workflows as directed acyclic graphs (DAGs) of typed nodes. Workflows are authored as YAML files, promoted through a lifecycle (draft → production → archive), and executed by a playbook state machine that walks the DAG frontier, spawns sub-agents for agent nodes, resolves routing decisions via the orchestrator LLM, manages loop/parallel state, and checkpoints progress to Postgres after each step.

### Data Flow

```
Trigger (schedule / heartbeat / chat / desktop event / calendar / workbench / chat-completions)
  → WorkflowRegistry.findCandidates(triggerType)
    → LLM selection (if multiple candidates)
      → Graph.createPlaybookState(workflow)
        → processNextStep() — walk DAG frontier
          → Agent node → spawn sub-agent (independent Graph execution)
            → Sub-agent completes → pendingCompletions map
          → Router/condition node → inject decision prompt → parse orchestrator response
          → Loop node → manage iteration state, re-enter body nodes
          → Parallel node → spawn multiple sub-agents simultaneously
          → Wait node → pause until condition met
          → Integration-call node → N8nService REST call
          → Tool-call node → execute tool from registry
          → Response / transfer / user-input → emit to UI
        → Node completes → checkpoint to Postgres (WorkflowCheckpointModel)
          → Advance DAG → processNextStep() (repeat)
            → All nodes complete → workflow_execution_event(completed) → WebSocket → UI
```

### Key Files

| File | Responsibility |
|------|----------------|
| `pkg/rancher-desktop/agent/nodes/Graph.ts` | Playbook orchestration, sub-agent lifecycle (pendingSubAgents, pendingCompletions, pendingFailures, pendingEscalations), checkpoint saves, workflow event emission |
| `pkg/rancher-desktop/agent/workflows/WorkflowPlaybook.ts` | DAG walker/state machine: createPlaybookState(), processNextStep(), resolveDecision(), completeSubAgent(), loop state management |
| `pkg/rancher-desktop/agent/nodes/HeartbeatNode.ts` | Background orchestrator: scans production workflows for heartbeat triggers, spawns agent graphs |
| `pkg/rancher-desktop/agent/workflows/WorkflowRegistry.ts` | Workflow lookup/selection: finds candidates by trigger type, LLM-based selection when ambiguous |
| `pkg/rancher-desktop/agent/services/WorkflowSchedulerService.ts` | Cron-based schedule trigger evaluation and execution |
| `pkg/rancher-desktop/agent/models/WorkflowCheckpointModel.ts` | Persists full playbook state to Postgres after each node completion |
| `pkg/rancher-desktop/agent/models/WorkflowPendingCompletionModel.ts` | Persists sub-agent results across graph restarts |
| `pkg/rancher-desktop/agent/tools/execute_workflow.ts` | Tool that activates workflows from agent context |
| `pkg/rancher-desktop/agent/tools/validate_sulla_workflow.ts` | Validates workflow YAML structure and connectivity |
| `pkg/rancher-desktop/agent/tools/restart_from_checkpoint.ts` | Resumes workflow execution from a saved checkpoint |
| `pkg/rancher-desktop/main/ipc/sullaWorkflowEvents.ts` | IPC handlers: workflow-list, workflow-get, workflow-save, workflow-execute, etc. |
| `pkg/rancher-desktop/agent/services/N8nService.ts` | n8n REST API integration |
| `pkg/rancher-desktop/agent/services/N8nBridgeService.ts` | n8n WebSocket live event bridge |
| `pkg/rancher-desktop/pages/editor/workflow/` | UI components: node config panels, canvas, palette |

### Workflow Directory Structure

```
~/sulla/workflows/
  ├── draft/        — Work-in-progress (not scannable by triggers)
  ├── production/   — Active (scannable by triggers, schedules, heartbeats)
  └── archive/      — Completed/unused (preserved for reference)
```

### Node Types

| Category | Node Types | Purpose |
|----------|-----------|---------|
| Triggers | calendar, chat-app, heartbeat, schedule, sulla-desktop, workbench, chat-completions | Entry points that activate the workflow |
| Agents | agent, integration-call, tool-call, orchestrator-prompt | Execute work (LLM calls, tool runs, n8n calls) |
| Routing | router, condition | Decision points that select outgoing edges |
| Flow Control | wait, loop, parallel, merge, sub-workflow | Manage execution order and concurrency |
| I/O | user-input, response, transfer | Interact with users or hand off to other workflows |

---

## 2. Must Have (Existing Features That Must Continue Working)

These features exist today and must remain functional through any refactor.

### 2.1 Workflow Definition Format

**As a workflow author, I want to define workflows as YAML files with typed nodes, edges, and viewport metadata so that I can author automation visually or by hand.**

Current implementation:
- YAML structure: `name`, `description`, `trigger`, `nodes[]`, `edges[]`, `viewport`
- Each node has: `id`, `type`, `label`, `position`, `data` (type-specific configuration)
- Each edge has: `id`, `source`, `target`, `sourceHandle`, `targetHandle`, `label` (optional)
- Viewport stores canvas pan/zoom for the visual editor
- Trigger block defines activation criteria (type, schedule expression, heartbeat config, etc.)

### 2.2 Workflow Lifecycle Management

**As a workflow author, I want to promote workflows through draft → production → archive stages so that only tested workflows are active and I can retire old ones safely.**

Current implementation:
- Three directories under `~/sulla/workflows/`: `draft/`, `production/`, `archive/`
- Only `production/` workflows are scanned by HeartbeatNode and WorkflowSchedulerService
- IPC channels support save, move, and delete operations
- File watchers detect changes and emit `workflow-files-changed` for hot reload in the UI

### 2.3 Trigger Types

**As a workflow author, I want multiple trigger types so that workflows can activate from schedules, heartbeats, user chat, desktop events, calendar events, workbench actions, and API calls.**

Current implementation:
- **schedule** — Cron expressions evaluated by WorkflowSchedulerService. Fires at the specified interval.
- **heartbeat** — HeartbeatNode scans production workflows for heartbeat triggers on each background cycle. Fires when the heartbeat condition is met.
- **chat-app** — Activated when a user message matches the workflow's chat trigger pattern.
- **sulla-desktop** — Activated by Sulla Desktop application events (app launch, window focus, etc.).
- **calendar** — Activated by calendar events via CalendarClient integration.
- **workbench** — Activated by workbench/editor actions.
- **chat-completions** — Activated via the ChatCompletionsServer API (port 3000).
- WorkflowRegistry.findCandidates() filters workflows by trigger type; when multiple match, an LLM call selects the best candidate.

### 2.4 Agent Nodes and Sub-Agent Spawning

**As a workflow author, I want agent nodes to spawn independent sub-agents that execute LLM tasks so that each step in my workflow can reason, use tools, and produce results autonomously.**

Current implementation:
- Agent nodes in the playbook spawn fresh AgentGraph instances (`isSubAgent=true`)
- Each sub-agent runs its own conversation loop (InputHandler → AgentNode) with its own message history
- Sub-agent configuration: agent ID, system prompt overrides, tool restrictions, max iterations
- Sub-agent results collected via `pendingCompletions` map on the orchestrator Graph
- Sub-agent failures collected via `pendingFailures` map
- Sub-agent escalations (BLOCKED status) collected via `pendingEscalations` map
- `subAgentDepth` tracking prevents infinite nesting
- `executeSubAgent()` in Graph.ts handles spawn, monitoring, and result collection

### 2.5 Tool-Call Nodes

**As a workflow author, I want tool-call nodes that execute specific tools directly so that I can perform discrete operations (file writes, API calls, database queries) without needing a full agent.**

Current implementation:
- Node data specifies the tool name and argument template
- Arguments can reference outputs from previous nodes via template variables
- Tool is resolved from the tool registry and executed directly
- Result is stored in the playbook state and available to downstream nodes

### 2.6 Integration-Call Nodes (n8n)

**As a workflow author, I want integration-call nodes that invoke n8n workflows so that I can leverage existing n8n automations from within Sulla workflows.**

Current implementation:
- N8nService provides REST API integration for triggering n8n workflows and polling results
- N8nBridgeService provides WebSocket integration for live execution events
- Node data specifies the n8n workflow ID and input parameters
- Results from n8n are captured and stored in playbook state
- Error handling includes timeout and retry logic

### 2.7 Orchestrator-Prompt Nodes

**As a workflow author, I want orchestrator-prompt nodes that inject a prompt into the orchestrator's context so that the orchestrating agent can reason about the workflow state and make decisions.**

Current implementation:
- Injects a prompt message into the orchestrator agent's conversation
- Orchestrator processes the prompt through its normal LLM call
- Response is captured and stored in playbook state
- Used for workflow-level reasoning, summarization, and decision preparation

### 2.8 Router Nodes (Decision Routing)

**As a workflow author, I want router nodes that classify the current state and select one of several outgoing paths so that my workflow can branch based on LLM judgment.**

Current implementation:
- Router node defines multiple outgoing edges, each with a label describing the route
- A decision prompt is injected into the orchestrator's message stream
- The orchestrator's response is parsed (regex/XML) to extract the chosen route label
- The matching outgoing edge is activated; other edges are skipped
- If no match, a fallback/default edge is used (if configured)

### 2.9 Condition Nodes

**As a workflow author, I want condition nodes that evaluate boolean expressions so that my workflow can branch on structured data (e.g., "if API returned status 200").**

Current implementation:
- Condition node defines a condition expression and true/false outgoing edges
- Condition evaluation can be: orchestrator-prompt (LLM decides), expression-based, or data-check
- The orchestrator's response or expression result determines which edge activates
- Simpler than router — always binary (true/false)

### 2.10 Loop Nodes

**As a workflow author, I want loop nodes with while, for-each, and ask-orchestrator modes so that I can iterate over data sets, repeat until a condition is met, or let the agent decide when to stop.**

Current implementation:
- Loop node maintains nested state: `currentIteration`, `bodyNodeIds`, `bodyStartNodeIds`, `accumulatedConversation`, `iterationResults`
- **while** mode: evaluates a condition before each iteration; stops when false
- **for-each** mode: iterates over a collection from a previous node's output
- **ask-orchestrator** mode: prompts the orchestrator LLM to decide whether to continue
- Loop body is a sub-DAG of nodes executed on each iteration
- Iteration results accumulated and available to downstream nodes after loop exit
- Max iteration safety limit prevents infinite loops

### 2.11 Parallel Nodes and Merge Strategies

**As a workflow author, I want parallel nodes that spawn multiple sub-agents simultaneously with configurable merge strategies so that I can run independent tasks concurrently and collect their results.**

Current implementation:
- Parallel node defines multiple outgoing branches, each spawning a sub-agent
- All branches execute simultaneously as independent graph instances
- Merge node collects results with strategies:
  - **wait-all** — waits for every branch to complete before proceeding
  - **first** — proceeds as soon as the first branch completes; other branches continue but results are not blocking
- Merge node aggregates results into a single output available to downstream nodes

### 2.12 Wait Nodes

**As a workflow author, I want wait nodes that pause execution until a condition is met or a timeout expires so that I can synchronize with external events.**

Current implementation:
- Wait node pauses the DAG walker at that position
- Supports time-based waits (duration) and condition-based waits (poll for state)
- Timeout with configurable behavior (fail, skip, or escalate)

### 2.13 Sub-Workflow Nodes

**As a workflow author, I want sub-workflow nodes that invoke another workflow as a nested execution so that I can compose complex automations from reusable workflow components.**

Current implementation:
- Sub-workflow node references another workflow by name/path
- The referenced workflow is loaded and executed as a nested playbook
- Input parameters are passed from the parent workflow
- Results are returned to the parent and stored in playbook state
- Nesting depth is tracked to prevent infinite recursion

### 2.14 Transfer Nodes

**As a workflow author, I want transfer nodes that hand off execution to another workflow so that I can chain workflows without returning to the caller.**

Current implementation:
- Transfer node terminates the current workflow and starts a new one
- The current playbook state context is passed to the target workflow
- Unlike sub-workflow, control does not return to the caller

### 2.15 User-Input and Response Nodes

**As a workflow author, I want user-input nodes that pause for human input and response nodes that display output so that my workflows can interact with users at defined points.**

Current implementation:
- **user-input** — Pauses workflow execution, prompts the user via WebSocket, waits for response
- **response** — Emits content to the user via WebSocket without pausing
- Both support template variables referencing previous node outputs

### 2.16 DAG Execution (Topological Frontier)

**As a developer, I want the workflow engine to walk the DAG by topological frontier so that nodes execute only when all their dependencies have completed, and independent branches run in correct order.**

Current implementation (WorkflowPlaybook.ts):
- `createPlaybookState()` builds the initial state from workflow YAML: node states, edge states, frontier set
- `processNextStep()` identifies the current frontier (nodes whose dependencies are all satisfied)
- Nodes are processed in topological order within each frontier tier
- Edge activation tracked per edge ID
- Completed nodes are removed from the frontier; their successors are added if all their incoming edges are satisfied
- Cycle detection prevents infinite loops in malformed DAGs

### 2.17 Checkpoint Persistence

**As a user, I want workflow progress saved to the database after each step so that if the application restarts, my workflow resumes from where it left off instead of starting over.**

Current implementation:
- `WorkflowCheckpointModel` persists the full playbook state to Postgres after each node completion
- Checkpoint includes: workflow ID, node states, edge states, frontier, loop state, accumulated outputs, conversation context
- `WorkflowPendingCompletionModel` persists sub-agent results separately so they survive graph restarts
- `restart_from_checkpoint` tool loads a checkpoint and resumes execution from the saved state

### 2.18 Workflow Resume from Checkpoint

**As a user, I want to resume a failed or interrupted workflow from its last checkpoint so that I do not lose progress on long-running automations.**

Current implementation:
- `restart_from_checkpoint` tool accepts a workflow execution ID
- Loads the most recent checkpoint from `WorkflowCheckpointModel`
- Reconstructs playbook state and re-enters `processNextStep()` from the saved frontier
- Drains any pending sub-agent completions from `WorkflowPendingCompletionModel`

### 2.19 Workflow Validation

**As a workflow author, I want structural validation of my workflow YAML so that I catch connectivity errors, unreachable nodes, and type mismatches before running the workflow.**

Current implementation (`validate_sulla_workflow` tool):
- Validates YAML structure (required fields, valid node types, valid edge references)
- Connectivity checks: all nodes reachable from trigger, no orphan nodes
- Edge validation: source and target nodes exist, handles are valid
- Type-specific validation: trigger nodes have valid trigger config, loop nodes have body node references, etc.
- Returns structured error/warning list

### 2.20 Workflow Execution Events

**As a frontend developer, I want real-time workflow execution events over WebSocket so that the UI can show live progress, edge animations, and node status updates.**

Current implementation:
- `workflow_execution_event` messages emitted via WebSocket during execution
- Event types: `node_started`, `node_completed`, `node_failed`, `edge_activated`, `workflow_started`, `workflow_completed`, `workflow_failed`
- Each event includes: workflow ID, node ID, status, timestamp, output data (if completed)
- Edge activation events enable animated edge visualization in the workflow canvas
- Events emitted from Graph.ts during playbook processing

### 2.21 Edge Activation Visualization

**As a user, I want to see edges light up in the workflow canvas as execution flows through them so that I can visually track which path the workflow is taking.**

Current implementation:
- `edge_activated` events sent when the DAG walker traverses an edge
- Frontend highlights the activated edge in the canvas
- Enables visual debugging of router/condition decisions and parallel fan-out

### 2.22 Workflow Scheduler

**As a workflow author, I want cron-based schedule triggers so that my workflows run on a recurring schedule without manual intervention.**

Current implementation (WorkflowSchedulerService):
- Parses cron expressions from workflow trigger configuration
- Evaluates schedules on a polling interval
- Fires matching workflows by invoking the workflow execution pipeline
- Tracks last-run timestamps to prevent double-firing

### 2.23 HeartbeatNode Scanning

**As a user, I want background scanning of production workflows for heartbeat triggers so that workflows activate automatically based on system state without a fixed schedule.**

Current implementation (HeartbeatNode):
- Runs as a background graph node on a recurring cycle
- Scans all workflows in `~/sulla/workflows/production/`
- Identifies workflows with heartbeat trigger type
- Evaluates heartbeat conditions (system state checks)
- Spawns agent graphs to execute matching workflows
- Tracks active heartbeat executions to prevent duplicate runs

### 2.24 n8n Integration

**As a workflow author, I want to call n8n workflows and receive live execution events so that I can integrate Sulla workflows with the broader n8n automation ecosystem.**

Current implementation:
- **N8nService** — REST API client for n8n: list workflows, trigger execution, poll status, fetch results
- **N8nBridgeService** — WebSocket client for n8n: receives live execution events (node started, completed, failed), bridges them to Sulla's event system
- Integration-call nodes use N8nService to trigger and monitor n8n workflow executions
- Error handling: connection retry, timeout, and authentication refresh

### 2.25 Workflow Tools

**As an agent, I want tools to execute, validate, and resume workflows so that I can manage workflow operations from within a conversation.**

Current implementation:
- `execute_workflow` — Activates a workflow by name or path. Resolves the workflow file, creates playbook state, and starts execution.
- `validate_sulla_workflow` — Validates a workflow YAML file and returns structured errors/warnings.
- `restart_from_checkpoint` — Resumes a workflow from its last saved checkpoint.

### 2.26 IPC Channels

**As a frontend developer, I want IPC channels for listing, reading, saving, and executing workflows so that the UI can manage workflows without direct file system access.**

Current implementation (sullaWorkflowEvents.ts):
- `workflow-list` — Returns all workflows grouped by lifecycle stage (draft, production, archive)
- `workflow-get` — Reads and parses a single workflow YAML file
- `workflow-save` — Writes workflow YAML to disk
- `workflow-execute` — Triggers workflow execution from the UI
- `workflow-move` — Moves a workflow between lifecycle stages
- `workflow-delete` — Removes a workflow file
- `workflow-files-changed` — File watcher event for hot reload

### 2.27 File Watchers and Hot Reload

**As a workflow author, I want the UI to automatically refresh when workflow files change on disk so that edits from any source (CLI, editor, agent) are reflected immediately.**

Current implementation:
- File watchers monitor `~/sulla/workflows/` recursively
- Changes emit `workflow-files-changed` IPC event
- Frontend re-fetches workflow list on receiving the event

---

## 3. Should Have (Improvements Needed)

These are architectural improvements that address the complexity and maintainability problems documented below. They do not add new user-facing features but make the existing system more reliable, debuggable, and extensible.

### Problem Summary

1. **Execution state stored in YAML** — The workflow YAML config gets overwritten with execution state during runs. This mixes definition with runtime state. A workflow that is running has its YAML file mutated, meaning the definition cannot be safely read or edited while execution is in progress. This is a known issue.

2. **Graph.ts is overloaded** — Graph.ts handles BOTH the simple agent loop (InputHandler → AgentNode) AND the full workflow playbook orchestration. These are fundamentally different execution models crammed into one class. The playbook processing code (`processPlaybook`, `drainCompletions`, `drainFailures`, `drainEscalations`, `executeSubAgent`, `saveCheckpoint`) is interleaved with basic graph execution. This makes Graph.ts ~2859 lines and extremely difficult to modify without breaking either system.

3. **No workflow event bus** — Workflow events (`node_started`, `node_completed`, `workflow_failed`) are emitted via direct WebSocket calls scattered through Graph.ts. There is no central event bus, no middleware for logging or metrics, and no audit trail of workflow execution history.

4. **Sub-agent lifecycle is fragile** — Sub-agents run as independent graph executions. Their results are collected via `pendingCompletions`/`pendingFailures` maps on the Graph class. If the orchestrator graph restarts, pending results must be drained from `WorkflowPendingCompletionModel`. This two-layer storage (in-memory maps + Postgres fallback) is complex and error-prone — race conditions between completion writes and reads can lose results.

5. **Decision resolution is implicit** — Router and condition decisions are resolved by injecting a prompt into the orchestrator's message stream and parsing the agent's natural language response. There is no structured decision protocol — just regex/XML parsing of freeform text. If the LLM's response does not match the expected format, the decision falls through to a default or fails silently.

6. **Loop state complexity** — Loop nodes maintain deeply nested state (`currentIteration`, `bodyNodeIds`, `bodyStartNodeIds`, `accumulatedConversation`, `iterationResults`) inside the playbook state object. This makes the playbook state tree deeply nested, hard to serialize/deserialize reliably, and difficult to inspect when debugging.

7. **No workflow versioning** — Workflows are YAML files on disk with no version history. There is no rollback capability, no diff between versions, and no immutable snapshot for a running execution. Editing a production workflow while it is executing could corrupt the run.

8. **Checkpoint/resume is coarse** — Checkpoints save the entire playbook state after each node. Resuming means replaying from a specific node, but the playbook state may reference nodes or edges that changed since the checkpoint was saved (since the YAML file can be edited at any time).

### 3.1 WorkflowExecutionEngine

**As a developer, I want workflow execution logic in its own class so that I can understand and debug playbook processing without reading the entire Graph.ts file.**

**As a developer, I want the simple agent loop (InputHandler → AgentNode) and the workflow playbook orchestration to be separate classes so that changes to one cannot break the other.**

Current state: Graph.ts (~2859 lines) contains both the generic DAG executor for the agent loop and the full workflow playbook orchestration. The playbook code — `processWorkflowPlaybook()`, `drainCompletions()`, `drainFailures()`, `drainEscalations()`, `executeSubAgent()`, `saveCheckpoint()`, sub-agent lifecycle management via `pendingSubAgents`/`pendingCompletions`/`pendingFailures`/`pendingEscalations` maps — is deeply interleaved with the basic graph execution loop.

Proposed: A `WorkflowExecutionEngine` class that owns:
- Playbook state creation and management (`createPlaybookState()`, `processNextStep()`)
- Sub-agent lifecycle (spawning, monitoring, result collection)
- Decision resolution (router/condition prompt injection and response parsing)
- Loop and parallel state management
- Checkpoint persistence (save/load/resume)
- Workflow event emission
- Graph.ts delegates to `WorkflowExecutionEngine` when `state.metadata.activeWorkflow` is present, and handles only the simple agent loop otherwise

### 3.2 Workflow Event Bus

**As a developer, I want a central workflow event bus with typed events and middleware so that I can add logging, metrics, and audit trail without modifying the execution engine.**

**As a developer, I want workflow execution history persisted to the database so that I can query past runs, diagnose failures, and build analytics dashboards.**

Current state: Workflow events are emitted via direct `dispatchToWebSocket()` calls in Graph.ts. Each call constructs its own payload. There is no subscriber pattern, no middleware, and no persistence of the event stream.

Proposed: A `WorkflowEventBus` service with:
- Typed event definitions: `WorkflowStarted`, `NodeStarted`, `NodeCompleted`, `NodeFailed`, `EdgeActivated`, `WorkflowCompleted`, `WorkflowFailed`, `SubAgentSpawned`, `SubAgentCompleted`, `DecisionMade`, `LoopIteration`, `CheckpointSaved`
- Subscriber pattern: `eventBus.on('NodeCompleted', handler)`
- Built-in middleware: WebSocket dispatch middleware (replaces direct calls), logging middleware, checkpoint middleware, audit trail middleware
- Event persistence to Postgres for post-run analysis
- Decouples event production (WorkflowExecutionEngine) from event consumption (UI, logging, metrics)

### 3.3 Runtime State Separation

**As a workflow author, I want to save a workflow without affecting a currently running execution so that production workflows are safe to edit.**

**As a developer, I want workflow YAML files to be definition-only so that I never have to worry about runtime state corrupting the workflow definition.**

Current state: The workflow YAML file is overwritten with execution state during runs. The file on disk is both the definition and the runtime state. This means: (a) the definition cannot be safely edited during execution, (b) a crash during write can corrupt both definition and state, (c) multiple simultaneous executions of the same workflow overwrite each other's state.

Proposed:
- YAML files are definition-only — never mutated at runtime
- Execution state stored entirely in Postgres (extending WorkflowCheckpointModel)
- Each execution gets a unique execution ID and its own state record
- Multiple simultaneous executions of the same workflow are supported
- Workflow definitions can be edited at any time without affecting running executions
- Running executions use an immutable snapshot of the definition taken at start time

### 3.4 Structured Decision Protocol

**As a developer, I want router and condition decisions to use a typed request/response protocol so that decision parsing is reliable and debuggable instead of regex over freeform text.**

**As a workflow author, I want routing decisions to be deterministic and auditable so that I can understand why a workflow took a specific path.**

Current state: Router and condition decisions are resolved by injecting a freeform prompt into the orchestrator's message stream and parsing the response with regex/XML. If the LLM's response does not match the expected pattern, the decision may fall through to a default or fail. There is no structured schema for the decision request or response, and no audit log of what the LLM was asked or what it answered.

Proposed:
- Decision request object: `{ type: 'router' | 'condition', nodeId, options: string[], context: string }`
- Decision response schema: `{ decision: string, confidence: number, reasoning: string }`
- LLM is prompted with a structured format (JSON schema or tool-call pattern) instead of freeform text
- Response is validated against the schema before being accepted
- Fallback behavior is explicit: retry once, then use default edge, then fail with descriptive error
- All decisions logged to the workflow event bus for audit trail

### 3.5 Workflow Versioning

**As a workflow author, I want version history for my workflows so that I can roll back to a previous version if an edit introduces a bug.**

**As a developer, I want running executions to use an immutable snapshot of the workflow definition so that edits to the YAML file cannot corrupt an in-flight run.**

Current state: Workflows are plain YAML files with no version tracking. Saving overwrites the previous version. There is no diff, no rollback, and no snapshot for running executions. Editing a production workflow during execution can corrupt the run because the playbook state references the live file.

Proposed:
- Content-hash versioning: each save computes a hash of the workflow content and stores the version
- Version history stored in Postgres: workflow ID, version hash, content snapshot, timestamp, author
- Rollback: restore a previous version by hash
- Diff: compare two versions (structural diff of nodes, edges, trigger config)
- Running executions bind to a specific version hash at start time
- Checkpoint records include the version hash, ensuring resume uses the correct definition

### 3.6 Sub-Agent Result Bus

**As a developer, I want sub-agent results delivered via a message queue so that result collection is decoupled from the orchestrator graph lifecycle and survives restarts reliably.**

Current state: Sub-agent results are collected via in-memory maps (`pendingCompletions`, `pendingFailures`, `pendingEscalations`) on the Graph class. If the orchestrator graph restarts, these maps are empty and results must be drained from `WorkflowPendingCompletionModel` in Postgres. This two-tier approach creates race conditions: a sub-agent may complete between the orchestrator's restart and its drain call, and the result ends up in neither the map nor the database.

Proposed:
- Replace in-memory maps with a persistent message queue (Redis pub/sub or a Postgres-backed queue)
- Sub-agents publish results to the queue keyed by orchestrator execution ID
- Orchestrator subscribes to its execution ID channel and receives results as they arrive
- No in-memory state for pending results — all results flow through the queue
- Dead-letter handling for results that arrive after the orchestrator has finished
- Eliminates the dual-storage race condition entirely

---

## 4. Nice to Have

### 4.1 Visual Workflow Debugger

**As a workflow author, I want to step through workflow execution one node at a time in the UI so that I can understand exactly what happened at each step and diagnose failures.**

Proposed:
- Step-through mode: execute one node, pause, show state, let user continue or abort
- Breakpoints: mark specific nodes as pause points
- State inspector: view playbook state, node outputs, decision context at each step
- Time-travel: scrub backward through completed nodes to see their inputs/outputs
- Integrates with the workflow canvas — current node highlighted, state panel alongside

### 4.2 Workflow Templates and Marketplace

**As a workflow author, I want pre-built workflow templates for common automation patterns so that I can start from a working example instead of building from scratch.**

Proposed:
- Template library: curated collection of workflow YAMLs for common patterns (data processing, report generation, monitoring, notification chains)
- One-click import: copy a template into the draft directory
- Template parameterization: templates define placeholders that the user fills in before first run
- Community marketplace: share and discover workflows (future — requires infrastructure)

### 4.3 Workflow Analytics

**As a workflow author, I want execution analytics per workflow and per node so that I can identify bottlenecks, failure hotspots, and optimization opportunities.**

Proposed:
- Execution time tracking per node (start time, end time, duration)
- Failure rate per node (failed / total executions)
- Workflow-level metrics: total execution time, success rate, average iterations for loop nodes
- Dashboard in the workflow editor showing recent execution history and aggregate stats
- Alerting: notify when a workflow's failure rate exceeds a threshold

### 4.4 Conditional Retry Policies

**As a workflow author, I want configurable retry policies per node so that transient failures (API timeouts, rate limits) are handled automatically without failing the entire workflow.**

Proposed:
- Per-node retry configuration: max retries, backoff strategy (fixed, exponential), retry conditions (error type matching)
- Retry state tracked in playbook state and checkpointed
- Distinct from loop nodes — retries are transparent error recovery, not business logic iteration
- Default policy: no retry (current behavior preserved)

### 4.5 Webhook Trigger Type

**As a workflow author, I want webhook triggers so that external systems can activate my workflows via HTTP POST.**

Proposed:
- Webhook trigger node generates a unique URL per workflow
- Incoming HTTP POST to the URL activates the workflow with the request body as input
- Authentication: shared secret or HMAC signature verification
- URL management in the workflow editor (copy URL, regenerate, enable/disable)

### 4.6 Approval Gates

**As a workflow author, I want approval gate nodes that pause execution and require explicit human approval before proceeding so that high-risk operations have a manual checkpoint.**

Proposed:
- Approval gate node pauses execution and notifies designated approvers
- Approvers can approve, reject, or request changes via the UI or a notification link
- Timeout with configurable behavior: auto-approve, auto-reject, or escalate
- Audit trail: who approved, when, with what comment
- Different from user-input — approval gates are about authorization, not data collection

### 4.7 Workflow Import/Export

**As a workflow author, I want to export workflows as portable packages and import them on another Sulla instance so that I can share automations across machines.**

Proposed:
- Export: bundle workflow YAML with referenced sub-workflows and agent configurations into a single archive
- Import: validate and unpack the archive into the draft directory
- Dependency resolution: warn if required agents, tools, or integrations are not available on the target instance
- Version compatibility check: ensure the workflow format is compatible with the target Sulla version

---

## 5. Non-Goals

The following are explicitly out of scope for this PRD:

- **Agent Graph refactoring** — The simple agent loop (InputHandler → AgentNode), LLM calling, tool execution, streaming, and outcome extraction are covered by the Agent Graph System PRD.
- **n8n internal architecture** — How n8n itself works is external. This PRD covers only the integration surface (REST API and WebSocket bridge).
- **Workflow canvas UI implementation** — Visual editor rendering, drag-and-drop, node palette, and canvas interactions are covered by the Tab UI System PRD.
- **OpenClaw** — Per project policy, the `openclaw/` directory is off-limits.
- **New LLM provider integrations** — Provider abstraction is handled by the Agent Graph System.

---

## 6. Migration Strategy

The Should Have improvements (sections 3.1-3.6) should be implemented incrementally:

1. **Phase 1: Runtime State Separation (3.3)** — Move execution state out of YAML files into Postgres. This is the highest-priority fix because it eliminates data corruption risk. YAML files become definition-only. Risk: Medium (requires migrating all state read/write paths).

2. **Phase 2: WorkflowExecutionEngine (3.1)** — Extract all playbook processing code from Graph.ts into a dedicated `WorkflowExecutionEngine` class. Graph.ts delegates to the engine when a workflow is active. No behavioral changes. Risk: Medium (large refactor but no logic changes).

3. **Phase 3: Workflow Event Bus (3.2)** — Create the event bus, migrate all direct WebSocket calls to use it. Add logging and checkpoint middleware. Risk: Low (additive — existing behavior preserved, new capabilities added).

4. **Phase 4: Structured Decision Protocol (3.4)** — Replace freeform text decision parsing with typed JSON schemas. Deploy alongside existing parsing initially (validate both, use structured if available). Risk: Medium (LLM response format change requires testing across providers).

5. **Phase 5: Sub-Agent Result Bus (3.6)** — Replace in-memory maps with Redis/Postgres queue. Deploy alongside existing maps initially (write to both, read from queue). Risk: Medium (concurrency-sensitive change).

6. **Phase 6: Workflow Versioning (3.5)** — Add version tracking to workflow save operations. Bind running executions to version snapshots. Risk: Low (additive — no existing behavior changes).

Each phase should be on its own branch with a passing build before merge.

---

## 7. Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Graph.ts workflow-related lines | ~800 (of 2859 total) | 0 (moved to WorkflowExecutionEngine) |
| Files with workflow event emission logic | 1 (Graph.ts, scattered) | 1 (WorkflowEventBus) |
| YAML files mutated at runtime | All running workflows | 0 |
| Decision parsing failures (silent fallthrough) | Unknown (no logging) | 0 (structured protocol with validation) |
| Sub-agent result loss on restart | Possible (race condition) | 0 (queue-based delivery) |
| Workflow version rollback capability | None | Full history with one-click rollback |
| Time to understand workflow execution code | ~60 min (reading Graph.ts + WorkflowPlaybook.ts + models) | ~15 min (reading WorkflowExecutionEngine) |
