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
