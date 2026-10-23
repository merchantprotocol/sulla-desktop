# Files harness: how agents work with files

Sulla Files is your Human's own file system, not your workspace. The File Manager tree is mounted at `/mnt/sulla-files` in the VM, in workflow runners, and in agent containers. Use normal file tools for reads and writes. Use the Files service tools only for search, history, restore, and links. Never write to Postgres directly, and never save to `~/sulla` folders expecting them to load.

## Files

Files: /mnt/sulla-files is your Human's own file system, not your workspace. You work in it alongside them; leave it tidier than you found it. Use normal tools (ls, cat, your edit/write tools, mv, cp, Python). Every change is versioned and audited automatically. Look before you create: search first (sulla files/search, sulla files/where, ls) and update in place. No -v2, -final, -new or -copy files: Files keeps every version. Save only what your Human would want to open: deliverables, plans, decisions, reference material, project files. Never save scratch work, drafts of drafts, logs, worker briefs, test data, build output or one-off notes to yourself there. Don't make a folder for a single file. Read the folder's _folder-metadata.yaml first; use clear names and existing locations. Give any new folder a real description straight away. Clean up your own leftovers; never delete, move or rename your Human's own files unless they asked. In the VM, /, /tmp and your home directory are RAM-backed: never put work there. Use /mnt/worktrees/<repo>-<branch> for code and /mnt/worktrees/_scratch/<your job id>/ for scratch, or your working directory inside an agent container. Delete scratch when done; move only finished work into /mnt/sulla-files. Use sulla files/search to find files by meaning, files/history and files/restore for past versions, files/link to share.

## Working in your Human's files

- /mnt/sulla-files is your Human's own file system, not your workspace. They open it in the File Manager every day, and you work in it alongside them. Leave it the way a careful assistant leaves a shared desk: tidier than you found it.
- Look before you create. Search first (sulla files/search, sulla files/where, ls) and update the file or folder that already exists instead of making a second one. No "-v2", "-final", "-new" or "-copy" files: Files keeps every version, so edit in place.
- Save only what your Human would want to open: deliverables, plans, decisions, reference material, project files. Never save scratch work, drafts of drafts, logs, worker briefs, test data, build output or one-off notes to yourself there.
- Don't make a folder for a single file. When you do create a folder, write a real description in its _folder-metadata.yaml straight away. A folder left saying "needs description" is clutter.
- Use clear names your Human would choose. Put things where they already keep that kind of thing; read the folder's _folder-metadata.yaml first.
- Clean up what you made: remove your own leftovers when the task ends. Never delete, move or rename your Human's own files unless they asked; if something of theirs looks like clutter, tell them.

## Where short-lived work goes

- In the VM, / is a RAM disk. /tmp, your home directory and everything outside /mnt live in memory: files there eat RAM and vanish on restart. Never put work there.
- Code: /mnt/worktrees/<repo>-<branch>.
- Scratch (briefs, scripts, downloads, previews, exports): /mnt/worktrees/_scratch/<your job id>/. Inside an agent container, use your working directory instead. Delete your scratch folder when you finish.
- Move only finished work into /mnt/sulla-files.

## 2. Drafts

- **Agent writes are drafts.** Any write by an agent creates a new draft version, wherever it lands. The published version does not change.
- **Exception: `Memory/`.** Durable agent memory publishes immediately so recall can see it. Claude Code project memory lives in `Memory/claude-code/<project>`, the Codex memory database is snapshotted to `Memory/codex`, and Sulla agents use `Memory/sulla`. Saving a memory file is not enough on its own: also record the durable fact with the observation tool.
- **Human writes publish immediately**, unless the file requires approval or the file is under `Use Cases/` (see section 5).
- **Drafts are visible to agents, not to the runtime.** Read a draft with normal file tools on the mount, or list versions with `sulla files/versions`. Humans see the published version and a **Draft pending** marker in File Manager.

## 3. Publish requests

Agents cannot publish. Ask for it:

```bash
sulla files/request_publish '{"file_id":"<id>","version_id":"<draft version id>","reason":"<why>"}'
```

- The call returns at once with `status: pending`, and a card appears in **Decide**.
- **Approve:** Desktop publishes the version as you, the human. The requesting chat gets a message.
- **Deny or expire:** the draft stays a draft. Nothing is published.
- A human can also publish a version in File Manager with **Publish version**. Only human identities can publish, through the service and the File Manager alike.

## 4. Locks and retention

- A **record lock** or a **retention rule** (retain until a date, or for N days after an event) applies to everyone, agents included.
- While a file is locked or retained, new versions and deletes fail with HTTP 423 `FILE_LOCKED`. Other edits to a locked file fail the same way. FUSE reports this as `EROFS`.
- Checkout conflicts and other HTTP 409 errors show as `EPERM` in FUSE.
- Retention can be extended but not shortened or cleared once a policy record sets it.
- Don't work around a lock. Report it.

## 5. Use Cases lifecycle

Agent, skill, workflow, function, and recipe definitions live in Files, not in `~/sulla`:

```
Use Cases/<type>/<slug>/
```

`<type>` is `agents`, `skills`, `workflows`, `functions`, or `recipes`. In File Manager this shows as **Sulla/Use Cases**. In the VM it is `/mnt/sulla-files/Use Cases`.

**Files per type:**

| Type | Files |
|------|-------|
| agents | `agent.json` |
| skills | `SKILL.md` plus any extra files |
| workflows | `workflow.yaml` or `routine.yaml` |
| functions | `function.yaml` plus its entrypoint |
| recipes | `installation.yaml` (or `manifest.yaml`) plus `docker-compose.yml` or `compose.yaml` |

**Lifecycle:**

1. Every edit under `Use Cases/` is a draft, whether a human or an agent makes it. A draft never activates anything.
2. Request publication (agents) or publish the version (humans).
3. The runtime poller (about every 2 seconds) reads published versions and rebuilds its Postgres index rows. Only published versions are active.
4. **Rollback** = publish an older version.
5. If a newly published version is invalid, Sulla keeps the last valid version active and posts a notice.

**Migration:** on the first run of this build, Sulla exported the old Postgres definitions into Files once. Existing Files content under `Use Cases/` that matched no live definition was moved to `Use Cases/_legacy-import/`. Nothing in `_legacy-import` is activated.

## 6. What not to do

- **Don't write to Postgres directly** (`agent_definitions`, `skill_definitions`, `workflows`, `files`, `file_versions`, and the like). That skips locks, retention, audit, and publish rules. Use the Files tools.
- **Don't save to random folders.** Check `_folder-metadata.yaml` files to find the right place, or use `sulla files/search`.
- **Don't treat a draft as live.** Only published versions run.
- **Don't write to `Logs/` or `Training Data/`.** They are read-only to callers (`403`, `EROFS`).
- **Don't save to `~/sulla/skills`, `~/sulla/agents`, or `~/sulla/workflows` expecting them to load.** The runtime does not read them.
- **Don't expect Files to index `/mnt/worktrees`.** Git worktrees are outside Files. Files watches only its configured roots (the docs folder, conversation JSONL, app logs, and folders you track).
- **Don't try to reach wallet or vault paths.** Protected names are rejected by the Files service.

## Read the docs from Files

Agents read these docs at `/mnt/sulla-files/Docs/`, not from the repository path.

## Projects

See [Projects in Files](projects-in-files.md) for the Projects/<project-slug>/ convention.
