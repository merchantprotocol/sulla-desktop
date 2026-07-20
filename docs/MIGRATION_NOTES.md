# Migration Notes — Workflows → Routines, and the Routine/Function Split

**Date:** 2026-04-21
**Status:** Docs clarified. Code rename is follow-up work.

If you are catching up on the Sulla Desktop automation story and you see conflicting terms in the codebase vs. the docs, read this first.

## 1. The rename: workflow → routine

"Workflow" is being retired as a product term. The replacement is **routine**.

- A **routine** is what you draw on the Sulla canvas: a DAG of nodes and edges.
- The data model is unchanged. The `WorkflowDefinition` TypeScript type, the `workflows` Postgres table, the `workflow-*` IPC handlers, and the `WorkflowPlaybook` DAG walker all keep their names during the transition.
- When the docs say "routine" and the code says "workflow", they are referring to the same object.
- A later patch series will rename the code. Not this pass.

## 2. The split that wasn't obvious before: routine vs. function

Earlier drafts of the docs conflated two separate concepts. They are now distinct:

| Concept       | What it is                                      | Where it lives                            | Who executes it                       |
|---------------|-------------------------------------------------|-------------------------------------------|---------------------------------------|
| **Routine**   | A DAG (nodes + edges) authored on the canvas.   | Postgres `workflows.definition` JSONB.    | Workflow playbook (in-process walker) |
| **Function**  | A single unit of Python/Node/shell code.        | `~/sulla/functions/<slug>/` (per-function git repo). | One of three runtime containers       |

Routines do **not** have versions, trust tiers, publish steps, registries, or signatures. Those concepts were an earlier over-design that belonged to neither "routine as drawn on a canvas" nor "function as a small unit of code." They have been deleted from the docs.

Functions do **not** have versions either. Each function is its own git repo; routines always run HEAD from disk. Stability comes from git history, not semver pinning.

## 3. The function node

The bridge between routines and functions is the new canvas node:

- `subtype: 'function'`, category `agent`, defined in `pkg/rancher-desktop/pages/editor/workflow/nodeRegistry.ts`.
- Config type `FunctionNodeConfig` in `pkg/rancher-desktop/pages/editor/workflow/types.ts`.
- Points at a function by slug (`functionRef: dedupe-emails`). No `@version`.
- At execution time the playbook HTTP-POSTs `/invoke` on the runtime that matches the function's declared runtime.

## 4. The three runtime containers

Standalone repo: [`sulla-runtimes`](../../sulla-runtimes/). Each runtime container lives there — extracted out of sulla-desktop so CI can build + publish images to `ghcr.io/merchantprotocol/sulla-<name>` independently. Runtimes listen on `127.0.0.1:30118`, `:30119`, `:30120` respectively. Bind-mount `~/sulla/functions/` → `/var/functions` read-only. These execute **functions**, never routines.

An earlier doc draft also listed an `agent-runtime` — that has been dropped. Agent-style LLM nodes live as the `agent` subtype in a routine and talk to the Sulla LLM gateway directly.

## 5. Concrete doc changes in this pass

- `docs/routines/schema/README.md` — rewritten. Routines are DAGs; no versioning, no publish, no registry.
- `docs/routines/schema/routine.schema.json` — rewritten to mirror `WorkflowDefinition` (nodes + edges + viewport + metadata).
- `docs/routines/schema/frontmatter.schema.json` — **deleted** (routines live in the DB; no ROUTINE.md frontmatter).
- `docs/routines/schema/workflow-integration.md` — rewritten to a short migration note.
- `docs/routines/schema/runtime-containers.md` — swept to say "functions" not "routines"; ports and paths corrected; `agent-runtime` dropped; trust tiers dropped.
- `docs/routines/schema/workflow-storage.md` — terminology updated; `routineRef` examples replaced with `functionRef`; rename phase added.
- `docs/routines/schema/examples/fetch-stripe-invoice/` — **deleted** (that was a function, not a routine). Replaced with `examples/minimal-routine/` showing an actual DAG.
- `docs/functions/schema/README.md` — narrative updated; functions are a peer concept to routines, not "the lightweight version of a routine."
- `docs/functions/schema/function.schema.json` — unchanged (already correctly shaped).

## 6. What still needs to happen in code (not in this doc pass)

- Rename `WorkflowDefinition` → `RoutineDefinition` (type alias at minimum).
- Rename `workflows` table → `routines` (migration; keep view alias for compat).
- Rename `workflow-*` IPC handlers → `routine-*` (keep old names as shims for one release).
- Update UI labels from "Workflow" to "Routine" in the canvas and chrome.
- `sulla workflow export` → `sulla routine export`.

## 7. Migration-number collision: routine/heartbeat renumbered 0029-0032 → 0037-0040

**Date:** 2026-07-20

Two unmerged feature branches independently claimed migration numbers 0029+:

- `feat/crm-dynamic-schema-migrations` — adds **0029-0036** (CRM dynamic schema:
  record_types, fields, relationships, records, field_values, record_links,
  presentation, audit). These were **already executed on the production install**
  (recorded in `sulla_migrations`, `executed_at` 2026-06-25) — the running binary
  was built from this branch.
- The routine-stewardship / issue-discovery stack (#499/#500) — originally added
  **0029-0032** (routine_stewardship_views, routine_digest_views,
  routine_promotion_candidates_view, heartbeat_seen_issues) on a base off `main`
  that had neither set.

Because the migration runner (`DatabaseManager.runMigrations`) tracks applied
migrations **by name** and fails fast on any `up` error, and because production
had already consumed 0029-0036 for CRM, the routine/heartbeat migrations were
renumbered to **0037-0040** (same order). This makes them sort *after* the CRM
set regardless of the eventual merge order and keeps the registry unambiguous
once both branches land on `main`. The migrations were authored idempotently
(`CREATE OR REPLACE VIEW`, `CREATE TABLE/INDEX IF NOT EXISTS`) and their objects
already exist on the live DB, so re-running under the new names is a no-op that
simply records the 0037-0040 rows on the next boot.

Gaps in the sequence (missing 0003-0007, 0015) are pre-existing and harmless —
the runner iterates the registry array, not a contiguous range.
