# Sulla memory seed

This folder is what a fresh Sulla Desktop install knows about itself. It replaces
`resources/sulla-docs`. A versioned seeder (`agent/database/seeders/MemorySeedSeeder.ts`)
loads it into the v7 subject memory (`subject_memory` schema). Recall then hands
agents the parts that matter for the current turn, instead of putting a large
environment block in every system prompt.

Everything here must be **true of current `main`**. Every tool name, parameter, path,
port, setting key and UI label must be checked against the source before it goes in.
If you can't verify something, leave it out.

## Layout

```
resources/memory-seed/
├── manifest.json          # { "version": <int> }. Bump it whenever any file changes.
├── subjects/<slug>.md     # one subject: overview, facts, rules
└── skills/<slug>.md       # one skill: when to use it, then exact steps
```

## Subject file: `subjects/<slug>.md`

```markdown
---
slug: sulla-files                 # kebab-case, unique across subjects
kind: system                      # global | major | system | tool
name: Sulla Files                 # display name
parent: sulla                     # parent subject slug (must exist in the seed or be 'global')
aliases: [Files, file manager, /mnt/sulla-files, FUSE mount]   # words a user or agent would type; recall matches these literally
---

## Overview
3-12 plain sentences: what it is, where it lives, how an agent uses it, and its limits.
This is the subject's front page.

## Facts
- One verifiable statement per bullet. These become `conclusion` items.

## Rules
- DO: Instruction in the imperative. Why: one short reason.
- DON'T: Instruction. Why: reason.
- LESSON: Something that goes wrong and how to avoid it. Why: reason.
- PREFER: A preference between options. Why: reason.
```

- `## Facts` and `## Rules` are optional. Leave out a section rather than pad it.
- A bullet is one item. Keep each one under about 300 characters. The `Why:` part is optional.
- Write for an agent on a brand-new install, run by a stranger. Don't name Jonathon,
  his projects, his machine paths (`/Users/jonathonbyrdziak`), PR numbers or dates.
  Use `~` or `{{sulla_home}}` style placeholders the way the source does.

### Subject tree

```
global
└── sulla                (major)  Sulla: the harness you run in
    ├── sulla-desktop    (system) the app, windows, tabs, settings
    ├── sulla-vm         (system) the VM, exec vs exechost, paths, RAM-backed dirs
    ├── sulla-files      (system) Files, the FUSE mount, versioning, folder metadata
    ├── sulla-memory     (system) v7 subject memory, observations, what recall gives you
    ├── sulla-tools      (system) the `sulla <category>/<tool>` CLI, browse_tools, integrations proxy, MCP
    │   └── tool-<category>  (tool) one per tool category, e.g. tool-browser, tool-github
    ├── sulla-agents     (system) agents, spawn_agent, jobs, channels, heartbeat
    ├── sulla-workflows  (system) workflows: schema, nodes, triggers
    ├── sulla-functions  (system) custom functions
    ├── sulla-use-cases  (system) Use Cases in Files, drafts, publish through Decide
    ├── sulla-marketplace(system) marketplace, extensions, integration packages
    ├── sulla-repository (system) the sulla-desktop source repo: layout, services, how to build and ship
    └── ...              other features (capture studio, secretary mode, decide, cloud, mobile, vault, identity)
```

Content workers may add `system` subjects under `sulla` for features that need their own page.
Use the slugs above where they fit. They match subjects that already exist on long-running
installs, so the seed adds to them instead of making duplicates.

## Skill file: `skills/<slug>.md`

```markdown
---
slug: sulla-tool-browser          # prefix: sulla-tool-<category> for tool skills, sulla-<topic> otherwise
label: Use the Sulla browser tools
trigger_when: When you need to open a web page, click, fill a form, read a page or take a screenshot in Sulla's own browser.
trigger_actions: [open a url, take a screenshot, click a button, read page text]
trigger_phrases: [browser, screenshot, open the page, website, tab]
scope: [tool-browser]             # subject slugs this skill belongs to
---

**When:** ...

**Do:**
1. Exact numbered steps with exact, copy-pasteable commands, e.g.
   `sulla browser/tab '{"action":"open","url":"https://example.com"}'`

**Tools:** every tool in the category, one line each:
- `sulla browser/screenshot '{"tabId":"<id>"}'`: what it returns. Required: tabId.

**Don't:**
- ...
```

- Recall picks skills by embedding `label + trigger_when` against the conversation, and
  boosts on literal `trigger_phrases`. Write `trigger_when` the way a person would describe
  needing this, not the way the code names it.
- Each tool category gets exactly one `sulla-tool-<category>` skill, listing **every** tool
  in that category from its manifest (name, what it does, required params, one exact example).
- Topic skills (`sulla-build-workflow`, `sulla-spawn-and-manage-agents`, ...) cover multi-step jobs.

## How the seeder loads it

- Subjects: inserted if the slug is new. Existing subjects keep their name and parent; aliases are merged.
- Recall shows seeded rules and facts under their subject, or under a `sulla.md` section. It never
  shows them as things the human said.
- Overview: stored with a timestamp older than any real activity (`version` ms since epoch 0),
  so an overview the install wrote itself always wins.
- Rules in `subjects/sulla.md` (the `major` subject) are the core harness rules. They are seeded
  `always_on`, so every conversation gets them once. Keep them to the 10-15 rules every agent needs.
- Facts and rules: items with `origin = 'seeded'`, id `seed:<subject>:<hash of text>`, scoped to the subject.
  When a new seed version drops or changes a bullet, the old item is retired through supersession.
- Skills: `version_ts` = seed version. A newer seed version replaces the older one.
- The seeder never edits or deletes rows the install wrote itself (non-`seed:` ids).
