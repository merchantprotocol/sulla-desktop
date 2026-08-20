# The Subconscious — recall, memory, and observation

Every actionable turn runs a **subconscious layer** around the primary agent: a set of small, isolated graphs that recall relevant context *before* the reply and write durable memory *after* it. This is how Sulla walks into a turn already knowing who you are, what the business is, and what it's learned — without you re-explaining.

Source of truth: `pkg/rancher-desktop/agent/middleware/SubconsciousMiddleware.ts` (orchestration) and `pkg/rancher-desktop/agent/services/GraphRegistry.ts` (per-agent prompts + tool grants). This doc is kept in sync with that code.

> **What this is NOT.** There is no episodic "knowledge graph", no `knowledge_nodes`/`node_links` tables, and no "Scribe" or "Dreamer" agent in the shipped system. That was an earlier design that was never merged. The real memory substrate is two Postgres tables (`observations`, `identity_observations`), a Redis citation index, and the on-disk conversation logs — described below. Don't document or rely on the KG design.

---

## Shape of a turn

```
user message
   │
   ▼
┌─────────────────────────── PRE-TURN (blocking, parallel) ───────────────────────────┐
│  runSubconsciousMiddleware()  — recalls only; primary agent waits for all of them    │
│    • Summarizer            (only if > 30 messages)                                    │
│    • Tool-Result Digester  (only if ≥ 20k tokens of stale tool_results)              │
│    • Observation Recall            → <observation_context>     (deterministic SQL)    │
│    • Identity Recall: human         → <user_observations>                             │
│    • Identity Recall: agent         → <self_observations>                             │
│    • Identity Recall: business      → <business_observations>                         │
│    • Identity Recall: environment   → <environment_observations>                      │
│    • Identity Recall: projects      → <projects_observations>                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
   │  (recalled context injected into state.metadata → rendered into the system prompt)
   ▼
PRIMARY AGENT runs the turn, streams the reply
   │
   ▼
┌────────────────────────── POST-TURN (fire-and-forget) ───────────────────────────────┐
│  runSubconsciousObservationWriters()  — AgentNode calls this after the loop ends      │
│    • Observation Writer  → observations + Projects work-state                         │
│    • Identity Observers: human · agent · business · world · environment · projects    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Two design rules drive that split:

- **Recalls run before the reply, writers run after.** A writer that ran pre-turn would only see up to the user's message — it would miss the agent's response, the tools it ran, and any mid-turn correction. Running writers *after* the loop lets each one observe the **completed exchange**.
- **Recall is never time-limited.** Starting a turn without the right context is worse than starting it a few seconds late. The pre-turn recalls are awaited together (`Promise.allSettled`), so adding a domain costs roughly `max()` of the parallel calls, not `sum()`.

Each subconscious agent gets its **own** graph (`createSubconsciousGraph`), its own `conversationId` linked to the parent via `parentConversationId`, and is fully logged under `~/sulla/logs/`. They never share state with each other.

### When the subconscious is skipped
- **Inside a workflow/routine** — if `workflowNodeId`, `activeWorkflow`, or `scopedWorkflowId` is set, the whole pipeline is skipped. Routines have deterministic inputs and don't need per-turn recall.
- **No analyzable user message** — channel-join pings and system-triggered turns carry no real user text, so recalls/writers are skipped rather than burning a round-trip per agent.

### Removed on 2026-08-19
The **Environment Brief**, **Episodic Recall**, **Security Conscience**, and **Conversation Recall** subconscious agents were removed — they didn't perform reliably. Older docs that mention an "environment brief" or "security conscience" agent, or `<recall_context>` / `<security_context>` injection blocks, are describing a system that no longer runs. The retained pre-turn work is the Observation Recall + the five identity recalls above.

---

## Pre-turn agents

### Summarizer
Runs only when the thread exceeds **30 messages** (`TRIGGER_WINDOW_SIZE`). Compresses/deletes old messages and splices the compacted history back into the live state. No tools — pure text in, structured text out.

### Tool-Result Digester
Runs when **≥ 20,000 tokens** (`DIGEST_TRIGGER_TOKEN_MASS`) of *stale* `tool_result` mass has accumulated — stale meaning outside the last **4 assistant turns** (`DIGEST_PROTECTED_RECENT_TURNS`) and not already digested. It rewrites those bulky tool results into short trusted-citation digests (marked `[digested tool result …]`) so the primary model re-reads the citation instead of a verbatim dump. It compacts in **one batch** because Anthropic prompt caching is strict-prefix — editing past messages invalidates the cache from that point, so it pays the rebuild once. (On the claude-code provider with `--resume`, history lives in the Claude Code session, so the digest benefits the pre-flight token budget but only reshapes history on re-seed.)

### Observation Recall → `<observation_context>`
**Deterministic SQL fast-path, not an LLM agent.** It tokenizes the latest real user message and runs `ObservationsModel.search` (word-level ILIKE, ranked phrase-hit → word-match → recency), returning the top **8 rows** formatted as `[id] priority date — content`. This replaced an older agent-loop that cost 17–120s of blocking prelude for a query Postgres answers in 3–17ms. Returns nothing when there's no match (no block injected).

### Identity Recall (per domain) → `<…_observations>`
One read-only LLM agent per domain, capped at 10 iterations, each surfacing only the `identity_observations` rows relevant to the current turn (relevance is turn-dependent, so this beats a fixed "last N" dump). Injected as:

| Domain | Injection block | "…recalling…" |
|--------|-----------------|---------------|
| `human` | `<user_observations>` | who you are |
| `agent` | `<self_observations>` | how we work |
| `business` | `<business_observations>` | the business |
| `environment` | `<environment_observations>` | this environment |
| `projects` | `<projects_observations>` | the projects |

Note `world` is **not** recalled pre-turn — it's written post-turn only.

---

## Post-turn writers

All fire-and-forget: the user already has their reply, so writers add **zero** turn latency, never touch `state.messages`, and don't compete with recall for the shared model. `AgentNode` calls `runSubconsciousObservationWriters()` after the loop ends. Seven writers launch:

- **Observation Writer** — writes/archives operational `observations` and updates Projects work-state.
- **Identity Observers**, one per domain: `human`, `agent`, `business`, `world`, `environment`, `projects`.

Each observer is scoped to write **only its own domain**, and none of them hardcode a specific person or business — the domain prompt describes *what* to study (the current human, the business, this environment, …), so the same code serves any install.

### Observe-only — a hard gate
Subconscious writers are **observers, not actors**. They are granted only observation/identity DB tools, enforced through BaseNode's strict `allowedToolNames` path (no dynamic tool injection), so taking filesystem/shell/code/browser action from a subconscious pass is *structurally impossible*:

| Agent | Tool grant |
|-------|-----------|
| Summarizer | none |
| Tool-Result Digester | none |
| Observation Recall | `search_observations`, `list_observations` (read-only) |
| Observation Writer | `add_/remove_/search_/list_observational_memory` |
| Identity Recall (per domain) | `search_/list_identity_observations` (read-only) |
| Identity Observer (per domain) | `add_/remove_/search_/list_identity_observation` |

Subconscious agents also never get host access even when the primary Sulla agent does.

---

## The memory substrate

### `observations` table — operational memory
Short, durable, surprising, or non-obvious operational facts (migration `0028`). Priority-ranked (critical/high/…). Written by the Observation Writer, recalled by the SQL fast-path above, and the top rows are also rendered into the primary system prompt's memory section. Agent tools: `observation/add_observational_memory`, `remove_observational_memory`, `search_observations`, `list_observations`. Soft-delete only (`archived=true`), so history is recoverable.

### `identity_observations` table — domain-keyed identity
Who the human is, how Sulla works, the business, the world, this environment, the projects (migrations `0050`–`0054`). The `domain` column is constrained to exactly six values:

```
agent · business · environment · human · projects · world
```

Each row carries a **certainty level**:

- **L3 — stated fact:** the subject told us directly, or it's a direct instruction.
- **L2 — derived fact:** established from conversation/tool evidence.
- **L1 — conclusion:** reasoned from L2/L3 (personality, style, habits).

Rows also carry `category`, provenance/basis, and confidence. Writes **dedupe**: passing an existing `id`, or a substantially-similar active row in the same domain, updates in place instead of creating a duplicate. Agent tools: `observation/add_identity_observation`, `remove_identity_observation`, `search_identity_observations`, `list_identity_observations`. Mirrors the `~/sulla/identity/<domain>/` files.

### Redis citation index — recall for research
`RecallIndexService` backs the `memory/*` tools. Before re-reading files or re-searching a directory, an agent calls `memory/recall_index_lookup` (topic and/or file paths); it returns trusted digests for files verified unchanged by content-hash, drops stale entries, and reports what still needs fresh research. `memory/recall_index_store` persists new digests (24h TTL unless re-hit). This is the fast/slow-path cache that keeps recall from re-doing expensive reads.

### Conversation logs — `recall_conversations`
Every user-facing conversation is written to `~/sulla/logs/conv_*.jsonl` (training-formatted transcripts; subconscious agents are never logged here). `memory/recall_conversations` searches the actual message **content** (`action:"search"`) and renders a full transcript by id (`action:"read"`) — use it to recall what was actually said or decided earlier, as opposed to `browser/search_conversations` which matches DB titles/summaries.

---

## Adding a new identity domain
It's deliberately cheap: add one `IdentityObserverDomainConfig` entry in `GraphRegistry.ts`, one dispatch line in `SubconsciousMiddleware.ts`, and (if it's a new `domain` value) widen the check constraint with a migration. No new table, model, or tool — every domain shares `identity_observations` and the same four identity tools.

See also: [`tools/meta.md`](../tools/meta.md) (memory + identity tool reference), [`identity/structure.md`](../identity/structure.md) (the `~/sulla/identity/` files), [`environment/heartbeat.md`](heartbeat.md).
