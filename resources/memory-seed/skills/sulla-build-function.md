---
slug: sulla-build-function
label: Build, publish, and run a deterministic Sulla function
trigger_when: When repeated work should become typed Python, Node, or shell code callable directly by agents and inside workflows.
trigger_actions: [build function, create custom function, run function, publish function, add function node]
trigger_phrases: [custom function, function.yaml, deterministic handler, runtime function, Python tool, Node tool, shell tool]
scope: [sulla-functions]
---

**Do:**
1. Confirm the work is deterministic. Keep judgment, prose, and ambiguous classification in an agent or router.
2. Pick a kebab-case slug. Create `function.yaml` and its entrypoint under `/mnt/sulla-files/Use Cases/functions/<slug>/`. Normal file writes create draft versions.
3. Declare every input and output. Use a short timeout and the least permissions. Never embed credentials.
4. For a small Python example, save these two files:

```yaml
# function.yaml
apiVersion: sulla/v1
kind: Function
id: function-normalize-lines
slug: normalize-lines
name: Normalize lines
description: Trims, removes blank lines, and de-duplicates text lines.
schemaversion: 1
spec:
  runtime: python
  entrypoint: main.py::handler
  inputs:
    text:
      type: string
      description: Newline-delimited text.
      required: true
  outputs:
    lines:
      type: array
      description: Unique non-empty lines in first-seen order.
    count:
      type: number
      description: Number of returned lines.
  timeout: 10s
  permissions:
    network: []
```

```python
# main.py
def handler(inputs: dict) -> dict:
    seen = set()
    lines = []
    for raw in str(inputs.get("text", "")).splitlines():
        value = raw.strip()
        if value and value not in seen:
            seen.add(value)
            lines.append(value)
    return {"lines": lines, "count": len(lines)}
```

5. Review the Files history for each file: `sulla files/history '{"path":"/mnt/sulla-files/Use Cases/functions/normalize-lines/function.yaml"}'` and the same command for `main.py`.
6. Request publication for each returned draft version: `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<version-id>","reason":"Reviewed function definition and handler"}'`. The function is not active until the human approves publication.
7. After publication and indexing, confirm registration: `sulla function/list '{}'`.
8. Run real input: `sulla function/run '{"slug":"normalize-lines","inputs":{"text":" beta\nalpha\nbeta "}}'`. Expect `lines` to be `["beta","alpha"]` and `count` to be `2`.
9. Inspect the recorded invocation: `sulla function/runs '{"slug":"normalize-lines","limit":1,"verbose":true}'`.
10. Use it in a workflow node:

```yaml
- id: node-20
  type: workflow
  position: { x: 400, y: 100 }
  data:
    subtype: function
    category: agent
    label: Normalize lines
    config:
      functionRef: normalize-lines
      inputs:
        text: "{{trigger}}"
      integrationAccounts: {}
      timeoutOverride: null
```

11. Validate and live-run the workflow. Confirm the next node receives `{{node-20.result}}`.

**Check:** The direct run succeeds, its history row is successful, the workflow run succeeds, and both paths return the same output shape.

**Don't:** Put secrets in inputs or outputs, return unbounded data, or add model work around a result that code can already structure.
