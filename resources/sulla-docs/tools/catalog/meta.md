# meta tools

Tools for browsing available tools, installing skills, and meta management.

## ask_user_question

Pause and ask the user one or more multiple-choice questions, then BLOCK until they answer in the chat (or the timeout elapses — default 5 min). Renders an interactive card with selectable options; the user may also type a free-form answer.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `questions` | array | Required |
| `timeoutMs` | number | Optional |

**Example**

```bash
sulla meta/ask_user_question '{"questions":"<questions>"}'
```

## dry_run_workflow

Walk a workflow statically — parse YAML, traverse from triggers, report execution order and any orphans or runtime-ambiguous branches. Does NOT execute any node (no side effects).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Optional |
| `filePath` | string | Optional |

**Example**

```bash
sulla meta/dry_run_workflow '{}'
```

## exec

Run any shell command inside a fully isolated sandboxed Linux VM with root access. This is ALSO how you invoke every `sulla <category>/<tool>` CLI command surfaced by browse_tools — pass the full `sulla ...` command string as the `command` arg (e.g. command: "sulla github/create_issue '{\"title\":\"bug\"}'").

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `command` | string | Optional |
| `cmd` | string | Optional |
| `cwd` | string | Optional |
| `timeout` | number | Optional |
| `stdin` | string | Optional |

**Example**

```bash
sulla meta/exec '{}'
```

## exechost

LAST RESORT host shell — runs a command on the HOST macOS machine, NOT the Sulla VM. Default to regular exec (VM sandbox) for everyday work; home files are already mounted into the VM.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `command` | string | Optional |
| `cmd` | string | Optional |
| `cwd` | string | Optional |
| `timeout` | number | Optional |
| `stdin` | string | Optional |
| `foreground` | boolean | Optional |

**Example**

```bash
sulla meta/exechost '{}'
```

## execute_workflow

Execute a pre-registered workflow by its EXACT slug. Only call this when the slug appears verbatim in the "Available workflows" section of your system prompt — never guess a slug from the user request (e.g. do NOT invent slugs like "browser-tab-open" or "ask-date-time" unless they are explicitly listed).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `workflowId` | string | Required |
| `message` | string | Optional |
| `resume` | boolean | Optional |

**Example**

```bash
sulla meta/execute_workflow '{"workflowId":"<workflowId>"}'
```

## pause_workflow

Pause a running workflow without releasing it. Cooperative — PlaybookController checks a Redis flag at each frontier tick and halts frontier advance.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `executionId` | string | Required |
| `reason` | string | Optional |

**Example**

```bash
sulla meta/pause_workflow '{"executionId":"<executionId>"}'
```

## restart_from_checkpoint

Restart a workflow execution from a specific node checkpoint. Use workflowId alone to list recent executions, executionId alone to list checkpoints, or executionId + nodeId to restart from that node.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `executionId` | string | Optional |
| `nodeId` | string | Optional |
| `workflowId` | string | Optional |

**Example**

```bash
sulla meta/restart_from_checkpoint '{}'
```

## resume_workflow

Resume a workflow paused with pause_workflow by clearing its pause flag. The orchestrator resumes frontier advance on its next tick.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `executionId` | string | Required |

**Example**

```bash
sulla meta/resume_workflow '{"executionId":"<executionId>"}'
```

## spawn_agent

The one way to delegate. Launch one or more child agents, each with a return contract. visibility "hidden" (default) runs the child in the background; visibility "tab" opens it as a live chat tab the human can join (use for leads that run their own team or keep a visible Playbook).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `tasks` | array | Required |
| `parallel` | boolean | Optional |
| `async` | boolean | Optional |

**Example**

```bash
sulla meta/spawn_agent '{"tasks":"<tasks>"}'
```

## stop_workflow

Request a running workflow to stop. Cooperative — writes a Redis flag the PlaybookController checks at each frontier tick, so the running orchestrator honors it on its next step.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `executionId` | string | Required |
| `reason` | string | Optional |

**Example**

```bash
sulla meta/stop_workflow '{"executionId":"<executionId>"}'
```

## validate_sulla_workflow

Validate a Sulla workflow YAML file for structural correctness before it goes live. Checks top-level schema, node types, subtype/category mapping, required config fields, edge format, trigger presence, and reachability.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `filePath` | string | Optional |
| `yaml` | string | Optional |

**Example**

```bash
sulla meta/validate_sulla_workflow '{}'
```
