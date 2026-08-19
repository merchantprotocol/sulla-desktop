# PRD — Subconscious pruning + focused User-Observation subsystem

**Status:** 🟡 Planning / discovery (pending confirmation on the open decisions below)
**Branch:** `feature/user-observation-subsystem` · **Started:** 2026-08-19
**Directive (Jonathon):** most subconscious agents underperform; the Observation Writer +
Observation Recall (and the Conversational Summarizer) work reliably. Prune the rest, then
*expand the proven observation technique* into focused, categorized observers — starting with
one that learns about the **human user**.

---

## Part A — Prune the subconscious agents

**Keep (proven reliable):**
- Observation **Writer** (fire-and-forget) — `GraphRegistry.createObservationAgent` · dispatch `SubconsciousMiddleware.ts:256-263`
- Observation **Recall** (deterministic SQL fast-path) — `SubconsciousMiddleware.ts:749-780`, dispatch `:265-272`
- Conversational **Summarizer** — `createSummarizer` · dispatch `:176-181`

**Remove:**
- **Environment Brief** — `createEnvironmentBrief` [GraphRegistry 1350-1374], dispatch `:220-223`
  ⚠️ historically nicknamed "memory recall" — NOT the Observation Recall we're keeping.
- **Episodic Recall** — `createEpisodicRecall` [1410-1430], dispatch `:225-227`
- **Episodic Scribe** — `createEpisodicScribe` [1438-1460] (write side of the knowledge graph)
- **Security Conscience** — `createSecurityConscience` [1383-1404], dispatch `:236-239`
  ⚠️ removing this drops the per-turn security/rules reminder (reads `sulla_rules`). Confirm intended.
- **Conversation Recall** — `createConversationRecall` [1529-1550], dispatch `:250-253`
- **Unstuck Research** — `createUnstuckResearch` [1556-1580], heartbeat dispatch `HeartbeatNode.ts:917-982`
- **Unstuck Constraint Relaxation** — `createUnstuckRelaxation` [1586-1610]

Each removal deletes: the dispatch call, the `run*` fn in SubconsciousMiddleware, the GraphRegistry
factory + its `*_TOOLS` const + `*_PROMPT` const, and the `<*_context>` entry in the BaseNode strip
regex (`BaseNode.ts:835-836`). **Open decision A1:** Tool-Result Digester — keep (it's token
compression like the summarizer, recommended) or remove?

---

## Part B — User-Observation subsystem (clone the proven pattern, focused on the user)

Mirrors the observation writer/recall that works, but scoped to the human and **categorized by
certainty level** instead of priority.

### Fact levels (replace priority)
- **L3 — stated:** definite facts the user explicitly told us.
- **L2 — derived:** assumed facts derived from conversation.
- **L1 — concluded:** conclusions/assumptions inferred from observed facts (personality, writing
  style, habits).

### New table `sulla_user_observations` (migration 0050) — clone of `observations` + level/category
```
id          TEXT PRIMARY KEY
content     TEXT NOT NULL
level       INTEGER NOT NULL DEFAULT 2      -- 1 concluded | 2 derived | 3 stated
category    TEXT NOT NULL DEFAULT 'identity' -- identity | relationship | association | personality | habit | preference | goal
subject     TEXT NOT NULL DEFAULT 'user'    -- 'user' or a named relation/association
source      TEXT
archived    BOOLEAN NOT NULL DEFAULT false
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ
```
Indexes: `(archived, level DESC, created_at DESC)`, `(archived, category)`, trigram GIN on `content`.

### Model `UserObservationsModel` — clone of `ObservationsModel`
CRUD + `search()` (same phrase→word→recency ranking, level as a tiebreak) + `findDuplicate` +
`listActive(category?, level?, limit)`.

### Writer agent `createUserObservationAgent` (fire-and-forget, subconscious slot)
Prompt discipline: (1) FIRST record concrete **stated** facts (L3); (2) then **derive** assumed
facts (L2); (3) then form **conclusions** (L1) about personality/style/habits. Dedup via
`search_user_observations`, update-in-place by id, soft-archive superseded. Tools:
`add_user_observation`, `remove_user_observation`, `search_user_observations`, `list_user_observations`.

### Reader `runUserObservationRecall` (deterministic, like the proven recall)
Compile the most important user facts — rank **L3 → L2 → L1**, then recency, with light category
balancing (don't let one category dominate), cap ~8-10. Inject as a `<user_observations>` block into
the primary/orchestrator prompt exactly like `<observation_context>`; strip after the call.

### Wiring
- Dispatch both in `SubconsciousMiddleware` alongside the kept observation agents.
- Inject `<user_observations>` in `CodexService.ts` (~349) / `AgentNode.ts` (~175).
- Add `user_observations` to the `BaseNode.ts` strip regex.

---

## Open decisions (need Jonathon)
- **A1** — keep the Tool-Result Digester? (recommend keep)
- **B1** — reader stays **deterministic ranking** (recommended, matches the proven recall) vs a light LLM synthesizer?
- **B2** — the new user observer runs **alongside** the general observation writer/recall (both), correct?
- **B3** — category set + the `subject` column (supports future relationship queries) — OK, or simplify?
- **B4** — this establishes a reusable pattern; the `~/sulla/identity/` layout is human/business/world/agent.
  Build only the **user (human)** observer now as the template, business/world later? (recommend yes)

## Phases
1. Prune agents (Part A) — surgical, isolated commits.
2. Table + model + tools (Part B data layer).
3. Writer agent + reader + wiring.
4. Rebuild + verify the injected `<user_observations>` block reaches the model.
