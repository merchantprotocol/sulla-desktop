# Example: minimal-routine

The smallest useful **template folder**. Demonstrates the three files present in most templates: `routine.yaml`, `README.md`, `AGENT.md`.

Three nodes, two edges:

```
  [heartbeat trigger] ──► [function: dedupe-emails] ──► [response]
```

- **heartbeat** — fires on the Sulla heartbeat interval.
- **function** — invokes `~/sulla/functions/dedupe-emails/` (declared in its own `function.yaml` as a Python function; the walker routes to `python-runtime` at `http://127.0.0.1:30118/invoke`).
- **response** — emits the deduped list back to the caller.

## Files

| File           | Purpose                                                                          |
|----------------|----------------------------------------------------------------------------------|
| `routine.yaml` | The DAG. Validated against [../../routine.schema.json](../../routine.schema.json). This is what gets loaded into the Postgres `workflows.definition` column when the template is instantiated. |
| `README.md`    | This file. Human-facing overview.                                                |
| `AGENT.md`     | Instructions for the orchestrating agent. Lists triggers, required integrations, required functions, and the entry node. |

## What's not here

- **Code.** The function logic lives at `~/sulla/functions/dedupe-emails/` (separate bundle with its own `function.yaml` + `main.py`). A richer template could ship its functions in a `functions/` subdirectory for portability — this one doesn't, to keep it minimal.
- **Skills, prompts, references, assets.** None needed for this routine. See [../../folder-layout.md](../../folder-layout.md) for the full set of directories a template can carry.
- **`.routine-meta.yaml`.** Only present in exported bundles. A hand-authored template doesn't need it.

## Using this template

1. Copy the folder to `~/sulla/routines/dedupe-emails/`.
2. It will appear in **My Templates** on next scan.
3. Click **Use template** to instantiate it into **My Routines** (creates a `workflows` row).
4. Ensure `~/sulla/functions/dedupe-emails/` exists before running.
