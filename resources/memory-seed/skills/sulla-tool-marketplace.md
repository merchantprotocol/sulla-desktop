---
slug: sulla-tool-marketplace
label: Use the Sulla Marketplace tools
trigger_when: When you need to use Sulla Marketplace operations.
trigger_actions: [marketplace, marketplace tools]
trigger_phrases: [marketplace, marketplace]
scope: [tool-marketplace]
---

**When:** When you need to use Sulla Marketplace operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# marketplace tools

Marketplace for community artifacts (skills, functions, workflows, agents, recipes) — search, info, download, scaffold, validate, publish, update, unpublish.

## diff

Show files only in the marketplace, only local, or differing between your installed copy and the latest marketplace version. Read-only.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |

**Example**

```bash
sulla marketplace/diff '{"kind":"<kind>","slug":"<slug>"}'
```

## download

Install a marketplace listing using the same database installer as the Use Cases tab. A package (use case) installs every embedded item in one all-or-nothing transaction.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |
| `overwrite` | boolean | Optional |

**Example**

```bash
sulla marketplace/download '{"kind":"<kind>","slug":"<slug>"}'
```

## info

Full details for one marketplace listing by kind + slug: template id, version, author, category, tags, downloads, manifest metadata and kind summary, and local install status.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |

**Example**

```bash
sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'
```

## list_local

List local artifacts from Postgres, with existing user-owned folders included as a legacy fallback. Filterable by kind.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Optional |

**Example**

```bash
sulla marketplace/list_local '{}'
```

## list_published

List everything you have submitted to the marketplace with its review status (pending / live / rejected), download count, and reviewer notes. Requires a Sulla Cloud session.

**Parameters**

None.

**Example**

```bash
sulla marketplace/list_published '{}'
```

## publish

Submit a local artifact to the Sulla Marketplace using the Library publish pipeline. Agents are exported from the database; other kinds come from ~/sulla/.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |
| `version` | string | Optional |

**Example**

```bash
sulla marketplace/publish '{"kind":"<kind>","slug":"<slug>"}'
```

## scaffold

Generate a new artifact directory locally with a kind-appropriate skeleton (manifest + handler / soul / compose / etc.). Pure local file generation — does not touch the marketplace.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |
| `name` | string | Optional |
| `description` | string | Optional |
| `runtime` | string | Optional |

**Example**

```bash
sulla marketplace/scaffold '{"kind":"<kind>","slug":"<slug>"}'
```

## search

Search the whole Sulla Marketplace catalog. Filter by free text, one kind, multiple kinds, and category.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `kind` | string | Optional |
| `kinds` | array | Optional |
| `category` | string | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla marketplace/search '{}'
```

## unpublish

Take down your own marketplace submission for kind + slug: approved listings are withdrawn (kept in your submissions as rejected), pending ones are deleted. Refuses without {"confirm":true}.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |
| `confirm` | boolean | Required |

**Example**

```bash
sulla marketplace/unpublish '{"kind":"<kind>","slug":"<slug>","confirm":"<confirm>"}'
```

## update

Update an installed marketplace artifact to the latest version, replacing the local copy in place (restored if the update fails). Errors if it isn't installed from the marketplace (use download instead).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |

**Example**

```bash
sulla marketplace/update '{"kind":"<kind>","slug":"<slug>"}'
```

## validate

Validate a locally-installed artifact against its kind-specific schema. Catches missing required fields, broken entrypoints, slug mismatches, and (for recipes) missing docker-compose.yml.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `kind` | string | Required |
| `slug` | string | Required |

**Example**

```bash
sulla marketplace/validate '{"kind":"<kind>","slug":"<slug>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
