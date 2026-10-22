# Password Vault

The vault stores credentials for every integration the user has connected — API keys, OAuth tokens, website passwords. Credentials are encrypted at rest. The agent's access is **gated by per-credential LLM access levels**, so the agent often sees metadata but not the secret itself.

## LLM access levels (per credential)

This is the most important thing to understand. Every credential has one of four access levels set by the user:

| Level | Agent sees | Agent can | Use case |
|-------|-----------|-----------|----------|
| `none` | `[VAULT PROTECTED]` (nothing) | Cannot use the credential at all | Highly sensitive keys |
| `metadata` | Account label, non-secret fields (URLs, usernames) | Cannot autofill, cannot proxy API | Reference-only |
| `autofill` | Metadata; secrets shown as `[VAULT PROTECTED — use vault/autofill]` | Trigger browser autofill; use credentials in proxy API calls (secrets injected automatically — agent never reads them) | Most common — typical for connected SaaS accounts |
| `full` | All plaintext (only when `include_secrets:true`; otherwise masked `****abcd`) | Read and manipulate any field | Trusted automation only |

**Rule of thumb:** if a tool call needs the secret, prefer the proxy pattern (`sulla <account_id>/<slug>`) — credentials are injected without the agent ever seeing them. Only request `include_secrets:true` when the user has explicitly asked to see or copy the secret.

## Tools

| Tool | Params | Purpose |
|------|--------|---------|
| `sulla vault/is_enabled` | `account_type` | Is integration X connected? |
| `sulla vault/list_accounts` | `account_type` | List all accounts on integration X (label, default flag, connection status) |
| `sulla vault/read_secrets` | `account_type`, `account_id?`, `include_secrets?` | Read fields for an account. Masked unless `include_secrets` is true and the level allows it. |
| `sulla vault/set_credential` | `account_type`, `property`, `value`, `account_id?`, `confirm?` | Create or update one credential property (encrypted on write). Overwriting a different existing value needs `confirm:true`. |
| `sulla vault/set_active_account` | `account_type`, `account_id` | Mark which account is the default for an integration |
| `sulla vault/list` | — | List saved website credentials only (for autofill); use `vault/list_api_keys` for API keys. Returns origin, username and access level. Passwords are never returned. |
| `sulla vault/list_api_keys` | — | List agent-usable API key/Login items without secrets. |
| `sulla vault/request` | `item`, `method`, `url`, `headers?`, `body?` | Make an HTTPS request with owner-declared credential injection. |
| `sulla vault/autofill` | `origin?`, `account_id?`, `assetId?` | Inject stored username/password into the active tab, or an explicit background tab via `assetId`. Success requires non-empty field verification. |
| `sulla vault/delete_credential` | `account_type`, `property`, `account_id?`, `confirm` | Soft-delete one credential property. `confirm:true` is required. |

## Plain API key items (no integration required)

`vault/list_api_keys '{}'` lists API key and Login items opened to the calling agent at
`autofill` or `full`, with valid encrypted **Agent usage** rules and unexpired access.
It returns only id, name, type, allowed hosts, and target/name/scheme rule metadata.
It never returns values or rule sources. `only_me` and agent allowlists are enforced.

In the vault editor, set **Agents can use → Autofill**, then configure **Agent usage**.
Hosts are exact hostnames or `*.example.com`; policy **Only on** is an additional limit.
Rules inject password, username, or `custom:Label` into a header or query parameter;
Basic auth uses username:password. Requests are HTTPS-only, non-streaming, block private
addresses and redirects, and redact injected values from responses. Caller auth headers
are stripped; only the owner's rules select credentials. **Ask me first** still applies.

For a Cloudflare Global API Key, choose that preset and put your Cloudflare login email
in Username. It sets `api.cloudflare.com`, `X-Auth-Key` from the secret, and `X-Auth-Email`
from Username. The Cloudflare API token preset instead uses `Authorization: Bearer`.

```bash
sulla vault/list_api_keys '{}'
sulla vault/request '{"item":"Cloudflare Global API Key","method":"GET","url":"https://api.cloudflare.com/client/v4/user","headers":{}}'
```

