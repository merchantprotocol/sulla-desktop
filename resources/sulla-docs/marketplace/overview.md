# Use Cases & Recipes

**Use Cases** is the user-facing name for the marketplace. The Use Cases tab lists ready-made jobs (skills, workflows, agents, functions, recipes) you can install. A **recipe** is one kind of Use Case: a Docker Compose configuration that runs a service in Lima. Say "Use Cases" to users, and use "recipe" only when you mean the Docker Compose kind.

**Use Cases are sourced from Files.** Definitions for agents, skills, workflows, functions, and recipes live in Sulla Files under `Sulla/Use Cases/<type>/<slug>/`. Postgres holds only the runtime index, rebuilt from published Files versions. This reverses the old "Postgres only, never filesystem" rule. It does not bring back the old `~/sulla` folders, which are not read. See [files-harness.md](../environment/files-harness.md) for drafts, publish requests, and rollback.

## What a recipe is

A recipe is a Docker Compose configuration, not a Docker image. Each recipe ships:

- `compose.yaml`: what containers to run, ports, volumes, env
- `metadata.yaml`: catalog info (title, description, categories, icon, exposed URLs)
- Optional `README.md`, icons

Installing a recipe pulls the referenced container images and starts them through Lima's Docker daemon. A local recipe definition lives in Files at `Sulla/Use Cases/recipes/<slug>/`, with an `installation.yaml` and a compose file. Nothing reads `~/sulla/recipes/`.

**Catalog source:** `https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/index.yaml`

**Backend API:** `http://127.0.0.1:6107/v1/extensions`. The extension tools call this backend.

## Tools the agent has

| Command | Purpose |
|---------|---------|
| `sulla extensions/list_extension_catalog` | Browse the catalog. Filter by `category` or `query`. |
| `sulla extensions/list_installed_extensions` | What's installed, with version, URLs, and status |
| `sulla extensions/install_extension` | Install by `id` (e.g. `docker.io/merchantprotocol/twenty:2.1.0`) |
| `sulla extensions/uninstall_extension` | Remove by `id`. Default keeps `data/`; `deleteData: true` wipes it |
| `sulla extensions/start_extension` | Start an installed extension by `id` |
| `sulla extensions/stop_extension` | Stop by `id`. Needs `confirm` |
| `sulla extensions/get_extension_status` | Status for one extension by `id` |

For Use Cases that aren't recipes, use `sulla marketplace/*` (see [`../tools/marketplace.md`](../tools/marketplace.md)).

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
Returns each extension with `id`, `version`, `extraUrls` (where the web UI is exposed), `status`, and `canUpgrade`.

### "Install Twenty CRM"
```bash
sulla extensions/install_extension '{"id":"docker.io/merchantprotocol/twenty:2.1.0"}'
```
The backend pulls the image, starts the compose stack, and allocates ports. Get the URL from `list_installed_extensions`. Don't assume a port.

### "Uninstall X"
```bash
sulla extensions/uninstall_extension '{"id":"docker.io/.../X:1.0","deleteData":false}'
```
**Default keeps user data.** Confirm with the user before passing `deleteData:true`. It's irreversible.

### "Open Twenty CRM" / "Show me X"
After getting the URL from `list_installed_extensions`, open it in a browser tab:
```bash
sulla browser/tab '{"action":"upsert","url":"<url from list_installed_extensions>"}'
```

### "Update an extension"
There's no dedicated update tool. Reinstall with the new version tag:
```bash
sulla extensions/install_extension '{"id":"docker.io/.../X:2.0.0"}'
```

### "Build me a new recipe"
Author the files directly under `/mnt/sulla-files/Sulla/Use Cases/recipes/<slug>/` with normal file tools:
- Write a `compose.yaml` or `docker-compose.yml` (real Docker Compose, with pinned image versions)
- Write an `installation.yaml` with the recipe manifest
- Test the stack with `sulla docker/docker_run` or `lima_shell`
- Request publication with `sulla files/request_publish`. The recipe becomes active only after a human approves it in Decide.

To publish to the public catalog, use `sulla marketplace/publish '{"kind":"recipe","slug":"<slug>"}'`. It needs a Sulla Cloud sign-in. The listing stays pending until an admin approves it. Don't claim it's public before that.

## Discovery vs invocation

Installed extensions are listed in the agent's system prompt (for example, "Twenty CRM at localhost:30207"). That list comes from `list_installed_extensions` at startup. It's data, not a tool. To **use** an extension, the agent either:

1. Opens its web UI in a browser tab (most extensions)
2. Calls a registered integration, if the extension exposes one, once it's connected through the vault

## Safety rules

- **Never uninstall or stop an extension without explicit user confirmation.** Recipes can hold months of user data.
- **Never pass `deleteData:true` without explicit user confirmation.** It's irreversible.
- **Don't stop extension containers with `docker_stop` directly.** Use `stop_extension` or `uninstall_extension` so the backend stays in sync.
- Built-in Sulla containers (`sulla_postgres`, `sulla_redis`, `python_runtime`, `shell_runtime`, `node_runtime`) are NOT extensions. `ServiceLifecycleManager` manages them. Don't install or uninstall them.

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/extensions/manifests.ts`
- Extension service: `pkg/rancher-desktop/agent/services/ExtensionService.ts`
- Recipe path resolver: `resolveSullaRecipesDir()` in `pkg/rancher-desktop/agent/utils/sullaPaths.ts`
- Lifecycle manager: `pkg/rancher-desktop/agent/services/ServiceLifecycleManager.ts`
