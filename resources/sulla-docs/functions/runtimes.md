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

If `function/function_list` returns results, all runtimes are up.

---

## How Invocation Works

1. Main process reads `~/sulla/functions/<slug>/function.yaml`
2. Installs dependencies if not cached: POST `/<runtime>/install`
3. Loads function: POST `/<runtime>/load` with `{name, version}`
4. Invokes: POST `/<runtime>/invoke` with `{name, version, inputs}`
5. Returns `{outputs: {...}, duration_ms: N}`

The `function/function_run` tool does steps 2–5 in one call.

---

## Input/Output Flow

```
function_run: { slug: "my-func", inputs: { n: 10 } }
  ↓ YAML loaded, inputs validated
  ↓ handler({ n: 10 }) called
  ↓ handler returns { result: 42 }
  ↓ Available as {{My Func Node}} in next workflow node
```
