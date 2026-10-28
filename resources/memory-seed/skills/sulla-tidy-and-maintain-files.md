---
slug: sulla-tidy-and-maintain-files
label: Tidy and maintain Sulla Files
trigger_when: When you need to leave the human's Files organized, remove your own leftovers, fix missing folder descriptions, or consolidate duplicates you created.
trigger_actions: [tidy Files, clean up Files, maintain files, find leftovers, fix folder description, consolidate duplicates]
trigger_phrases: [tidy Files, clean up my files, organize Files, missing folder description, duplicate file, leave it tidy]
scope: [sulla-files]
---

**When:** Use this after saving work or before handing off a task. The goal is a clean human workspace, not a broad cleanup of the human's files.

**Do:**
1. Search before touching anything: `sulla files/search '{"query":"<your topic or filename>"}'`, `sulla files/where '{"what":"<kind of deliverable>"}'`, and `ls /mnt/sulla-files/<candidate-folder>`.
2. Read each candidate folder's `_folder-metadata.yaml`. Prepare a real description for a missing one with `sulla files/create_folder` only when no existing described folder fits; never make a single-file folder.
3. Find files you created in the current task and distinguish canonical deliverables from scratch, drafts of drafts, logs, briefs, test data, build output, and notes to self. Scratch belongs in `/mnt/worktrees/_scratch/<job>/` or the agent workspace; delete your own scratch there when done.
4. If you created duplicates in Files, choose the canonical path and record the consolidation. Do not silently delete, move, or rename any Files entry—even one you created—because deletion and workspace changes wait for the human's tap.
5. Inspect the canonical file with `sulla files/history` or `sulla files/versions`; use `sulla files/restore` only to restore an identified older version as a new version.
6. Check that project folders contain only their intended `PROJECT.md`, `TASKS.md`, plans, specs, decisions, and progress. Check that Use Case drafts remain under `Use Cases/<type>/<slug>/` and are not called active until Decide approves publication.
7. Report remaining cleanup that needs the human's tap, including exact paths and the safe undo or restore path. Leave the workspace tidier than you found it without broad deletion.

**Check:** Every deliverable is in the existing canonical folder, folder descriptions are present, no agent scratch remains in Files, duplicates have a documented canonical choice, and any irreversible cleanup is prepared rather than performed.

**Don't:**
- Don't sweep or delete the human's files, trash, history, or share links.
- Don't call an old version or a draft the current published file without checking its state.
- Don't create `-v2`, `-new`, `-copy`, or `-final` files; use Files version history.
- Don't bypass locks, retention, protected paths, or Decide.
