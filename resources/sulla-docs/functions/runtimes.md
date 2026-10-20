# Sulla Functions — Runtimes

## Python (port 30118)

**Entrypoint syntax:** `main.py::handler`

**Handler signature:**
```python
def handler(inputs: dict) -> dict:
    # inputs: dict of input values from function.yaml spec.inputs
    # return: dict of output values matching spec.outputs
    return {"key": value}
```

**Dependency file:** `requirements.txt` (optional, pip format)
```
requests==2.31.0
pandas>=2.0
```

**Minimal example:**
```python
def handler(inputs):
    name = inputs.get("name", "world")
    return {"greeting": f"Hello, {name}!"}
```

**File I/O example:**
```python
import json
import os
from datetime import datetime, timezone

def handler(inputs):
    path = os.path.expanduser("~/sulla/content/output.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    
    data = {"timestamp": datetime.now(timezone.utc).isoformat(), "inputs": inputs}
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    
    return {"success": True, "path": path}
```

**Compatibility:** `"python>=3.10"`

---

## Node.js (port 30120)

**Entrypoint syntax:** `main.js::handler`

**Handler signature:**
```javascript
export async function handler(inputs) {
    // inputs: object of input values
    // return (or resolve): object of output values
    return { key: value };
}
```

**Must be ESM** — `package.json` must have `"type": "module"`.

**package.json:**
```json
{
  "name": "my-function",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "main.js"
}
```

**Minimal example:**
```javascript
export async function handler(inputs) {
    const text = inputs.text ?? "Hello World";
    return {
        reversed: text.split("").reverse().join(""),
        length: text.length
    };
}
```

**Compatibility:** `"node>=20"`

---

## Shell (port 30119)

**Entrypoint syntax:** `main.sh` (no `::function`)

**Handler mechanism:**
- Inputs are passed as a JSON document on **stdin**
- Outputs must be written as a JSON document to **stdout**
- Exit code is captured; stderr is captured separately

**Handler pattern:**
```bash
#!/usr/bin/env bash
set -euo pipefail

# Read inputs from stdin
inputs_json="$(cat)"

# Parse with jq
my_param=$(echo "$inputs_json" | jq -r '.my_param // "default"')

# Also available as INPUT_* env vars
# detail="${INPUT_detail:-basic}"

# Do work...
result="done"

# Output JSON to stdout
cat <<JSON
{
  "result": "$result",
  "param_used": "$my_param"
}
JSON
```

**Dependency file:** `packages.txt` (optional, Alpine package names)
```
curl
jq
git
```

**Compatibility:** `"bash>=5"`

---

## Runtime Ports & Health

| Runtime | Port | Health check |
|---------|------|-------------|
| Python | 30118 | `curl http://127.0.0.1:30118/health` |
| Shell | 30119 | `curl http://127.0.0.1:30119/health` |
| Node | 30120 | `curl http://127.0.0.1:30120/health` |

`function_list` reads Postgres only. It does not contact the runtimes, so a successful list doesn't prove they're up. Check the health URLs above.

Inside a workflow, a function node starts an on-demand runtime container from the `sulla-python-runtime`, `sulla-shell-runtime`, or `sulla-node-runtime` image (`services/sulla-workflows/src/runtime.ts`).

---

## How Invocation Works

`function_run` (the tool) does this in one call:

1. Loads the function's files from Postgres (`function_definitions`) and writes them to a temporary folder for this call
2. Reads `spec.runtime`. Unknown runtimes fail here
3. If the stored files include a deps file (`requirements.txt`, `package.json`, or `packages.txt`), POST `/<runtime>/install`
4. POST `/<runtime>/load` with `{name, version}`
5. If `spec.integrations` is set, resolves vault env vars for this call
6. POST `/<runtime>/invoke` with `{name, version, inputs}` (plus `env` when vault values resolved)
7. Removes the temporary folder and POSTs `/<runtime>/unload`
8. Writes one row to `function_runs`

The runtime returns `{outputs, duration_ms}`. `function_run` returns the trace plus `outputs`.

---

## Input/Output Flow

```
function_run: { slug: "my-func", inputs: { n: 10 } }
  ↓ function loaded from Postgres
  ↓ handler({ n: 10 }) called in the runtime
  ↓ handler returns { result: 42 }
  ↓ a workflow function node exposes that object as {{My Func Node}}
```
