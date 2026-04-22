# Routine Template Folder Layout

**Status:** Draft
**Date:** 2026-04-22
**Scope:** Defines the folder layout of a **template** at `~/sulla/routines/<slug>/` and the `.routine.zip` bundle that moves between machines.

A template is a folder, not a file. `routine.yaml` is required; everything else is opt-in. The importer reads whatever is present; the exporter bundles whatever is present. Unknown files are preserved on round-trip.

This model mirrors [Claude Skills](https://github.com/anthropics/skills) and the agentskills.io convention: the folder is the shareable artifact, structured by directory so both humans and the orchestrating agent can find what they need.

---

## 1. Complete layout

```
<slug>/
├── routine.yaml              # REQUIRED — the DAG (validated against routine.schema.json)
├── README.md                 # RECOMMENDED — human-facing overview
├── AGENT.md                  # OPTIONAL — instructions for the orchestrating agent (§3)
├── CHANGELOG.md              # OPTIONAL
├── skills/                   # OPTIONAL — per-routine skill docs the orchestrator loads
│   └── <skill-slug>.md
├── prompts/                  # OPTIONAL — reusable prompt fragments referenced from nodes
│   └── <name>.md
├── references/               # OPTIONAL — extended docs, API specs, PDFs
│   └── *
├── assets/                   # OPTIONAL — images, diagrams, screenshots
│   └── *
├── functions/                # OPTIONAL — local function bundles this routine depends on
│   └── <function-slug>/
│       └── function.yaml     #   (mirror of ~/sulla/functions/ layout, bundled for portability)
├── examples/                 # OPTIONAL — sample inputs/outputs for LLM few-shot or docs
│   ├── input.json
│   └── output.json
└── .routine-meta.yaml        # AUTO — exporter-managed; see §4
```

**Minimum viable template:** just `routine.yaml`.

**Recommended template for sharing:** `routine.yaml` + `README.md` + `AGENT.md`.

---

## 2. Per-file rules

### `routine.yaml` — REQUIRED

The DAG document. Validated against [routine.schema.json](./routine.schema.json). Identical in shape to the `workflows.definition` JSONB column. This is what gets loaded into Postgres when a user instantiates the template.

### `README.md` — RECOMMENDED

Human-facing. What the routine does, when to use it, any setup it assumes (integrations, vault accounts, external services). Rendered in the template card's detail view.

### `AGENT.md` — OPTIONAL

Orchestrator-facing. Read by the agent that runs the routine. YAML frontmatter + markdown body. See §3.

### `CHANGELOG.md` — OPTIONAL

Free-form version history. Not parsed by the app.

### `skills/` — OPTIONAL

Each `.md` file here is a skill the orchestrating agent can load while running the routine. Same idea as Claude Skills' SKILL.md — a scoped capability the agent can activate. Skill filenames are slugs; the body is freeform markdown with optional YAML frontmatter. The orchestrator loads all skills in this folder when it starts a run.

### `prompts/` — OPTIONAL

Reusable prompt fragments that can be referenced from `routine.yaml` nodes via the template syntax `{{ file:prompts/<name>.md }}`. Keeps long system prompts out of the YAML and in dedicated editable files.

### `references/` — OPTIONAL

Extended documentation the orchestrating agent may consult on demand — API references, schema dumps, PDFs, whatever. Not loaded automatically; the agent pulls them as needed.

### `assets/` — OPTIONAL

Static binary/media assets. Two distinct roles:

1. **Documentation assets** — images referenced from `README.md` / `AGENT.md`, screenshots, diagrams, sample CSVs, exporter-prep hero art. Filenames are free-form.

2. **Sticky-note media** — images, diagrams, or locally-hosted clips embedded in canvas sticky notes. These are referenced from `node.data.content` (the sticky's markdown) via the `sulla-routine-asset://<slug>/<file>` URI scheme. The renderer resolves that URI to `~/sulla/routines/<slug>/assets/<file>` so the canvas shows the image even when the routine has never been exported. When the user drops an image onto a sticky note, the desktop app copies the file into this folder and rewrites the markdown to reference it.

   Recommended convention for drop-targeted files: `sticky-<nodeId>-<original-filename>` — keeps per-note media grouped and prevents filename collisions across multiple sticky notes in the same routine.

Sticky notes may also embed remote media directly (absolute HTTPS URLs for images; YouTube / Vimeo / `.mp4|.webm|.ogg` URLs auto-embed as players). Use `assets/` when you want the media to travel inside the bundle — otherwise remote URLs are fine and keep the zip small.

### `functions/` — OPTIONAL

Bundled function code that the routine's function nodes depend on. Each subfolder is a full [function bundle](../../functions/schema/README.md) (with its own `function.yaml`). On import, these do **not** auto-install to `~/sulla/functions/` — they're shipped alongside for reference/portability. Promoting them to the runtime is a separate user action (out of scope for v1).

### `examples/` — OPTIONAL

Sample inputs and outputs. Useful for documentation, LLM few-shot context, and testing. Not executed.

### `.routine-meta.yaml` — AUTO-MANAGED

Written by the exporter, read by the importer. Users should not hand-edit. Schema:

```yaml
bundleSchemaVersion: 1            # bumps when this folder layout changes
exportedAt: 2026-04-22T17:30:00Z
exportedBy:
  host: jons-mac.local            # for human traceability only, not enforced
  sullaVersion: 2.1.0
sourceTemplateSlug: dedupe-emails # if this routine was instantiated from a template
sourceRoutineId: routine-abc123   # the DB routine id at export time; informational
checksums:
  routine.yaml: sha256:<hex>
  AGENT.md:     sha256:<hex>
  # ... one entry per file in the bundle
```

Checksums let the importer detect corruption; everything else is informational.

---

## 3. `AGENT.md` frontmatter

Optional but highly recommended. Serves two purposes:

1. **Orchestrator hints** — the agent running the routine reads the frontmatter to decide whether to run it, how to wire it up, and what capabilities it needs.
2. **Marketplace manifest source** — when the template is published, the publish flow reads the frontmatter to populate `manifest.metadata.*` and the per-kind summary block. See the marketplace [manifest schema](../../../../docs/marketplace/manifest-schema.json) for the destination shape.

```markdown
---
# ── Orchestrator hints (used locally) ─────────────
name: Email Deduper
summary: One-line pitch the orchestrator sees in routine lists.
triggers: [heartbeat]
required_integrations: [gmail]
required_vault_accounts: [google]
required_functions: [dedupe-emails]
entry_node: node-trigger

# ── Marketplace publish metadata (optional, all only matter if published) ──
tagline: "Keep your inbox list clean on every tick."
category: ops                    # routines: content | research | planning | leads | learning | ops | goals
license: MIT                     # SPDX id or free-form label
media:
  hero:
    type: image                  # image | gif | video
    url: https://cdn.example.com/dedupe-emails-hero.jpg
    poster: https://cdn.example.com/dedupe-emails-poster.jpg   # video only
  screenshots:
    - url: https://cdn.example.com/dedupe-screen-1.png
      caption: "Inbox before dedup"
author:
  displayName: "Acme Plumbing"
  url: https://acme.example.com
stats:
  estimatedRunTime: "~45 seconds"
  estimatedCostPerRun: "<$0.01"
stages:
  - title: "Pull inbox"
    description: "Fetch the current email list from the upstream source."
  - title: "Dedupe"
    description: "Compare addresses case-sensitively, keep first occurrence."
  - title: "Emit"
    description: "Return the unique list downstream."
---

# When to use this routine

Freeform markdown the agent reads before invoking. Describe preconditions,
expected inputs, what "success" looks like, common failure modes.
```

### Orchestrator-hint fields

| Field                     | Type        | Purpose                                                                |
|---------------------------|-------------|------------------------------------------------------------------------|
| `name`                    | string      | Display name. Falls back to `routine.yaml` `name` if absent.           |
| `summary`                 | string      | One-line description shown on template cards.                          |
| `triggers`                | string[]    | Node subtypes that fire this routine (e.g. `[heartbeat, schedule]`).   |
| `required_integrations`   | string[]    | Integration slugs the routine needs available.                         |
| `required_vault_accounts` | string[]    | Vault account types (e.g. `google`, `github`) that must be configured. |
| `required_functions`      | string[]    | Function slugs that must exist at `~/sulla/functions/<slug>/`.         |
| `entry_node`              | string      | The node id the walker starts from. Usually a trigger.                 |

### Marketplace-publish fields

Only read by the **publish flow** (`routines-publish-to-marketplace` IPC). Purely descriptive — missing fields are simply omitted from the manifest.

| Field                          | Type     | Manifest destination                        |
|--------------------------------|----------|---------------------------------------------|
| `tagline`                      | string   | `metadata.tagline`                          |
| `category`                     | string   | `metadata.category`                         |
| `license`                      | string   | `metadata.license`                          |
| `media.hero.{type,url,poster}` | object   | `metadata.media.hero`                       |
| `media.screenshots[]`          | object[] | `metadata.media.screenshots`                |
| `author.displayName`           | string   | `metadata.author.displayName`               |
| `author.url`                   | string   | `metadata.author.url`                       |
| `stats.estimatedRunTime`       | string   | `metadata.stats.estimatedRunTime`           |
| `stats.estimatedCostPerRun`    | string   | `metadata.stats.estimatedCostPerRun`        |
| `stages[]`                     | object[] | `routineSummary.stages` (routines only)     |

Hero/screenshot URLs **must be absolute HTTPS** — the marketplace website can't resolve bundle-relative paths because the bundle is opaque to the worker. Host media on your own CDN, R2, GitHub raw, etc. The same assets may also be duplicated inside `assets/` for offline desktop rendering.

### CHANGELOG.md at the bundle root

If `CHANGELOG.md` is present at the bundle root, the publish flow copies its entire content into `manifest.metadata.changelog`. Recommended convention: one `## vX.Y.Z — YYYY-MM-DD` heading per release, most recent first. The marketplace detail page renders this in a collapsible panel.

All marketplace-publish fields are optional. A minimal template (just `routine.yaml` + a basic AGENT.md) still publishes successfully — just with sparser marketplace display.

---

## 4. Zip bundle format

A `.routine.zip` is a standard zip archive. The top-level directory inside the zip is the slug:

```
dedupe-emails.routine.zip
└── dedupe-emails/
    ├── routine.yaml
    ├── README.md
    ├── AGENT.md
    └── .routine-meta.yaml
```

### Security rules (enforced by importer)

- Reject zips with any entry containing `..` in its path (traversal).
- Reject zips with absolute paths.
- Reject zips containing symlinks.
- Reject zips whose entries escape the top-level slug directory.
- Reject zips without a valid `routine.yaml`.
- File size cap: 100 MB per file, 500 MB total (configurable).

### Collision handling

- **Slug collision** at `~/sulla/routines/<slug>/`: suffix `-2`, `-3`, etc. The importer never overwrites an existing folder.
- **Id collision** inside `routine.yaml`: irrelevant for the template (the id is just a label until instantiated). On instantiate, the DB always mints a fresh routine id.

---

## 5. What the export process does (DB routine → bundle)

```
1. Create tmpdir.
2. If routine.source_template_slug is set and ~/sulla/routines/<slug>/ exists:
     copy that folder's contents into tmpdir (preserves AGENT.md, skills/, prompts/, etc.).
   Else:
     seed tmpdir with a minimal README.md stub.
3. Fetch the DB row (workflows.definition).
4. Strip runtime state from the JSONB:
     - node.data.execution
     - node.data.lastRunId / node.data.lastRunOutput
     - any other transient run fields
5. Serialize the cleaned definition to YAML.
6. Overwrite tmpdir/routine.yaml with it.
7. Regenerate tmpdir/.routine-meta.yaml (exportedAt, checksums, etc.).
8. Prompt the user for a destination (default filename: <slug>.routine.zip).
9. Zip tmpdir into the chosen destination.
10. Delete tmpdir.
```

Export **never writes back to `~/sulla/routines/`**. Shared artifacts go wherever the user picks.

---

## 6. What the export process does (template → bundle)

When the user exports from the **My Templates** tab (no DB involvement):

```
1. Prompt for destination (default filename: <slug>.routine.zip).
2. Zip ~/sulla/routines/<slug>/ as-is into the destination.
```

The template on disk is already the shareable artifact — this path is a convenience wrapper.

---

## 7. What the import process does

```
1. Prompt user to pick a .zip file OR a folder.
2. If zip:
     a. Unpack to tmpdir.
     b. Run security checks (§4).
3. If folder:
     a. Copy to tmpdir.
4. Validate tmpdir/routine.yaml against routine.schema.json.
5. Derive slug from routine.yaml name (kebab-case).
6. If ~/sulla/routines/<slug>/ exists, suffix: <slug>-2, <slug>-3, ...
7. Move tmpdir to ~/sulla/routines/<slug>/.
8. Re-scan the templates directory so the new card appears.
```

No DB writes. The user must click "Use template" to instantiate into Postgres.

---

## 8. Related docs

- [README.md](./README.md) — high-level routine model.
- [routine.schema.json](./routine.schema.json) — formal schema for `routine.yaml`.
- [examples/minimal-routine/](./examples/minimal-routine/) — example template folder.
- [../../functions/schema/README.md](../../functions/schema/README.md) — function bundle schema (used by `functions/` subdirs).
