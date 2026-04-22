# Bundles — the four-kind peer model

**Status:** Draft
**Date:** 2026-04-22
**Scope:** The shared contract for how Sulla Desktop imports, exports, and publishes the four kinds of shareable assets: **routines, skills, functions, recipes**.

All four are peers. They share the same bundle format, the same import/export/publish flow, and the same marketplace envelope — only the contents and install target differ.

> This doc is the one-stop reference for any code touching import/export/publish. Per-kind folder layouts and runtime concerns live in the kind's own schema doc (linked below).

---

## 1. The four kinds

| Kind        | Core doc(s)                                                      | Install target                                   | Runtime handler                 | Per-kind schema |
|-------------|------------------------------------------------------------------|--------------------------------------------------|---------------------------------|-----------------|
| `routine`   | `routine.yaml`                                                   | `~/sulla/routines/<slug>/`                       | In-process DAG walker           | [routines/schema/](../routines/schema/README.md) |
| `skill`     | `SKILL.md`                                                       | `~/sulla/skills/<slug>/`                         | Agent prompt loader             | [skills/schema/](../skills/schema/README.md) |
| `function`  | `function.yaml`                                                  | `~/sulla/functions/<slug>/`                      | Python/Node/shell runtime       | [functions/schema/](../functions/schema/README.md) |
| `recipe`    | `manifest.yaml` + `installation.yaml` + `docker-compose.yml`     | `paths.extensionRoot/<manifest.id>/` (see §1.1)  | Existing Docker extension system | [recipes/schema/](../recipes/schema/README.md) |

### 1.1. Note on the recipe install target

Recipes install into the **existing extension root**, not `~/sulla/recipes/`. This is the directory the current extension manager already watches (`paths.extensionRoot` in [`pkg/rancher-desktop/utils/paths.ts`](../../pkg/rancher-desktop/utils/paths.ts)):

- macOS: `~/Library/Application Support/rancher-desktop/extensions/<manifest.id>/`
- Linux: `$XDG_DATA_HOME/rancher-desktop/extensions/<manifest.id>/`
- Windows: analogous via `WindowsPaths`

Directory name = `manifest.id` from the bundle's `manifest.yaml`, NOT the marketplace slug. This matches how GitHub-pulled recipes already land today — a marketplace-installed recipe is indistinguishable on disk from a `sulla-recipes` repo–pulled one, and the existing `RecipeExtensionImpl` install/start pipeline picks it up identically.

The `~/sulla/recipes/` path (`resolveSullaRecipesDir()`) is reserved and not currently used by the extension manager; marketplace installs do not write there.

Install targets are the canonical user-writable directories. Resource-shipped copies (the default skills/agents/workflows that ship with the app) live under `~/sulla/resources/` and are not affected by import.

## 2. Common bundle shape

Every kind ships as a **folder** zipped into `<slug>.{routine,skill,function,recipe}.zip`. The top level of the zip is a single directory — the slug:

```
<slug>/
├── <core-doc(s)>              # REQUIRED, kind-dependent:
│                              #   routine  → routine.yaml
│                              #   skill    → SKILL.md
│                              #   function → function.yaml + main.{py,js,sh}
│                              #   recipe   → manifest.yaml + installation.yaml + docker-compose.yml + icon
├── README.md                  # RECOMMENDED — human-facing overview
├── AGENT.md                   # OPTIONAL for routines; rare for other kinds
├── CHANGELOG.md               # OPTIONAL — auto-mapped to manifest.metadata.changelog on publish
├── skills/                    # OPTIONAL — only routines ship secondary skill files
├── prompts/                   # OPTIONAL
├── references/                # OPTIONAL
├── assets/                    # OPTIONAL
├── examples/                  # OPTIONAL
├── functions/                 # OPTIONAL — only routines bundle helper functions
├── tests/                     # OPTIONAL — only functions use this
├── config-examples/           # OPTIONAL — only recipes use this
└── .<kind>-meta.yaml          # AUTO — exporter-managed, holds bundleSchemaVersion + checksums
```

Only the core doc is mandatory. Everything else is opt-in; the importer reads whatever's present, the exporter bundles whatever's present.

**Security invariants** (enforced by the importer):
- Exactly one top-level directory inside the zip (the slug).
- No `..`, absolute paths, null bytes, or symlinks in any entry.
- File size caps: 100 MB per file, 500 MB per bundle (runtime-enforced), 25 MB at the marketplace edge.

## 3. IPC contract

