---
slug: sulla-repo-agent-runtime
kind: system
name: Sulla agent runtime source
parent: sulla-repository
aliases: [agent runtime source, agent code, prompts, tool manifests, built-in agents]
---

## Overview
The agent runtime is under `pkg/sulla-desktop/agent`. Nodes and controllers execute turns, prompt sections assemble system prompts, and tool manifests expose the `sulla <category>/<tool>` catalog. Database migrations create runtime state, while seeders install built-in agents, skills, observations, and memory data. The v7 subject-memory schema and memory seed are part of this runtime.

## Facts
- `agent/nodes` contains the turn and workflow execution nodes; `agent/controllers` contains orchestration controllers.
- `agent/prompts/sections` contains independently composed prompt sections, including safety, tooling, skills, memory, workspace, and completion wrappers.
- `agent/tools/<category>/manifests.ts` defines catalog metadata; `agent/tools/manifests.ts` and `agent/tools/registry.ts` assemble categories.
- Migration `0133_create_v7_subject_memory.ts` creates the v7 subject-memory schema, and `agent/memory/V7SubjectMemory.ts` implements its subject-memory access.
- Tests are colocated in `__tests__` directories under `pkg/sulla-desktop` and its subpackages, and are run through the repository Yarn test scripts.
