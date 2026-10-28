---
slug: sulla-use-an-integration
label: Connect and safely use an integration
trigger_when: When a human wants to connect a service, test a saved credential, call its API, use an MCP server, or troubleshoot OAuth without exposing secrets.
trigger_actions: [connect an integration, test an API key, call a CRM, create a billing customer, use MCP, fix OAuth]
trigger_phrases: [connect my GitHub account, test the API key, pull open deals, create a customer, call this service API, connect this MCP server, make an API token, OAuth sign-in fails]
scope: [sulla-vault, tool-vault, sulla-tools]
---

**When:** Use this for a service that must authenticate through Sulla Vault. The service slug is the integration's catalog id, such as `github`, `hubspot`, `salesforce`, or `stripe`.

**Do:**
1. Open the in-app integration setup when the human needs to connect or repair OAuth: `sulla ui/open_tab '{"mode":"integrations"}'`. Never ask the human to paste a secret into chat.
2. Check connection metadata, then list accounts if needed: `sulla vault/is_enabled '{"account_type":"<service>"}'` and `sulla vault/list_accounts '{"account_type":"<service>"}'`. If it is disabled or absent, stop and tell the human to connect it in Integrations, then re-check.
3. Select the intended account only after listing it: `sulla vault/set_active_account '{"account_type":"<service>","account_id":"<account-id>"}'`.
4. For a generic saved API key, list safe metadata and resolve the item id: `sulla vault/list_api_keys '{}'`. Call only the allowed HTTPS host through the broker: `sulla vault/request '{"item":"<item-id>","method":"GET","url":"https://api.example.com/v1/resource"}'`. Do not use `read_secrets` with `include_secrets:true`.
5. For a native integration proxy, discover the live account command with `sulla meta/browse_tools '{"query":"<service> API"}'`, then run the exact `sulla <account_id>/<slug> '<json>'` command returned. For MCP, discover it and run `sulla <account_id>/mcp/<tool> '<json>'`.
6. Read-only requests such as listing open CRM deals can proceed after the enabled check. A write such as creating a billing customer is an external side effect: prepare the exact request, then use the native `ask_user_question` approval card once before sending it.
7. If OAuth fails, capture the exact non-secret error, re-open Integrations, check enabled/account metadata, and retry the supported sign-in. If it still fails, report the provider error and the missing integration/account state; do not invent a token or bypass OAuth.
8. If the provider requires a personal API token, tell the human which scopes the endpoint needs, have them create it in the provider UI, and have them save it in Vault with the integration's setup screen. Never request the token value in chat.

**Check:** The enabled check says connected; a read-only API call returns the expected resource shape without secret material; an MCP call returns its tool result; or the provider UI reports OAuth connected. For a write, verify the provider response and ask the human to confirm the created record if the API does not return one.

**Cleanup:** Do not delete credentials or accounts as cleanup. Remove only temporary non-secret request files or browser tabs you created. Leave the connected account in Vault for reuse.

**Traps:**
- `vault/list_accounts` shows metadata, not a usable API command; discover the integration or MCP tool before calling it.
- `vault/request` requires an item id/name from `vault/list_api_keys` and an allowed HTTPS host; it is not a way to send arbitrary requests.
- Never print, log, copy, or store raw keys, OAuth codes, passwords, or bearer tokens.
- Authentication is not consent to upload or mutate data. Do not send, post, pay, or delete without the human's explicit go-ahead.
- If no integration or account exists, say so and route to the human's provider setup; Sulla cannot create a third-party account for them.
