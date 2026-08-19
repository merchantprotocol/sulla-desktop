# PRD — Subconscious pruning + focused User-Observation subsystem

**Status:** Implemented on PR #600; production-readiness pass in progress.
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

Each removal deleted: the dispatch call, the `run*` fn in SubconsciousMiddleware, the GraphRegistry
factory + its `*_TOOLS` const + `*_PROMPT` const, and the `<*_context>` entry in the BaseNode strip
regex. Tool-Result Digester stays because it is token compression, not agent memory/reasoning.

---

## Part B — User-Observation subsystem (clone the proven pattern, focused on the user)

Mirrors the observation writer/recall that works, but scoped to the human and **categorized by
certainty level** instead of priority.

### Fact levels (replace priority)
- **L3 — stated:** definite facts the user explicitly told us.
- **L2 — derived:** assumed facts derived from conversation.
- **L1 — concluded:** conclusions/assumptions inferred from observed facts (personality, writing
  style, habits).

### New table `identity_observations` (migration 0050) — AS BUILT
Generalized per Jonathon 2026-08-19: instead of a user-only table, ONE domain-keyed table
mirroring `~/sulla/identity/` (human / business / world / agent). The human observer ships
first; adding another domain = one config entry + one dispatch line, no new migration.
```
id          TEXT PRIMARY KEY
domain      TEXT NOT NULL DEFAULT 'human'   -- human | business | world | agent
level       SMALLINT NOT NULL DEFAULT 2 CHECK (level IN (1,2,3))  -- 3 stated | 2 derived | 1 concluded
category    TEXT                            -- identity | relationship | association | personality | habit | preference | goal
content     TEXT NOT NULL
basis       TEXT                            -- for L2/L1: the facts it was derived/concluded from
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ
archived    BOOLEAN NOT NULL DEFAULT false  -- soft-archive only, never hard-delete
source      TEXT
```
Index: `(domain, archived, level DESC, created_at DESC)`.

### Model `IdentityObservationsModel` — clone of `ObservationsModel`, domain-scoped
CRUD + `search(domain, query)` (same phrase→word ranking, level-weighted) + `findDuplicate(domain,
content)` + `listActive(domain, {level?, category?, limit})` ordered level DESC then recency.

### Writer `GraphRegistry.createIdentityObserver(state, domain)` (fire-and-forget, subconscious slot)
Reusable template: `IDENTITY_OBSERVER_DOMAINS` holds per-domain focus config;
`buildIdentityObserverPrompt` renders the shared L3→L2→L1 discipline — (1) FIRST record **stated**
facts (L3); (2) then **derive** facts with `basis` (L2); (3) then form **conclusions** (L1) about
personality/style/habits, always with `basis`. Promote levels when evidence upgrades a fact;
soft-archive contradicted rows. Tools: `add_identity_observation`, `remove_identity_observation`,
`search_identity_observations`, `list_identity_observations` (each takes `domain`, default human).

### Reader `runIdentityObservationRecall(state, domain)` (deterministic SQL fast-path, no LLM)
Compiles the domain picture ranked purely **L3 → L2 → L1** then recency (NOT query-matched — who
the user is matters every turn), cap 12. Injected as a `<user_observations>` block in
`AgentNode.ts` exactly like `<observation_context>`; stripped per turn by
`BaseNode.stripInjectedContextBlocks`.

### Wiring (as built)
- `SubconsciousMiddleware` 3c/3d: `runIdentityObserver(state, 'human')` fire-and-forget +
  `runIdentityObservationRecall(state, 'human')` awaited → `metadata.userObservationContext`.
- Injection in `AgentNode.ts`; strip regex in `BaseNode.ts`.
- Add `user_observations` to the `BaseNode.ts` strip regex.

---

## Decisions
- Tool-Result Digester remains enabled.
- Identity recall is deterministic SQL ranking, not an LLM synthesizer.
- The human identity observer runs alongside the general observation writer/recall.
- One domain-keyed table supports `human / business / world / agent`; PR #600 ships only the human observer.
- Certainty levels are `L3 stated`, `L2 derived`, `L1 concluded`.

## Phases
1. Prune agents (Part A) — done.
2. Table + model + tools (Part B data layer) — done.
3. Writer agent + reader + wiring — done.
4. Rebuild + verify the injected `<user_observations>` block reaches the model — pending final verification after merge-conflict resolution.
