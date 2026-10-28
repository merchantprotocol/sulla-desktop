# Marketplace Tools

Browse, install, update, and publish artifacts on the **Sulla Marketplace**. The agent tools use the same installer as the Use Cases tab in the app.

Artifact kinds: `skill`, `function`, `workflow`, `recipe`, `integration`, and `agent`. The internal API key for workflows is `routine`; user-facing text calls them **Workflows**. Agents can be scaffolded, validated, published, downloaded, and updated like other marketplace artifacts.

## How it talks to the cloud

- API host: `https://sulla-workers.merchantprotocol.workers.dev` (the Sulla Cloud workers the Marketplace tab uses).
- **Reads need no sign-in:** `search`, `info`, `download`, `update` and `diff`.
- **Writes need a Sulla Cloud session:** `publish`, `unpublish` and `list_published`. The user signs in from the app. If the tools say "Sign in to Sulla Cloud", send the user there with `sulla ui/open_tab '{"mode":"marketplace"}'`.
- Publishing is reviewed. A new submission is **pending** until an admin approves it, then it goes live.

## Where artifacts land locally

Installs go into the database through the same installer the Use Cases tab uses. Nothing is written under `~/sulla/` for a marketplace install. `marketplace/list_local` reads the database and falls back to legacy user-owned folders.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla marketplace/search` | Search live listings by `query`, `kind` (or `kinds`), and `category`. Shows version, author, downloads, and installed / update-available status. |
| `sulla marketplace/info` | Full detail for one listing (`kind` + `slug`): template id, author, category, manifest metadata and summary, install status. |
| `sulla marketplace/download` | Install a listing. `overwrite:true` replaces the installed copy. A package installs all its items in one all-or-nothing transaction. |
| `sulla marketplace/update` | Update an installed listing to the latest version, in place. Restored if the update fails. Errors if it was not installed from the marketplace. |
| `sulla marketplace/diff` | Files only in the marketplace, only local, or differing, before you update. Read-only. |
| `sulla marketplace/scaffold` | Generate a new local artifact skeleton (`kind`, `slug`, optional `name`, `description`, `runtime`). Does not touch the marketplace. |
| `sulla marketplace/validate` | Validate a local artifact against its kind's schema. |
| `sulla marketplace/publish` | Submit a local artifact for review (`version` optional). Signed in only. |
| `sulla marketplace/unpublish` | Take down your own submission (`confirm:true` required). Signed in only. Does not touch your local copy. |
| `sulla marketplace/list_local` | List local artifacts, optionally filtered by `kind`. |
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
- **`update` and `download` with `overwrite:true` replace the installed copy.** Local edits are lost, so run `diff` first.
- **Publish never uploads secrets or junk:** `.env*` (except `.env.example` / `.sample` / `.template`), `.git`, `node_modules`, `__pycache__`, `.venv`, `*.pem` / `*.key` / `*.p12` / `*.pfx`, `.DS_Store`, `.marketplace.json`, and `.npmrc` / `.pypirc` / `.netrc` are excluded.
- **Bundles are extracted defensively:** no symlink entries, 50 MB download cap per bundle, 500 MB total extracted.

## Reference

- Agent tools: `pkg/sulla-desktop/agent/tools/marketplace/`
- API client: `pkg/sulla-desktop/main/marketplace/client.ts`
- Install pipeline: `pkg/sulla-desktop/main/marketplace/install.ts`, `databaseInstaller.ts`
- Publish pipeline: `pkg/sulla-desktop/main/marketplace/publish.ts`, `bundleFiles.ts`, `manifestBuilder.ts`

## Submission review and signatures

`marketplace/publish` submits a version for automated and human review; it does not make the version live. Automated review checks the per-kind manifest, package size, likely secrets/credentials, declared hooks and permissions, referenced network hosts, and shell-use flags. Administrators can approve, request changes, or reject with author-visible notes. Use `marketplace/list_published` to read the current decision and notes.

Approval signs the approved manifest and payload with the marketplace Ed25519 key. All marketplace installs verify that signature and integrity before writing anything locally; unsigned or tampered downloads fail closed. This applies to skills, functions, workflows, recipes, agents, integrations, and multi-item packages. Local artifacts and unpublished development copies remain installable through their existing local paths. Every update is reviewed independently and is offered only after approval.

### Signature enforcement rollout

Signed downloads are always verified: a tampered or untrusted signature is refused. Unsigned listings still install, with a warning in the log, until `resources/trusted-integration-publishers.json` sets `"requireSignatures": true`. Flip that switch only after the marketplace signing key is provisioned, its public key is listed in `keys`, and existing listings have been re-signed.
