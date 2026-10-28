---
slug: sulla-tool-skills
label: Use the Sulla Skills tools
trigger_when: When you need to use Sulla Skills operations.
trigger_actions: [skills, skills tools]
trigger_phrases: [skills, skills]
scope: [tool-skills]
---

**When:** When you need to use Sulla Skills operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# skills tools

Skills stored in the database (the only runtime source) — list/search, load (optionally materialized to ~/sulla/cache/skills/<slug>/), create/update from SKILL.md text, and disable/soft-delete. Reusable skills teach agents how to perform repeatable tasks.

## skill_disable

Disable, re-enable, or soft-delete a skill in the database. Disabled and deleted skills stop showing up for agents; nothing is ever hard-deleted, and a deleted slug is never re-imported from folders or re-seeded by app updates. skill_save restores a deleted skill.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Required |
| `action` | string | Optional |

**Example**

```bash
sulla skills/skill_disable '{"slug":"<slug>"}'
```

## skill_get

Load one skill from the database: its full SKILL.md (frontmatter + body) and the list of its extra files. Set materialize:true to also write the skill folder to ~/sulla/cache/skills/<slug>/ and get that path back, for skills whose scripts or html must run from disk.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `slug` | string | Required |
| `materialize` | boolean | Optional |
| `include_files` | boolean | Optional |

**Example**

```bash
sulla skills/skill_get '{"slug":"<slug>"}'
```

## skill_list

List the skills in the database (slug, title, source, enabled, triggers). Pass query to search titles, descriptions, tags, triggers and bodies.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `include_disabled` | boolean | Optional |
| `include_deleted` | boolean | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla skills/skill_list '{}'
```

## skill_save

Create or update a skill as a draft in Files from SKILL.md text: a YAML frontmatter block (slug, title, tags, triggers, ...) followed by the markdown body. Optionally pass files (relative path -> text) to store extra files such as templates/ or scripts/.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `markdown` | string | Required |
| `slug` | string | Optional |
| `files` | object | Optional |

**Example**

```bash
sulla skills/skill_save '{"markdown":"<markdown>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
