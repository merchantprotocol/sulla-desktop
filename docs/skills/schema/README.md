# Skills — Schema & Design

**Status:** Draft
**Date:** 2026-04-22
**Scope:** Defines what a **Skill** is in Sulla Desktop, the folder layout of a skill bundle, and how it maps to the marketplace `sulla/v3` manifest.

> This doc covers the **skill-bundle shape** — the file tree that travels via import/export/publish/install. For cross-kind lifecycle (how all four kinds import/export/publish together) see [`../../bundles/README.md`](../../bundles/README.md).

---

## 1. What is a Skill?

A **skill** is an atomic behavioral instruction set — a scoped capability the orchestrating agent can load and apply. Inspired by [Claude Skills](https://github.com/anthropics/skills) and agentskills.io.

Concretely, a skill is:

- A markdown file (`SKILL.md`) with YAML frontmatter.
- Optionally, supporting prompts, references, and assets.
- Addressed by slug — the agent activates it via `load_skill('<slug>')` or equivalent.

Skills are **not** code. They are instructions. Code lives in [functions](../../functions/schema/README.md). A skill tells the agent *how to behave* in a given situation; a function *does* work when invoked.

## 2. Install target

```
~/sulla/skills/<slug>/
```

Resolved via `resolveSullaUserSkillsDir()` in [`sullaPaths.ts`](../../../pkg/rancher-desktop/agent/utils/sullaPaths.ts). Resource-shipped skills (bundled with the app) live at `~/sulla/resources/skills/`; the user dir takes precedence on slug collision when the skill loader scans both.

## 3. Folder layout

```
<slug>/
├── SKILL.md              # REQUIRED — the skill itself (frontmatter + markdown body)
├── README.md             # RECOMMENDED — human-facing overview
├── CHANGELOG.md          # OPTIONAL — auto-mapped to manifest.metadata.changelog
├── prompts/              # OPTIONAL — reusable prompt fragments referenced from the skill
│   └── <name>.md
├── references/           # OPTIONAL — extended docs the agent consults on demand
│   └── *
├── assets/               # OPTIONAL — images, diagrams, reference PDFs
│   └── *
└── .skill-meta.yaml      # AUTO — exporter-managed; bundleSchemaVersion + checksums
```

Only `SKILL.md` is required. Everything else is opt-in.

## 4. `SKILL.md` frontmatter

`SKILL.md` carries a YAML frontmatter block followed by a markdown body. The frontmatter drives both the local skill loader and the marketplace manifest.

```markdown
---
name: Handle Pricing Objection
skillKey: handle_pricing_objection
category: sales
condition: always

# ── Optional marketplace-publish metadata ──
summary: "Defuse pricing pushback with empathy-first reframes."
tagline: "Don't defend the price — reframe the value."
license: MIT
author:
  displayName: "Acme Sales Co"
  url: https://acme.example.com
tags: [sales, objections, pricing]
required_integrations: []
stats:
  estimatedRunTime: "~5 seconds of prompt overhead"
---

# When to load this skill

The orchestrator should load this skill on calls/chats where the caller
raises price concerns ("too expensive", "we don't have budget", etc.).

# Instructions

Freeform markdown the agent reads before responding. Describe the specific
technique, example phrasings, failure modes to avoid.
```

### Loader-facing fields (required for the skill to function)

| Field        | Type   | Purpose |
|--------------|--------|---------|
| `name`       | string | Display name. Human-readable. |
| `skillKey`   | string | Stable slug the agent uses to load it (`load_skill('<skillKey>')`). Should match the folder slug. |
| `category`   | string | Grouping (sales / support / research / authoring / ...). |
| `condition`  | string | When the skill should activate. `always` = load every run; anything else is a freeform hint the agent interprets. |

### Marketplace-publish fields (optional)

All read only at publish time. Missing fields are simply omitted from the resulting manifest.

| Field                     | Manifest destination                  |
|---------------------------|---------------------------------------|
| `summary`                 | `metadata.description` (falls back)   |
| `tagline`                 | `metadata.tagline`                    |
| `license`                 | `metadata.license`                    |
| `tags`                    | `metadata.tags`                       |
| `author.displayName`      | `metadata.author.displayName`         |
| `author.url`              | `metadata.author.url`                 |
| `required_integrations`   | `skillSummary.requiredIntegrations`   |
| `stats.estimatedRunTime`  | `metadata.stats.estimatedRunTime`     |

### Body → `skillSummary.promptLength`

The manifest's `skillSummary.promptLength` is the character count of the markdown body (everything after the closing `---`). Derived automatically at publish time.

## 5. Mapping to the marketplace manifest

On publish, the desktop builds a `sulla/v3` manifest with the `skillSummary` block:

```yaml
skillSummary:
  skillKey:              handle_pricing_objection
  category:              sales
  condition:             always
  promptLength:          1234          # chars in SKILL.md body
  requiredIntegrations:  []
```

`previews.coreDoc` carries the full rendered `SKILL.md` (frontmatter + body). Reviewers and website detail pages render it sanitized.

See [`../../../docs/marketplace/manifest-schema.json`](../../../../docs/marketplace/manifest-schema.json) for the formal schema.

## 6. Import / export / publish / install

Follows the unified flow in [`../../bundles/README.md`](../../bundles/README.md):

- **Import** — user picks `.skill.zip` or a folder. `bundles-import` sniffs `SKILL.md` at the bundle root → lands at `~/sulla/skills/<slug>/`.
- **Export** — `skills-export(slug)` zips `~/sulla/skills/<slug>/` as-is.
- **Publish** — `bundles-publish(kind: 'skill', slug)` builds the manifest from `SKILL.md` frontmatter + README + CHANGELOG, submits to `/marketplace/submit-manifest`, uploads the zip.
- **Install from marketplace** — download zip → hand to `bundles-import` → same local result.

## 7. Open questions

- **Enable/disable UX.** After import, does the skill auto-activate, or does the user explicitly enable it from My Skills? Recommend explicit enable (safer for user trust) but TBD.
- **Condition DSL.** Is `condition: always` a special string or the start of a DSL (e.g., `"caller_type == 'prospect'"`)? Current answer: freeform hint for the agent to interpret — no parser. Formalize if/when skills get a selection engine.
- **Resource vs. user skill precedence.** Confirm the skill loader scans `~/sulla/skills/` before `~/sulla/resources/skills/` so user-imported skills override resource-shipped defaults of the same slug.
