# PRD: Agent Graph System

**Status:** Draft
**Date:** 2026-03-20
**Author:** Engineering
**Scope:** Backend engine that processes user messages through a node-based pipeline, calls LLMs, executes tools, and delivers responses to the UI via WebSocket.

---

## 1. Overview

The Agent Graph System is the core runtime of Sulla Desktop. It receives user messages over WebSocket, routes them through a DAG of processing nodes (InputHandlerNode, AgentNode, HeartbeatNode), calls LLMs with provider abstraction, executes tools, extracts protocol tags (`<speak>`, `<thinking>`, `<AGENT_DONE>`, `<AGENT_BLOCKED>`, `<AGENT_CONTINUE>`), and streams responses back to the frontend.

### Data Flow

```
User message
  → WebSocket (port 30118)
    → Graph.execute()
      → InputHandlerNode (sanitize, rate-limit, summarize, budget-enforce)
        → AgentNode (build system prompt, call LLM, execute tools, extract outcome)
          → LLM response (streaming tokens)
            → Extract <thinking> → dispatch as 'thinking' kind to UI
            → Extract <speak> → dispatch as 'speak_dispatch' for TTS
            → no you're not out there carry your food and then come back in following me around begging me to go eat it much on these → dispatch as 'assistant' kind to UI
              → Tool calls → execute → emit tool_call/tool_result events → feed results back to LLM
                → Outcome extraction (AGENT_DONE / AGENT_BLOCKED / AGENT_CONTINUE)
                  → Graph loop or terminate
                    → 'graph_execution_complete' signal → WebSocket → UI
```

### Key Files

| File | Lines | Responsibility |
|------|-------|----------------|
| `pkg/rancher-desktop/agent/nodes/Graph.ts` | ~2859 | LangGraph-style DAG executor, playbook orchestration, sub-agent tracking, conversation/training logging, graph lifecycle |
| `pkg/rancher-desktop/agent/nodes/BaseNode.ts` | ~2542 | Abstract base class: LLM calling, WebSocket dispatch, tool execution, speak/thinking extraction, streaming, prompt enrichment, training data, message budget |
| `pkg/rancher-desktop/agent/nodes/AgentNode.ts` | ~631 | Main agent node: system prompt assembly, voice mode handling, outcome extraction (DONE/BLOCKED/CONTINUE), tool execution orchestration |
| `pkg/rancher-desktop/agent/nodes/InputHandlerNode.ts` | ~416 | Input sanitization, rate-limiting, conversation batch summarization, token budget enforcement |
| `pkg/rancher-desktop/agent/nodes/HeartbeatNode.ts` | ~348 | Background task orchestrator: scans heartbeat-triggered workflows, spawns sub-agent graphs |
| `pkg/rancher-desktop/agent/nodes/StreamBufferManager.ts` | ~290 | Buffers partial speech transcripts, detects pauses, manages serverless handoffs |
| `pkg/rancher-desktop/agent/nodes/ThreadStateStore.ts` | ~191 | Thread state persistence (Redis with in-memory fallback) |
| `pkg/rancher-desktop/agent/services/WebSocketClientService.ts` | - | WebSocket connection management, hub readiness gate, channel multiplexing |

### Services (30+)

AbortService, ActiveAgentsRegistry, BackendGraphWebSocketService, CalendarClient, ConversationLogger, ConversationSummaryService, ExtensionService, FrontendGraphWebSocketService, GraphRegistry, HeartbeatService, HumanHeartbeatBridge, HumanPresenceTracker, IntegrationService, JsonParseService, LlamaCppService, N8nBridgeService, N8nService, N8nVueBridgeService, OAuthCallbackServer, OAuthService, ObservationalSummaryService, PlaywrightClient, ProjectService, SchedulerService, SkillService, TextToSpeechService, TrainingDataLogger, TrainingDataPreprocessor, TrainingQueueWorker, TranscriptionService, WebSocketClientService, WorkflowSchedulerService.

### Graph Types

