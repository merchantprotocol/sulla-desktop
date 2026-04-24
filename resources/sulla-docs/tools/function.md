# Sulla Tools — Functions

## function/function_list

List all custom functions installed in `~/sulla/functions/`.

```bash
exec({ command: "sulla function/function_list '{}'" })
```

Returns an array of function metadata: `slug`, `name`, `runtime`, `entrypoint`, `inputs`, `outputs`.

---

## function/function_run

Execute a custom function by slug.

```bash
exec({ command: "sulla function/function_run '{\"slug\":\"test-python-math\",\"inputs\":{\"n\":15}}'" })
```

Parameters:
- `slug` (required): Directory name under `~/sulla/functions/`
- `inputs` (optional): Key/value object matching the function's declared inputs
- `version` (optional): Defaults to `"1.0.0"`

The call performs load + invoke in one step. Returns full execution trace:
```json
{
  "slug": "test-python-math",
  "runtime": "python",
  "duration_ms": 45,
  "outputs": {
    "fibonacci": 610,
    "primes": [2, 3, 5, 7, 11, 13]
  }
}
```

---

## Runtime Health Check

Verify runtimes are healthy before running functions:

```bash
exec({ command: "sulla function/function_list '{}'" })
```

If this returns functions, the runtimes are up. Ports:
- Python: `http://127.0.0.1:30118`
- Shell: `http://127.0.0.1:30119`
- Node: `http://127.0.0.1:30120`

---

## Creating a New Function

See `functions/schema.md` for the complete `function.yaml` spec and `functions/runtimes.md` for handler signatures.

Quick checklist:
1. Create `~/sulla/functions/<slug>/function.yaml`
2. Create handler file (`main.py`, `main.js`, or `main.sh`)
3. Test: `exec({ command: "sulla function/function_run '{\"slug\":\"<slug>\",\"inputs\":{...}}'" })`

---

## Example Invocations

```bash
# Python math function
exec({ command: "sulla function/function_run '{\"slug\":\"test-python-math\",\"inputs\":{\"n\":20}}'" })

# Node transform function
exec({ command: "sulla function/function_run '{\"slug\":\"test-node-transform\",\"inputs\":{\"text\":\"Hello World\"}}'" })

# Shell sysinfo function
exec({ command: "sulla function/function_run '{\"slug\":\"test-shell-sysinfo\",\"inputs\":{\"detail\":\"full\"}}'" })

# Social cache read
exec({ command: "sulla function/function_run '{\"slug\":\"social-cache-read\",\"inputs\":{\"max_age_days\":7}}'" })
```
