# The Subconscious — recall, memory, and observation

The subconscious middleware recalls context before a primary turn and schedules
observation writers after it. Its source is
`agent/middleware/SubconsciousMiddleware.ts`; graph prompts and tool grants live
in `agent/services/GraphRegistry.ts`.

## Shape of a turn

Pre-turn work is awaited with `Promise.allSettled` before the primary agent
runs. The middleware summarizes history above 30 messages and digests at least
20,000 estimated tokens of stale tool results, protecting the most recent four
assistant turns. Those transformations are separate from memory recall.

When observation injection is enabled and there is analyzable user content,
recall includes memory, prior conversations, related Files references and
installed skills. Team recall uses the current agent identity. A subagent
directory is added for threads with children. These references suggest context;
they do not dispatch work.

Workflow-scoped execution (`workflowNodeId`, `activeWorkflow`, or
`scopedWorkflowId`) skips this pipeline. Recall generally skips turns without
analyzable user text; heartbeat triggers have special handling in that check.

## Pre-turn recall modes

`subconsciousRecallMode` defaults to `ranked`:

- `ranked`: BM25, local Potion embeddings and a logistic-regression ranker,
  returning up to 16 memories per domain. If ranked recall is unavailable,
  the middleware falls back to SQL recall.
- `sql`: deterministic per-domain keyword recall.
- `agent`: legacy per-domain read-only LLM recall graphs.

Domains include operational observations plus `human`, `agent`, `business`,
`world`, `environment`, `projects`, and `skills`. Recalled rows populate the
existing observation-context metadata keys used in prompt assembly. Do not
assume every recall launches a model or that only six identity domains exist.

Conversation Reader supplies `<conversation_context>`. Files recall supplies
references, not full file contents. Installed skill recall is a deterministic
keyword-ranked read of `skill_definitions`; the primary agent decides whether
to load a skill. Team and subagent directories are also read-only context.

## Post-turn writers

`runSubconsciousObservationWriters()` observes the completed exchange after the
primary agent loop. Writers are fire-and-forget through the process-wide
`SubconsciousWriterGate`, which limits background model concurrency.

With observation injection enabled, it launches the operational observation
writer, seven identity observers (including skills), and a conversation-keyword
writer. The reflex trainer also runs for human turns, independently of
observation injection, but not for delegated subagent prompts. Workflow-scoped
turns and turns without analyzable user content are skipped.

Writers have their own graph state and restricted tool grants; do not use them
as general-purpose shell, browser or implementation workers. Ephemeral
`subconscious_*` conversations are excluded from persistent conversation
history and transcript logs by `SullaLogger`.

## The memory substrate

`observations` stores operational memories; `identity_observations` stores
domain-keyed identity memories. Identity certainty levels are L3 (stated),
L2 (derived) and L1 (conclusion). Observation tools live in `observation/*`.
These are not the same as the Knowledge Base: the code also contains
`knowledge_nodes` and `node_links` tables and knowledge projection machinery.

`RecallIndexService` backs `memory/recall_index_lookup` and
`memory/recall_index_store`: content-hash-checked digests avoid repeating file
research. `memory/recall_conversations` searches message content or reads a
transcript. `browser/search_conversations` is a separate title/summary search.
User-facing conversation JSONL logs are written by `SullaLogger`; Files-first
exposes Training Data as a system area. Do not assume a raw host log path is
mounted into the agent VM.

## Implementation references

- `pkg/rancher-desktop/agent/middleware/SubconsciousMiddleware.ts`
- `pkg/rancher-desktop/agent/services/GraphRegistry.ts`
- `pkg/rancher-desktop/agent/services/SubconsciousWriterGate.ts`
- `pkg/rancher-desktop/agent/memory/MemoryRecallService.ts`
- `pkg/rancher-desktop/agent/services/SullaLogger.ts`
- `pkg/rancher-desktop/agent/services/RecallIndexService.ts`