| Graph | Factory | Topology | Purpose |
|-------|---------|----------|---------|
| AgentGraph | `createAgentGraph()` | InputHandler → Agent (loop until DONE/BLOCKED) | Primary user-facing conversation |
| HeartbeatGraph | `createHeartbeatGraph()` | InputHandler → Heartbeat (loop until all workflows done) | Background workflow execution |

### Thread State

All graphs share `BaseThreadState` which carries:
- `messages: ChatMessage[]` — the conversation thread
- `metadata.threadId` — unique thread identifier
- `metadata.wsChannel` — WebSocket channel for dispatch
- `metadata.conversationId` — conversation logger session ID
- `metadata.cycleComplete` / `metadata.waitingForUser` — loop control flags
- `metadata.isSubAgent` / `metadata.subAgentDepth` — nesting context
- `metadata.activeWorkflow` — workflow playbook state (when orchestrating)
- `metadata.options.abort` — abort controller for cancellation
- `metadata.agent` — agent-specific runtime state (status, blocker, response)

---

## 2. Must Have (Existing Features That Must Continue Working)

These features exist today and must remain functional through any refactor.

### 2.1 Message Processing Pipeline

**As a user, I want my messages sanitized and rate-limited before they reach the LLM so that prompt injection attacks are blocked and spam does not overwhelm the system.**

Current implementation (InputHandlerNode.ts):
- Input sanitization: strips Unicode control characters, detects prompt injection patterns (e.g., "ignore all previous instructions", ChatML injection, Llama-style injection)
- Rate-limiting: per-thread burst detection (12 messages in 10 seconds = abuse), minimum 400ms between messages
- Message length enforcement: minimum 1 character, maximum 100,000 characters with truncation
- All checks are heuristic-first (no LLM calls except for summarization)

### 2.2 Conversation Summarization and Token Budget

**As a user, I want my long conversations to continue working without errors even after hundreds of messages, because the system compresses old messages into observational memory format.**

Current implementation (InputHandlerNode.ts):
- Rolling window: MAX_WINDOW_SIZE = 80 messages
- Batch summarization: when hitting max window, oldest 25% are compressed via LLM into observational memory entries (priority-tagged facts)
- Token budget ceiling: 96,000 tokens (estimated at 4 chars/token)
- Hard ceiling fallback: fast character-weight trimming that preserves system messages and the latest user message
- Summaries stored on `state.metadata.conversationSummaries` and appended as a special `_conversationSummary` message
- Tool call/result pairs are kept together during eviction (BaseNode.buildToolPairMap)

### 2.3 LLM Calling with Provider Abstraction

**As a user, I want to switch between OpenAI, Anthropic, Ollama, and other providers without losing any functionality, because the system abstracts provider differences behind a unified interface.**

Current implementation (BaseNode.normalizedChat):
- Provider abstraction via `BaseLanguageModel` interface with `ChatMessage` and `NormalizedResponse` types
- Primary/secondary model failover: if the primary model fails, automatically retries on the secondary
- Input budget enforcement: trims messages if total tokens exceed model's input limit (preserves system messages and latest user)
- Tool schema generation: converts `toolRegistry` entries to provider-specific tool schemas
- Tool access policy: per-agent allowlists for tool names and categories, with sub-agent restrictions
- Abort signal propagation: `throwIfAborted()` checked before and after LLM calls

### 2.4 Streaming Response Display

**As a user, I want to see the AI's response appear word-by-word as it is generated so that I know the system is working and I can read along.**

Current implementation (BaseNode.callLLMStreaming):
- Token-by-token streaming via `StreamCallbacks.onToken`
- Throttled dispatch: stream content flushed to WebSocket every 80ms (STREAM_THROTTLE_MS)
- Protocol tag stripping during stream: `<speak>`, `<thinking>`, `<AGENT_DONE>`, `<AGENT_BLOCKED>`, `<AGENT_CONTINUE>` tags are stripped before dispatch so raw XML never appears in the UI
- Content buffer tracks full response for post-completion processing
- Dispatched via `wsChatMessage()` with kind='streaming'

