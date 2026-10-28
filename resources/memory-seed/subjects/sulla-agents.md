---
slug: sulla-agents
kind: system
name: Sulla agents
parent: sulla
aliases: [agents, workers, sub-agents, spawn_agent, agent jobs, delegation, check-ins]
---

## Overview
Sulla can launch bounded agent jobs from an active agent turn. `spawn_agent` accepts up to 10 tasks; each task can select an enabled agent definition, run in the VM or a container, and return a contract result. Hidden jobs run in the background; tab jobs open a live agent tab. Jobs retain status and check-ins for a limited period, and completion is delivered to the parent.

## Facts
- `meta/spawn_agent` takes a non-empty `tasks` array; each task needs a string `prompt` and may set `agentId`, `agentName`, `model`, `provider`, `runLocation`, `workspacePath`, `contract`, `visibility`, `focus`, and `label`.
- A spawn call accepts at most 10 tasks. Omit `agentId` for the default agent; a supplied selector must name an enabled agent definition.
- `visibility` is `hidden` by default or `tab`; a tab launch needs an active chat thread and a valid routable agent.
- `agents/check_agent_jobs` accepts optional `jobId` and returns job/task status, elapsed time, contract, results, check-ins, and undelivered orchestrator messages.
- `agents/report_progress` is available only inside a delegated task and requires `step` and `summary`; `percent`, `filesTouched`, and `blockers` are optional.
- A delegated child finishes with `agents/return_result` (alias `chat/return_contract`); its input must satisfy the task contract.
- `agents/send_job_message` is the job messaging path. `send_agent_message` is deprecated and returns guidance instead of sending.
- Container jobs receive an isolated guest workspace; an explicit `workspacePath` is seeded into that workspace. Cleanup can retain a recovery workspace when inspection says work is not safe to remove.
- The active-agent registry tracks agent id, name, role, channel, type, status, start time, last activity, description, and an optional status note.

## Rules
- DO: Give each task a self-contained brief with acceptance checks and a return contract. Why: workers cannot rely on unstated parent context.
- DO: Launch independent tasks in one `spawn_agent` call, then monitor with `agents/check_agent_jobs`. Why: jobs run asynchronously.
- DO: Send a `report_progress` check-in at meaningful milestones and include blockers. Why: parents can distinguish slow work from a stalled job.
- DO: Use `return_result` when the work is complete. Why: the contract validates the result and wakes the parent.
- DON'T: Poll a channel for a child reply or assume a job is done because the spawn call returned. Why: completion is asynchronous and delivered by the job system.
- DON'T: claim completion without checking the job result and reviewing the worker output. Why: a task can fail or return an invalid contract.
