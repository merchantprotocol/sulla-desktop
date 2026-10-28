---
slug: sulla-discover-and-call-tools
label: Discover and call Sulla tools
trigger_when: When you need a Sulla CLI tool and are unsure of its exact category, name, parameters, or example.
trigger_actions: [discover a tool, browse tools, call a tool, use Sulla CLI]
trigger_phrases: [browse_tools, Sulla tool, CLI tool, integration proxy, MCP, exact command]
scope: [sulla-tools]
---

**When:** Find the live command first, then dispatch it through the isolated VM.

**Do:**
1. Discover by category: `sulla meta/browse_tools '{"category":"github"}'`.
2. Discover by need: `sulla meta/browse_tools '{"query":"pull request"}'`.
3. Read the returned exact `sulla <category>/<tool> '<json-args>'` command and copy its parameter names.
4. Run that full command through `exec`, not as a direct native function call.
5. For a vault integration, use `sulla <account_id>/<slug> '<json-args>'`; for MCP, use `sulla <account_id>/mcp/<tool> '<json-args>'`.
6. Check the result before chaining IDs, cursors, SHAs, or destructive actions.

**Don't:**
- Don't use `execute_workflow` for a catalog CLI tool; it only runs named workflows.
- Don't invent commands or parameters when discovery is available.
- Don't put tokens or passwords in command arguments; auth is injected from the vault.
- Don't use `exechost` for routine VM execution.
