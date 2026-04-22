# Functions — Schema & Design

A **function** is a single unit of executable code — Python, Node, or shell — that lives at `~/sulla/functions/<slug>/` and runs inside one of the Sulla [runtime containers](../../routines/schema/runtime-containers.md). Functions are the code-level building block of Sulla; [routines](../../routines/schema/README.md) are the orchestration layer that *calls* functions via the `subtype: 'function'` node on the canvas.

> Functions are **one of four peer kinds** in the bundle model — routines, skills, functions, recipes. They share the same marketplace bundle format and import/export/publish/install flow. See [`../../bundles/README.md`](../../bundles/README.md) for the cross-kind contract. The function-specific manifest summary (`functionSummary`) is derived from `function.yaml` at publish time.

## Functions vs. routines

| Functions                                                   | Routines                                                     |
|-------------------------------------------------------------|--------------------------------------------------------------|
| A single unit of code with a manifest.                      | A DAG of nodes and edges authored on a canvas.               |
| Live on disk: `~/sulla/functions/<slug>/`.                  | Live in Postgres: `workflows.definition` JSONB.              |
| Python, Node, or shell — declared in `function.yaml`.       | Not a language — an orchestration graph.                     |
| Executed by a runtime container (python/shell/node).        | Executed by the in-process workflow playbook (DAG walker).   |
| Addressed by slug (`functionRef: dedupe-emails`).           | Addressed by id (`workflow-...` / `routine-...`).            |
| Each function is its own git repo.                          | Not git-tracked; exported to YAML on demand.                 |

Functions are leaves. Routines compose them (and agents, triggers, routing, flow-control) into executable graphs.

## Directory layout

One directory per function, each its own git repo:

```
~/sulla/functions/<slug>/
├── FUNCTION.md         # Optional docs
├── function.yaml       # Manifest (validated against function.schema.json)
├── main.py             # Entrypoint (or main.js / main.ts / main.sh)
├── requirements.txt    # Optional — Python deps
├── package.json        # Optional — Node deps
├── apk.txt             # Optional — shell extras (alpine packages)
└── .gitignore
```

The runtime is declared in `function.yaml` (`spec.runtime: python|node|shell`) and is **not** overridden per-invocation. A function is bound to one runtime at author time.

## How a routine invokes a function

The routine canvas has a **Function** node (`subtype: 'function'`, category `agent`). Its config points at a function slug:

```yaml
# routine.yaml (excerpt) — one node in a routine's `nodes` array
- id: node-dedupe
  type: workflow
  position: { x: 400, y: 100 }
  data:
    subtype: function
    category: agent
    label: Dedupe Emails
    config:
      functionRef: dedupe-emails
      inputs:
        list: "{{ node-fetch.output.emails }}"
      vaultAccounts: {}
      timeoutOverride: null
```

When the playbook walker reaches the node:

1. Reads `~/sulla/functions/dedupe-emails/function.yaml` to learn the runtime.
2. Resolves `inputs` and `vaultAccounts`.
3. HTTP-POSTs `/invoke` on the matching runtime:
   - `spec.runtime: python` → `http://127.0.0.1:30118/invoke`
   - `spec.runtime: shell`  → `http://127.0.0.1:30119/invoke`
   - `spec.runtime: node`   → `http://127.0.0.1:30120/invoke`
4. The runtime loads `/var/functions/<slug>/` (bind-mounted read-only from `~/sulla/functions/`) and runs the declared entrypoint.
5. Output comes back as JSON and is attached to the node's output state.

## Version control

Each function is its own git repo (`git init` in each subdir). You can push to GitHub for sharing. There is **no version pinning** in `functionRef` — routines always run HEAD from disk. Editing a function changes behavior for every routine that calls it. If you want a stable snapshot, use git branches/tags at the repo level.

## Manifest

`function.yaml` is validated against [function.schema.json](./function.schema.json). The core shape:

```yaml
apiVersion: sulla/v1
kind: Function
id: function-<slug>
name: <display name>
description: <what and when>
schemaversion: 1
slug: <slug>

spec:
  runtime: python        # python | node | shell
  entrypoint: main.py::handler
  compatibility: "python>=3.12"
  inputs:
    <name>: { type: ..., required: ..., ... }
  outputs:
    <name>: { type: ..., ... }
  permissions:
    network: [ "api.example.com" ]
    env:     [ "API_KEY" ]
    secrets: [ "example/api_key" ]
  timeout: 30s
```

Functions intentionally drop everything that was speculative in earlier drafts:

- No `version` / `immutable` / `locked` / `trust` / `_status`.
- No registry, no publish step, no semver pinning.
- The manifest is the whole contract.

## Files in this directory

| File                   | Purpose                                    |
|------------------------|--------------------------------------------|
| `README.md`            | This document.                             |
| `function.schema.json` | JSON Schema for `function.yaml`.           |
