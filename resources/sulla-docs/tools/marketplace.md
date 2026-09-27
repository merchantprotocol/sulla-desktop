# Marketplace Tools

Browse, install, update, and publish artifacts on the **Sulla Marketplace**. The agent tools use the same code as the Marketplace tab in the app, so an install from either one looks identical on disk.

Marketplace kinds: `skill`, `function`, `routine` (alias `workflow`), `recipe`, `integration`.
`agent` is local-only: `scaffold`, `validate` and `list_local` accept it, but agents aren't distributed through the marketplace.

## How it talks to the cloud

- API: Sulla Cloud workers (`https://sulla-workers.merchantprotocol.workers.dev/marketplace/...`), the same host the Marketplace tab uses.
- **Reads need no sign-in:** `search`, `info`, `download`, `update` and `diff` work signed out.
- **Writes need a Sulla Cloud session:** `publish`, `unpublish` and `list_published`. The user signs in from the app (Marketplace tab or My Profile). There is no vault token. If the tools say "Sign in to Sulla Cloud", send the user there with `sulla ui/open_tab '{"mode":"marketplace"}'`.
- Publishing is reviewed. A new submission is **pending** until an admin approves it, then it goes live.

## Where artifacts land locally

| Kind | Directory |
|------|-----------|
| skill | `~/sulla/skills/<dir>/` |
| function | `~/sulla/functions/<dir>/` |
| routine | `~/sulla/routines/<dir>/` |
| recipe | `~/sulla/recipes/<dir>/`. Start it from Studio → Library → Recipes (Launch). |
| integration | `~/sulla/integrations/<dir>/`. Bundled functions and skills fan out to `~/sulla/functions/<integration>-<name>/` and `~/sulla/skills/<integration>-<name>/`. |

`<dir>` is the bundle's top-level folder, which isn't always the slug (e.g. `twenty-crm` installs as `twenty/`). Every marketplace install writes a `.marketplace.json` marker (template id, version, install time). That marker is how "already installed" and "update available" work, so don't delete it.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla marketplace/search` | Search live listings by `query` / `kind` / `category`. Shows version, author, downloads, and installed / update-available status. |
| `sulla marketplace/info` | Full detail for one listing (`kind` + `slug`): template id, author, category, manifest metadata and summary, install status. |
| `sulla marketplace/download` | Install a listing. No-op if already installed. `overwrite:true` replaces it in place. |
| `sulla marketplace/update` | Update an installed listing to the latest version, in place. Restored if the update fails. |
| `sulla marketplace/diff` | Files only in the marketplace, only local, or differing, before you update. Read-only. |
| `sulla marketplace/scaffold` | Generate a new local artifact skeleton. |
| `sulla marketplace/validate` | Validate a local artifact against its kind's schema. |
| `sulla marketplace/publish` | Submit a local artifact for review. Signed in only. |
| `sulla marketplace/unpublish` | Take down your own submission (`confirm:true` required). Signed in only. |
| `sulla marketplace/list_local` | List local artifacts by kind. |
| `sulla marketplace/list_published` | Your submissions with status (pending / live / rejected), downloads, and reviewer notes. Signed in only. |

## Common requests

```bash
sulla marketplace/search '{}'                                          # everything
sulla marketplace/search '{"kind":"function","query":"pdf"}'
sulla marketplace/search '{"category":"Finance"}'
sulla marketplace/info '{"kind":"function","slug":"pdf-merge"}'
sulla marketplace/download '{"kind":"function","slug":"pdf-merge"}'
sulla marketplace/diff '{"kind":"function","slug":"pdf-merge"}'       # before updating
sulla marketplace/update '{"kind":"function","slug":"pdf-merge"}'
sulla marketplace/scaffold '{"kind":"function","slug":"my-tool","runtime":"python"}'
sulla marketplace/validate '{"kind":"function","slug":"my-tool"}'
sulla marketplace/publish '{"kind":"function","slug":"my-tool","version":"1.0.0"}'
sulla marketplace/list_published '{}'
sulla marketplace/unpublish '{"kind":"function","slug":"my-tool","confirm":true}'
```

## Hard rules

- **Publishing is outward-facing.** Confirm with the user before `publish` (see `agent-patterns/user-consent.md`).
- **`unpublish` requires `confirm:true`.** For an approved listing, it withdraws it (kept in your submissions as rejected). For a pending one, it deletes it.
- **`update` and `download` with `overwrite:true` replace the whole folder.** Local edits to an installed artifact are lost, so run `diff` first.
- **Publish never uploads secrets or junk:** `.env*` (except `.env.example` / `.sample` / `.template`), `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pem` / `*.key`, `.DS_Store`, and `.marketplace.json` are excluded.
- **Bundles are extracted defensively:** single top-level folder, no path traversal, no symlinks, 50 MB download cap.

## Reference

- Agent tools: `pkg/rancher-desktop/agent/tools/marketplace/`
- API client: `pkg/rancher-desktop/main/marketplace/client.ts`
- Install pipeline: `pkg/rancher-desktop/main/marketplace/install.ts`
- Publish pipeline: `pkg/rancher-desktop/main/marketplace/publish.ts`, `bundleFiles.ts`, `manifestBuilder.ts`
- Server: `sulla-workers` → `src/routes/marketplace.ts` (public + author), `src/routes/admin/marketplace.ts` (review)