| IPC                           | Direction          | Purpose |
|-------------------------------|--------------------|---------|
| `bundles-import`              | renderer → main    | Unified import. Opens a picker (zip or folder), sniffs the core doc, lands the bundle at the right install target. |
| `routines-export`             | renderer → main    | Export a DB routine as a zip. Merges sibling files from `source_template_slug` folder when present. |
| `routines-export-template`    | renderer → main    | Zip `~/sulla/routines/<slug>/` as-is. |
| `skills-export`               | renderer → main    | Zip `~/sulla/skills/<slug>/` as-is. |
| `functions-export`            | renderer → main    | Zip `~/sulla/functions/<slug>/` as-is. |
| `recipes-export`              | renderer → main    | Zip `~/sulla/recipes/<slug>/` as-is. |
| `bundles-publish`             | renderer → main    | Build the sulla/v3 manifest + bundle zip, two-step submit to the marketplace. Dispatches to per-kind manifest builders. |
| `bundles-install-from-marketplace` | renderer → main | Download a bundle zip by `tpl_<id>`, hand to `bundles-import` internally. |
| `app-state:set-routine-context` | renderer → main  | Pushes current visible surface so the File menu can enable/disable per-kind export items. Payload extended to `{mode: 'routine' | 'skill' | 'function' | 'recipe' | 'template', id?: string, slug?: string, name?: string}`. |

Only routines have a DB representation, so only `routines-export` does the DB→folder merge. Skills/functions/recipes are file-system native; their export is a pure folder zip.

## 4. Kind detection

`bundles-import` sniffs the extracted bundle to decide the kind. Priority order (first match wins):

1. `routine.yaml` at the bundle root → `routine`
2. `function.yaml` at the bundle root → `function`
3. **All three** of `manifest.yaml` + `installation.yaml` + `docker-compose.yml` at the bundle root → `recipe`
4. `SKILL.md` at the bundle root → `skill`

If none match, reject with `no recognized core doc(s) at bundle root (expected one of: routine.yaml, function.yaml, SKILL.md, or the recipe trio manifest.yaml+installation.yaml+docker-compose.yml)`.

Recipes intentionally require all three files together so that a bundle whose authors happen to ship a generic `manifest.yaml` (for some other purpose) isn't misidentified. Partial recipes — any two of the three — are rejected as malformed with a message naming the missing file.

If a routine/function/skill bundle *also* contains the recipe trio at its root, that's a malformed bundle (ambiguous kind). Reject with `ambiguous bundle — multiple kinds detected`. A bundle must declare a single kind.

## 5. Import flow (all kinds)

```
1. User picks .zip or folder via dialog.
2. Create tmpdir.
3. If zip: stream extract via yauzl with per-entry validation.
   If folder: copy tree, reject symlinks.
4. Resolve the single top-level directory inside tmpdir.
5. Sniff core doc (§4) → determine kind.
6. Validate the core doc minimally (parseable, has required fields per kind's schema).
7. Derive slug: prefer top-level dir name; fall back to slugify(core-doc.name).
8. Pick available slug at ~/sulla/<kind>s/<slug>/ (suffix -2, -3, ... on collision).
9. Atomic rename tmpdir → install target.
10. Return { kind, slug, id?, name }.
```

The importer never touches the database. Creating a runnable routine from an imported template is a separate user action (via "Use template").

## 6. Export flow

### 6.1. Routines (DB-backed)

Special case — the DAG lives in Postgres, so export merges:

```
1. Create tmpdir.
2. If routine.source_template_slug is set AND ~/sulla/routines/<slug>/ exists:
     copy template folder contents → tmpdir (preserves AGENT.md, skills/, prompts/, etc.)
   Else:
     seed with a minimal README.md.
3. Strip runtime state (node.data.execution, lastRunId, lastRunOutput) from the DB definition.
4. Serialize cleaned definition → tmpdir/routine.yaml (overwriting template's version).
5. Regenerate tmpdir/.routine-meta.yaml with fresh checksums.
6. Prompt for destination, default <slug>.routine.zip.
7. Zip tmpdir with slug/ as the root folder inside the archive.
8. Clean tmpdir.
```

Never writes back to `~/sulla/routines/`.

### 6.2. Skills / Functions / Recipes (folder-native)

All three are the same algorithm:

```
1. Prompt for destination, default <slug>.<kind>.zip.
2. Zip ~/sulla/<kind>s/<slug>/ as-is with slug/ as the root folder inside the archive.
3. Regenerate .<kind>-meta.yaml inside the zip on the fly (optional — or require the source folder to have it current).
```

No DB involvement. The folder on disk IS the source of truth.

## 7. Publish flow (marketplace)

Bundle publish is a **two-step** upload to `sulla-workers`:

