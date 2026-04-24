# Sub-Agents

Spawn parallel sub-agents to do work independently and check on their progress later. Useful for: gathering data from multiple sources, batch operations, anything you want fanned out.

## Tools

| Tool | Canonical category | Purpose |
|------|--------------------|---------|
| `sulla meta/spawn_agent` | meta | Launch one or more sub-agents |
| `sulla agents/check_agent_jobs` | agents | Poll for results of async sub-agent jobs |

**Important:** the tool registry resolves tools by **name only** — `sulla agents/spawn_agent` and `sulla anything/spawn_agent` also work because the backend ignores the category segment in the URL. But the canonical surfacing in `sulla meta --help` lists `spawn_agent` under `meta`. Use that form for clarity.

`check_agent_jobs` is the only tool actually registered under the `agents` category.

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
