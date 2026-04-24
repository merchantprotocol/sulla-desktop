# Marketplace Tools

Generic artifact lifecycle for the Sulla marketplace. Works across **6 artifact kinds**: `skill`, `function`, `workflow`, `agent`, `recipe`, `integration`.

## How it talks to the cloud

The tools hit a Sulla Cloud marketplace API:

| Setting | Source | Default |
|---------|--------|---------|
| Base URL | vault `sulla-cloud` integration → `marketplace_url` | `https://marketplace.sulla.dev` |
| Auth | vault `sulla-cloud` integration → `api_token` (Bearer) | (none — read endpoints may still work) |

**Today (2026-04-23):** the cloud marketplace worker isn't deployed yet. Reads degrade gracefully — `search` falls back to the GitHub recipes catalog (`merchantprotocol/sulla-recipes/index.yaml`) for `kind=recipe`. Writes (publish/unpublish) return a clear "marketplace API not reachable" message until the worker ships.

## Where artifacts live locally

| Kind | Local directory | Manifest file | Companion files |
|------|-----------------|---------------|-----------------|
| skill | `~/sulla/resources/skills/<slug>/` | `SKILL.md` | (single-file bundle) |
| function | `~/sulla/functions/<slug>/` | `function.yaml` | `main.{py,js,sh}`, `requirements.txt` / `package.json` / `packages.txt`, `FUNCTION.md` |
| workflow | `~/sulla/routines/<slug>/` | `routine.yaml` | (single-file bundle) |
| agent | `~/sulla/resources/agents/<slug>/` | `config.yaml` | `soul.md` |
| recipe | `~/sulla/recipes/<slug>/` | `manifest.yaml` | `docker-compose.yml`, `installation.yaml`, icon |
| integration | `~/sulla/integrations/<slug>/` | `<slug>.v<N>-auth.yaml` (dynamic filename) | `INTEGRATION.md`, `<endpoint>.v<N>.yaml` (one per endpoint) |

