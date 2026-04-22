# Routines — Schema & Design

**Status:** Draft
**Date:** 2026-04-21
**Scope:** Defines what a **Routine** is in Sulla Desktop, how it is stored, and how it relates to **Functions** and the **runtime containers** that execute code.

> Routines are **one of four peer kinds** in the bundle model — routines, skills, functions, recipes. Each has its own on-disk folder layout and runtime concerns, but they share the same import/export/publish/install flow. See [`../../bundles/README.md`](../../bundles/README.md) for the cross-kind contract.

> **Heads-up:** "Routine" is the new name for what used to be called a **workflow** inside Sulla Desktop. The old `workflow` terminology is being retired. If a doc, database column, IPC name, or type still says `workflow`.

---

## 1. What is a Routine?

A **Routine** is a directed acyclic graph (DAG) of nodes and edges — the thing you build on the Sulla canvas. It is the unit of **composition** in Sulla. A routine describes *what happens when*: which node fires first, which nodes branch, which nodes wait, which nodes invoke code, which nodes call agents.

A routine is **not** a unit of code. Code lives in [functions](../../functions/schema/README.md). A routine that needs to run user-written code places a **function node** (`subtype: 'function'`) on its canvas, and that node HTTP-POSTs to the matching runtime container.

In concrete terms:

- **Canvas model:** nodes (typed, per-node config) + edges + viewport + top-level metadata.
- **Runtime storage:** rows in the Postgres `workflows` table. The graph lives in the `definition` JSONB column. (The table is called `workflows` for historical reasons — it stores routines.) This is the source of truth for the DAG walker.
- **Authorship bundle:** a folder at `~/sulla/routines/<slug>/` containing `routine.yaml` plus supporting files (`AGENT.md`, `skills/`, `prompts/`, `references/`, `assets/`, `examples/`, …). Folders in this directory show up in the **My Templates** tab. See [folder-layout.md](./folder-layout.md) for the full layout.
- **Distribution format:** a `.routine.zip` containing the bundle. Produced by export, consumed by import.
- **Execution:** the DAG walker reads from Postgres and dispatches each node to the appropriate handler (agent, integration call, function runtime, etc.).

### Templates vs. routines

| | Templates | Routines |
|---|---|---|
| Where | `~/sulla/routines/<slug>/` (folders on disk) | Postgres `workflows` table |
| Tab | **My Templates** | **My Routines** |
| Role | Reference library / starting point | Your editable, runnable instance |
| Created by | Import, or hand-authored on disk | Instantiating a template, or creating blank |
| Edited by | Finder / git / text editor | The Sulla canvas |
| Execution | Not directly — must be instantiated first | Yes, by the DAG walker |

A routine carries an optional `source_template_slug` column pointing back to the template it was instantiated from. Export uses this to re-bundle sibling files (AGENT.md, skills/, etc.) alongside the current DB definition.

Routines are **installation-scoped**. There is no global registry, no semver, no publish step, no trust tier, no signature. Distribution is by hand — you zip, you share, someone imports.

---

## 2. Routine = Workflow (DAG)

The shape of a routine is identical to the existing `WorkflowDefinition` TypeScript interface in `pkg/rancher-desktop/pages/editor/workflow/types.ts`:

```ts
interface WorkflowDefinition {
  id:          string;
  name:        string;
  description: string;
  version:     1;
  createdAt:   string;
  updatedAt:   string;
  nodes:       WorkflowNodeSerialized[];
  edges:       WorkflowEdgeSerialized[];
  viewport?:   { x: number; y: number; zoom: number };
}
```

See [routine.schema.json](./routine.schema.json) for the formal schema (it mirrors this shape exactly).

Every node has a `subtype` drawn from `WorkflowNodeSubtype` — including the new `subtype: 'function'` that invokes a function (see section 3).

---

## 3. How a routine invokes code: the function node

The canvas has a **Function** node (`subtype: 'function'`, category `agent`). Its config is `FunctionNodeConfig`:

```ts
interface FunctionNodeConfig {
  functionRef:     string;  // slug of a function at ~/sulla/functions/<slug>/
  inputs:          Record<string, string>;                                       // template-aware
  vaultAccounts:   Record<string, { accountId: string; secretPath: string }>;    // per-node secret binding
  timeoutOverride: string | null;
}
```

When the playbook walker reaches a function node:

1. It reads `~/sulla/functions/<functionRef>/function.yaml` to learn the function's runtime (python/node/shell), declared inputs/outputs, and env/secret requirements.
2. It resolves `inputs` via the normal `{{variable}}` template substitution.
3. It resolves `vaultAccounts` to actual secret values from the Sulla vault.
4. It HTTP-POSTs `/invoke` on the matching runtime:
   - `python-runtime` → `http://127.0.0.1:30118/invoke`
   - `shell-runtime`  → `http://127.0.0.1:30119/invoke`
   - `node-runtime`   → `http://127.0.0.1:30120/invoke`
5. The runtime loads `/var/functions/<slug>/` (bind-mounted from `~/sulla/functions/`) and executes the declared entrypoint.
6. The response is attached to the node's output and becomes addressable downstream as `{{ <node-id>.output.<field> }}`.

Runtimes execute **functions**, never routines. Routines are orchestrated by the in-process DAG walker.

---

## 4. Storage: DB vs. disk

Two separate stores, linked by `source_template_slug`:

```
Postgres `workflows` table                ~/sulla/routines/<slug>/
─────────────────────────────             ────────────────────────
id, name, description, version            routine.yaml       ← DAG (same schema as the JSONB)
status, enabled                           AGENT.md           ← orchestrator instructions
definition (JSONB) ◄───── canvas          README.md          ← human-facing doc
source_template_slug ────────────────►    skills/, prompts/, references/, assets/, examples/, functions/
created_at, updated_at                    .routine-meta.yaml ← exporter-managed metadata
```

**The canvas writes only to Postgres.** Folders on disk are never auto-updated by the app. They are touched only by explicit user actions: Import (unpacks into a new folder) and the template being hand-authored in a text editor.

```
Canvas edit ──► debounced save ──► UPDATE workflows SET definition = <jsonb>, updated_at = now()
                                    INSERT INTO workflow_history (before, after, ...)
```

**Import** unpacks a `.routine.zip` (or a folder the user picks) into `~/sulla/routines/<slug>/`. Slug collisions get suffixed (`-2`, `-3`, …). The DB is not touched — the new template appears in **My Templates** on next scan. Getting it into the DB is a second user action (clicking "Use template" / instantiate).

**Export** pulls from the DB (the source of truth for the DAG). If the routine has a `source_template_slug` pointing to a still-present template folder, the exporter copies that folder into a temp dir, overwrites `routine.yaml` with the current DB definition (stripped of runtime state), updates `.routine-meta.yaml`, zips it, and writes to a user-picked location. If no source template exists, the bundle contains only the seeded minimum. **Export never writes back to `~/sulla/routines/`** — shared artifacts go wherever the user chooses.

Exporting a template (from **My Templates**) is a simpler path: just zip the existing folder as-is. The DB is not involved.

See [folder-layout.md](./folder-layout.md) for the full per-file spec and [routine.schema.json](./routine.schema.json) for the formal schema of `routine.yaml`.

---

## 5. Files in this directory

| File                        | Purpose                                                                 |
|-----------------------------|-------------------------------------------------------------------------|
| `README.md`                 | This document.                                                          |
| `folder-layout.md`          | Per-file spec for the `~/sulla/routines/<slug>/` template folder.       |
| `routine.schema.json`       | JSON Schema for the `routine.yaml` document (canvas JSONB + YAML export). |
| `examples/minimal-routine/` | A tiny example template folder — heartbeat → function → response.       |

---

## 6. Open questions

- **Workflow→routine rename rollout.** The code still uses `workflow`/`Workflow` in types, tables, IPC names, and file paths. The docs are leading; the code renames happen in follow-up patches. Tracked in [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md).
- **Bundle schema versioning.** `.routine-meta.yaml` carries a `bundleSchemaVersion` so the importer can refuse or migrate future layouts. `routine.yaml` itself still uses `version: 1` for the DAG-document shape — the two are independent.
- **Cross-machine routine sync.** Export/import handles one-shot sharing. Continuous sync (git-backed templates, remote registries) is out of scope.
- **AGENT.md spec.** The frontmatter fields (`name`, `summary`, `triggers`, `required_integrations`, `required_vault_accounts`, `required_functions`, `entry_node`) are described in `folder-layout.md` but don't yet have their own JSON Schema. Add one if the field set stabilizes.
