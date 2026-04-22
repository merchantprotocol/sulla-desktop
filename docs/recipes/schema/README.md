# Recipes — Schema & Design

**Status:** Draft
**Date:** 2026-04-22
**Scope:** Defines what a **Recipe** is as a marketplace bundle, the folder layout, and how it maps to the `sulla/v3` marketplace manifest.

> Recipes use the **existing three-file extension layout** — no new format. The marketplace just adds a display/search manifest on top of what the desktop extension system already reads. For the extension runtime perspective see [`../../extensions/README.md`](../../extensions/README.md). For cross-kind lifecycle see [`../../bundles/README.md`](../../bundles/README.md).

---

## 1. What is a Recipe?

A **recipe** is the packaged configuration for a third-party extension — everything Sulla Desktop needs to launch the extension as a local Docker container stack:

- A catalog manifest describing what the extension is.
- An installation spec describing what Sulla should do to set it up.
- A Docker Compose file describing the containers.
- An icon.

Recipes do **not** ship Docker images. The Compose file references images by name + tag; Docker pulls them from the user's own registry at **launch time**, not install time. This is what keeps bundles small (typically tens of KB) and within the 25 MB marketplace cap.

Recipe vs. extension:

- **Recipe** — the marketplace asset. The four files + docs. Installable via the marketplace.
- **Extension** — a running container stack, managed at runtime by Sulla's Docker extension system.

A recipe becomes an extension when the user launches it.

## 2. Install target

```
paths.extensionRoot/<manifest.id>/
```

Resolved via `paths.extensionRoot` in [`pkg/rancher-desktop/utils/paths.ts`](../../../pkg/rancher-desktop/utils/paths.ts). On macOS this is `~/Library/Application Support/rancher-desktop/extensions/<manifest.id>/`.

**Critical:** recipes do NOT install to `~/sulla/recipes/`. They land in the same directory the existing extension manager already watches — the one the `sulla-recipes` GitHub-pull pipeline uses today. A marketplace-installed recipe is byte-identical on disk to one pulled from the `sulla-recipes` repo, so the existing [`RecipeExtensionImpl`](../../../pkg/rancher-desktop/main/extensions/recipeExtension.ts) install/start/stop/status/uninstall pipeline picks it up with no modifications.

