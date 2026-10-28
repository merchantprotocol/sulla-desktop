---
slug: sulla-tool-models
label: Use the Sulla Models tools
trigger_when: When you need to use Sulla Models operations.
trigger_actions: [models, models tools]
trigger_phrases: [models, models]
scope: [tool-models]
---

**When:** When you need to use Sulla Models operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# models tools

AI provider/model inventory — provider connection status, Sulla compatibility, CLI installation checks, model discovery, and locally tracked usage.

## list

List models available for one provider using Sulla provider discovery, with static catalog fallback when live discovery is unavailable.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `provider` | string | Required |

**Example**

```bash
sulla models/list '{"provider":"<provider>"}'
```

## providers

List AI model providers, whether each is connected/on or disconnected/off, whether any required CLI is installed in the Sulla VM, and whether Sulla can use it.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `include_disconnected` | boolean | Optional |

**Example**

```bash
sulla models/providers '{}'
```

## usage

Read locally tracked usage, API-equivalent cost estimates, model breakdowns, trends, and the latest subscription limit windows emitted by provider CLIs.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `provider` | string | Optional |
| `model` | string | Optional |
| `profile_id` | string | Optional |
| `hours` | number | Optional |

**Example**

```bash
sulla models/usage '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
