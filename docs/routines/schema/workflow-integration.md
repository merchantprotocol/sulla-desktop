# Routines ARE Workflows — Migration Note

This file used to describe how "workflows invoke routines." That design is dead. The new model is simpler:

**Routines replace workflows. They are the same thing.**

- What Sulla Desktop calls a *workflow* in its existing code (`WorkflowDefinition`, the `workflows` table, `WorkflowPlaybook`, `workflow-*` IPC handlers, the canvas) is henceforth called a **routine** in the docs and the product UI.
- The document shape is unchanged: nodes + edges + viewport + metadata. See [routine.schema.json](./routine.schema.json).
- The DAG walker that executes the graph is unchanged.
- The old `workflow` name will be retired from code over successive patches. When you see it, read it as "routine."

## What changed about invoking code?

Code lives in **functions** — separate from routines. See [../../functions/schema/README.md](../../functions/schema/README.md).

A routine invokes a function via the new **function node** (`subtype: 'function'`, category `agent`). That node HTTP-POSTs the matching runtime container (`python-runtime`, `shell-runtime`, or `node-runtime`) which executes the function code from `~/sulla/functions/<slug>/` and returns the result.

There is no separate "routine invokes routine" concept. A routine can place a `sub-workflow` node if it wants to run another routine as a step (same as before).

## What was deleted from this doc?

- The idea of a `routine` node subtype that resolves `routineRef: foo@1.2.3` to a versioned artifact. That artifact concept has been dropped; it was a conflation of routine (DAG) with function (code).
- Routine registry, publish step, semver pinning, `@latest` / `@draft` refs, trust tiers. None of those apply.
- `agent-runtime` as a fourth runtime. There are only three runtime containers: python, shell, node.

See [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md) for the full summary of the rename + split.
