# Example: minimal-routine

The smallest useful routine. Three nodes, two edges:

```
  [heartbeat trigger] ──► [function: dedupe-emails] ──► [response]
```

- **heartbeat** — fires on the Sulla heartbeat interval.
- **function** — invokes `~/sulla/functions/dedupe-emails/` (declared in its own `function.yaml` as a Python function; the walker routes to `python-runtime` at `http://127.0.0.1:30118/invoke`).
- **response** — emits the deduped list back to the caller.

Files:

- `routine.yaml` — the exported routine document (validated against [../../routine.schema.json](../../routine.schema.json)). In the live system this same JSON lives in the `workflows.definition` column.

No code in this directory. Code is in `~/sulla/functions/dedupe-emails/` (a separate git repo with its own `function.yaml` + `main.py`).
