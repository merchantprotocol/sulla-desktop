---
slug: sulla-workflows
kind: system
name: Sulla Workflows
parent: sulla
aliases: [workflows, routines, workflow, routine.yaml, workflow YAML, agent loop]
---

## Overview
Sulla Workflows are YAML graphs of triggers, work nodes, decisions, flow control, and I/O. Use them when work recurs or needs durable branching, retries, approval, scheduling, or checkpoints. Agent nodes spend model tokens; tool and function nodes do deterministic work without asking a model to repeat it. Draft definitions live in `Use Cases/workflows/<slug>/` in Sulla Files. Only a published version is indexed for execution.

## Facts
- Every serialized node has `type: workflow`, numeric `position`, and `data` with `subtype`, `category`, `label`, and `config`.
- Current node categories are `trigger`, `agent`, `routing`, `flow-control`, and `io`.
- Work subtypes include `agent`, `tool-call`, `integration-call`, `orchestrator-prompt`, and `function`.
- Routing subtypes are `router` and `condition`; flow-control includes `wait`, `loop`, `parallel`, `merge`, and `sub-workflow`.
- I/O includes `user-input`, `response`, `transfer`, and `desktop-notification`.
- A loop body leaves the loop through `loop-exit`, starts through `loop-start`, and returns through the loop node's `loop-back` target handle.
- A loop stops when its condition evaluates true or its iteration ceiling is reached. `maxIterations` defaults to 10 at runtime when absent or zero.
- Router outputs use `route-0`, `route-1`, and so on. Condition outputs use `condition-true` and `condition-false`.
- `user-input` pauses the run in `waiting` state until the human responds. Put it before any approval-gated action.
- Templates support `{{trigger}}`, `{{node-id.result}}`, `{{Node label.result}}`, and `{{node-id.threadId}}`. Loop bodies also support `{{loop.index}}` and for-each item fields.
- Unresolved templates remain literal. Node references expose only `result` and `threadId`.
- `maxConcurrentRuns` is the root concurrency limit. The default is 1, and suspended waits still count.
- `preflight.functionRef` runs a local function before model or agent work. A missing or invalid `shouldRun` result fails closed.
- Only `production` schedule workflows are armed. Publication activates a Files-backed workflow; database status and `enabled` control scheduling.

## Rules
- DO: Validate and dry-run every new or edited YAML before import. Why: schema validity and graph traversal catch different mistakes.
- DO: Give every loop a finite `maxIterations`, even when it has a stop condition. Why: the ceiling prevents runaway token use.
- DO: Put deterministic checks in functions and use their result to control a loop. Why: code is cheaper and more reliable than repeated model judgment.
- DO: Use `sourceHandle: route-N` for routers and the exact condition and loop handles. Why: handles select graph traversal.
- DO: Put `user-input` before an externally consequential step. Why: sends, posts, payments, and deletes require the human's tap.
- DON'T: Use legacy trigger subtypes for new workflows. Use `manual` or `schedule`. Why: legacy subtypes remain only for saved-workflow compatibility.
- DON'T: Treat a dry run as a successful live run. Why: it executes no node and causes no side effects.
- DON'T: Guess a workflow slug. Why: `execute_workflow` accepts only an exact registered workflow id.
