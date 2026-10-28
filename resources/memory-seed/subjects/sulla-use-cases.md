---
slug: sulla-use-cases
kind: system
name: Sulla Use Cases
parent: sulla
aliases: [Use Cases, use cases, recipes, skills, agents, workflows, functions]
---

## Overview
Use Cases are installable artifacts stored in Sulla Files under the Use Cases area. A use case can bundle an agent, skill, workflow, function, recipe, or integration. New or edited artifacts remain drafts until a file version is requested for publication and a human approves it in Decide. Marketplace download installs artifacts transactionally; it is separate from local authoring and publication.

## Facts
- The supported artifact kinds include package, workflow, agent, skill, function, integration, and recipe.
- New bundles keep kind-specific required files together: `SKILL.md`, `function.yaml` plus entrypoint, `routine.yaml`, or `installation.yaml` plus Compose.
- `marketplace/scaffold` generates a local skeleton; `marketplace/validate` checks its kind-specific shape.
- Agents are local-only for marketplace publishing at present; they can be exported as manifests but are not currently published through the catalog.
- A missing `sullaApi` can use the legacy compatibility path, but new Extension Contract v1 artifacts should declare `sullaApi: ^1.0.0`.

## Rules
- DO: Validate before requesting publication. Why: drafts are invisible to runtime until approved and published.
- DO: Request publication through Files and wait for Decide approval. Why: writing a draft is not authorization to activate it.
- DON'T: call a draft as if it were installed. Why: only published/installed versions become runtime-visible.
