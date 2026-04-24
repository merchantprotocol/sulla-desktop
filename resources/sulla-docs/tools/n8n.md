# n8n

n8n is a separate workflow engine that runs alongside Sulla. Sulla workflows and n8n workflows **coexist** — they solve different problems.

## When to use n8n vs Sulla workflows

| | n8n workflow | Sulla workflow |
|---|--------------|---------------|
| **Authoring** | Visual drag-and-drop UI | YAML in `~/sulla/routines/<slug>/routine.yaml` |
| **Reasoning** | Deterministic node chains | Agent decides what to do at agent nodes |
| **Best for** | Fixed pipelines (HTTP → transform → DB), webhooks, scheduled batch jobs | Anything that needs an LLM to interpret context, route, or write |
| **Triggers** | Webhooks, cron, manual | Manual, schedule, chat-app, calendar, heartbeat |
| **Visual debugging** | Yes — n8n's UI | Limited (canvas exists but agent is mostly text) |
| **Scope** | Per-workflow node graph | First-class agent + sub-workflows |

If the user has a recurring "fetch from X, transform, post to Y" pipeline with no judgment calls, **n8n**. If they want "summarize my email and decide what's urgent," **Sulla workflow with an agent node**.

## Where n8n runs

**Verified live 2026-04-23: n8n is NOT running.** No n8n container appears in `docker_ps -a`. The tool surface exists but the service isn't provisioned in this environment.

When the user installs n8n (via a recipe):
- Auth: `X-N8N-API-KEY` header. Key stored in vault under integration `n8n`, property `N8N_API_KEY`; base URL under property `BASE_URL`.
- API URL: comes from the vault's `BASE_URL` property. `N8nService.ts:28` has a fallback default of `http://127.0.0.1:30119`, but **30119 is shell_runtime's port in this build** — the recipe should set a non-colliding URL on install.
- DB: n8n uses its own Postgres tables (`workflow_entity`, `webhook_entity`, etc.) — either inside Sulla's Postgres or in a dedicated n8n-db container, depending on recipe.

Before using any `sulla n8n/*` tool, run `sulla vault/vault_is_enabled '{"account_type":"n8n"}'` to confirm n8n is installed and has credentials. If not, tell the user and offer to install the recipe.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla n8n/patch_workflow` | Atomic node/connection mutations |
| `sulla n8n/validate_workflow` | Graph health check (floating nodes, missing creds, broken connections) |
| `sulla n8n/validate_workflow_payload` | Validate before create/update |
| `sulla n8n/diagnose_webhook` | Check webhook readiness (DB registration + live test) |
| `sulla n8n/restart_n8n_container` | Restart the container + health poll |

For everything else (create workflow, run workflow, list workflows, get execution history, manage credentials), the agent uses the **integration proxy** to hit n8n's REST API directly:
```bash
sulla n8n_account_id/n8n '{"method":"GET","path":"/api/v1/workflows"}'
```

## `patch_workflow` — the editing power tool

Atomic batch of node/connection operations. All applied in sequence, then saved as one API call.

```bash
sulla n8n/patch_workflow '{
  "workflowId": "5",
  "operations": [
    {
      "target": "node",
      "op":     "add",
      "node":   { "name": "HTTP", "type": "n8n-nodes-base.httpRequest", "position": [400, 200], "parameters": {...} }
    },
    {
      "target": "node",
      "op":     "update",
      "nodeName": "Set",
      "patch":  { "parameters": { "values": {...} } }
    },
    {
      "target":           "connection",
      "op":               "add",
      "source":           "HTTP",
      "connectionTarget": "Set",
      "sourceIndex":      0,
      "targetIndex":      0
    }
  ]
}'
```

- `op: add` for nodes needs the full node object
- `op: update` accepts `patch` (deep-merged) or full `node`
- `op: remove` accepts `nodeId` or `nodeName`
- Connections: `source` and `connectionTarget` are node **names** (case-sensitive!). Defaults: `sourceIndex: 0`, `targetIndex: 0`.

## `validate_workflow` — pre-flight checks

```bash
sulla n8n/validate_workflow '{"workflowId":"5"}'
```

Returns:
```jsonc
{
  "valid": false,
  "nodes":       { "floating": [...], "missingType": [...] },
  "credentials": { "missing": [...] },
  "connections": { "broken": [...], "circular": [...] },
  "webhooks":    { "issues": [{ "nodeName":"...", "issue":"...", "severity":"...", "recommendation":"..." }] }
}
```

Always run **before** patching a workflow that's running in production. Catches floating nodes, missing credential refs, broken connections, and webhook path issues (kebab-case enforcement).

## `diagnose_webhook` — when a webhook isn't firing

```bash
sulla n8n/diagnose_webhook '{"workflowId":"5"}'
```

Performs four checks:
1. Query `webhook_entity` table — is the webhook registered?
2. POST a diagnostic payload to `http://127.0.0.1:30119/webhook/<path>` — does it respond?
3. Tail container logs for webhook startup errors
4. Return `{ active, path, method, endpoint_status_code, recent_logs }`

## `restart_n8n_container` — when n8n is wedged

```bash
sulla n8n/restart_n8n_container '{}'
```

1. Docker restart the container
2. Poll `/healthz` until ready (default 15s timeout)
3. Query webhook registration counts post-restart
4. Return container status + webhook summary

**Don't use this casually** — restarting n8n drops in-flight executions.

## Common requests

### "List my n8n workflows"
```bash
sulla n8n_account_id/n8n '{"method":"GET","path":"/api/v1/workflows"}'
```

### "Add a new HTTP node to workflow 5"
```bash
sulla n8n/validate_workflow '{"workflowId":"5"}'      # pre-check
sulla n8n/patch_workflow '{...as above...}'
sulla n8n/validate_workflow '{"workflowId":"5"}'      # post-check
```

### "Why isn't this webhook firing?"
```bash
sulla n8n/diagnose_webhook '{"workflowId":"5"}'
# → tells you whether it's a registration issue, an endpoint issue, or a startup error
```

### "Activate / deactivate this workflow"
Via REST API:
```bash
sulla n8n_account_id/n8n '{"method":"POST","path":"/api/v1/workflows/5/activate"}'
sulla n8n_account_id/n8n '{"method":"POST","path":"/api/v1/workflows/5/deactivate"}'
```

### "Show me execution history"
```bash
sulla n8n_account_id/n8n '{"method":"GET","path":"/api/v1/executions?workflowId=5&limit=10"}'
```

## Hard rules

- **Run `validate_workflow` before and after `patch_workflow`** — n8n won't catch all errors at save time.
- **Node names are case-sensitive** in connections. "HTTP" ≠ "http".
- **Webhook paths get kebab-cased.** `MyWebhook` becomes `my-webhook`. Plan accordingly.
- **Credentials must already exist in n8n** — the patch tool won't create them. Direct the user to the n8n UI for credential management.
- **Don't patch a running execution.** Wait for it to finish or the patch may hit unexpected state.
- **`patch_workflow` is not transactional with rollback** — if operation 3 of 5 fails, ops 1–2 already applied. Validate first.

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/n8n/`
- Manifest: `pkg/rancher-desktop/agent/tools/n8n/manifests.ts`
- Service: `pkg/rancher-desktop/agent/services/N8nService.ts`
- Vault property: `account_type: "n8n"` → `api_key` (and instance URL if non-default)
