# agents tools

Sub-agent spawning and job management — run parallel background agents and check their results.

## check_agent_jobs

Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrator-message counts.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `jobId` | string | Optional |

**Example**

```bash
sulla agents/check_agent_jobs '{}'
```

## close_agent_conversation

Close a sub-agent conversation and free its resources (drops the sub-agent's graph + state). Do this when you're done talking to a sub-agent.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `conversationId` | string | Required |

**Example**

```bash
sulla agents/close_agent_conversation '{"conversationId":"<conversationId>"}'
```

## directory

Directory of every callable custom agent (from agent_definitions) as compact cards: when to call it, when not to, what to send, what it returns, cost tier, and which agents it can call. Use it to pick the right specialist before spawn_agent.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `slug` | string | Optional |
| `includeInactive` | boolean | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla agents/directory '{}'
```

## list_agents

List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn).

**Parameters**

None.

**Example**

```bash
sulla agents/list_agents '{}'
```

## read_agent_conversation

Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `conversationId` | string | Optional |

**Example**

```bash
sulla agents/read_agent_conversation '{}'
```

## report_progress

Record a milestone check-in for your current delegated task (hidden worker or agent tab). Call it at meaningful milestones and at least every ~5 minutes; your parent sees it in its subagent directory.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `step` | string | Required |
| `summary` | string | Required |
| `filesTouched` | array | Optional |
| `blockers` | array | Optional |
| `percent` | number | Optional |

**Example**

```bash
sulla agents/report_progress '{"step":"<step>","summary":"<summary>"}'
```

## return_result

Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab). The result is checked against the contract in your brief; a mismatch is refused so you can fix it.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `status` | enum: completed\|blocked\|failed | Optional |
| `summary` | string | Optional |
| `output` | any | Optional |
| `result` | object | Optional |
| `jobId` | string | Optional |

**Example**

```bash
sulla agents/return_result '{}'
```

## send_agent_message

DEPRECATED conversation compatibility surface. For a running spawn_agent job, use send_job_message with its jobId instead.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `conversationId` | string | Required |
| `message` | string | Required |

**Example**

```bash
sulla agents/send_agent_message '{"conversationId":"<conversationId>","message":"<message>"}'
```

## send_job_message

Send new direction to one or all running tasks in a delegated job, hidden or tab. Hidden workers get it live when possible, otherwise at their next model-call boundary; a tab child gets it in its chat (steers a live turn or starts one).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `jobId` | string | Required |
| `taskIndex` | number | Optional |
| `message` | string | Required |

**Example**

```bash
sulla agents/send_job_message '{"jobId":"<jobId>","message":"<message>"}'
```

## start_agent_conversation

DEPRECATED compatibility wrapper over spawn_agent. Launches one async job and returns jobId plus a conversationId alias.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `prompt` | string | Required |
| `agentId` | string | Optional |
| `label` | string | Optional |

**Example**

```bash
sulla agents/start_agent_conversation '{"prompt":"<prompt>"}'
```

## stop_agent_job

Kill switch for a running delegated job, hidden or tab. Hidden: fires the job's abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `jobId` | string | Required |

**Example**

```bash
sulla agents/stop_agent_job '{"jobId":"<jobId>"}'
```
