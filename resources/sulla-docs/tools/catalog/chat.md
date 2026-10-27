# chat tools

Controls scoped to the current chat thread, including its independent heartbeat and persistent sidebar artifacts.

## artifact_append

Append text to an existing sidebar artifact, such as a notes or progress log section.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |
| `text` | string | Required |

**Example**

```bash
sulla chat/artifact_append '{"idOrName":"<idOrName>","text":"<text>"}'
```

## artifact_close

Close an artifact sidebar tab while preserving its content and revision history.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |

**Example**

```bash
sulla chat/artifact_close '{"idOrName":"<idOrName>"}'
```

## artifact_create

Create and focus a sidebar artifact for this chat. If its name already exists, updates that same artifact instead of opening a duplicate.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `name` | string | Required |
| `kind` | enum: markdown\|html\|code | Optional |
| `content` | string | Required |
| `status` | enum: working\|done\|error\|viewing\|editing | Optional |
| `language` | string | Optional |
| `path` | string | Optional |
| `focus` | boolean | Optional |
| `expectedVersion` | number | Optional |
| `project_slug` | string | Optional |
| `project_name` | string | Optional |
| `file_name` | string | Optional |
| `document_kind` | enum: plan\|spec\|notes\|report | Optional |
| `owner_agent` | string | Optional |
| `epic` | string | Optional |
| `document_status` | string | Optional |
| `delete_when` | string | Optional |
| `related_prs` | array | Optional |
| `related_tasks` | array | Optional |

**Example**

```bash
sulla chat/artifact_create '{"name":"<name>","content":"<content>"}'
```

## artifact_delete

Soft-delete an artifact while retaining its database revision history. Requires confirm: true.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |
| `confirm` | boolean | Required |

**Example**

```bash
sulla chat/artifact_delete '{"idOrName":"<idOrName>","confirm":"<confirm>"}'
```

## artifact_edit

Apply exact find/replace edits atomically to an existing artifact. Every find must occur exactly once or nothing changes.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |
| `edits` | array | Required |

**Example**

```bash
sulla chat/artifact_edit '{"idOrName":"<idOrName>","edits":"<edits>"}'
```

## artifact_focus

Focus an existing open sidebar artifact without changing its content or version.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |

**Example**

```bash
sulla chat/artifact_focus '{"idOrName":"<idOrName>"}'
```

## artifact_history

Read every saved revision of an artifact, newest first, including whether the agent or human made it.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |

**Example**

```bash
sulla chat/artifact_history '{"idOrName":"<idOrName>"}'
```

## artifact_list

List sidebar artifacts for this chat. Plans and working docs should live in ONE named artifact that you keep updating in place.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `includeClosed` | boolean | Optional |

**Example**

```bash
sulla chat/artifact_list '{}'
```

## artifact_open

Open an existing Sulla Files file in this chat artifact sidebar. Edits save back to the same versioned file with conflict protection.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file_id` | string | Required |
| `focus` | boolean | Optional |

**Example**

```bash
sulla chat/artifact_open '{"file_id":"<file_id>"}'
```

## artifact_read

Read current artifact content and version, including edits or checkbox ticks made by the human. Always read before editing a shared plan.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |

**Example**

```bash
sulla chat/artifact_read '{"idOrName":"<idOrName>"}'
```

## artifact_reopen

Reopen and focus a previously closed artifact in this chat.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |

**Example**

```bash
sulla chat/artifact_reopen '{"idOrName":"<idOrName>"}'
```

## artifact_revert

Restore an artifact content from an earlier version as a new revision, preserving all history.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |
| `version` | number | Required |

**Example**

```bash
sulla chat/artifact_revert '{"idOrName":"<idOrName>","version":"<version>"}'
```

## artifact_update

Replace an artifact content and/or rename or change its status. Updates the existing sidebar tab in place; do not create a new copy of a plan.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `idOrName` | string | Required |
| `expectedVersion` | number | Optional |
| `content` | string | Optional |
| `newName` | string | Optional |
| `status` | enum: working\|done\|error\|viewing\|editing | Optional |
| `language` | string | Optional |
| `path` | string | Optional |
| `focus` | boolean | Optional |

**Example**

```bash
sulla chat/artifact_update '{"idOrName":"<idOrName>"}'
```

## launch_agent_tab

Alias of meta/spawn_agent with visibility "tab": launch an enabled agent in its own visible chat tab with a return contract. Prefer spawn_agent with visibility "tab".

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `agentId` | string | Required |
| `brief` | string | Required |
| `title` | string | Optional |
| `contract` | object | Optional |
| `focus` | boolean | Optional |
| `projectTaskId` | string | Optional |

**Example**

```bash
sulla chat/launch_agent_tab '{"agentId":"<agentId>","brief":"<brief>"}'
```

## list_tab_contracts

Alias view of agents/check_agent_jobs for this chat's tab children, in the old contract shape (status open/returned/cancelled, returned results).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `status` | enum: open\|returned\|cancelled | Optional |

**Example**

```bash
sulla chat/list_tab_contracts '{}'
```

## message_tab

Alias of agents/send_job_message addressed by contract id or child thread id: send a follow-up to one of this chat's open children. Steers a running child or starts a new turn when idle.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `contractId` | string | Optional |
| `childThreadId` | string | Optional |
| `message` | string | Required |

**Example**

```bash
sulla chat/message_tab '{"message":"<message>"}'
```

## return_contract

Alias of agents/return_result: return your contract to the agent that launched you. Only the child thread that owns the contract may call this; schema mismatches are rejected.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `contractId` | string | Optional |
| `result` | object | Optional |
| `status` | enum: completed\|blocked\|failed | Optional |
| `summary` | string | Optional |
| `output` | string | Optional |

**Example**

```bash
sulla chat/return_contract '{}'
```

## route_agent

Select an enabled agent persona for a chat. Reflex uses this as a training target for first-message routing; it is not executed by the normal mid-chat Reflex action engine.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `agentId` | string | Required |

**Example**

```bash
sulla chat/route_agent '{"agentId":"<agentId>"}'
```

## set_heartbeat

Set the heartbeat for the current chat tab only. Use intervalMinutes=0 to turn it off.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `intervalMinutes` | number | Required |
| `message` | string | Optional |

**Example**

```bash
sulla chat/set_heartbeat '{"intervalMinutes":"<intervalMinutes>"}'
```
