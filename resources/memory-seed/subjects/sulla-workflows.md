---
slug: sulla-workflows
kind: system
name: Sulla Workflows
parent: sulla
aliases: [workflows, routines, workflow, routine.yaml, workflow YAML]
---

## Overview
Sulla Workflows are YAML graphs of triggers and nodes. The graph definition is imported with `workflow/import_workflow`; its database status controls whether it runs, and only `production` workflows are scheduled. A new workflow should be drafted, validated, dry-run, imported as `draft`, and tested before publication. Workflows can call agents, functions, native tools, integrations, other workflows, and user approval steps.

## Facts
- Every node has `type: workflow`, a position, and `data` containing `subtype`, `category`, `label`, and `config`.
- New workflows should use `manual` or `schedule` triggers; legacy trigger subtypes may validate but should not be authored.
- `maxConcurrentRuns` is the root concurrency limit; the default is 1 and suspended waits still count.
- `preflight.functionRef` runs a local function before any model or agent work; missing or invalid `shouldRun` fails closed.
- `browser: true` grants scheduled graph-owned browser capability; use the native `browser_controller` tool call, not a nested CLI call.
- Templates resolve trigger data and node output; only `.result` and `.threadId` resolve on node references, and unresolved variables remain literal.
- `import_workflow` writes a draft to Sulla Files; publication is separate from import.

## Rules
- DO: Run `meta/validate_sulla_workflow` and `workflow/dry_run_workflow` before importing. Why: structural validity does not prove graph reachability or execution order.
- DO: Use `status: draft` while authoring. Why: the import default is production.
- DO: Use `sourceHandle: route-N` for router edges and the documented condition and loop handles. Why: handles determine graph traversal.
- DON'T: Treat moving a YAML file between folders as a status change. Why: the database row controls execution.
- DON'T: use `execute_workflow` for an unregistered or guessed slug. Why: it only executes an exact named workflow.
