# Create-Workflow Skill — Mirror for sulla-docs

The live skill lives at `~/sulla/resources/skills/create-workflow/SKILL.md` and is what
the subconscious memory-recall agent surfaces when the human says "build me a workflow",
"create a routine", "make an automation", etc.

This file mirrors it inside sulla-docs so agents grepping the docs bundle can find the
same guidance without depending on the runtime skill being present. If the two drift,
the runtime file is canonical — sync this one to match.

---

## The canonical flow

1. **Confirm scope** (trigger kind, steps in English, branches, failure mode, schedule if any)
2. **Scaffold** — `sulla marketplace/scaffold '{"kind":"workflow","slug":"<slug>"}'`
3. **Draft** the YAML at `~/sulla/routines/<slug>/routine.yaml`
4. **Validate** — both passes:
   - `sulla meta/validate_sulla_workflow '{"filePath":"<path>"}'` (graph)
   - `sulla marketplace/validate '{"kind":"workflow","slug":"<slug>"}'` (kind-schema)
5. **Install to DB** — `sulla workflow/import_workflow '{"slug":"<slug>","status":"draft"}'`
6. **Display the workflow as an artifact** — `sulla workflow/display_workflow '{"slug":"<slug>"}'`.
   Reads the routine YAML and publishes it as a `workflow_document` event. The chat frontend
   opens (or updates in place) a workflow artifact whose payload IS the routine — zero
   field mapping. Deduped by workflow name.
7. **Iterate**: edit YAML → re-validate → re-import → re-run `display_workflow`
8. **Ship** — flip `status` to `"production"` on the final `import_workflow` call

---

## Why each step matters

| Step | What breaks if you skip it |
|------|---------------------------|
| Scaffold | Hand-rolled dirs tend to miss the companion files and the scaffolder-known shape — validator complains. |
| Graph validate | Bad `subtype ↔ category` pairs and missing required config fields don't fail until runtime. |
| Kind-schema validate | Slug/id/directory disagreement makes the DB upsert "succeed" but the editor can't find it. |
| DB install | A routine that only exists as YAML on disk is invisible to `execute_workflow` until imported. |
| Open editor | The human can't see a DB row — they need the Routines view focused on the draft. |
| Re-import after edits | YAML changes don't flow to the DB automatically. Every edit needs an `import_workflow` re-run. |
| Status `draft` during authoring | Leaving it `production` tells the scheduler to run a half-built workflow. |

---

## Display-as-artifact

Same artifact pane renders both authoring and execution. Two sources populate it:

1. **Authoring:** `sulla workflow/display_workflow '{"slug":"<slug>"}'` reads the
   routine YAML and publishes a `workflow_document` event. PersonaAdapter opens (or
   updates in place) a `workflow` artifact whose payload IS the routine — same
   `position.{x,y}`, same `data.{label,subtype,config}`, same `edges[].source/target`.
   Zero field mapping between the YAML and what the user sees.
2. **Execution:** the backend's per-node `workflow_node` events layer runtime state
   (`active`/`done`/`error`) onto the same artifact, matched by node id. No second
   card, no switcheroo — the graph the user was watching now animates as each step
   fires.

Dedup key is the workflow display name. Re-running `display_workflow` after each
edit updates the same card in place.

---

## Full skill content

See `~/sulla/resources/skills/create-workflow/SKILL.md` for the complete tool mapping,
minimum-viable-YAML template, iteration pattern, and hard rules. It's the skill the
recall agent surfaces to the primary agent — this sulla-docs entry is a pointer so
agents searching the docs bundle don't miss the reference.
