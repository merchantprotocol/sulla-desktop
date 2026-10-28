---
slug: sulla-discover-and-call-tools
label: Discover and call Sulla tools
trigger_when: When you need a Sulla CLI tool or a vaulted integration/MCP proxy and are unsure of its exact category, name, parameters, account, or example.
trigger_actions: [discover a tool, browse tools, call a tool, use Sulla CLI]
trigger_phrases: [browse_tools, Sulla tool, CLI tool, integration proxy, MCP, exact command, call an API, use my saved key]
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
7. For an integration, first run `sulla vault/is_enabled '{"account_type":"<service>"}'` and `sulla vault/list_accounts '{"account_type":"<service>"}'`; select an account with `sulla vault/set_active_account '{"account_type":"<service>","account_id":"<account-id>"}'` only when needed.
8. For a generic key, run `sulla vault/list_api_keys '{}'`, then call only an allowed host with `sulla vault/request '{"item":"<item-id>","method":"GET","url":"https://api.example.com/v1/resource"}'`. For an MCP server, run the exact `sulla <account_id>/mcp/<tool>` command returned by discovery.

**Don't:**
- Don't use `execute_workflow` for a catalog CLI tool; it only runs named workflows.
- Don't invent commands or parameters when discovery is available.
- Don't put tokens or passwords in command arguments; auth is injected from the vault.
- Don't use `exechost` for routine VM execution.
- Don't treat a successful authentication check as permission to send, post, pay, or delete; prepare writes and ask the human before dispatch.
