---
slug: sulla-agents
kind: system
name: Sulla agents
parent: sulla
aliases: [agents, workers, sub-agents, spawn_agent, agent jobs, delegation, check-ins, agent directory]
---

## Overview
Sulla launches bounded agent jobs with `meta/spawn_agent`. The live directory describes which enabled agents to call, what to send, what they return, and their cost tier. Hidden jobs run asynchronously in the background. Tab jobs open visible agents that can lead their own team or run a Playbook. Every job has a return contract, progress check-ins, messaging, stop control, and parent wake-up on completion. The parent remains responsible for the goal, reviews the actual result, and integrates or recovers the work.

## Facts
- `agents/directory` returns callable agent cards with `whenToCall`, `whenNotToCall`, `send`, `returns`, `costTier`, and `canCall`.
- `meta/spawn_agent` requires a non-empty `tasks` array, accepts at most 10 tasks, and defaults to parallel asynchronous execution.
- Each task requires `prompt`; it may set `agentId`, `agentName`, `label`, `visibility`, `contract`, `runLocation`, `model`, `provider`, `workspacePath`, `projectTaskId`, and tab-only `focus`.
- A non-empty `agentId` or `agentName` must resolve to an enabled definition. An invalid selector is rejected instead of falling back.
- `visibility` defaults to `hidden`. `tab` requires an active chat thread and a routable enabled agent.
- Async launch returns a `jobId`. Completion is delivered to and wakes the parent graph; `check_agent_jobs` is a fallback and history read.
- `agents/check_agent_jobs` returns job results and per-task status, elapsed time, visibility, contract, latest check-in, check-in history, blockers, files, and queued-message counts.
- `agents/send_job_message` targets a running job and optional zero-based task index. Delivery is live when possible or queued for the next model-call boundary.
- `agents/stop_agent_job` stops cooperatively. An in-flight model or tool call can finish before the task unwinds.
- A delegated child records milestones with `agents/report_progress` and finishes with `agents/return_result`; a contract mismatch is refused.
- Container jobs use isolated guest workspaces. Cleanup removes safe workspaces and reports a recovery path when a workspace must be retained.
- Completed jobs are kept for a limited history period; `check_agent_jobs` reports when a requested job has expired.

## Rules
- DO: Compare the cost of briefing and reviewing with doing the work yourself. Why: delegation has real overhead.
- DO: Pick the cheapest directory agent likely to get the work right; use the strongest suitable agent for critical or previously failed work. Why: quality and cost both matter.
- DO: Put the full context, boundaries, definition of done, and return shape in the first prompt. Why: missing context causes questions, rework, and interrupted runs.
- DO: Run independent work in parallel waves within machine limits, with one writer per file set. Why: safe parallelism saves time without creating conflicts.
- DO: Give each coding worker its own worktree and branch and require frequent pushes. Why: restarts can destroy unpushed work.
- DO: Treat about 15 minutes without a useful check-in, or an ended task without a result, as a recovery signal. Why: dead work should not strand the goal.
- DO: Resume from the pushed branch or retained workspace and re-brief the exact gap. Why: recovery should preserve completed work.
- DO: Review the diff and acceptance evidence before integrating. Why: a worker's summary and a valid contract are not proof.
- DO: Use a different agent to review high-stakes work. Why: independent review catches correlated mistakes.
- DON'T: Poll running jobs. Why: completion wakes the parent and needless polling wastes time.
- DON'T: Hand ownership of the goal to a worker. Why: the launching agent remains accountable for integration, verification, and cleanup.
