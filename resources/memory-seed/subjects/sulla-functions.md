---
slug: sulla-functions
kind: system
name: Sulla Functions
parent: sulla
aliases: [functions, custom functions, function.yaml, function runtime, runtime tool, zero-token tool]
---

## Overview
A Sulla Function is deterministic Python, Node, or shell code described by `function.yaml`. Use one to replace repeated tool choreography, data shaping, polling, validation, or API glue that does not need model judgment. A published function becomes a direct tool through `sulla function/run` and a workflow `function` node. Every invocation is recorded, so failures and duration can be inspected without replaying the work through a model.

## Facts
- A function manifest uses `apiVersion: sulla/v1`, `kind: Function`, `schemaversion: 1`, and a `spec` object.
- `spec.runtime` is `python`, `node`, or `shell`; Python and Node entrypoints use `file::handler`, while shell uses a script path.
- The direct tool is `sulla function/run` with `slug`, optional `inputs`, and optional `version`.
- `sulla function/runs` filters invocation history by slug, failure, time, limit, and verbosity.
- A workflow function node has category `agent`, subtype `function`, and config `functionRef`, `inputs`, optional integration bindings, and optional timeout override.
- Function-node input strings support the same workflow templates as other nodes.
- Published files under `Use Cases/functions/<slug>/` are indexed into the runtime. The entrypoint file named by `function.yaml` must be present.
- Runtime outputs are the handler's returned object. Output names should match `spec.outputs`.
- Declared permissions and integrations do not bypass Sulla policy or vault access controls.

## Rules
- DO: Promote a repeated deterministic sequence after it appears twice. Why: one maintained function prevents repeated token spend and drift.
- DO: Use narrow typed inputs and small structured outputs. Why: callers should not need another model pass to interpret the result.
- DO: Bound polling, retries, output size, and runtime with `spec.timeout`. Why: deterministic code still needs failure limits.
- DO: Run the function directly before wiring it into a workflow. Why: this separates function bugs from graph bugs.
- DON'T: Put secrets in code, manifests, inputs, outputs, or logs. Why: function execution is audited and may persist data.
- DON'T: use a function for ambiguous decisions or prose judgment. Why: those belong in agent, router, or approval nodes.
- DON'T: assume workflow config selects Python, Node, or shell. Why: `function.yaml` owns the runtime.
