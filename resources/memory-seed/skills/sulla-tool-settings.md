---
slug: sulla-tool-settings
label: Use the Sulla Settings tools
trigger_when: When you need to use Sulla Settings operations.
trigger_actions: [settings, settings tools]
trigger_phrases: [settings, settings]
scope: [tool-settings]
---

**When:** When you need to use Sulla Settings operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# settings tools

Read and write Sulla Desktop settings through SullaSettingsModel (the single authoritative read-path — never raw Redis sulla_settings).

## get

Read a Sulla Desktop setting through SullaSettingsModel (Redis cache → Postgres → file fallback). Use this instead of redis_hget on sulla_settings — raw Redis reads of that hash are blocked.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `property` | string | Required |
| `default` | string | Optional |

**Example**

```bash
sulla settings/get '{"property":"<property>"}'
```

## set

Write a Sulla Desktop setting through SullaSettingsModel so Postgres and the Redis cache stay in sync. Use this instead of redis_hset on sulla_settings — raw Redis writes of that hash are blocked.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `property` | string | Required |
| `value` | string | Required |
| `cast` | string | Optional |

**Example**

```bash
sulla settings/set '{"property":"<property>","value":"<value>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
