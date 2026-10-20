# Files harness: how agents work with files

Sulla Files is the one place for files. The File Manager tree is mounted at `/mnt/sulla-files` in the VM, in workflow runners, and in agent containers. Save and publish through the Files tools. Never write to Postgres directly, and never save to `~/sulla` folders expecting them to load.

## 1. Where to save

1. Find a folder first: `sulla files/where '{"what":"<what you are saving>","kind":"<kind>","project":"<project>"}'` (tool `files_where`). It returns ranked described folders, a `suggestedFolder`, and a `suggestedFilename`.
2. Save into the suggested folder and follow its `namingHint`.
3. If no folder fits, create one: `sulla files/create_folder '{"collection_id":"<id>","path":"<path>","description":"<what belongs here>"}'`. `description` is required. Add `naming_hint` if it helps the next agent.
4. Write with `sulla files/put '{"collection_id":"<id>","path":"<path>","content":"..."}'` (tool `files_put`).

`files_where` is guidance, not a lock. If nothing fits, make a sensible folder and describe it.

- **Folder map:** the agent environment prompt lists described folders. Use it to pick a folder, but still run `files/where` for a new file.
- **Undescribed folders:** a folder an agent creates through the mount gets the placeholder `Created by <agent> on <date> — needs description` until someone describes it.
- **Scratch vs. knowledge:** agent writes with no collection go to the run's scratch collection. Scratch files from a run expire 14 days after the run ends. Use `sulla files/promote` (tool `files_promote`) to move them to a knowledge collection and clear the expiry.

## 2. Drafts

- **Agent writes are drafts.** Any write by an agent creates a new draft version, wherever it lands. The published version does not change.
- **Human writes publish immediately**, unless the file requires approval or the file is under `Sulla/Use Cases/` (see section 5).
- **Drafts are visible to agents, not to the runtime.** Read a draft with `sulla files/get` or list versions with `sulla files/versions` (tool `files_versions`). Humans see the published version and a **Draft pending** marker in File Manager.

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
Sulla/Use Cases/<type>/<slug>/
```

`<type>` is `agents`, `skills`, `workflows`, `functions`, or `recipes`. In File Manager this shows as **Sulla/Use Cases**. In the VM it is `/mnt/sulla-files/Sulla/Use Cases`.

**Files per type:**

| Type | Files |
|------|-------|
| agents | `agent.json` |
| skills | `SKILL.md` plus any extra files |
| workflows | `workflow.yaml` or `routine.yaml` |
| functions | `function.yaml` plus its entrypoint |
| recipes | `installation.yaml` (or `manifest.yaml`) plus `docker-compose.yml` or `compose.yaml` |

**Lifecycle:**

1. Every edit under `Sulla/Use Cases/` is a draft, whether a human or an agent makes it. A draft never activates anything.
2. Request publication (agents) or publish the version (humans).
3. The runtime poller (about every 2 seconds) reads published versions and rebuilds its Postgres index rows. Only published versions are active.
4. **Rollback** = publish an older version.
5. If a newly published version is invalid, Sulla keeps the last valid version active and posts a notice.

**Migration:** on the first run of this build, Sulla exported the old Postgres definitions into Files once. Existing Files content under `Use Cases/` that matched no live definition was moved to `Sulla/Use Cases/_legacy-import/`. Nothing in `_legacy-import` is activated.

## 6. What not to do

- **Don't write to Postgres directly** (`agent_definitions`, `skill_definitions`, `workflows`, `files`, `file_versions`, and the like). That skips locks, retention, audit, and publish rules. Use the Files tools.
- **Don't save to random folders.** Run `files/where` first.
- **Don't treat a draft as live.** Only published versions run.
- **Don't write to `Logs/` or `Training Data/`.** They are read-only to callers (`403`, `EROFS`).
- **Don't save to `~/sulla/skills`, `~/sulla/agents`, or `~/sulla/workflows` expecting them to load.** The runtime does not read them.
- **Don't expect Files to index `/mnt/worktrees`.** Git worktrees are outside Files. Files watches only its configured roots (the docs folder, conversation JSONL, app logs, and folders you track).
- **Don't try to reach wallet or vault paths.** Protected names are rejected by the Files service.

## Read the docs from Files

Agents read these docs at `/mnt/sulla-files/Sulla/Docs/`, not from the repository path.
