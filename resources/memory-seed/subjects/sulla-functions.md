---
slug: sulla-functions
kind: system
name: Sulla Functions
parent: sulla
aliases: [functions, custom functions, function.yaml, function runtime]
---

## Overview
A Sulla Function is a deterministic Python, Node, or shell handler described by `function.yaml`. The manifest declares its slug, runtime, entrypoint, typed inputs and outputs, timeout, and permissions. Functions run through Sulla's runtime and are callable from workflows or with `function_run`; every invocation is recorded in function history.

## Facts
- A function manifest uses `apiVersion: sulla/v1`, `kind: Function`, `schemaversion: 1`, and a `spec` object.
- `spec.runtime` is `python`, `node`, or `shell`; examples use `main.py::handler` or `main.js::handler` entrypoints.
- `function_run` accepts `slug`, optional `inputs`, and optional `version`, defaulting to `1.0.0`.
- `function_list` shows function metadata; `function_runs` filters run history by slug, failures, time, limit, and verbosity.
- Function permissions are declared in the manifest and do not grant access beyond Sulla's existing policies.

## Rules
- DO: Declare every input and output with a type and required/default behavior. Why: validation and runtime input handling use the manifest.
- DO: Keep handlers deterministic and bounded by `spec.timeout`. Why: functions are for narrow, reliable work.
- DON'T: put secrets in source, manifests, inputs, or outputs. Why: function execution is audited and data may be persisted.
- DON'T: assume a function's runtime from a workflow node. Why: the function manifest owns the runtime.
