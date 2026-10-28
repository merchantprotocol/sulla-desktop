---
slug: sulla-build-workflow
label: Build and validate a Sulla workflow
trigger_when: When a user wants a workflow created, validated, scheduled, dry-run, or executed.
trigger_actions: [build workflow, validate workflow, schedule workflow, dry-run workflow]
trigger_phrases: [build a workflow, workflow, schedule this, validate workflow]
scope: [sulla-workflows]
---

**Do:**
1. Read the workflow authoring and node-type docs needed for the requested graph.
2. Draft YAML with a trigger, connected nodes, required agent fields, and a clear completion contract.
3. Validate it: `sulla meta/validate_sulla_workflow '{"filePath":"<path>"}'`.
4. Import as a draft: `sulla workflow/import_workflow '{"slug":"<slug>","yaml":"<yaml>","status":"draft"}'`.
5. Dry-run safely with `sulla meta/dry_run_workflow '{"slug":"<slug>"}'`; execute only when the slug is available and the run is safe.
6. Use `sulla workflow/set_workflow_status '{"name":"<name>","status":"production"}'` to arm a schedule.

**Don't:**
- execute before structural validation and a dry run.
- guess trigger field names; read the current node schema.
