# Marketplace & Recipes

## What a recipe is

A **recipe** is a marketplace-installable Docker Compose configuration — not a Docker image. Each recipe ships:

- `compose.yaml` — what containers to run, ports, volumes, env
- `metadata.yaml` — catalog info (title, description, categories, icon, exposed URLs)
- Optional `README.md`, icons

Installing a recipe pulls the referenced container images and starts them via Lima's Docker daemon. The recipe directory ends up at `~/sulla/recipes/<slug>/`.

**Catalog source:** `https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/index.yaml` (cached 1 min)

**Backend API:** `http://127.0.0.1:6107/v1/extensions` (Basic auth) — handles install, list, uninstall. The agent calls extension tools, which proxy through this backend.

## Tools the agent has

| Tool | Purpose |
|------|---------|
| `sulla extensions/list_extension_catalog` | Browse the marketplace. Filter by `category` or `query`. |
| `sulla extensions/list_installed_extensions` | What's installed and running, with version + URLs |
| `sulla extensions/install_extension` | Install by ID (e.g. `docker.io/merchantprotocol/twenty:2.1.0`) |
| `sulla extensions/uninstall_extension` | Remove. Default preserves `data/`; `deleteData: true` wipes |

## Common user requests

### "What can I install?"
```bash
sulla extensions/list_extension_catalog '{}'
sulla extensions/list_extension_catalog '{"category":"crm"}'
sulla extensions/list_extension_catalog '{"query":"pdf"}'
```

### "What do I have installed?"
```bash
sulla extensions/list_installed_extensions '{}'
```
Returns each running extension with `id`, `version`, `extraUrls` (where the web UI is exposed), `status`, and `canUpgrade`.

### "Install Twenty CRM"
```bash
sulla extensions/install_extension '{"id":"docker.io/merchantprotocol/twenty:2.1.0"}'
```
Backend pulls the image, starts the compose stack, allocates ports. Twenty ends up at `localhost:30207`.

### "Uninstall X"
```bash
sulla extensions/uninstall_extension '{"id":"docker.io/.../X:1.0","deleteData":false}'
```
**Default keeps user data.** Confirm with the user before passing `deleteData:true` — it's irreversible.

### "Open Twenty CRM" / "Show me X"
After locating the URL via `list_installed_extensions`, open it in a browser tab:
```bash
sulla browser/tab '{"action":"upsert","url":"http://localhost:30207"}'
```

### "Update an extension"
There's no dedicated update tool. Re-install with the new version tag:
```bash
sulla extensions/install_extension '{"id":"docker.io/.../X:2.0.0"}'
```

### "Build me a new recipe"
Author files locally under `~/sulla/recipes/<slug>/`:
- Write a `compose.yaml` (real Docker Compose; pin image versions)
- Write a `metadata.yaml` with title, description, labels (categories), `extraUrls`
- Test by running the compose stack manually via `sulla docker/docker_run` or `lima_shell`

Submitting to the public marketplace = a PR against `merchantprotocol/sulla-recipes`. The agent can prep the PR but Jonathon merges.

## Discovery vs invocation

Installed extensions are passively listed in the agent's system prompt (e.g., "Twenty CRM at localhost:30207"). That list comes from `list_installed_extensions` at startup — it's data, not tools. To **use** an extension, the agent either:

1. Opens its web UI in a browser tab (most extensions)
2. Calls a registered integration if the extension exposes one (e.g., `sulla twenty/<endpoint>` once the integration is connected via vault)

## Safety rules

- **Never uninstall without explicit user confirmation.** Recipes can hold months of user data.
- **Never pass `deleteData:true` without explicit user confirmation.** Same reason.
- **Don't kill running extension containers via `docker_stop` directly** — let `uninstall_extension` handle lifecycle. Manual `docker_stop` confuses the backend.
- Pre-installed Sulla containers (`sulla_postgres`, `sulla_redis`, `python_runtime`, `shell_runtime`, `node_runtime`) are NOT extensions — they are managed by `ServiceLifecycleManager`. Do not attempt to install/uninstall them.

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/extensions/manifests.ts`
- Extension service: `pkg/rancher-desktop/agent/services/ExtensionService.ts`
- Recipe path resolver: `resolveSullaRecipesDir()` in `pkg/rancher-desktop/agent/utils/sullaPaths.ts`
- Memory: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/project_marketplace_recipe_model.md`
