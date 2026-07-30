# Sub-Agents

Spawn parallel sub-agents to do work independently and check on their progress later. Useful for: gathering data from multiple sources, batch operations, anything you want fanned out.

## Tools

| Tool | Canonical category | Purpose |
|------|--------------------|---------|
| `sulla meta/spawn_agent` | meta | Launch one or more sub-agents (fire-and-forget or blocking) |
| `sulla agents/check_agent_jobs` | agents | Poll for results of async sub-agent jobs |
| `sulla agents/stop_agent_job` | agents | Kill switch — cancel a running async job |
| `sulla agents/start_agent_conversation` | agents | Open a persistent, multi-turn conversation with a sub-agent |
| `sulla agents/send_agent_message` | agents | Send a follow-up to an open conversation, get the reply |
| `sulla agents/read_agent_conversation` | agents | Read a conversation transcript, or list open conversations |
| `sulla agents/close_agent_conversation` | agents | Close a conversation and free its graph + state |
| `sulla agents/list_agents` | agents | Directory of live named agents you can `<channel:>`-message |

**Important:** the tool registry resolves tools by **name only** — `sulla agents/spawn_agent` and `sulla anything/spawn_agent` also work because the backend ignores the category segment in the URL. But the canonical surfacing in `sulla meta --help` lists `spawn_agent` under `meta`. Use that form for clarity.

**Two ways to talk to a sub-agent:** `spawn_agent` is fire-one-prompt-and-run (poll for the result). `start_agent_conversation` keeps the sub-agent alive so you can go back and forth — delegate, then clarify/correct/ask follow-ups with full context retained. To reach the already-running *named* agents (heartbeat, workbench, mobile-relay), use a `<channel:NAME>` tag — `list_agents` shows who's addressable.

## `spawn_agent`

```bash
sulla meta/spawn_agent '{
  "tasks": [
    {"prompt": "research X", "label": "research", "agentId": "code-researcher"},
    {"prompt": "scrape Y",   "label": "scrape"}
  ],
  "parallel": true,
  "async":    true
}'
```

| Field | Default | Notes |
|-------|---------|-------|
| `tasks[].prompt` | required | The task instruction the sub-agent gets |
| `tasks[].agentId` | parent's `wsChannel` | Which agent config from `~/sulla/agents/`. Defaults to the parent agent's channel. |
| `tasks[].label` | optional | Human-readable name shown in `check_agent_jobs` output |
| `parallel` | `true` | Run tasks concurrently. `false` = serial. |
| `async` | `true` | Fire-and-forget; return jobId immediately. `false` = block until done. |

**Returns:**
- `async: true` → `{ jobId, taskCount, status: "running" }` — poll with `check_agent_jobs`
- `async: false` → array of completed task results (blocks until all done)

## `check_agent_jobs`

```bash
sulla agents/check_agent_jobs '{"jobId":"job_..."}'
```

**Possible responses:**
```jsonc
// Still running:
{
  "jobId":     "job_...",
  "status":    "running",
  "taskCount": 3,
  "elapsed":   "45s",
  "message":   "..."
}

// Done:
{
  "jobId":  "job_...",
  "status": "completed",
  "results": [
    {
      "label":   "research",
      "status":  "completed" | "blocked" | "error",
      "output":  "...the sub-agent's final summary or last message...",
      "threadId":"..."
    },
    ...
  ]
}

// Failed:
{ "jobId":"job_...", "status":"failed", "error":"..." }
```

**Important:** `status: "blocked"` means the sub-agent emitted `<AGENT_BLOCKED>` — read the `output` for the unblock_requirement. It didn't fail, it's waiting for input.

## `stop_agent_job` — kill switch

```bash
sulla agents/stop_agent_job '{"jobId":"agent-job-..."}'
```

Cancels a running async job (misfired, duplicated, or no longer needed). Fires the job's abort signal, which cascades to every sub-agent it spawned — the same signal the user's stop button uses. **Cooperative, not preemptive:** jobs run in-process (not child processes), so a sub-agent mid-LLM/tool-call finishes that call, then unwinds on its next step. The job settles as `status: "stopped"`; poll `check_agent_jobs` to confirm. Returns `already-finished` if the job isn't running, `not-found` if it expired.

## Conversations — talk back-and-forth with a sub-agent

Unlike `spawn_agent` (one prompt, run to completion), a **conversation** keeps the sub-agent's thread alive so you can send follow-ups with full context retained.

```bash
# Open — runs the first turn, returns the reply + a conversationId
sulla agents/start_agent_conversation '{"prompt":"Draft a migration plan for X","agentId":"code-researcher","label":"migration"}'
# → { "conversationId":"conv-...", "status":"completed", "reply":"..." }

# Continue — the sub-agent still has the whole prior context
sulla agents/send_agent_message '{"conversationId":"conv-...","message":"Now account for the FK on table Y"}'
# → { "status":"completed", "reply":"..." }

# Catch up / list
sulla agents/read_agent_conversation '{"conversationId":"conv-..."}'   # transcript + status
sulla agents/read_agent_conversation '{}'                              # list all open conversations

# Done — frees the sub-agent's graph + state
sulla agents/close_agent_conversation '{"conversationId":"conv-..."}'
```