```
1. Build manifest locally:
   - Hash every file in the bundle (sha256) → bundle.files[]
   - Read README.md, core doc → previews
   - Read AGENT.md/SKILL.md frontmatter, core doc → routineSummary / skillSummary / etc.
   - Read CHANGELOG.md → metadata.changelog
   - Read kind-specific publish fields (tagline, category, license, media, stats, etc.)
2. POST /marketplace/submit-manifest → receive tpl_<id>
3. PUT  /marketplace/templates/<id>/bundle (application/zip body)
4. Display success + link to My Submissions on sulladesktop.com.
```

The manifest schema (`sulla/v3`) is defined by the marketplace repo and validated against [`docs/marketplace/manifest-schema.json`](../../../docs/marketplace/manifest-schema.json). Client-side validation should run before the first POST so the user sees errors immediately instead of a worker 400.

Per-kind manifest builders live under `pkg/rancher-desktop/main/marketplace/manifest/{routine,skill,function,recipe}.ts`. They share a common helper for file-tree + checksum + preview extraction; only the kind-specific `*Summary` block differs.

## 8. Install from marketplace

```
1. User clicks Install on sulladesktop.com → sulla:// deep link OR direct download.
2. Desktop receives template id, GETs /marketplace/templates/<id>/download.
3. Saves zip to tmp file.
4. Hands to bundles-import internally (same unified flow as local zip import).
5. Navigates Studio → Library → <kind> tab so the user sees the new card.
```

No kind-specific endpoints — every download returns the same content-type (`application/zip`), and the universal importer handles it.

## 9. Studio Library (UI reorganization)

With four kinds as peers, the existing "Routines Home" evolves into a broader **Studio → Library** surface. Tabs:

| Tab | Content | Primary action |
|-----|---------|----------------|
| My Routines | DB routines (existing) | Run / Edit / Export |
| My Templates | `~/sulla/routines/` folders | Use template (instantiate into DB) / Export |
| My Skills | `~/sulla/skills/` folders | Enable / Export |
| My Functions | `~/sulla/functions/` folders | Run / Export |
| My Recipes | `~/sulla/recipes/` folders | Launch / Export |
| Marketplace | Browse/install from sulla-workers | Install |
| Archive | Archived routines | Restore |

Each list tab has the same `+ Import` button in the header (wired to `bundles-import`; kind follows from the zip contents, tab switches after success).

This is a UX consolidation — the code changes are additive, not replacements. The existing Routines Home can host the new tabs until a full Studio shell is designed.

## 10. File menu layout

```
File › Routines
├── Import…                   (unified — calls bundles-import)
├── Export Current Routine…   (enabled when mode='routine')
├── Export Current Skill…     (enabled when mode='skill')
├── Export Current Function…  (enabled when mode='function')
└── Export Current Recipe…    (enabled when mode='recipe')
```

"Import…" stays unified because the zip tells us the kind. Export items split because the user is viewing a specific thing in a specific surface, and the context tracker knows which.

Submenu label is "Routines" today for historical reasons; renames to "Bundles" or "Library" when the Studio reorg lands.

## 11. Reconciliation notes (unresolved)

These need a call before the corresponding code lands:

### 11.1. Skills folder sharing with `resources/skills`

`resolveSullaSkillsDir()` currently returns `~/sulla/resources/skills` (resource-shipped). User skills import to `resolveSullaUserSkillsDir()` = `~/sulla/skills`. The skill loader needs to scan both paths with the user dir taking precedence on slug collision. Verify this is already the case before marketplace-installed skills are expected to activate.

### 11.2. sulla:// protocol registration

The marketplace display-guide references `sulla://marketplace/install?id=<id>` deep links. Verify the desktop registers this protocol handler (Electron `app.setAsDefaultProtocolClient`) and routes to `bundles-install-from-marketplace`. If not registered, add it before the marketplace install CTA goes live.

## 12. Related docs

- [routines/schema/README.md](../routines/schema/README.md) — routine DAG + folder layout
- [routines/schema/folder-layout.md](../routines/schema/folder-layout.md) — full routine bundle spec
- [functions/schema/README.md](../functions/schema/README.md) — function runtime + folder layout
- [skills/schema/README.md](../skills/schema/README.md) — skill bundle spec (new)
- [recipes/schema/README.md](../recipes/schema/README.md) — recipe bundle spec (new)
- [../../docs/marketplace/README.md](../../../docs/marketplace/README.md) — marketplace contract (manifest + bundle, sulla/v3)
- [../../docs/marketplace/manifest-schema.json](../../../docs/marketplace/manifest-schema.json) — formal manifest JSON Schema
