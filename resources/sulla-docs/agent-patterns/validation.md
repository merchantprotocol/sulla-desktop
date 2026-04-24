# Validation — The "Never Ship Unverified" Contract

Every artifact the agent creates or edits has a matching validator. Run it before reporting done. A silent schema bug in a saved artifact surfaces much later as a cryptic runtime failure; catching it at author time is free.

This is one doc per purpose, not per artifact. Specifics live in the per-artifact authoring guides (`workflows/authoring.md`, `functions/authoring.md`, etc.); this page is the **policy** everything else links back to.

## The rule

> **If you wrote it or changed it, validate it before you say it's done.**

No exceptions for "simple changes." The validators are fast (sub-second for everything except `marketplace/validate` for large routines). The cost of running them is zero; the cost of shipping a broken manifest is a user-reported bug.

## The validators, by artifact kind

| Kind | Primary validator | What it checks |
|------|-------------------|---------------|
| **Workflow / Routine** | `sulla meta/validate_sulla_workflow '{"filePath":"…"}'` | Graph structure, node↔category mapping, required config fields per subtype, edge structure, reachability, at least one trigger |
| **Workflow / Routine** (also) | `sulla marketplace/validate '{"kind":"workflow","slug":"…"}'` | Kind-schema level: top-level YAML keys, slug↔id agreement, manifest shape |
| **Function** | `sulla marketplace/validate '{"kind":"function","slug":"…"}'` | `function.yaml` shape, slug/id/directory agreement, inputs/outputs schema, runtime field, permissions block |
| **Skill** | `sulla marketplace/validate '{"kind":"skill","slug":"…"}'` | `SKILL.md` frontmatter, required fields |
| **Agent** | `sulla marketplace/validate '{"kind":"agent","slug":"…"}'` | `config.yaml` shape, soul.md present, integrations block |
| **Recipe** | `sulla marketplace/validate '{"kind":"recipe","slug":"…"}'` | `manifest.yaml`, `docker-compose.yml` present, installation.yaml shape |
| **Integration YAML** (e.g. `configapi` integrations) | `sulla configapi/configapi-validate '{"slug":"…"}'` | Integration spec shape, endpoint definitions |
| **Goal / Identity file** | Structural only — it's markdown. Read back after write. | Format matches existing files; no tool enforcement. |

When two validators apply (workflows, especially), run both. `meta/validate_sulla_workflow` catches graph-level bugs the kind schema doesn't see; `marketplace/validate` catches manifest-level bugs the graph validator doesn't know to look at.

## The validate-before-save pattern

For every artifact creation or edit, the flow is:

```
1. Read the relevant schema doc(s).
2. Draft in memory / buffer.
3. Write to disk.
4. Run the validator(s).
5. If errors → fix → re-validate.
6. If clean → report back to the user with a summary of what was written.
```

Step 4 is non-negotiable. Step 5 is a loop, not a single shot — fix all errors, re-run, repeat until clean.

**When writing to a template path** (`~/sulla/routines/…`, `~/sulla/skills/…`, `~/sulla/functions/…`, `~/sulla/recipes/…`, `~/sulla/integrations/…`) validation must pass before telling the user the artifact is ready.

**When writing to the workflows DB**, `meta/validate_sulla_workflow` must pass before the row is set to `status: "production"`. Draft rows with validation errors are tolerable (the user is still iterating); production rows are not.

## Interpreting validator output

All validators return `{ errors: [], warnings: [] }` or a `ValidationIssue[]` shape:

```json
{
  "severity": "error",
  "path":     "nodes[3].data.config.agentId",
  "message":  "agentId is required for agent-subtype nodes"
}
```

- **`severity: "error"`** → must fix before shipping. Treat the artifact as broken.
- **`severity: "warning"`** → surface to the user, don't block. Examples: orphan branch in a workflow that might be intentional, slug mismatch with filename.
- **`path`** → dotted path into the YAML. Walk it to the offending node and read the `message`.
- **`message`** → what's wrong. Usually actionable verbatim.

If a validator errors out with `"tool not available"` or similar, it means the relevant runtime isn't up (e.g. function runtimes down for `function_list`). Check `environment/docker.md` for the health-check call rather than skipping validation.

## Common validation pitfalls

- **`subtype` ↔ `category` mismatch.** Workflow nodes need both, and they must pair correctly (e.g. `subtype: agent` → `category: agent`, `subtype: router` → `category: routing`). `meta/validate_sulla_workflow` catches this.
- **Missing required config fields.** Per-subtype required keys are listed in `workflows/node-types.md`. Agent nodes in particular need `agentId`, `agentName`, `additionalPrompt`, `orchestratorInstructions`, `successCriteria`, `completionContract`.
- **Slug / id / directory disagreement.** A function at `~/sulla/functions/csv-to-json/` must have `slug: csv-to-json`, `id: function-csv-to-json`, and its `entrypoint` must reference a file that actually exists. All three must line up.
- **Output shape doesn't match `spec.outputs`.** Function validators can't catch this — only `function_run` can. Run the function with a minimal input and confirm the returned keys match `spec.outputs`.
- **Unreachable nodes.** Anything downstream of nothing means an edge is missing. Validator reports which node is orphaned.
- **Trigger required.** Every workflow must have at least one trigger node (`manual`, `schedule`, `chat`, `calendar`, `heartbeat`). Validator enforces.

## What validation does NOT catch

Validation is structural, not semantic. A workflow can be valid-by-schema and still do nothing useful. After validation passes, also:

- **Test-run functions** with a minimal input. Schema doesn't prove the handler works.
- **Dry-run workflows** via `meta/execute_workflow` when safe to do so — the user agrees it's idempotent or reversible.
- **Inspect outputs** from upstream nodes when a node template-references them (`{{Node Label}}`) — a valid graph can still pass the wrong shape between steps.

Semantic testing is per-turn judgment. Structural validation is mechanical — always run it.

## Reference

- Workflow graph validator: `pkg/rancher-desktop/agent/tools/workflow/validate_sulla_workflow.ts`
- Kind-schema validators: `pkg/rancher-desktop/agent/tools/marketplace/validate.ts`
- Integration validator: `pkg/rancher-desktop/agent/integrations/configApi/…`
- Per-artifact authoring guides: `workflows/authoring.md`, `functions/authoring.md`, `tools/marketplace.md`
