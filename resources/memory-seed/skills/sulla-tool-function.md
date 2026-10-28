---
slug: sulla-tool-function
label: Use the Sulla Function tools
trigger_when: When you need to use Sulla Function operations.
trigger_actions: [function, function tools]
trigger_phrases: [function, function]
scope: [tool-function]
---

**When:** When you need to use Sulla Function operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# function tools

Custom function runner — list installed functions and invoke them by slug across python, shell, and node runtimes. Returns full execution trace in one call.

## list

List all custom functions stored in Postgres — shows slug, name, runtime, entrypoint, inputs, and outputs for each.

**Parameters**

None.

**Example**

```bash
sulla function/list '{}'
```

## run

Load and run a custom function by slug. Returns the full execution trace: function metadata, runtime details, load status, inputs used, and all outputs — everything in one call.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Required |
| `inputs` | object | Optional |
| `version` | string | Optional |

**Example**

```bash
sulla function/run '{"slug":"<slug>"}'
```

## runs

Query the function_run history. Every function_run call writes a row with slug, runtime, inputs/outputs, success, error_stage, duration.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Optional |
| `only_failures` | boolean | Optional |
| `since` | string | Optional |
| `limit` | number | Optional |
| `verbose` | boolean | Optional |

**Example**

```bash
sulla function/runs '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
