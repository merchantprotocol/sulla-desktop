---
slug: sulla-tools
kind: system
name: Sulla tools
parent: sulla
aliases: [tools, CLI tools, sulla CLI, browse_tools, exec dispatch, MCP, integration proxy]
---

## Overview
Sulla tools are callable capabilities exposed as `sulla <category>/<tool> '<json-args>'`. An agent dispatches them by passing the full command string to the VM `exec` tool. The catalog is discoverable with `sulla meta/browse_tools`, filtered by category or keyword. Integration proxy calls use `sulla <account_id>/<slug> '<json-args>'`; MCP calls use `sulla <account_id>/mcp/<tool> '<json-args>'`. Vault-backed integrations inject authentication; never copy credentials into arguments.

## Facts
- `browse_tools` returns ready-to-run CLI command strings, not directly callable function names.
- `exec` runs commands inside the isolated Sulla VM and is also the dispatch surface for `sulla` CLI tools.
- Integration proxy calls are addressed as `sulla <account_id>/<slug>`.
- MCP calls are addressed as `sulla <account_id>/mcp/<tool>`.
- The `meta/execute_workflow` tool runs named workflows only; it is not a dispatcher for catalog tools.

## Rules
- DO: Discover an unfamiliar tool with `sulla meta/browse_tools '{"query":"..."}'` or `'{"category":"..."}'`. Why: names and schemas change.
- DO: Invoke the returned command through `exec` exactly as shown. Why: catalog entries are CLI commands, not native tool calls.
- DO: Use the category skill for the complete tool list, required parameters, examples, and common job steps. Why: subjects hold rules; skills hold procedures.
- DO: Keep integration and MCP account IDs in the command only when needed. Why: auth is vault-injected.
- DON'T: call `execute_workflow` for a CLI tool. Why: it accepts workflow slugs, not catalog commands.
- DON'T: invent tool names, parameters, account IDs, or workflow slugs. Why: guessed calls fail or can cause unintended effects.
- DON'T: route routine VM work through `exechost`. Why: host execution is a last resort and crosses the VM boundary.
- LESSON: A catalog command must be nested inside `exec` as its full command string. Why: calling `sulla` as though it were a native function fails.
