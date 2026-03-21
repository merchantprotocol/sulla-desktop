# PRD: Controller + Extractor Architecture

**Status:** Draft
**Date:** 2026-03-20
**Author:** Engineering
**Scope:** Refactor the agent execution pipeline into a layered Controller → Graph architecture where Controllers handle all customization (prompt assembly, tool filtering, response parsing) and Graphs are pure LLM executors.

---

## 1. Problem Statement

The current system has god classes where prompt building, speak extraction, thinking extraction, tool preparation, and response parsing are all tangled inside the graph execution layer:

- **BaseNode.ts** (2,542 lines) — handles prompt enrichment, LLM streaming, speak tag extraction (in-stream and post-stream), thinking extraction, tool execution, sentence splitting, WebSocket dispatch, and training data logging
- **AgentNode.ts** (631 lines) — handles voice mode selection, system prompt assembly, outcome extraction, and DOM streaming — responsibilities that should be split between a controller and the graph
- **Graph.ts** (2,859 lines) — 49% is workflow/playbook code unrelated to graph execution

This tangling means:
- When TTS speaks wrong content, the bug is nearly impossible to trace (speak logic spans 4 methods across 2 files)
- Adding a new extraction mode requires modifying the god class
- Graphs cannot be simplified because they own business logic that belongs in controllers
- Testing any single concern requires instantiating the entire graph stack

---

## 2. Architecture Overview

### Layered Separation

```
┌─────────────────────────────────────────────────────────┐
│  ChatController (top layer)                             │
│  Assembles configs, builds prompts, parses responses    │
│                                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐  │
│  │ AgentConfig  │ │ ToolFilter  │ │ Extractors[]     │  │
│  │ persona,     │ │ allowlist,  │ │ enrichPrompt()   │  │
│  │ settings,    │ │ policy,     │ │ processChunk()   │  │
│  │ mode         │ │ categories  │ │ processComplete()│  │
│  └─────────────┘ └─────────────┘ └──────────────────┘  │
│                                                         │
│  run(userMessage):                                      │
│    1. prompt = buildPrompt(agentConfig)                  │
│    2. prompt = extractors.enrichPrompt(prompt)           │
│    3. tools  = toolFilter.prepare(agentConfig.tools)     │
│    4. response = graph.execute(prompt, msgs, tools,      │
│                                { onChunk })              │
│    5. cleaned = extractors.processComplete(response)     │
│    6. dispatch results to ChatInterface / WebSocket      │
│    7. return cleaned response                            │
│                                                         │
│  onChunk(chunk):  ← streaming callback passed to graph  │
│    chunk = extractors.processChunk(chunk)                │
│    dispatch('streaming', chunk)                          │
└──────────────────────┬──────────────────────────────────┘
                       │ execute(prompt, messages, tools, callbacks)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Graph (bottom layer — pure LLM executor)               │
│                                                         │
│  execute(prompt, messages, tools, callbacks):            │
│    1. Build message array (system + history + user)      │
│    2. Trim to context window budget                      │
│    3. Call LLM streaming                                 │
│    4. Pass each chunk to callbacks.onChunk()             │
│    5. If tool_calls → execute tools → append results     │
│    6. Return raw response { content, metadata }          │
│                                                         │
│  NO awareness of: voice mode, speak tags, thinking tags, │
│  extractors, controllers, agent config, personas         │
└─────────────────────────────────────────────────────────┘
```

### Key Principle

**Controllers assemble and parse. Graphs execute.**

The Graph is a vendor-class — it takes exactly what it's given (prompt, messages, tools), calls the LLM, handles the tool-calling loop, and returns raw output. It makes no decisions about what prompt instructions to include, what tags to extract, or how to dispatch results. All of that is the Controller's job.

---

## 3. The Extractor Interface

Extractors are two-way modules: they modify the prompt going IN to the LLM and clean the response coming OUT. Each extractor can independently dispatch its extracted data to the frontend.

```typescript
interface StreamContext {
  state: BaseThreadState;
  threadId: string;
  channel: string;
  dispatch: (type: string, data: any) => void;
}

interface Extractor {
  readonly name: string;

  /** Modify the system prompt before it goes to the LLM. */
  enrichPrompt(systemPrompt: string, ctx: StreamContext): string;

  /** Process a streaming chunk in real-time. Returns the cleaned chunk. */
  processChunk(chunk: string, ctx: StreamContext): string;

  /** Process the complete response after streaming ends. Returns cleaned text. */
  processComplete(fullText: string, metadata: ResponseMetadata, ctx: StreamContext): string;

  /** Reset internal state between LLM calls (buffers, flags). */
  reset(): void;
}
```