- `start`/`send` **block** for the sub-agent's turn and return its reply. A sub-agent that emits `<AGENT_BLOCKED>` returns `status: "blocked"` with the requirement in `reply`.
- Soft cap **20 open conversations**; idle ones pruned after **1 hour**. `close_agent_conversation` frees one eagerly.
- Depth-guarded (max 3) like `spawn_agent`. In-memory only — does not survive a restart.

## `list_agents` — directory of live named agents

```bash
sulla agents/list_agents '{}'
```

Returns the live named agents (heartbeat, workbench, mobile-relay, frontends) with channel, status, and uptime — the same roster that appears in turn context, queryable on demand. To message one, emit a channel tag in your reply: `<channel:heartbeat>your message</channel:heartbeat>` (fire-and-forget; the reply arrives on a later turn). This is different from conversations: `list_agents` + channel tags reach the *already-running long-lived* agents; `start_agent_conversation` spins up a *fresh delegated* sub-agent for synchronous back-and-forth.

## Limits

- **Max 10 tasks per `spawn_agent` call** — prevents accidental fan-out explosions.
- **Depth max 3** — a sub-agent that spawns sub-agents that spawn sub-agents will hit the depth guard at level 3.
- **Job TTL: 1 hour** — auto-expire whether they finished or not. Cleaned up on retrieval.
- **In-memory only** — job IDs and pending work do not survive a Sulla Desktop restart.

## When to use what — sub-agent vs channel vs workflow

| Pattern | Latency | Interaction model | Best for |
|---------|---------|------------------|----------|
| `spawn_agent(async:true)` | Returns ~100ms; results later via poll | Independent | Multi-task delegation, parallel work that doesn't need back-and-forth |
| `<channel:workbench>...</channel:workbench>` | Fire-and-forget; reply may come back | Coordinated | Real-time agent-to-agent messaging when the other agent is already running |
| `sulla meta/execute_workflow` | Async, returns executionId | Fixed pipeline | Deterministic multi-step automation that doesn't need agent reasoning at each step |
| `spawn_agent(async:false)` | Blocks until done | Synchronous | When you need the result before you can proceed |

**Quick guide:**
- Need 5 things researched in parallel and you'll synthesize → `spawn_agent` async, then `check_agent_jobs`
- Need the workbench agent to verify something while you keep going → channel tag
- Need a known repeatable pipeline → workflow
- Need one focused task done before continuing → `spawn_agent` sync (or just do it yourself)

## Patterns

### Fan out research, then synthesize
```bash
sulla meta/spawn_agent '{
  "tasks": [
    {"label":"competitor-pricing", "prompt":"Look up pricing for ..."},
    {"label":"market-size",        "prompt":"Estimate TAM for ..."},
    {"label":"recent-news",        "prompt":"Find news from last 7 days about ..."}
  ],
  "parallel": true,
  "async":    true
}'
# returns jobId — keep working
sulla agents/check_agent_jobs '{"jobId":"..."}'
# when status:completed, read each result's output
```

### Use a specialized agent for a hard problem
```bash
sulla meta/spawn_agent '{
  "tasks": [{"agentId":"forecaster","prompt":"Run a 13-week forecast for ..."}],
  "async": false
}'
# blocks until done; returns the result
```

### Spawn a worker that runs in the background
```bash
sulla meta/spawn_agent '{
  "tasks": [{"label":"long-scrape","prompt":"Scrape every page on ..."}],
  "async": true
}'
# now ignore it; check back later or never
```

## Where do `agentId` configs live?

`~/sulla/agents/<agentId>/` — each is a directory with a config file describing the agent's system prompt, tools, model, etc. The user can install pre-built ones (forecaster, code-researcher, prompt-engineer, etc.) or author their own. If `agentId` doesn't exist, the system silently defaults to the parent's channel — which usually isn't what you wanted, so verify.

## Hard rules

- **Don't spawn sub-agents in tight loops.** 10 tasks per call, depth 3 — but you can chain calls, and that's how you accidentally DoS yourself.
- **`status: "blocked"` is not an error.** Read the unblock_requirement and surface it to the user.
- **Don't rely on jobIds across restart.** They evaporate. If the work matters durably, write the result to disk or Postgres before the parent agent finishes.
- **Sub-agents inherit parent metadata** (`isSubAgent: true`, `subAgentDepth`). Don't try to fake these — the depth guard protects you.

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/agents/`
- Manifest: `pkg/rancher-desktop/agent/tools/agents/manifests.ts`
- Agent configs: `~/sulla/agents/`
- Channel routing: see `agent-patterns/channels.md`