### 2.5 Thinking/Reasoning Display

**As a user, I want to see the AI's reasoning process in a collapsible thinking section so that I can understand why it made certain decisions.**

Current implementation (BaseNode.extractAndDispatchThinking):
- Source 1: `reply.metadata.reasoning` — Anthropic extended thinking / reasoning blocks (native provider support)
- Source 2: `<thinking>...</thinking>` tags in `reply.content` — other providers that use XML tags
- Extracted content dispatched via `wsChatMessage()` with kind='thinking'
- Tags stripped from `reply.content` in-place so they do not appear in the chat response
- In voice mode, thinking is extracted during streaming; in text mode, post-completion

### 2.6 Speak Tag Extraction for TTS (Voice Mode)

**As a user, I want my voice responses to only include `<speak>` tagged content so that Sulla does not read her internal thoughts aloud.**

Current implementation (BaseNode.callLLMStreaming + extractAndDispatchSpeakTags):
- **Voice mode (streaming):** Progressive `<speak>` tag detection during token streaming. Content between `<speak>` and `</speak>` is buffered and dispatched sentence-by-sentence via `wsSpeakDispatch()` for real-time TTS playback. Sentence boundary detection uses regex with abbreviation awareness (Dr., Mr., etc.).
- **Non-voice mode (post-completion):** `extractAndDispatchSpeakTags()` extracts all `<speak>` content from the final response and dispatches it as a single speak event.
- **Secretary/intake mode:** Thinking is extracted but speak tags are stripped (these modes are silent).
- Speak dispatch uses a dedicated `speak_dispatch` WebSocket event type, separate from chat messages.
- Safety: if kind='speak' leaks into `wsChatMessage()`, it is redirected to `wsSpeakDispatch()`.
- All `<speak>` tags are stripped from `reply.content` after extraction so they do not display in chat.

### 2.7 Tool Execution with Progress Cards

**As a user, I want to see which tools the AI is using and their results as interactive cards in the chat, so that I can follow along with the AI's work.**

Current implementation (BaseNode.executeToolCalls + processPendingToolCalls):
- Tool registry lookup: `toolRegistry.getTool(toolName)` resolves tool instances
- Pre-execution events: `emitToolCallEvent()` dispatches a 'tool_call' WebSocket event with tool name, arguments, and a unique callId — UI renders a "running" progress card
- Post-execution events: `emitToolResultEvent()` dispatches a 'tool_result' event with success/failure, result content, and execution time — UI updates the card
- Tool access policy enforcement: per-agent tool allowlists, category restrictions, sub-agent tool filtering
- Deduplication: `buildToolRunDedupeKey()` prevents re-running identical tool calls within the same conversation
- Structured tool run records persisted to `state.metadata.__toolRuns` for audit trail
- Conversation logging: tool calls and results logged via ConversationLogger
- Training data capture: tool calls logged for fine-tuning data generation
- Results appended to conversation as tool_result messages for LLM context

### 2.8 Graph Abort/Stop (User Cancel)

**As a user, I want to stop the AI mid-response by clicking a stop button, and have it halt immediately without finishing the current tool or LLM call.**

Current implementation (AbortService + throwIfAborted):
- `AbortService` provides per-thread abort signals stored on `state.metadata.options.abort`
- `throwIfAborted()` is called at multiple checkpoints: before LLM calls, after LLM calls, before each tool execution, and in the graph main loop
- Abort during streaming: LLM streaming callbacks check the signal
- Abort during tool execution: checked before each tool in the batch
- Graph catch block: AbortError sets `waitingForUser=true` and `cycleComplete=true`, then sends `graph_execution_complete` with abort status
- Graph.destroy() cleans up node resources

### 2.9 Conversation Logging

**As a developer, I want every conversation persisted with full message history, tool calls, and graph lifecycle events so that I can debug issues and review past interactions.**