### Design properties

- **Self-contained**: Each extractor knows its own prompt instructions, tag patterns, and dispatch format
- **Composable**: Multiple extractors run in sequence — each receives the output of the previous
- **Independently testable**: Create an extractor with a mock dispatch function, feed it chunks, verify output
- **No reverse dependencies**: Extractors never call back into the Controller or Graph

---

## 4. Concrete Extractors

### 4.1 SpeakExtractor

**Active in:** voice mode
**Prompt injection:** Appends `VOICE_MODE_PROMPT` from `prompts/voiceModes.ts` — instructs the LLM to wrap spoken responses in `<speak>` tags and keep them to 1-3 sentences

**Chunk processing (real-time):**
- Detects `<speak>` tag open/close in the streaming chunks
- Buffers content between tags
- Splits at sentence boundaries (`. ? !` excluding abbreviations like Dr., Mr.)
- Dispatches each complete sentence immediately via `dispatch('speak_dispatch', { text })` — enables TTS to start playing while the LLM is still generating
- Returns the chunk with speak content stripped so it doesn't appear in the chat UI

**Complete processing:**
- Flushes any remaining speak buffer
- Strips all `<speak>` tags from final content
- Returns cleaned text

**Moves from:**
- `BaseNode.callLLMStreaming()` onToken speak extraction (lines 1455-1509)
- `BaseNode.tryDispatchSentence()` (lines 1543-1601)
- `BaseNode.extractAndDispatchSpeakTags()` (lines 1644-1666)
- `BaseNode.wsSpeakDispatch()` (lines 1897-1928)
- `ABBREVIATIONS` set

**User stories:**
- As a user in voice mode, I hear TTS responses sentence-by-sentence with low latency because speak extraction happens during streaming
- As a developer, I can test SpeakExtractor in isolation: feed it chunks containing `<speak>` tags and verify it dispatches sentences and returns clean text
- As a developer, I can trace every TTS event to SpeakExtractor because it's the ONLY code that dispatches speak content

### 4.2 ThinkingExtractor

**Active in:** all modes (always on)
**Prompt injection:** None (thinking is natively supported by Anthropic extended thinking, or produced by the LLM via `<thinking>` tags on its own)

**Chunk processing:** None (thinking content arrives as metadata, not in the content stream)

**Complete processing:**
- Extracts `<thinking>` tags from response content
- Extracts Anthropic `metadata.reasoning` (native thinking blocks)
- Combines both sources
- Dispatches as `dispatch('assistant_message', { kind: 'thinking', content })` for the thinking bubble UI
- Strips `<thinking>` tags from content
- Returns cleaned text

**Moves from:**
- `BaseNode.extractAndDispatchThinking()` (lines 1603-1632)

**User stories:**
- As a user, I see the agent's thinking process in a collapsible thinking bubble
- As a developer, I can add thinking support to any new mode by simply including ThinkingExtractor

### 4.3 SecretaryExtractor

**Active in:** secretary mode
**Prompt injection:** Appends `SECRETARY_MODE_PROMPT` from `prompts/voiceModes.ts` — instructs the LLM to silently observe meeting transcripts and extract actions/facts/conclusions in `<secretary_analysis>` XML

**Chunk processing:** None (secretary analysis is post-completion)

**Complete processing:**
- Extracts `<secretary_analysis>` blocks from response
- Parses `<actions>`, `<facts>`, `<conclusions>` sub-tags into structured arrays
- Dispatches structured result via callback
- Strips any accidental `<speak>` tags (safety — secretary mode should not produce speak)
- Returns cleaned text

**Moves from:**
- `VoicePipeline.ts` secretary analysis watcher (lines 140-162)
- `VoicePipeline.ts` `extractListItems()` helper (lines 429-437)

**User stories:**
- As a user in a meeting, I see real-time action items, facts, and conclusions extracted from the conversation
- As a developer, I can test secretary analysis parsing independently

### 4.4 IntakeExtractor

**Active in:** intake mode
**Prompt injection:** Appends `INTAKE_MODE_PROMPT` from `prompts/voiceModes.ts` — instructs the LLM to act as a fast dispatcher, assess actionable items, keep responses to one line max

**Chunk processing:** None
**Complete processing:** Strips any accidental `<speak>` tags (safety)

