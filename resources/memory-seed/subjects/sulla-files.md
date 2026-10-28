---
slug: sulla-files
kind: system
name: Sulla Files
parent: sulla
aliases: [Files, file manager, /mnt/sulla-files, FUSE mount, documents, where to save, save this, save the report, save a file, finished document, deliverable]
---

## Overview
Sulla Files is the human's managed, versioned file system. The File Manager namespace is mounted at `/mnt/sulla-files` in the VM, workflow runners, and agent containers. Normal file reads and writes on the mount go through the authenticated Files service. Every agent write creates a draft version; agents can read drafts, but the human sees the published version plus a Draft pending marker. Files enforces locks, retention, protected paths, audit attribution, and publication rules.

## Facts
- The mount supports reads, writes, append, exclusive create, folders, rename and move, unlink, and empty-directory removal.
- Canonical paths are relative POSIX paths; `..`, backslashes, symlink traversal, raw host paths, and protected wallet or vault names are rejected.
- `Memory/` is the exception to draft publication: durable memory files publish immediately.
- Agent writes carry actor identity and are versioned and audited automatically.
- A lock or retention policy rejects mutations with HTTP 423 `FILE_LOCKED`; FUSE reports `EROFS`.
- File Manager edits and agent edits share one Automerge document; connected editors receive merged changes.
- `.sulla` is plain UTF-8 Markdown with optional flat YAML-style front matter; `.sulla.md` remains supported.

## Rules
- DO: Search with `sulla files/search`, `sulla files/where`, and `ls` before creating a file.
- DO: Read `_folder-metadata.yaml` before saving and add a real description when creating a folder.
- PREFER: Update an existing file in place instead of making `-v2`, `-new`, `-copy`, or `-final` duplicates.
- DON'T: Delete, move, or rename the human's files without the human's tap.
- DON'T: Work around a lock, retention policy, or protected path. Report the exact constraint.
- DON'T: Write Files records directly in Postgres. Why: That bypasses versioning, locks, retention, and audit.
