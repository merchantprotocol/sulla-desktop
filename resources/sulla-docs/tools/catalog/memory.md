# memory tools

Tools for the memory recall subconscious agent — Redis citation index lookup/store, tool discovery, and catalog browsing.

## episodic_recall

Recall Knowledge Base nodes by query or alias. Read-only.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `terms` | array | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla memory/episodic_recall '{}'
```

## episodic_resolve

Resolve aliases to canonical active Knowledge Base nodes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `terms` | array | Required |

**Example**

```bash
sulla memory/episodic_resolve '{"terms":"<terms>"}'
```

## episodic_search

Search durable conversation history and message content. Empty query lists recent conversations.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `include_archived` | boolean | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla memory/episodic_search '{}'
```

## recall_conversations

Search and read the on-disk conversation logs (~/sulla/logs/conv_*.jsonl) — the training-formatted JSONL transcripts of every past user-facing conversation (subconscious agents are never logged here). Unlike search_conversations (which matches DB titles/summaries), this searches the actual message CONTENT and returns transcripts. action:"search" finds past conversations by keyword and returns each hit's id, date, title, and a matching snippet; action:"read" renders one conversation's full transcript by id.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: search\|read | Required |
| `query` | string | Optional |
| `id` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla memory/recall_conversations '{"action":"<action>"}'
```

## recall_index_lookup

Check the Redis citation index for previously-researched digests BEFORE re-reading files or re-searching directories. Pass a topic and/or a list of file paths.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `topic` | string | Optional |
| `paths` | array | Optional |

**Example**

```bash
sulla memory/recall_index_lookup '{}'
```

## recall_index_store

Persist freshly-researched citation digests into the Redis citation index so future recall passes can reuse them without re-reading source files. Store one entry per file you read (path + the digest you produced), and optionally a topic with citation strings.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `files` | array | Optional |
| `topic` | string | Optional |
| `citations` | array | Optional |

**Example**

```bash
sulla memory/recall_index_store '{}'
```
