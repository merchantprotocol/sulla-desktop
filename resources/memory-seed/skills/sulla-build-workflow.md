---
slug: sulla-build-workflow
label: Build and validate a Sulla workflow
trigger_when: When you need to design or edit a workflow graph, routine YAML, trigger, node, route, loop, or approval step.
trigger_actions: [build a workflow, create a routine, edit workflow YAML, validate workflow]
trigger_phrases: [workflow, routine, workflow YAML, scheduled workflow]
scope: [sulla-workflows]
---

**When:** Build a graph from a plain-language trigger and steps.

**Do:**
1. Gather the trigger, steps, branches, failure behavior, and approval points.
2. Write YAML with root `id`, `name`, `description`, `version: 1`, `nodes`, and `edges`. Every node uses `type: workflow` and `data: {subtype, category, label, config}`.
3. Use `manual` or `schedule` triggers. Set `maxConcurrentRuns` when the default one-run ceiling is not enough.
4. Validate and dry-run: `sulla meta/validate_sulla_workflow '{"filePath":"<path>/routine.yaml"}'`, then `sulla meta/dry_run_workflow '{"filePath":"<path>/routine.yaml"}'`.
5. Import only as a draft: `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<complete YAML>","status":"draft"}'`.

**Don't:** publish or enable a workflow before validation and human approval.