Current implementation (ConversationLogger service):
- `logGraphStarted()` — records agent name, channel, parent conversation ID
- `logMessage()` — records each user/assistant message (excludes thinking and streaming kinds)
- `logToolCall()` — records tool name, arguments, and results
- `logGraphCompleted()` — records final status (completed, aborted, failed, max_iterations, max_loops)
- Conversation ID propagated through `state.metadata.conversationId`
- Parent conversation tracking via `state.metadata.parentConversationId`

### 2.10 Training Data Capture

**As a developer, I want automatic fine-tuning data generation from real conversations so that I can train custom models on Sulla's actual usage patterns.**

Current implementation (TrainingDataLogger service):
- `startSession()` — begins a training data session tied to a conversation ID
- `logSystemPrompt()` — captures the full assembled system prompt (once per session)
- `logTrainingTurn()` — captures user message, assistant response, and tool calls as a training example
- `endSession()` — finalizes the session
- Sessions are tied to conversation IDs; system prompt is only logged once per session
- Training data is post-processed by TrainingDataPreprocessor and queued by TrainingQueueWorker

### 2.11 Observational Memory

**As a user, I want Sulla to remember important facts, preferences, and decisions from past conversations without me repeating them, because the system extracts and stores observational memories.**

Current implementation (ObservationalSummaryService + enrichPrompt):
- Observational memories are priority-tagged facts (Critical/Valuable/Low) stored in SullaSettingsModel
- During prompt enrichment (`enrichPrompt()`), recent observations are injected into the system prompt as awareness context
- Memories are generated from: conversation batch summarization (InputHandlerNode), explicit `add_observational_memory` tool calls, and conversation summary service
- Agent config can opt out of observation injection (`injectObservations: false`)
- SOP for observation creation is defined in `OBSERVATIONAL_MEMORY_SOP` constant

### 2.12 Sub-Agent Orchestration

**As a user, I want Sulla to delegate complex tasks to specialized sub-agents that run in the background without blocking the main conversation.**

Current implementation (HeartbeatNode + Graph playbook system):
- HeartbeatNode scans `~/sulla/workflows/production/` for workflows with heartbeat triggers
- Each workflow is executed by spawning a fresh AgentGraph as a sub-agent (`isSubAgent=true`)
- Sub-agent depth tracking prevents infinite nesting (`subAgentDepth`)
- Playbook system in Graph.ts: DAG walker that processes workflow nodes (router, condition, sub-agent) and re-enters the agent loop for decisions
- Non-blocking sub-agent tracking: `pendingSubAgents`, `pendingCompletions`, `pendingFailures`, `pendingEscalations` maps
- Persisted completion records survive Graph restarts (WorkflowPendingCompletionModel)
- `<PROMPT>` tag parsing for agent delegation in orchestrator responses
- `<AGENT_DONE>` parsing extracts summary and "Needs user input" flag from sub-agent output

### 2.13 Thread Management

**As a user, I want to have multiple independent conversation threads and resume previous ones, so that I can work on different tasks without losing context.**

Current implementation (ThreadStateStore + GraphRegistry):
- Thread state persistence via Redis (with in-memory fallback for development)
- `saveThreadState()` — deep-clones and saves state with 1-hour TTL
- `loadThreadState()` — restores state from Redis or memory
- `deleteThreadState()` — cleanup
- ThreadId carried on `state.metadata.threadId` and used for WebSocket routing
- GraphRegistry tracks active graph instances by thread/channel

### 2.14 System Prompt Assembly

**As a developer, I want the system prompt to be modular and composable so that different agents can have different personalities, tool access, and context without code changes.**