`vault/request` accepts an id or exact unique name, method (`GET/POST/PUT/PATCH/DELETE`),
HTTPS URL, optional non-secret headers and body. It returns status, safe headers and body.
A missing item means it isn't opened to this agent, has expired, or lacks valid usage
rules; restricted items aren't disclosed to distinguish those cases. Host denials,
approval requirements, and locked vault errors are returned explicitly.

## Common requests

### "Connect my GitHub / Slack / Stripe account"
The agent doesn't run the OAuth flow itself. The user clicks Connect in the integration's settings UI; the OAuth callback writes to the vault. The agent's role:
1. `vault/is_enabled '{"account_type":"github"}'` — confirm not yet connected
2. Tell the user where to go (Settings → Integrations → GitHub → Connect)
3. After they confirm, re-check with `vault/is_enabled`

For credentials with no OAuth flow (e.g., raw API keys), use `vault/set_credential` with the user-provided value.

### "What integrations do I have connected?"
`vault/list_accounts` for each integration of interest.

### "Is my Slack working?"
```bash
sulla vault/is_enabled '{"account_type":"slack"}'
```

### "Add my OpenAI key"
```bash
sulla vault/set_credential '{"account_type":"openai","property":"api_key","value":"<the key the user gave you>"}'
```
The value is encrypted before write and never appears in conversation after the call.

### "Use my GitHub PAT to call the API"
**Use the proxy — don't read the secret.** Example:
```bash
sulla <github_account_id>/github '{"method":"GET","path":"/user/repos"}'
```
The integration proxy injects the PAT from the vault. Agent never touches the token.

### "Autofill my password on this site"
1. Make sure the user is on the site and identify the intended browser tab
2. Trigger:
   ```bash
   sulla vault/autofill '{"origin":"https://github.com"}'
   ```
   To target a specific background tab, include its exact `assetId`:
   ```bash
   sulla vault/autofill '{"origin":"https://github.com","assetId":"github-login"}'
   ```
3. The vault service resolves that exact tab through the browser registry, verifies its origin, fills the login form, and proves every expected field is non-empty before reporting success or auto-submitting
4. If the target runtime is not initialized, the page rejects a value, or the origin differs, the tool returns a failure tied to the target `assetId`
5. The password never appears in the tool response

If no matching account exists, tell the user and offer to save one with `vault/set_credential`.

### "Show me my OpenAI key"
Only when the user explicitly asked to see or copy it:
```bash
sulla vault/read_secrets '{"account_type":"openai","include_secrets":true}'
```
Otherwise, use the default masked output.

### "Remove my GitHub credential"
Only when the user asked for the removal:
```bash
sulla vault/delete_credential '{"account_type":"github","property":"api_token","confirm":true}'
```

## Hard rules

- **Never log raw secrets** — even in CONTINUE / DONE wrappers
- **Never paste a secret into a chat response** unless the user just asked to see it
- **Default to the proxy pattern** (`sulla <account>/<slug>`) over reading and re-passing secrets
- **Don't try to bypass `none`/`metadata` access levels** — escalate to the user, don't workaround
- **Browser autofill never returns the password** to the agent. That's intentional.
- **`llm_access` is user-only.** `vault/set_credential` refuses to write it.
- **Overwriting an existing secret** with `vault/set_credential` requires `{"confirm":true}`. Only set it when the user asked for the change.
- **Functions and workflow steps** only receive a secret when the account allows it: never at `none`/`metadata`, and website logins only at `full` (function code can echo values back to the agent).

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/integrations/manifests.ts`
- Tool implementations: `pkg/rancher-desktop/agent/tools/integrations/`
- Access policy: `pkg/rancher-desktop/agent/services/vaultAccessPolicy.ts`
- Integration service: `pkg/rancher-desktop/agent/services/IntegrationService.ts`
- LLM access map: `pkg/rancher-desktop/agent/integrations/select_box/VaultLlmAccess.ts`
- Autofill flow: `pkg/rancher-desktop/agent/tools/integrations/vault_autofill.ts`
- Schema: migration `pkg/rancher-desktop/agent/database/migrations/0013_create_integration_values_table.ts`
