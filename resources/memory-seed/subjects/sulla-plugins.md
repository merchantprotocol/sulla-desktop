---
slug: sulla-plugins
kind: system
name: Sulla plugins
parent: sulla
aliases: [plugin, plug-in, add-on, extension, build for Sulla, extend Sulla]
---

## Overview
A Sulla plugin is the smallest installable artifact that adds a capability without changing Desktop core. Use a skill for reusable instructions, a function for deterministic Python, Node, or shell code, a workflow for orchestration, an agent for a named specialist, and a recipe for a Docker Compose service. Use an ordinary integration artifact to describe auth and REST or MCP endpoints. A signed integration package is the harder security boundary for executable catalog code that can reach only declared proxy paths. Extension Contract v1 lets installed functions handle granted hooks and contribute declarative UI. A memory pack is a skill that installs subjects and skills into subject memory. Start with `sulla-build-a-plugin`, then use the focused integration, recipe, or hooks/UI skill.

## Facts
- Files drafts live under `Use Cases/skills`, `functions`, `workflows`, `agents`, `recipes`, and `integrations`, each in a folder named for its slug; drafts need Files publication and human approval before runtime activation.
- A skill uses `SKILL.md`; a function uses `function.yaml` plus its entrypoint; a workflow uses `routine.yaml`; an agent is edited in Agents and exported as a `sulla/v3` manifest.
- A recipe uses `manifest.yaml`, `installation.yaml`, `docker-compose.yml`, and usually an icon; its service lifecycle is managed by the `extensions` tools.
- An ordinary integration uses `<slug>.v<N>-auth.yaml`, one or more `<name>.v<N>.yaml` endpoint manifests, and preferably `INTEGRATION.md`.
- A signed integration package uses an `apiVersion: sulla/v1`, `kind: integration` package manifest plus entry files and is persisted immutably in the `integration_packages` database table after marketplace installation.
- A memory pack is `Use Cases/skills/<pack-slug>/SKILL.md` with `memory_pack: true` and a `memory/` tree containing its own versioned manifest, subjects, and skills.
- Marketplace kinds are `package`, `workflow` (also accepted as `routine`), `agent`, `skill`, `function`, `integration`, and `recipe`; agents are currently local-only for marketplace publishing.
- `marketplace/scaffold` creates a database draft; `marketplace/validate` validates the saved local artifact; publishing the draft locally is separate from submitting it to the marketplace.
- Marketplace submission requires a Sulla Cloud session and starts as `pending`; only marketplace review makes it live.

## Rules
- DO: Pick the smallest plugin kind that fully solves the job. Why: smaller bundles are easier to audit, permission, test, and maintain.
- DO: Search the marketplace and inspect `examples/extensions/hello-*` before building. Why: an approved artifact or working starter may already fit.
- DO: Request only exact hooks, network access, proxy routes, scopes, ports, and files. Why: plugin boundaries are deny-by-default.
- DON'T: Treat writing Files drafts as installation. Why: drafts are invisible until Files publication is approved.
- DON'T: submit or publish without the human choosing Approve in `ask_user_question`. Why: marketplace submission is outward-facing.
- DON'T: put secrets, `.env`, keys, `.git`, dependency caches, or build output in a plugin. Why: packages must remain reviewable and safe to distribute.
