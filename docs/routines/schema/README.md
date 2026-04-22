# Routines — Schema & Design

**Status:** Draft
**Date:** 2026-04-21
**Scope:** Defines what a **Routine** is in Sulla Desktop, how it is stored, and how it relates to **Functions** and the **runtime containers** that execute code.

> **Heads-up:** "Routine" is the new name for what used to be called a **workflow** inside Sulla Desktop. The old `workflow` terminology is being retired. If a doc, database column, IPC name, or type still says `workflow`, read it as "routine." See [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md) for the rename plan.

---

## 1. What is a Routine?

A **Routine** is a directed acyclic graph (DAG) of nodes and edges — the thing you build on the Sulla canvas. It is the unit of **composition** in Sulla. A routine describes *what happens when*: which node fires first, which nodes branch, which nodes wait, which nodes invoke code, which nodes call agents.

A routine is **not** a unit of code. Code lives in [functions](../../functions/schema/README.md). A routine that needs to run user-written code places a **function node** (`subtype: 'function'`) on its canvas, and that node HTTP-POSTs to the matching runtime container.

In concrete terms:

- **Canvas model:** nodes (typed, per-node config) + edges + viewport + top-level metadata.
- **Storage:** rows in the Postgres `workflows` table. The graph lives in the `definition` JSONB column. (The table is called `workflows` for historical reasons — it stores routines.)
- **Export format:** `routine.yaml`, a YAML serialization of the same JSONB document. Used for sharing, git check-in, backup. Not the source of truth.
- **Execution:** the existing workflow playbook / DAG walker walks the graph and dispatches each node to the appropriate handler (agent, integration call, function runtime, etc.).

Routines are **installation-scoped**. They're built and edited on the canvas, saved to the local Postgres, and optionally exported to YAML for version control. There is no global registry, no semver, no publish step, no trust tier, no signature. Those concepts were an earlier mis-design that conflated routines with functions; they no longer apply here.

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

## 4. Storage

Routines live in Postgres. The canvas is the author, the database is the source of truth, YAML is an export format. See [workflow-storage.md](./workflow-storage.md) for the table schema, migration path, and how this wires into existing code.

```
Canvas edit ──► debounced save ──► UPDATE workflows SET definition = <jsonb>, updated_at = now()
                                    INSERT INTO workflow_history (before, after, ...)
```

There are no files under `~/sulla/routines/` in the new model. Export produces a standalone `routine.yaml` you can put anywhere.

---

## 5. Files in this directory

| File                      | Purpose                                                                 |
|---------------------------|-------------------------------------------------------------------------|
| `README.md`               | This document.                                                          |
| `routine.schema.json`     | JSON Schema for the routine document (canvas JSONB and exported YAML).  |
| `runtime-containers.md`   | What the python/shell/node runtime containers are and how they run functions. |
| `workflow-storage.md`     | Postgres storage model for routines, and the workflow→routine cutover plan. |
| `workflow-integration.md` | Short migration note: routines *are* workflows. Kept to avoid broken links. |
| `examples/minimal-routine/` | A tiny example routine with one function-node and one response-node.   |

---

## 6. Open questions

- **Workflow→routine rename rollout.** The code still uses `workflow`/`Workflow` in types, tables, IPC names, and file paths. The docs are leading; the code renames happen in follow-up patches. Tracked in [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md).
- **Export schema versioning.** Exported `routine.yaml` should probably carry a `schemaVersion` field so future schema drifts can import old files. Currently piggy-backing on `WorkflowDefinition.version: 1`.
- **Cross-machine routine sync.** Still open — see workflow-storage.md section 10.