**Moves from:**
- Voice directive selection in `AgentNode.execute()` (lines 142-157)

---

## 5. ChatController

The ChatController is the top-level orchestrator. It holds the agent configuration, registers extractors based on mode, builds the complete system prompt, prepares the tool list, delegates execution to the graph, and parses the response.

### Mode → Extractor Mapping

| Mode | Extractors Enabled | Prompt Additions |
|------|-------------------|------------------|
| `text` | ThinkingExtractor | None |
| `voice` | ThinkingExtractor, SpeakExtractor | VOICE_MODE_PROMPT |
| `secretary` | ThinkingExtractor, SecretaryExtractor | SECRETARY_MODE_PROMPT |
| `intake` | ThinkingExtractor, IntakeExtractor | INTAKE_MODE_PROMPT |

### Responsibilities

| Responsibility | Currently In | Moves To |
|---|---|---|
| Build system prompt from agent config + persona + environment | `BaseNode.enrichPrompt()` (lines 449-689) | `ChatController.buildPrompt()` |
| Select voice mode directive | `AgentNode.execute()` (lines 139-157) | `ChatController.setMode()` → extractors handle it |
| Prepare tool list from agent allowlist | `BaseNode.normalizedChat()` (lines 1012-1076) | `ChatController.prepareTools()` |
| Filter tools by policy and sub-agent restrictions | `BaseNode.normalizedChat()` (lines 1040-1076) | `ChatController.prepareTools()` |
| Dispatch streaming chunks to frontend | `BaseNode.callLLMStreaming()` onToken (lines 1438-1454) | `ChatController.onChunk()` |
| Extract speak tags and dispatch TTS | `BaseNode` (4 methods, ~170 lines) | `SpeakExtractor` |
| Extract thinking tags and dispatch | `BaseNode.extractAndDispatchThinking()` | `ThinkingExtractor` |
| Post-completion mode-specific processing | `BaseNode.normalizedChat()` (lines 1130-1140) | `ChatController.processComplete()` → runs extractors |

### What ChatController does NOT do

- Call the LLM (Graph does this)
- Execute tools (Graph does this)
- Manage context window budgeting (Graph does this)
- Handle the tool-calling loop (Graph does this)
- Manage WebSocket connections (existing services do this)

---

## 6. Graph Simplification

### Current state

The Graph currently acts as both executor AND controller:
- `BaseNode.normalizedChat()` builds prompts, calls LLM, extracts tags, executes tools, dispatches results — all in one method
- `AgentNode.execute()` selects voice mode, builds agent-specific prompts, extracts outcomes
- `Graph.ts` manages node routing AND contains ~1,400 lines of playbook execution

### Target state

The Graph becomes a pure LLM executor with a clean API:

```typescript
interface GraphExecuteOptions {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  callbacks: {
    onChunk?: (chunk: string) => void;
    onToolCall?: (toolCall: ToolCall) => void;
    onToolResult?: (result: ToolResult) => void;
  };
}

interface GraphResponse {
  content: string;
  metadata: {
    tool_calls?: ToolCall[];
    reasoning?: string;
    finish_reason: string;
    usage?: TokenUsage;
  };
}

// Graph.execute(options): Promise<GraphResponse>
```

