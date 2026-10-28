---
slug: sulla-tool-rules
label: Use the Sulla Rules tools
trigger_when: When you need to use Sulla Rules operations.
trigger_actions: [rules, rules tools]
trigger_phrases: [rules, rules]
scope: [tool-rules]
---

**When:** When you need to use Sulla Rules operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# rules tools

User-created rules the Security Conscience enforces. Distinct from global markdown under ~/sulla/rules/global/.

## add_rule

Add or update a user-created rule the Security Conscience should enforce (e.g. "always confirm before touching prod", "never deploy on Fridays"). Provide an id to update a specific rule in place; otherwise a substantially similar existing rule is updated instead of creating a duplicate.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Optional |
| `title` | string | Optional |
| `content` | string | Required |
| `category` | string | Optional |
| `severity` | string | Optional |
| `enabled` | boolean | Optional |
| `source` | string | Optional |

**Example**

```bash
sulla rules/add_rule '{"content":"<content>"}'
```

## archive_rule

Archive (soft-delete) a user-created rule by its id. The record is never hard-deleted — it is marked archived=true so the history is always recoverable.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla rules/archive_rule '{"id":"<id>"}'
```

## list_rules

List active user-created rules from the rules table, most severe first then recency. These are the rules the human wants honored (security, operational, personal).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `category` | string | Optional |
| `severity` | string | Optional |
| `limit` | number | Optional |
| `include_disabled` | boolean | Optional |

**Example**

```bash
sulla rules/list_rules '{}'
```

## search_rules

Search user-created rules by keyword or phrase across title + content. The query is split into words and any rule containing ANY meaningful word matches (stopwords ignored), ranked by phrase hit then word-match count.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Required |
| `limit` | number | Optional |
| `include_archived` | boolean | Optional |
| `include_disabled` | boolean | Optional |

**Example**

```bash
sulla rules/search_rules '{"query":"<query>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
