---
slug: sulla-tool-observation
label: Use the Sulla Observation tools
trigger_when: When you need to read or record durable memory and observations.
trigger_actions: [observation, observation tools]
trigger_phrases: [observation, observation]
scope: [tool-observation]
---

**When:** When you need to read or record durable memory and observations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# observation tools

Observational memory tools for the subconscious observation curator agent.

## add_identity_observation

Store a focused identity observation into the domain-keyed identity_observations table (human / business / world / agent / environment / projects / skills — mirrors ~/sulla/identity/). Levels are CERTAINTY: 3 = stated fact (subject directly told us), 2 = derived fact (established from conversation evidence), 1 = conclusion (reasoned from L3/L2 facts — personality, style, habits).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Optional |
| `domain` | string | Optional |
| `level` | number | Required |
| `category` | string | Optional |
| `content` | string | Required |
| `basis` | string | Optional |
| `subject` | string | Optional |
| `evidence` | string | Optional |
| `confidence` | number | Optional |
| `kind` | string | Optional |
| `skillSlug` | string | Optional |
| `source` | string | Optional |

**Example**

```bash
sulla observation/add_identity_observation '{"level":"<level>","content":"<content>"}'
```

## add_observational_memory

Use this tool to store the observations you make into long-term memory.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Optional |
| `priority` | string | Optional |
| `content` | string | Required |
| `source` | string | Optional |

**Example**

```bash
sulla observation/add_observational_memory '{"content":"<content>"}'
```

## list_identity_observations

List active identity observations for one domain, most certain first (L3 stated → L2 derived → L1 concluded) then most recent. Optionally filter by level and/or category.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `domain` | string | Optional |
| `level` | number | Optional |
| `category` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla observation/list_identity_observations '{}'
```

## list_observations

List active observational memories sorted by priority (critical/high first) then recency. Optionally filter by priority level.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `priority` | string | Optional |
| `limit` | number | Optional |
| `include_archived` | boolean | Optional |

**Example**

```bash
sulla observation/list_observations '{}'
```

## remove_identity_observation

Archive (soft-delete) an identity observation by its ID. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla observation/remove_identity_observation '{"id":"<id>"}'
```

## remove_observational_memory

Archive (soft-delete) a specific observational memory by its ID. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla observation/remove_observational_memory '{"id":"<id>"}'
```

## search_conversation_keywords

Read-only search for the Conversation Reader over the conversation_keywords index. Pass term (or query) for exact canonical-term match, falling back to pg_trgm fuzzy match, falling back to ILIKE over conversation_history title/summary/last_summary; or pass thread_id to list every indexed keyword for that thread.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `term` | string | Optional |
| `query` | string | Optional |
| `thread_id` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla observation/search_conversation_keywords '{}'
```

## search_conversation_logs

Read-only search over ~/sulla/logs/ for the Conversation Reader. Pass thread_id to resolve that conversation's specific log file(s) (channel-scoped .log plus the conv_<id>.jsonl event stream); omit it to scan all thread-scoped log files within a recency window (since / days).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `thread_id` | string | Optional |
| `keyword` | string | Optional |
| `since` | string | Optional |
| `days` | number | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla observation/search_conversation_logs '{}'
```

## search_identity_observations

Search active identity observations within one domain (human / business / world / agent / environment / projects / skills) by meaning with the ranked recall engine (keyword + embedding search + learned ranker), so paraphrases match. Rows include a relevance score, best first. include_archived falls back to any-word keyword matching.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Required |
| `domain` | string | Optional |
| `limit` | number | Optional |
| `include_archived` | boolean | Optional |

**Example**

```bash
sulla observation/search_identity_observations '{"query":"<query>"}'
```

## search_observations

Search active observational memories by meaning with the ranked recall engine (keyword + embedding search + learned ranker), so paraphrases match. Returns compact rows (id, priority, timestamp, relevance score, content), best first. include_archived falls back to any-word keyword matching.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Required |
| `limit` | number | Optional |
| `include_archived` | boolean | Optional |

**Example**

```bash
sulla observation/search_observations '{"query":"<query>"}'
```

## update_identity_section

Write the consolidated identity profile for a domain into its system-prompt section (e.g. the "user" section injected into every system prompt). Overwrites the section content and marks it customized so the boot seeder never clobbers it.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `content` | string | Required |

**Example**

```bash
sulla observation/update_identity_section '{"id":"<id>","content":"<content>"}'
```

## upsert_conversation_keywords

Observer-only database writer for salient terms from the completed conversation turn. Canonicalizes and upserts terms by (term, thread_id), bumping hit_count and last_seen on repeats.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `terms` | array | Required |
| `thread_id` | string | Required |
| `conversation_history_id` | string | Optional |
| `channel_id` | string | Optional |
| `agent_id` | string | Optional |
| `source` | enum: primary\|subconscious\|worker | Optional |

**Example**

```bash
sulla observation/upsert_conversation_keywords '{"terms":"<terms>","thread_id":"<thread_id>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
