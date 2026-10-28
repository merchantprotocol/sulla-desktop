---
slug: sulla-find-the-right-use-case
label: Find the right Sulla use case before building
trigger_when: When a job sounds like it needs a new skill, workflow, function, agent, integration, recipe, or package and you should check the existing catalog first.
trigger_actions: [find existing use case, compare marketplace options, choose a use case, search before building]
trigger_phrases: [is there already a use case, find an existing skill, search before building, do we have a workflow for this, marketplace alternatives]
scope: [sulla-marketplace, sulla-use-cases]
---

**Do:**
1. Describe the job in plain language and search the relevant kinds: `sulla marketplace/search '{"query":"<job and domain>","kinds":["workflow","skill","function","agent","recipe","integration"],"limit":25}'`.
2. Read details for the best matches: `sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'`. Compare trigger behavior, inputs and outputs, permissions, publisher, version, install state, and dependencies.
3. Prefer the smallest existing artifact that solves the job: a skill for guidance, a workflow for repeatable orchestration, a function for deterministic code or hooks, an agent for a specialized persona, a recipe for a container service, and an integration for a signed brokered API package.
4. Install only after review with `sulla marketplace/download '{"kind":"<kind>","slug":"<slug>","overwrite":false}'`; validate the result and follow the Files publication step if the tool returns a draft.
5. Build a new artifact only when no candidate fits, or when its permissions, lifecycle, or behavior cannot be safely adapted. Record why an existing candidate was rejected.

**Don't:** start by scaffolding, trust a title alone, or copy a listing's permissions without checking what the job actually needs.