Current implementation (BaseNode.enrichPrompt + AgentNode):
- Soul prompt: loaded from SullaSettingsModel (`soulPrompt` field), prefixed with bot name and user name
- Agent prompt files: per-agent `.md` files loaded from `~/sulla/agents/{agentId}/`, cached with 30s TTL
- Template variable substitution: `{{botName}}`, `{{primaryUserName}}`, `{{formattedTime}}`, `{{skills_index}}`, `{{tool_categories}}`, `{{installed_extensions}}`, etc.
- Environment prompt: system capabilities, integrations index, active extensions
- Awareness injection: observational memories, conversation summaries
- Voice mode prompts: VOICE_MODE_PROMPT, SECRETARY_MODE_PROMPT, INTAKE_MODE_PROMPT appended when input source is microphone
- Channel awareness: active agents registry context block
- Trust level enforcement: different prompt blocks for trusted/untrusted/verify users
- Integration index: filtered by agent allowlist, shows connected status and available endpoints
- Workflow index: scoped or full workflow listing

### 2.15 Outcome Extraction

**As a developer, I want the agent's completion status (DONE, BLOCKED, CONTINUE) parsed reliably from every LLM response so that the graph loop can make correct routing decisions.**

Current implementation (AgentNode.extractAgentOutcome):
- XML regex parsing: `<AGENT_DONE>`, `<AGENT_BLOCKED>`, `<AGENT_CONTINUE>` wrapper blocks
- BLOCKED extracts: `<BLOCKER_REASON>` and `<UNBLOCK_REQUIREMENTS>` sub-tags
- CONTINUE extracts: `<STATUS_REPORT>` sub-tag
- DONE extracts: summary text and "Needs user input: yes/no" flag
- Outcome stored on `state.metadata.agent` (status, status_report, blocker_reason, unblock_requirements, response)
- `cycleComplete` set to true on DONE or BLOCKED
- BLOCKED + primary agent sets `waitingForUser=true`; BLOCKED + sub-agent defers to orchestrator
- User-visible text is stripped of wrapper XML before dispatch

### 2.16 Graph Execution Loop

**As a developer, I want the graph executor to be a generic DAG runner that supports static edges, conditional edges, loop safety, and abort handling so that any node topology can be expressed.**

Current implementation (Graph.execute):
- Generic `Graph<TState>` class parameterized by state type
- Fluent builder API: `addNode()`, `addEdge()`, `addConditionalEdge()`, `setEntryPoint()`, `setEndPoints()`
- Main loop: iterates nodes, resolves next via `resolveNext()` (handles static edges, conditional edge functions, decision types: end/goto/continue/next/revise)
- Loop safety: `MAX_CONSECUTIVE_LOOP = 40` — forces end or critic review after 40 same-node iterations
- Abort checking: `throwIfAborted()` after every node execution
- Event loop yielding: `await new Promise(r => setTimeout(r, 0))` between iterations
- Completion signal: `transfer_data` with `graph_execution_complete` dispatched via WebSocket on exit
- Playbook integration: `processWorkflowPlaybook()` called after agent cycle for workflow DAG walking

---

## 3. Should Have (Improvements Needed)

These are architectural improvements that address the complexity and maintainability problems documented below. They do not add new user-facing features but make the existing system more reliable, debuggable, and extensible.

### Problem Summary

1. **BaseNode is a God Class** (~2542 lines) handling LLM calls, WebSocket dispatch, tool execution, speak extraction, thinking extraction, streaming, training data, prompt enrichment, message budget, and conversation logging. Violates Single Responsibility Principle.
2. **No separation between LLM response processing and delivery** — speak tag extraction, thinking extraction, streaming dispatch, and final message delivery are interleaved in `callLLMStreaming()` and `normalizedChat()`.
3. **Implicit message typing** — WebSocket messages use string `type` and `kind` fields with no schema validation. A wrong kind = silent failure.
4. **No central message bus** — Each node calls `dispatchToWebSocket()` directly. No centralized routing, no middleware, no audit trail.
5. **Tool execution mixed into node classes** — Tool registry, execution, progress reporting, deduplication, access policy, and result formatting are spread across BaseNode and AgentNode.

### 3.1 SpeakExtractor Class

**As a developer, I want speak extraction in its own class so that when TTS speaks wrong content, I can look at one file to find the bug.**

**As a user, I want voice responses to be reliable and never include internal reasoning, XML tags, or tool output in the spoken audio.**

