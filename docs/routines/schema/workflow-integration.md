# Workflow ↔ Routine Integration

How Sulla workflows reference and invoke routines.

---

## 1. The `routine` node subtype

Workflows invoke routines through a new node subtype — `routine` — that slots into the existing workflow YAML graph alongside `agent`, `integration-call`, `tool-call`, and `orchestrator-prompt`.

```yaml
- id: node-fetch-invoice
  type: workflow
  position: { x: 500, y: 200 }
  data:
    subtype: routine                          # NEW subtype
    category: agent                           # Placed in the "Agents" category
    label: "Fetch Stripe Invoice"
    config:
      routineRef: fetch-stripe-invoice@1.2.3  # name@version (semver or range)
      inputs:
        invoice_id: "{{ trigger.invoice_id }}"
        include_line_items: true
      # Optional overrides:
      timeoutOverride: 60s
      retriesOverride:
        max: 5
```

The workflow engine:

1. Resolves `routineRef` by name + version against the routine registry.
2. Loads `routine.yaml` and validates inputs against its `spec.inputs` schema.
3. Routes the invocation to the runtime container named by `spec.runtime`.
4. Passes the resolved inputs, collects outputs, and writes them to the workflow's shared state.
5. The outputs become addressable by downstream nodes as `{{ routineNodeId.output.name }}`.

---

## 2. Version pinning

`routineRef` accepts the same range syntax as npm / Cargo:

| Ref form                            | Meaning                                                  |
|-------------------------------------|----------------------------------------------------------|
| `fetch-stripe-invoice@1.2.3`        | Exact version. Immutable. Recommended for production.    |
| `fetch-stripe-invoice@^1.2.3`       | Compatible (minor + patch). Auto-upgrades within 1.x.    |
| `fetch-stripe-invoice@~1.2.3`       | Patch-only auto-upgrade (1.2.x).                         |
| `fetch-stripe-invoice@latest`       | Always latest published. Only for draft workflows.       |
| `fetch-stripe-invoice@draft`        | Live link to the local draft. Editor-only, not scannable.|

Production workflows should **always pin exact versions.** The engine rejects `@latest` and `@draft` refs when a workflow is in `_status: production`.

---

## 3. Invocation lifecycle

```
Workflow node: routine (fetch-stripe-invoice@1.2.3)
  ↓
WorkflowPlaybook.processNextStep()
  ↓
RoutineRegistry.resolve("fetch-stripe-invoice", "1.2.3")
  ↓
Load routine.yaml + verify .routine/signature.sha
  ↓
Validate inputs against spec.inputs (JSON Schema)
  ↓
Route to runtime container (python-runtime / node-runtime / shell-runtime / agent-runtime)
  ↓
Runtime hot-loads functions/main.py::handler (if not already loaded in this session)
  ↓
Invoke handler(inputs) with permissions sandbox applied
  ↓
Validate outputs against spec.outputs (JSON Schema)
  ↓
WorkflowCheckpointModel.save()  — outputs persisted
  ↓
Advance DAG → next node
```

If any step fails (validation, signature mismatch, handler exception, timeout), the workflow engine follows the existing failure-handling path: the node is marked failed, `pendingFailures` is populated, and downstream nodes can branch on failure via routing nodes.

---

## 4. Input/output binding

Workflow-to-routine input binding uses the existing template syntax:

```yaml
config:
  routineRef: generate-invoice-pdf@2.0.0
  inputs:
    invoice: "{{ node-fetch-invoice.output.invoice }}"
    customer_email: "{{ trigger.email }}"
    template_name: "premium"                 # literal value
    include_watermark: "{{ env.ENV == 'staging' }}"
```

Outputs are namespaced by node ID:

```yaml
# Downstream node references the routine's output
config:
  prompt: |
    Here is the PDF URL: {{ node-generate-pdf.output.pdf_url }}
```

---

## 5. Runtime container selection

| `spec.runtime` | Container         | Typical use                                              |
|----------------|-------------------|----------------------------------------------------------|
| `python`       | `python-runtime`  | Data transforms, API clients, ML inference, scraping.    |
| `node`         | `node-runtime`    | Anything with a rich JS/TS ecosystem (web, parsing).     |
| `shell`        | `shell-runtime`   | CLI invocations, file moves, system ops, one-liners.     |
| `agent`        | `agent-runtime`   | LLM-driven steps where the entrypoint is a prompt file.  |

The runtime container is a **long-lived process** shared by multiple routines. Individual routines are hot-loaded into isolated namespaces (Python `importlib`, Node `vm` context, separate shell processes, per-agent conversation state). This is the fast-iteration path. For `trust: marketplace` routines, the engine instead spawns an isolated container per invocation (slower, safer).

---

## 6. Routine vs sub-workflow — when to use which

| Use a routine when…                                        | Use a sub-workflow when…                                      |
|-------------------------------------------------------------|----------------------------------------------------------------|
| The work is a single deterministic function.                | The work is a multi-step graph of its own.                     |
| You want hot-reloadable code.                               | You want visual authoring + checkpoint per step.               |
| Inputs/outputs are typed and schema-validated.              | Free-form data flow across agent nodes.                        |
| You want semver + versioned registry.                       | Composition at the workflow level.                             |
| Latency matters (runtime is warm).                          | Latency doesn't matter, durability matters.                    |

Routines are leaves. Workflows compose routines (and other workflows) into DAGs.

---

## 7. Migration notes

Existing workflow YAMLs continue to work unchanged. `routine` is additive — a new subtype, not a replacement.

Over time, patterns currently implemented as large `agent` nodes with inline prompts and `orchestrator-prompt` chains will be extracted into named routines. This is opt-in; no migration is forced.

The `integration-call` and `tool-call` subtypes are superseded conceptually by routines with `runtime: shell` or `runtime: python` wrapping an integration API. They remain supported for backward compat, but new work should prefer the routine path.