The directory name is `manifest.id` (from the bundle's `manifest.yaml`), not the marketplace slug. This mirrors current behavior and keeps the integration point clean: the marketplace flow is "download the zip, drop it in the extension root, run the existing install."

Studio → Library → Recipes surfaces them. When the user launches one, the Docker extension system reads `installation.yaml` → runs setup steps → executes `commands.start` (typically `docker compose up -d`).

## 3. Bundle layout

The zip contains a single top-level directory (the slug) with three required files, an icon, and anything else the author wants to ship:

```
<slug>/
├── manifest.yaml           # REQUIRED — catalog metadata (extension name, description, labels, version)
├── installation.yaml       # REQUIRED — Sulla hooks: setup commands, registered URLs, dependencies, variables
├── docker-compose.yml      # REQUIRED — the Compose config Sulla runs
├── <slug>.svg              # REQUIRED — icon (any of: .svg, .png; typically <slug>.svg)
├── README.md               # RECOMMENDED — install/usage instructions for humans
├── CHANGELOG.md            # OPTIONAL — auto-mapped to manifest.metadata.changelog on publish
├── config-examples/        # OPTIONAL — sample .env, config JSON, etc.
│   └── .env.example
├── references/             # OPTIONAL — upstream API docs, project docs
│   └── *
├── assets/                 # OPTIONAL — screenshots, hero image for marketplace display
│   └── hero.png
└── .recipe-meta.yaml       # AUTO — exporter-managed (bundleSchemaVersion + checksums)
```

The three required files + icon match the existing layout in the [`sulla-recipes`](https://github.com/merchantprotocol/sulla-recipes) repo. Authors who already maintain a recipe there can publish to the marketplace by zipping the existing folder as-is.

### The two "manifests"

This layout unavoidably has two files/concepts called "manifest," which is confusing. To keep them straight:

| Name | Location | Purpose | Read by |
|------|----------|---------|---------|
| **Catalog manifest** (`manifest.yaml`) | Inside the bundle | Extension identity, display labels, version — per the existing `sulla-recipes` convention | Desktop extension runtime; sulla-admin when reviewing |
| **Marketplace manifest** (`sulla/v3` document) | NOT in the bundle — submitted separately to `/submit-manifest` | Marketplace display/search: previews, file tree, capability summaries, tags, media | Workers, admin review UI, website, Studio browser |

The marketplace manifest is **derived from the bundle** by the publishing client — it reads `manifest.yaml`, `installation.yaml`, `docker-compose.yml`, README, CHANGELOG, and produces the sulla/v3 document.

## 4. Required file details

### 4.1. `manifest.yaml` (catalog manifest)

The existing per-extension catalog metadata file. Shape as documented in [`docs/extensions/manifest-yaml.md`](../../extensions/manifest-yaml.md). Typical contents:

```yaml
name:        "Twenty CRM"
slug:        twenty-crm
description: "Open-source CRM you can self-host."
version:     "2.1.0"
icon:        twenty-crm.svg
labels:
  - crm
  - sales
homepage:    https://twenty.com
```

### 4.2. `installation.yaml`

Sulla-specific extension runtime hooks. Shape as documented in [`docs/extensions/installation-yaml.md`](../../extensions/installation-yaml.md). Typical contents:

```yaml
setup:
  - command: mkdir -p ~/sulla/recipes/twenty-crm/data

compose: docker-compose.yml

urls:
  - label: Twenty CRM
    url:   http://localhost:30207

dependencies:
  - extension: calendly
    version:   ">=1.5"

variables:
  - name:    PG_DATABASE_PASSWORD
    default: "{{ random.password(32) }}"
```

### 4.3. `docker-compose.yml`

A standard Docker Compose v3 file. Referenced from `installation.yaml`'s `compose:` field. Nothing Sulla-specific about it — `docker compose up -d` runs it verbatim.

### 4.4. Icon

Any image file referenced from `manifest.yaml`'s `icon:` field. SVG preferred. Served alongside the bundle at install time so Studio can render the card.

## 5. Derivation: bundle → sulla/v3 `recipeSummary`

At publish time the desktop reads the three required files and derives the marketplace manifest's `recipeSummary` block:

| Manifest field                     | Source                                                                 |
|------------------------------------|------------------------------------------------------------------------|
| `recipeSummary.extension`          | `manifest.yaml` → `slug`                                               |
| `recipeSummary.extensionVersion`   | `manifest.yaml` → `version`                                            |
| `recipeSummary.image`              | `docker-compose.yml` → first `services.*.image` (canonical reference)  |
| `recipeSummary.ports`              | `docker-compose.yml` → union of `services.*.ports[*]` host-port ints   |
| `recipeSummary.dependencies`       | `installation.yaml` → `dependencies[]` (passed through)                |
| `recipeSummary.configKeys`         | `installation.yaml` → `variables[].name`                               |
| `recipeSummary.requiredIntegrations` | none today; reserved for future Sulla-integration gating             |

Other marketplace-manifest fields:

| Manifest field                      | Source                                                                     |
|-------------------------------------|----------------------------------------------------------------------------|
| `metadata.name`                     | `manifest.yaml` → `name`                                                   |
| `metadata.description`              | `manifest.yaml` → `description`                                            |
| `metadata.version`                  | `manifest.yaml` → `version`                                                |
| `metadata.tags`                     | `manifest.yaml` → `labels`                                                 |
| `previews.readme`                   | bundle's `README.md` (if present)                                          |
| `previews.coreDoc`                  | `manifest.yaml` rendered (the "core doc" for recipes, reviewer-facing)     |
| `metadata.changelog`                | bundle's `CHANGELOG.md` (if present)                                       |

## 6. Kind detection for `bundles-import`

The bundle is recognized as a recipe when **all three** required files are present at the slug root:

- `manifest.yaml`
- `installation.yaml`
- `docker-compose.yml`

Missing any of the three → reject with `recipe bundle is missing required file: <filename>`. Using all three (rather than any one) disambiguates against other kinds that might happen to contain a `manifest.yaml` for their own reasons.

## 7. Import / export / publish / install

Follows the unified flow in [`../../bundles/README.md`](../../bundles/README.md):

- **Import** — user picks `.recipe.zip` or a folder. `bundles-import` confirms the three required files + parses `manifest.yaml` for the `id`, then lands at `paths.extensionRoot/<manifest.id>/` and triggers the existing install flow (setup commands + start).
- **Export** — `recipes-export(<manifest.id>)` zips `paths.extensionRoot/<manifest.id>/` as-is. Auto-regenerates `.recipe-meta.yaml` checksums on export.
- **Publish** — `bundles-publish(kind: 'recipe', id)` reads the three files + optional README/CHANGELOG → builds the `sulla/v3` marketplace manifest → submits to `/submit-manifest` → PUTs the zip.
- **Install from marketplace** — download zip → `bundles-install-from-marketplace` → extract to `paths.extensionRoot/<manifest.id>/` → call `RecipeExtensionImpl.installFromLocalAssets()` (new method) which skips GitHub asset fetch and runs the existing setup + start pipeline. Docker pulls the image the first time the user launches the extension.

### Why a new install entry point?

The existing `RecipeExtensionImpl.install()` does four phases: `fetchManifest → pullRecipeAssets → processAllRecipeFiles → runSetup → start`. Phase 2 (`pullRecipeAssets`) hits the GitHub Contents API to download files — that's inappropriate for marketplace installs where the files are already in the zip. The new `installFromLocalAssets()` method short-circuits that phase: files are already in the extension root, so we skip straight to variable resolution + setup + start.

Every other piece of the install pipeline — variable substitution, `.env` writing, integration credential saving, runtime commands — is reused verbatim. The refactor is additive, ~20 lines; nothing in the existing code path changes.

## 8. Relationship to the `sulla-recipes` repo

[`sulla-recipes`](https://github.com/merchantprotocol/sulla-recipes) is the pre-marketplace distribution: a single git repo with every extension's folder under `recipes/<slug>/`. Each folder is already exactly the bundle shape this doc describes.

Migration path: **no migration needed for bundle contents.** An author can publish an existing sulla-recipes folder to the marketplace by:

1. Zipping the folder (exporter handles this).
2. Adding optional `README.md`/`CHANGELOG.md`/`assets/hero.png` for richer marketplace display (still optional).
3. Running the publish flow.

The sulla-recipes repo continues to serve as the in-app default catalog. The marketplace is additive — community recipes that aren't in the repo.

## 9. Open questions

- **Image prefetch at install vs. pull at launch.** Current answer: pull at launch (keeps installs fast, respects the 25 MB cap). Revisit if UX research says users want pre-pulled images.
- **Port conflict detection at install.** Should Studio check `recipeSummary.ports` against bound host ports and warn before install? Nice-to-have, not blocking.
- **Multiple icons / additional media.** Does the marketplace card show `manifest.yaml`'s `icon:` or the `assets/hero.png`? Display guide suggests the latter when present. Confirm the display-guide's precedence matches the publish flow's media population.