Current state: Speak logic is spread across ~200 lines in BaseNode — `callLLMStreaming()` (progressive speak tag detection, sentence boundary detection, abbreviation handling), `extractAndDispatchSpeakTags()` (post-completion extraction), `wsSpeakDispatch()` (WebSocket dispatch), and `tryDispatchSentence()` (sentence splitting). These methods share mutable state (`speakBuffer`, `insideSpeakTag`, `sentenceBuffer`, `spokenSentences`) via closure variables in the streaming callback.

Proposed: A `SpeakExtractor` class with:
- `feedToken(token: string)` — called during streaming, returns `{ speakContent?: string, chatContent?: string }`
- `flush(): string[]` — returns any remaining buffered speak content
- `extractFromComplete(content: string): { speakContent: string[], cleanedContent: string }` — post-completion extraction
- All sentence boundary logic, abbreviation lists, and speak buffer state encapsulated
- Clear input/output contract: raw tokens in, separated speak/chat content out

### 3.2 ThinkingExtractor Class

**As a developer, I want thinking extraction in its own class so that when reasoning content leaks into chat or speak, I can trace exactly where the extraction failed.**

**As a user, I want the thinking section to always show the full reasoning and never have it mixed into the chat response.**

Current state: Thinking logic in `extractAndDispatchThinking()` (~40 lines) handles two sources (metadata.reasoning and `<thinking>` tags) and mutates `reply.content` in-place. Simple today but tightly coupled to NormalizedResponse structure and WebSocket dispatch.

Proposed: A `ThinkingExtractor` class with:
- `extract(content: string, metadata: { reasoning?: string }): { thinkingContent: string, cleanedContent: string }`
- No side effects — returns extracted thinking and cleaned content
- Caller decides how to dispatch

### 3.3 MessageDispatcher

**As a developer, I want a central message dispatcher so that I can see every WebSocket message in one place, validate its schema, and add middleware (logging, filtering, rate-limiting) without touching every node.**

**As a user, I want consistent message formatting so that thinking always appears in the thinking panel, speak always goes to TTS, and chat always appears in the chat panel — no cross-contamination.**

Current state: `dispatchToWebSocket()`, `wsChatMessage()`, `wsSpeakDispatch()`, `emitToolCallEvent()`, `emitToolResultEvent()` are all separate methods on BaseNode (~300 lines combined). Each constructs its own message payload with different shapes. The `kind` field is an unvalidated string. Speak-kind messages that leak into `wsChatMessage()` are caught by a runtime guard that redirects to `wsSpeakDispatch()`.

Proposed: A `MessageDispatcher` service with:
- Typed message constructors: `MessageDispatcher.chat()`, `MessageDispatcher.thinking()`, `MessageDispatcher.speak()`, `MessageDispatcher.toolCall()`, `MessageDispatcher.toolResult()`, `MessageDispatcher.graphComplete()`
- Schema validation at dispatch time — wrong message shapes throw immediately with a descriptive error
- Middleware pipeline: logging middleware (replaces scattered console.log calls), conversation logging middleware, training data middleware
- Single `dispatch(channel, message)` method that all paths go through
- Message type enum instead of raw strings

### 3.4 ToolExecutor Service

**As a developer, I want tool execution in a dedicated service so that adding a new tool does not require reading 2500 lines of BaseNode to understand the execution lifecycle.**

**As a user, I want tool execution to be reliable with clear error messages when a tool fails, and progress cards that accurately reflect what is happening.**

Current state: Tool execution spans ~250 lines in BaseNode (`executeToolCalls()`, `processPendingToolCalls()`, `getToolPolicyBlockReason()`, `appendToolResultMessage()`, `buildToolRunDedupeKey()`, `persistStructuredToolRunRecord()`). Access policy checking is split between `normalizedChat()` (LLM tool schema filtering) and `executeToolCalls()` (runtime policy check). Deduplication logic uses a custom stable-stringify + hash approach.

