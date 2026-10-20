# Sulla Tools — Functions

Custom functions are stored in Postgres. Three tools: `function/list`, `function/run`, `function/runs`.

---

## function/list

List all custom functions stored in Postgres.

```bash
sulla function/list '{}'
```

Returns each function's `slug`, `name`, `runtime`, `entrypoint`, `inputs`, and `outputs`.

---

## function/run

Load and run a custom function by slug. The call performs load + invoke in one step and returns the full execution trace.

```bash
sulla function/run '{"slug":"test-python-math","inputs":{"n":15}}'
```

Parameters:
- `slug` (required): the function's slug from `function/list`
- `inputs` (optional): key/value object matching the function's declared inputs
- `version` (optional): version string for the runtime loader. Defaults to `"1.0.0"`

Every invocation writes a row to the `function_runs` table.

---

## function/runs

Read the run history.

```bash
sulla function/runs '{"slug":"test-python-math","only_failures":true}'
```

Params: `slug`, `only_failures`, `since` (ISO timestamp), `limit` (default 50), `verbose` (adds inputs and outputs).

---

## Runtime Health Check

Confirm runtimes are up before running functions:

```bash
sulla function/list '{}'
```

If this returns functions, the runtime manager is reachable. Ports:
- Python: `http://127.0.0.1:30118`
- Shell: `http://127.0.0.1:30119`
- Node: `http://127.0.0.1:30120`

---

## Creating a New Function

See `functions/schema.md` for the `function.yaml` spec and `functions/runtimes.md` for handler signatures.

---

## Example Invocations

```bash
# Python math function
sulla function/run '{"slug":"test-python-math","inputs":{"n":20}}'

# Node transform function
sulla function/run '{"slug":"test-node-transform","inputs":{"text":"Hello World"}}'

# Shell sysinfo function
sulla function/run '{"slug":"test-shell-sysinfo","inputs":{"detail":"full"}}'
```
