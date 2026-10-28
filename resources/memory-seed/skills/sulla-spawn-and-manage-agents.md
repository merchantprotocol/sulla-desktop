---
slug: sulla-spawn-and-manage-agents
label: Delegate work and manage sub-agents
trigger_when: When you need to decide whether to delegate, choose the right worker, launch one or more agent jobs, watch progress, recover a failed worker, or stop a delegated job.
trigger_actions: [decide whether to delegate, choose an agent, spawn a worker, monitor a sub-agent, recover a stalled job, stop an agent job]
trigger_phrases: [delegate this, spawn an agent, launch a worker, sub-agent, choose an agent, check agent jobs, worker stalled, stop the worker]
scope: [sulla-agents]
---

**When:** Use this skill for bounded work that is worth the cost of writing and reviewing a brief. Do the work yourself when explaining it to a worker and checking the result would take as long as the work. Delegate when a specialist is materially better, independent work can run in parallel, or a separate reviewer reduces risk. Delegation never transfers ownership of the goal.

**Do:**
1. Define the result before choosing a worker. Split work only at boundaries that can be accepted independently. Do not create a worker just to rediscover the task.
2. Search the live directory with the work stated in ordinary language:
   `sulla agents/directory '{"query":"implement and review a database migration"}'`
   Read each card's `whenToCall`, `whenNotToCall`, `send`, `returns`, and `costTier`. Pick the cheapest agent that is likely to get the task right. Use the strongest suitable agent for critical work, ambiguous work, or work a cheaper agent already failed.
3. Fetch one exact card before launch when needed:
   `sulla agents/directory '{"slug":"<agent-slug>"}'`
   Use its `slug` as `agentId`. A supplied `agentId` must match an enabled agent definition. Omit it only when the default agent is intentional.
4. Write a self-contained brief. Include the goal and why, all paths and identifiers, links, prior attempts, boundaries, exact acceptance checks, cleanup, and the required return shape. Use the `sulla-write-a-worker-brief` skill. If the worker must ask for basic context, the brief was too thin.
5. Launch hidden background work by default:
   `sulla meta/spawn_agent '{"tasks":[{"agentId":"<agent-slug>","label":"<short human label>","visibility":"hidden","prompt":"<complete brief>","contract":{"name":"result","description":"The verified task result","schema":{"type":"object","required":["status","summary","output"],"properties":{"status":{"type":"string","enum":["completed","blocked","failed"]},"summary":{"type":"string"},"output":{}}}}}],"parallel":true,"async":true}'`
   `tasks` must be a non-empty array and accepts at most 10 tasks. `parallel` and `async` both default to `true`. The async response contains `mode`, `jobId`, `taskCount`, `parallel`, and a message. Save the `jobId`.
6. Use `visibility:"tab"` only for a visible lead that will run its own team or a Playbook the human may join. A tab launch requires an active chat thread and an enabled routable agent. `label` becomes its tab title; `focus` defaults to `false`:
   `sulla meta/spawn_agent '{"tasks":[{"agentId":"<lead-slug>","label":"Delivery lead","visibility":"tab","focus":false,"prompt":"<complete brief>","contract":{"name":"result"}}]}'`
   A tab stays open until the child returns its contract or the parent stops it. Tab tasks never make the parent call block.
7. Prefer async work. Completion is delivered into the parent graph and wakes it. Do not poll. Use this only for a fallback, a status request, or history:
   `sulla agents/check_agent_jobs '{"jobId":"<job-id>"}'`
   Omit `jobId` to list active and recent jobs. The result shows job and task status, elapsed time, visibility, contract, results, latest check-in, recent check-ins, blockers, touched files, and queued-message counts.
8. Watch the latest check-in rather than guessing from elapsed time. A task with no useful check-in for about 15 minutes, or one that ended without a result, is dead unless the work itself clearly requires a longer silent operation. Inspect its result, branch, worktree, cleanup receipt, and any retained recovery workspace before relaunching.
9. Send correction only when it is necessary:
   `sulla agents/send_job_message '{"jobId":"<job-id>","taskIndex":0,"message":"The acceptance check still fails at <path>. Continue on the existing branch and return the corrected result."}'`
   Omit `taskIndex` to target every queued or running task. Put all known direction in the first launch: a mid-run message is injected at a model-call boundary and can cause some workers to finish their current line of work early.
10. Stop a misfired, duplicate, obsolete, or stalled job:
    `sulla agents/stop_agent_job '{"jobId":"<job-id>"}'`
    Stop is cooperative; an in-flight model or tool call can finish first. Check the job once afterward to confirm `stopped`.
11. Recover instead of restarting blindly. Read what the job left. Relaunch from its pushed branch or retained workspace with the exact remaining gap. If the same model or provider repeatedly fails, choose a different suitable agent from the directory.
12. Judge and integrate the result yourself with the `sulla-judge-and-land-worker-results` skill. A returned contract is evidence to inspect, not proof that the goal is complete.

**Task fields:**
- `prompt` is required.
- `agentId` selects a database-backed enabled agent; `agentName` is an alias.
- `label` names the job or tab.
- `visibility` is `hidden` by default or `tab`.
- `contract` names and optionally defines the JSON Schema the child must return. Without it, the default result is `{status, summary, output}`.
- `runLocation` may override one run with `vm` or `container`; it does not change the agent definition.
- `model` and `provider` are per-run overrides and fail rather than silently falling back when they cannot be resolved.
- `workspacePath` lets a container job seed its isolated workspace from an existing worktree under `/mnt/worktrees`; shared Git metadata is not mounted.
- `projectTaskId` is only a legacy correlation id. It does not claim project work.

**Check it worked:**
- The launch returned a `jobId`, and the directory shows the intended agent and label.
- Meaningful check-ins arrive with concrete progress or blockers.
- The final result matches the contract and the brief's definition of done.
- Your own review confirms the deliverable, tests or static checks, pushed state, and cleanup.

**Don't:**
- Don't delegate work that is faster to do than to brief and review.
- Don't choose by agent name alone. Use the directory card and cost tier.
- Don't launch overlapping writers on the same files or branch.
- Don't wait on a job when other independent work can move.
- Don't repeatedly poll. Results wake the parent.
- Don't accept the worker's summary without reading the actual output and diff.
- Don't use deprecated agent conversation tools for new delegated work.
