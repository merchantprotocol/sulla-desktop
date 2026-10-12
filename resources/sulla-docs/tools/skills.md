# Skills — stored in the database

Skills live in the `skill_definitions` Postgres table. That table is the only
place agents read skills from at runtime. SKILL.md folders are an import and
export format, nothing more.

## Tools (category `skills`)

| Tool | What it does |
|---|---|
| `sulla skills/skill_list '{"query":"feature"}'` | List or search skills (slug, title, source, triggers). `include_disabled` / `include_deleted` show hidden rows. |
| `sulla skills/skill_get '{"slug":"playbook-software-feature"}'` | Full SKILL.md plus the list of extra files. `materialize:true` writes the folder to `~/sulla/cache/skills/<slug>/` and returns the path (for scripts/html that must run from disk). `include_files:true` inlines the extra files. |
| `sulla skills/skill_save '{"markdown":"---\nslug: my-skill\ntitle: My Skill\n---\n# My Skill\n..."}'` | Create or update a skill from SKILL.md text. Optional `files` (relative path → text). Saving a deleted slug restores it. |
| `sulla skills/skill_disable '{"slug":"my-skill","action":"disable"}'` | `disable`, `enable`, or `delete` (soft). Nothing is ever hard-deleted. |

## Where skills come from

- **Built-in** (`source_kind: builtin`) — shipped inside the app
  (`agent/builtinSkills/<slug>/`), seeded on every boot. A built-in row you
  edit is never overwritten by an app update.
- **Folders** (`user` / `resources`) — every `~/sulla/skills/<slug>/SKILL.md` and
  `~/sulla/resources/skills/<slug>/SKILL.md` is copied in when its slug is new.
  The folders are never changed or deleted. A row nobody edited in the database
  follows later edits to its own folder; a row edited in the database does not.
- **Marketplace** (`marketplace`) — `marketplace/download` and `update` install the
  folder and copy it into the table right away.

`marketplace/validate`, `publish`, `diff` and `list_local` work on the database
row (exported to a temp folder when a folder is needed).

## Assigned skills

An agent's `skill_refs` are listed in its system prompt under "Your skills"
(title + description from the table). Load the full skill with `skill_get`
before following it.