**The Graph:**
- Takes exactly what it's given (prompt, messages, tools)
- Calls the LLM with streaming
- Passes each chunk through `callbacks.onChunk()` (doesn't know or care what the callback does)
- If the LLM returns tool_calls → executes them → appends results to messages → can loop back to LLM if configured
- Returns the raw response content and metadata
- Makes NO decisions about what to include in the prompt, what to extract from the response, or how to dispatch results

**The Graph does NOT:**
- Know about voice mode, secretary mode, or any chat modes
- Extract `<speak>`, `<thinking>`, or `<secretary_analysis>` tags
- Inject voice directives or persona instructions
- Filter tools by agent config (it receives the already-filtered list)
- Dispatch to the frontend (the callback handles that)

---

## 7. PlaybookController

**Separate from ChatController.** Owns workflow/playbook execution — the ~1,400 lines currently in Graph.ts that handle step execution, condition evaluation, node orchestration, and sub-agent spawning.

```
PlaybookController
  ├── executePlaybook(playbook, state): Promise<PlaybookResult>
  ├── evaluateCondition(condition, context): boolean
  ├── orchestrateNodes(steps, graph): Promise<StepResult[]>
  └── Takes Graph instance as dependency for node access
```

**Moves from:** Graph.ts playbook code (~1,400 lines)
**Result:** Graph.ts drops from ~2,859 to ~1,450 lines — just graph routing and node management

---

## 8. MessageDispatcher

Replaces the 667-line switch statement in `AgentPersonaModel.ts` with a handler registry.

```typescript
type MessageHandler<T = any> = (data: T, context: DispatchContext) => void;

class MessageDispatcher {
  private handlers = new Map<string, MessageHandler>();

  register<T>(type: string, handler: MessageHandler<T>): void {
    this.handlers.set(type, handler);
  }

  dispatch(message: { type: string; data: any }, context: DispatchContext): boolean {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      console.warn(`[MessageDispatcher] Unknown message type: ${message.type}`);
      return false;
    }
    handler(message.data, context);
    return true;
  }
}
```

Uses TypeScript interfaces for type safety. No Zod.

**User stories:**
- As a developer, I add a new WebSocket message type by registering one handler function — not by adding a case to a 667-line switch
- As a developer, unknown message types are logged instead of silently dropped
- As a developer, each handler is a small testable function

---

## 9. MessageRenderer

Registry mapping message `kind` → Vue render component. Replaces `v-if`/`v-else-if` chains in chat templates.

```typescript
class MessageRenderer {
  private renderers = new Map<string, Component>();

  register(kind: string, component: Component): void {
    this.renderers.set(kind, component);
  }

  resolve(kind: string): Component | undefined {
    return this.renderers.get(kind);
  }
}
```

**User stories:**
- As a developer, I add a new message kind by registering one component — not by modifying template conditionals
- As a developer, the chat template is a single `<component :is="renderer.resolve(msg.kind)" />` line

---

## 10. Must Have / Should Have / Nice to Have

### Must Have (core architecture)

1. **Extractor interface** with `enrichPrompt()`, `processChunk()`, `processComplete()`, `reset()`
2. **SpeakExtractor** — in-stream speak tag extraction with sentence-by-sentence TTS dispatch
3. **ThinkingExtractor** — post-stream thinking tag + Anthropic reasoning extraction
4. **SecretaryExtractor** — post-stream secretary analysis parsing
5. **IntakeExtractor** — intake mode prompt injection
6. **ChatController** — mode-based extractor registration, prompt assembly, tool preparation, response parsing
7. **ChatController.buildPrompt()** — assembles system prompt from agent config + persona + environment + extractor enrichments
8. **ChatController.prepareTools()** — filters tools by agent config allowlist and policy
9. **ChatController.onChunk()** — streaming callback that runs extractors and dispatches to frontend
10. **Graph simplified API** — `execute(prompt, messages, tools, callbacks)` returns raw response
11. **Graph strips speak/thinking extraction** — no tag awareness in graph layer
12. **Graph strips voice mode selection** — no mode awareness in graph layer
13. **Graph strips prompt enrichment** — receives pre-built prompt from controller
14. **PlaybookController** — workflow/playbook execution extracted from Graph.ts
15. **All existing features preserved** — text chat, voice chat, secretary mode, intake mode, tool execution, streaming, barge-in, TTS playback

### Should Have (cleanup and quality)

16. **MessageDispatcher** — handler registry replacing AgentPersonaModel switch statement
17. **MessageRenderer** — kind → component registry replacing template conditionals
18. **Extractor unit tests** — each extractor testable with mock dispatch
19. **Typed tool callback `kind`** — enum instead of raw string, eliminates speak leak vector
20. **ToolExecutor** — extracted from BaseNode, uses typed kinds

### Nice to Have (future extensibility)

21. **Custom extractor registration** — plugins can register new extractors at runtime
22. **Extractor priority/ordering** — configurable execution order
23. **Extractor enable/disable at runtime** — toggle extractors without mode change
24. **Graph provider abstraction** — swap LLM providers without touching controllers
25. **Controller composition** — nest controllers for complex workflows

---

## 11. Implementation Phases

### Phase 1: Extractors (additive, zero risk)

Create the extractor interface and all four concrete extractors as new files. No existing code modified.

| File | Lines | Source |
|------|-------|--------|
| `agent/controllers/Extractor.ts` | ~30 | New interface |
| `agent/controllers/SpeakExtractor.ts` | ~200 | From BaseNode lines 1455-1509, 1543-1601, 1644-1666, 1897-1928 |
| `agent/controllers/ThinkingExtractor.ts` | ~80 | From BaseNode lines 1603-1632 |
| `agent/controllers/SecretaryExtractor.ts` | ~80 | From VoicePipeline lines 140-162, 429-437 |
| `agent/controllers/IntakeExtractor.ts` | ~30 | From AgentNode lines 142-157 |

### Phase 2: ChatController (additive, zero risk)

Create the ChatController as a new file. Wires extractors together, builds prompts, prepares tools.

| File | Lines | Source |
|------|-------|--------|
| `agent/controllers/ChatController.ts` | ~300 | From BaseNode.enrichPrompt, normalizedChat tool prep, AgentNode voice selection |

### Phase 3: Swap (medium risk — the actual integration)

Modify BaseNode and AgentNode to delegate to ChatController. This is where the god classes shrink.

| File | Change |
|------|--------|
| `agent/nodes/BaseNode.ts` | Remove enrichPrompt, speak/thinking extraction, tool filtering. Add ChatController field. callLLMStreaming passes chunks through controller.onChunk(). normalizedChat calls controller.processComplete(). |
| `agent/nodes/AgentNode.ts` | Remove voice directive selection. Set controller.setMode() from metadata. Delegate prompt building to controller. |

### Phase 4: PlaybookController (independent)

Extract playbook execution from Graph.ts.

| File | Change |
|------|--------|
| `agent/controllers/PlaybookController.ts` | ~1,400 lines moved from Graph.ts |
| `agent/nodes/Graph.ts` | Remove playbook code, delegate to PlaybookController |

### Phase 5: MessageDispatcher + MessageRenderer (independent)

| File | Change |
|------|--------|
| `agent/controllers/MessageDispatcher.ts` | ~180 lines, replaces switch in AgentPersonaModel |
| `composables/chat/MessageRenderer.ts` | ~150 lines, replaces template conditionals |
| `models/AgentPersonaModel.ts` | Replace 667-line switch with dispatcher.dispatch() |

---

## 12. File Impact Summary

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `agent/controllers/Extractor.ts` | ~30 | Interface definition |
| `agent/controllers/SpeakExtractor.ts` | ~200 | Speak tag extraction + TTS dispatch |
| `agent/controllers/ThinkingExtractor.ts` | ~80 | Thinking extraction + dispatch |
| `agent/controllers/SecretaryExtractor.ts` | ~80 | Secretary analysis parsing |
| `agent/controllers/IntakeExtractor.ts` | ~30 | Intake mode prompt injection |
| `agent/controllers/ChatController.ts` | ~300 | Top-level orchestrator |
| `agent/controllers/PlaybookController.ts` | ~1,400 | Workflow execution |
| `agent/controllers/MessageDispatcher.ts` | ~180 | Handler registry |
| `composables/chat/MessageRenderer.ts` | ~150 | Render registry |

### Modified Files

| File | Current | After | Reduction |
|------|---------|-------|-----------|
| `agent/nodes/BaseNode.ts` | 2,542 | ~1,800 | -742 |
| `agent/nodes/AgentNode.ts` | 631 | ~500 | -131 |
| `agent/nodes/Graph.ts` | 2,859 | ~1,450 | -1,409 |
| `models/AgentPersonaModel.ts` | 667 | ~200 | -467 |

### Unchanged Files

- Backend services (TranscriptionService, TextToSpeechService)
- IPC handlers (sullaEvents.ts)
- ChatInterface.ts
- Voice OOP services (VoiceRecorderService, TTSPlayerService, VoicePipeline)
- Voice UI components
- Database models
- prompts/voiceModes.ts (extractors import from it)

---

## 13. Verification

1. **Build**: `yarn build` passes after each phase
2. **Text chat**: Send message → verify normal response with thinking bubble (ThinkingExtractor)
3. **Voice mode**: Speak → verify only `<speak>` content is spoken by TTS with low latency (SpeakExtractor)
4. **Secretary mode**: Run meeting transcript → verify actions/facts/conclusions parsed (SecretaryExtractor)
5. **Intake mode**: Stream voice → verify fast dispatch behavior (IntakeExtractor)
6. **Tool execution**: Trigger tool call → verify execution and results display
7. **Workflows**: Run playbook → verify all steps complete (PlaybookController)
8. **Barge-in**: Speak during TTS → verify immediate stop
9. **Streaming**: Verify chat UI shows progressive text during LLM response
10. **Extractor isolation**: Unit test each extractor — feed mock chunks, verify dispatch calls and cleaned output
11. **Graph independence**: Verify Graph has zero imports from controllers/extractors
12. **Logs**: `grep "VOICE:SPEAK"` shows clean source-traced events
