# Password Vault

The vault stores credentials for every integration the user has connected — API keys, OAuth tokens, website passwords. The agent's access is **gated by per-credential LLM access levels**, so the agent often sees metadata but not the secret itself.

## How it's protected

- **Storage:** Postgres table `integration_values` (encrypted at rest with the `$VAULT$` prefix marker)
- **Encryption:** AES-256-GCM with a Vault Master Key (VMK) derived from the user's master password via PBKDF2 (100k iterations, 32-byte salt)
- **VMK at rest:** encrypted via Electron `safeStorage` (OS keychain integration), backed up via recovery key
- **Files in `~/.sulla/`:** `vault-salt`, `vault-key.enc`, `vault-key.backup`, `vault-recovery-hash`, `vault-verify`
- **Unlock:** auto on app start via `safeStorage`; falls back to master password or recovery key
- **VMK lives in memory only** — never serialized, never sent over IPC

The agent runs inside Lima but the vault files live on the host. The agent talks to the vault through tools, not files.

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

| Tool | Purpose |
|------|---------|
| `sulla vault/vault_is_enabled` | Is integration X connected? |
| `sulla vault/vault_list_accounts` | List all accounts on integration X (label, default flag, connection status) |
| `sulla vault/vault_read_secrets` | Read fields for an account (with masking per LLM access level) |
| `sulla vault/vault_set_credential` | Create or update one credential property (encrypted on write) |
| `sulla vault/vault_set_active_account` | Mark which account is the default for an integration |
| `sulla vault/vault_list` | List all saved website credentials (for autofill); passwords never returned |
| `sulla vault/vault_autofill` | Trigger browser injection of stored username/password into the active tab |

## Common requests

### "Connect my GitHub / Slack / Stripe account"
The agent doesn't run the OAuth flow itself. The user clicks Connect in the integration's settings UI; the OAuth callback writes to the vault. The agent's role:
1. `vault_is_enabled '{"account_type":"github"}'` — confirm not yet connected
2. Tell the user where to go (Settings → Integrations → GitHub → Connect)
3. After they confirm, re-check with `vault_is_enabled`

For credentials with no OAuth flow (e.g., raw API keys), use `vault_set_credential` with the user-provided value.

### "What integrations do I have connected?"
`vault_list_accounts` for each integration of interest, or read the integrations service if the user wants a sweep.

### "Is my Slack working?"
```bash
sulla vault/vault_is_enabled '{"account_type":"slack"}'
```

### "Add my OpenAI key"
```bash
sulla vault/vault_set_credential '{"account_type":"openai","property":"api_key","value":"sk-..."}'
```
The value is encrypted before write. Connection status is auto-set to true for known credential properties.

### "Use my GitHub PAT to call the API"
**Use the proxy — don't read the secret.** Example:
```bash
sulla github_account_id/github '{"method":"GET","path":"/user/repos"}'
```
The integration proxy injects the PAT from the vault. Agent never touches the token.

### "Autofill my password on this site"
1. Make sure the user is on the site (check the active browser tab)
2. Trigger:
   ```bash
   sulla vault/vault_autofill '{"origin":"https://github.com"}'
   ```
3. The vault service finds the matching account, executes JS in the tab via `window.sullaBridge.detectLoginForm()` + `setValue()`, auto-submits after 200ms
4. The password never appears in the tool response

If no matching account: tell the user, offer to save one via `vault_set_credential`.

### "Show me my OpenAI key"
Only when the user explicitly asked to see/copy:
```bash
sulla vault/vault_read_secrets '{"account_type":"openai","include_secrets":true}'
```
Otherwise, default to masked output.

### "Remove my GitHub credential"
There's no dedicated delete tool. Set the property to empty or use the integrations UI. Confirm before destructive ops.

## Hard rules

- **Never log raw secrets** — even in CONTINUE / DONE wrappers
- **Never paste a secret into a chat response** unless the user just asked to see it
- **Default to the proxy pattern** (`sulla <account>/<slug>`) over reading and re-passing secrets
- **Don't try to bypass `none`/`metadata` access levels** — escalate to the user, don't workaround
- **Browser autofill never returns the password** to the agent. That's intentional.

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/integrations/manifests.ts`
- Vault service: `pkg/rancher-desktop/agent/services/VaultKeyService.ts`
- Integration service: `pkg/rancher-desktop/agent/services/IntegrationService.ts`
- LLM access map: `pkg/rancher-desktop/agent/integrations/select_box/VaultLlmAccess.ts`
- Autofill flow: `pkg/rancher-desktop/agent/tools/integrations/vault_autofill.ts`
- Schema: migration `pkg/rancher-desktop/agent/database/migrations/0013_create_integration_values_table.ts`