`marketplace/download` materialises into the right dir automatically.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla marketplace/search` | Search marketplace by `query` / `kind` / `category` |
| `sulla marketplace/info` | Full metadata for one artifact (`kind` + `slug`) |
| `sulla marketplace/download` | Pull an artifact and materialise it locally |
| `sulla marketplace/scaffold` | Generate a new artifact dir with kind-appropriate skeleton |
| `sulla marketplace/validate` | Validate a local artifact against its kind's schema |
| `sulla marketplace/publish` | POST a local artifact to the cloud marketplace |
| `sulla marketplace/unpublish` | DELETE a published artifact (`{"confirm":true}` required) |
| `sulla marketplace/list_local` | List locally-installed artifacts (filterable by kind) |
| `sulla marketplace/list_published` | List artifacts the current user has published |
| `sulla marketplace/update` | Pull the latest version of an installed artifact (overwrite) |

## Common requests

### "What can I install?"
```bash
sulla marketplace/search '{}'                                            # everything
sulla marketplace/search '{"kind":"function"}'                           # functions only
sulla marketplace/search '{"query":"pdf","kind":"function"}'             # PDF-related functions
sulla marketplace/search '{"category":"crm"}'                            # CRM-tagged
```

### "Tell me more about X"
```bash
sulla marketplace/info '{"kind":"function","slug":"pdf-extract-text"}'
```

### "Install / download X"
```bash
sulla marketplace/download '{"kind":"function","slug":"pdf-extract-text"}'
sulla marketplace/download '{"kind":"function","slug":"pdf-extract-text","overwrite":true}'
```

For **recipes** (Docker-compose extensions like Twenty CRM), `extensions/install_extension` is still the dedicated path — it handles compose lifecycle. `marketplace/download` for kind=recipe just lays the files; you'd still install via `extensions/install_extension`.

### "Start / stop / restart a recipe"
Recipes (Docker-compose extensions) have their own lifecycle controls under `extensions/`:
```bash
sulla extensions/get_extension_status '{"id":"docker.io/.../twenty:2.1.0"}'
sulla extensions/start_extension '{"id":"docker.io/.../twenty:2.1.0"}'
sulla extensions/stop_extension '{"id":"docker.io/.../twenty:2.1.0","confirm":true}'   # confirm:true required
```
Stopping kills the container stack — web UI and any dependent flows go down. Data on disk is preserved. Use `start_extension` to bring it back up. Restart = stop then start.

### "Build me a new function / skill / workflow"
```bash
sulla marketplace/scaffold '{"kind":"function","slug":"my-tool","name":"My Tool","description":"…","runtime":"python"}'
sulla marketplace/scaffold '{"kind":"skill","slug":"my-skill"}'
sulla marketplace/scaffold '{"kind":"workflow","slug":"my-routine"}'
sulla marketplace/scaffold '{"kind":"agent","slug":"my-agent"}'
sulla marketplace/scaffold '{"kind":"recipe","slug":"my-recipe"}'
sulla marketplace/scaffold '{"kind":"integration","slug":"my-service"}'
```

Generates the directory + manifest + handler/companion files. Then iterate.

### "Validate this before I publish"
```bash
sulla marketplace/validate '{"kind":"function","slug":"my-tool"}'
```
Returns errors per the kind's schema. For workflows, also run `sulla meta/validate_sulla_workflow` for the deeper graph-level check.

### "Publish my function"
```bash
sulla marketplace/publish '{"kind":"function","slug":"my-tool"}'
sulla marketplace/publish '{"kind":"function","slug":"my-tool","version":"1.2.0"}'
```
Bundles the manifest + companion files (text or base64 for binaries), POSTs to the cloud. Skips files >5MB and `node_modules` / `__pycache__` / `.*` dirs.

### "Take down my published artifact"
```bash
sulla marketplace/unpublish '{"kind":"function","slug":"my-tool","confirm":true}'
```
**`confirm:true` is required** — the tool refuses without it. Local copy is untouched.

### "What do I have installed?"
```bash
sulla marketplace/list_local '{}'                       # all kinds
sulla marketplace/list_local '{"kind":"function"}'      # filter
```

### "What have I published?"
```bash
sulla marketplace/list_published '{}'
```
Requires Sulla Cloud token in vault.

### "Update X to the latest version"
```bash
sulla marketplace/update '{"kind":"function","slug":"pdf-extract-text"}'
```

## Hard rules

- **`unpublish` requires `confirm:true`.** Same as destructive Docker — guard against accidental deletes.
- **`download` won't overwrite** an existing local copy unless `overwrite:true` — protects in-progress edits.
- **Files >5MB are skipped** during publish (logged with a `__SKIPPED__` marker in the file map). Use external storage / object hosting for big binaries.
- **Hidden dirs (`.*`), `node_modules`, `__pycache__`** are excluded automatically from publish bundles.
- **For recipes**, prefer `extensions/install_extension` over `marketplace/download` for actual deployment — recipes need compose lifecycle which only the extensions backend handles.

## When the cloud isn't reachable

- `search` for `kind=recipe` falls back to the GitHub catalog automatically — works today
- `search` for other kinds returns an error (no fallback)
- `info`, `download`, `publish`, `unpublish`, `list_published`, `update` return a clear error explaining the cloud worker isn't deployed
- `scaffold`, `validate`, `list_local` work entirely locally — no cloud required

## What's still missing

- **`marketplace/diff`** — compare local vs marketplace version (planned)
- **Per-routine deep-link** — `marketplace/info` returns metadata, not the visual canvas
- **OAuth flow inside `publish`** — token must be in vault first; no in-tool sign-in

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/marketplace/`
- HTTP client: `pkg/rancher-desktop/agent/tools/marketplace/MarketplaceClient.ts`
- Per-kind layouts: `pkg/rancher-desktop/agent/tools/marketplace/types.ts`
- Existing extensions tool (recipe install lifecycle): `pkg/rancher-desktop/agent/tools/extensions/`
- Cloud worker (TODO — not yet implemented): `sulla-cloud/workers/marketplace`