Proposed: A `ToolExecutor` service with:
- `execute(toolCalls, state, options): Promise<ToolResult[]>` — single entry point
- Encapsulates: access policy checking, deduplication, progress event emission, result formatting, error handling, conversation logging, training data capture
- Tool run lifecycle hooks: `onToolStart`, `onToolComplete`, `onToolError` — nodes subscribe to events instead of calling emit methods
- Clear separation from LLM integration — ToolExecutor does not know about LLM providers

### 3.5 Response Pipeline

**As a developer, I want LLM response processing to be a linear pipeline of discrete steps so that I can test each step in isolation and understand the transformation chain.**

Current state: Response processing is split between `callLLMStreaming()` (streaming path with interleaved speak/thinking extraction) and the post-streaming code in `normalizedChat()` (non-voice thinking/speak extraction, tag stripping). The voice vs. non-voice branching creates two parallel code paths that diverge significantly.

Proposed: A response pipeline with explicit stages:
1. **Raw LLM response** — content string + metadata (reasoning, tool_calls)
2. **Extract thinking** → `{ thinkingContent, remainingContent }`
3. **Extract speak** → `{ speakContent[], remainingContent }`
4. **Extract outcome** → `{ status, statusReport, blockerReason, ... }`
5. **Strip protocol tags** → cleaned user-visible content
6. **Dispatch** → send thinking, speak, chat, and outcome via MessageDispatcher

Each stage is a pure function (except dispatch). Streaming mode runs stages 2-3 incrementally during token arrival; non-streaming mode runs them post-completion. The stage interfaces are the same either way.

### 3.6 Message Schema Validation

**As a developer, I want runtime type checking on WebSocket messages so that when a message has the wrong shape, the error tells me exactly what field is wrong and where it was dispatched from, instead of silently failing.**

Current state: `WebSocketMessage` interface has `type: string` and `data: unknown`. The `kind` field used by chat messages (e.g., 'assistant', 'thinking', 'streaming', 'speak', 'agent_result', 'agent_error') is not part of any type definition — it lives inside the `data` payload as an untyped property. No runtime validation.

Proposed:
- Message type enum: `GraphMessageType.CHAT`, `GraphMessageType.THINKING`, `GraphMessageType.SPEAK_DISPATCH`, `GraphMessageType.TOOL_CALL`, `GraphMessageType.TOOL_RESULT`, `GraphMessageType.GRAPH_COMPLETE`, etc.
- Message kind enum: `ChatKind.ASSISTANT`, `ChatKind.THINKING`, `ChatKind.STREAMING`, `ChatKind.AGENT_RESULT`, `ChatKind.AGENT_ERROR`
- Zod or similar runtime validation schemas for each message type
- Validation runs at dispatch time in MessageDispatcher — invalid messages throw with full context (message type, payload, call site)
- Frontend receives typed messages and can exhaustively switch on type/kind

---

## 4. Nice to Have

### 4.1 Plugin Architecture for Node Types

**As a developer, I want to add new node types (e.g., a CodeReviewNode, a RAGNode) by dropping a file into a directory without modifying Graph.ts or any factory function.**

Proposed:
- Node discovery: scan a `nodes/` directory for files exporting classes that implement `GraphNode<T>`
- Node registration via decorator or static metadata: `@GraphNodePlugin({ id: 'code_review', name: 'Code Review' })`
- Graph builder accepts node IDs by string reference, resolves from plugin registry
- Enables third-party node development without core changes

### 4.2 Message Replay/Debugging Tools

**As a developer, I want to replay a conversation's WebSocket messages in sequence so that I can reproduce bugs without needing a user to re-trigger the issue.**

Proposed:
- MessageDispatcher logs all dispatched messages to a replay log (JSONL format) with timestamps
- CLI tool or dev panel: `sulla replay --conversation-id <id>` — replays all messages to a WebSocket client in original timing
- Filterable by message type (e.g., replay only tool calls, replay only speak dispatches)
- Enables deterministic bug reproduction for speak/thinking/streaming issues

