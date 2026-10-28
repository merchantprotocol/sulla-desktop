---
slug: sulla-files
kind: system
name: Sulla Files
parent: sulla
aliases: [Files, file manager, /mnt/sulla-files, FUSE mount, documents, where to save, save this, save the report, save a file, finished document, deliverable]
---

## Overview
Sulla Files is the human's area: the human's own managed file system and File Manager. An agent working there is responsible for keeping it to the human's standards. It is not a place to dump thoughts, notes, logs, scratch work, or garbage. Put only work the human would open—finished deliverables, plans, decisions, reference material, and project files—in the right existing folder.

The Files service exposes the managed surface at `/mnt/sulla-files` through an authenticated FUSE mount in the VM, workflow runners, and agent containers. Normal reads and writes on that mount are versioned and audited; the current publication state depends on the file's policy. Agent writes to approval-controlled files are drafts until the human approves publication in Decide. Memory and standard Projects paths publish immediately when their collection does not require approval. The File Manager and agent access share the same service-backed files, not a private copy.

## Facts
- The mount supports list, stat, read, create, truncate, positional write, flush, fsync, rename, mkdir, unlink, rmdir, and close; hard links, symlinks, xattrs, locks, mmap, cross-collection moves, and executable workloads fail closed.
- Collections appear as stable top-level directories under `/mnt/sulla-files`; host paths and source capabilities do not enter the VM or agent containers.
- Canonical paths are relative POSIX paths; `..`, backslashes, symlink traversal, raw host paths, and protected wallet or vault names are rejected.
- Agent tool paths passed to `files/history`, `files/restore`, and `files/link` must be absolute `/mnt/sulla-files/...` paths when using a path.
- A draft is visible to agents with access, while the human sees the published version plus a draft-pending state; only a published Use Case version is runtime-active.
- `Memory/` and `Projects/` publish immediately only when the target collection does not require approval; an approval-required collection can still produce drafts.
- Files keeps versions, records audit attribution, enforces locks and retention, and can restore an older version as a new version.
- `_folder-metadata.yaml` is the File Manager's folder-description file; folder metadata is also served by the Files metadata API.
- The current folder map is live Files data: obtain it with `sulla files/where` or the Files search/list tools instead of embedding it in a system prompt.
- Agents can save files up to 64 MiB through `/mnt/sulla-files`; larger writes fail with `EFBIG` and leave the mount serving other requests.

## Rules
- DO: Treat Files as the human's shared desk. Why: every file left there is part of the human's workspace and standards.
- DO: Save only a deliverable, plan, decision, reference item, or project file the human would open.
- DO: Search with `sulla files/search '{"query":"<topic>"}'` and locate a destination with `sulla files/where '{"what":"<deliverable>"}'` before creating anything.
- DO: Read the destination folder's `_folder-metadata.yaml` before saving. Why: its description and naming hint tell you what belongs there.
- DO: Update an existing file in place. Why: Files already keeps versions, so duplicates hide the canonical document.
- DO: Describe a new folder immediately with `sulla files/create_folder` and a real purpose; do not make a folder for one file.
- DO: Keep project state in `Projects/<slug>/PROJECT.md` and `TASKS.md`; keep plans, specs, decisions, and progress in that project folder.
- DO: Keep Use Case artifacts under `Use Cases/<type>/<slug>/` as drafts, then request publication through `sulla files/request_publish` so the human can approve in Decide.
- DO: Delete your own scratch, logs, briefs, test data, and build output from `/mnt/worktrees/_scratch/<job>/` or the agent workspace when finished.
- DO: Use `sulla files/history` and `sulla files/versions` to inspect history before restoring; use `sulla files/restore` to make an older version current as a new version.
- DO: Prepare share links with `sulla files/link`; revoke them with `sulla files/revoke_link` when the human authorizes it.
- DON'T: Put scratch, drafts of drafts, worker briefs, logs, build output, test data, or notes to yourself in Files. Why: Files is the human's workspace, not agent storage.
- DON'T: Make `-v2`, `-new`, `-copy`, or `-final` names. Why: version history is already built in.
- DON'T: Delete, move, or rename the human's Files without the human's tap. Why: those changes alter the human's workspace and may be irreversible.
- DON'T: Work around locks, retention, protected paths, or the publication gate. Why: the Files service is the authority for custody and lifecycle.
- DON'T: Write Files records directly in Postgres. Why: that bypasses versioning, locks, retention, and audit.
- LESSON: If a folder has no description, stop and add one through the supported Files path before placing a deliverable there. Why: undocumented folders become dumping grounds.
- LESSON: If you find duplicate files you created, identify the canonical one and prepare a cleanup; do not silently delete a Files entry without the human's tap.
- LESSON: If `/mnt/sulla-files` reports `Transport endpoint is not connected`, stop writing through that mount and continue in a newly started agent container. Why: an existing container binds the FUSE root itself, so replacing the daemon's root mount cannot repair that container's detached mount namespace; its workspace remains durable for the replacement container.
