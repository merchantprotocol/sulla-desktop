---
slug: sulla-use-cases
kind: system
name: Sulla Use Cases
parent: sulla
aliases: [Use Cases, skills, workflows, agents, functions, recipes, publish]
---

## Overview
Use Case definitions live in Sulla Files under `/mnt/sulla-files/Use Cases/<type>/<slug>/`. Types are `agents`, `skills`, `workflows`, `functions`, and `recipes`. Files is the source of truth; database rows are runtime indexes. Every edit is a draft and does not activate until the human approves publication in Decide. The runtime polls published versions and keeps the last valid definition active if a new one is invalid.

## Facts
- Agent definitions use `agent.json`; skills use `SKILL.md`; workflows use `workflow.yaml` or `routine.yaml`.
- Functions use `function.yaml` plus an entrypoint; recipes use an installation or manifest file plus a Compose file.
- Publishing an older version is the rollback path.

## Rules
- DO: Review the draft, then call `sulla files/request_publish` with its file and version identifiers.
- DON'T: Treat a draft as active or write runtime index tables directly.
- DON'T: Save definitions under `~/sulla/skills`, `~/sulla/agents`, or `~/sulla/workflows` and expect them to activate.