### 4.3 Graph Visualization in Dev Mode

**As a developer, I want to see a visual representation of the graph topology, current node, and edge conditions in the Sulla UI dev panel so that I can understand execution flow at a glance.**

Proposed:
- Graph emits topology metadata: nodes, edges, current node ID, iteration count
- Dev panel renders a simple DAG visualization (nodes as boxes, edges as arrows, current node highlighted)
- Live updates as the graph executes — current node pulses, completed nodes dim
- Shows metadata.agent.status, cycle count, and last decision type

### 4.4 Automated Testing for the Full Pipeline

**As a developer, I want end-to-end tests that send a user message through the full graph pipeline and assert on the WebSocket messages emitted, so that refactors do not break the user experience.**

Proposed:
- Test harness: mock LLM provider that returns deterministic responses (with configurable speak/thinking tags, tool calls, outcomes)
- Mock WebSocket collector that captures all dispatched messages in order
- Test cases for:
  - Basic chat: message in → assistant response out
  - Voice mode: message in → speak dispatch + cleaned chat out
  - Tool execution: message in → tool_call event → tool_result event → assistant response
  - Abort: message in → abort signal → graph_execution_complete with abort status
  - Rate limiting: rapid messages → rate limit error
  - Token budget: long conversation → summarization → continued operation
  - Outcome extraction: DONE/BLOCKED/CONTINUE responses → correct graph routing

---

## 5. Non-Goals

The following are explicitly out of scope for this PRD:

- **Frontend/UI changes** — This PRD covers the backend graph engine only. Frontend rendering of messages, tool cards, thinking panels, etc. is a separate concern.
- **New LLM provider integrations** — Adding new providers (e.g., Google Gemini) is a separate effort. This PRD assumes the existing `BaseLanguageModel` abstraction is sufficient.
- **Workflow definition format changes** — The YAML workflow definition format and playbook walker logic are covered by a separate PRD.
- **Database schema changes** — Thread state storage, conversation logging schema, and training data format are stable and not changing.
- **OpenClaw** — Per project policy, the `openclaw/` directory is off-limits.

---

## 6. Migration Strategy

The Should Have improvements (sections 3.1-3.6) should be implemented incrementally to avoid a risky big-bang refactor:

1. **Phase 1: Extract SpeakExtractor and ThinkingExtractor** — Pure extraction with no behavioral changes. BaseNode delegates to the new classes. Existing tests continue passing. Risk: Low.

2. **Phase 2: Extract ToolExecutor** — Move tool execution out of BaseNode into a service. BaseNode calls `toolExecutor.execute()` instead of `this.executeToolCalls()`. Risk: Medium (tool lifecycle events must be preserved exactly).

3. **Phase 3: Introduce MessageDispatcher** — Create the dispatcher, migrate `wsChatMessage()` and `wsSpeakDispatch()` to use it. Add message type/kind enums. Keep old methods as thin wrappers initially. Risk: Medium (WebSocket message format changes could break frontend).

4. **Phase 4: Response Pipeline** — Compose extractors and dispatcher into a linear pipeline. Unify the voice/non-voice code paths. Risk: Medium-High (streaming behavior is subtle).

5. **Phase 5: Message Schema Validation** — Add Zod schemas and validation. Start in warn-only mode, then switch to strict. Risk: Low (additive, no behavioral change until strict mode).

Each phase should be on its own branch with a passing build before merge.

---

## 7. Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| BaseNode.ts line count | ~2542 | < 800 |
| Files with speak-related logic | 1 (BaseNode) | 1 (SpeakExtractor) |
| Files with thinking-related logic | 1 (BaseNode) | 1 (ThinkingExtractor) |
| WebSocket message types with runtime validation | 0 | All |
| Tool execution code locations | 2 (BaseNode + AgentNode) | 1 (ToolExecutor) |
| Time to diagnose a "wrong speak content" bug | ~30 min (reading 2500-line file) | ~5 min (reading SpeakExtractor) |
