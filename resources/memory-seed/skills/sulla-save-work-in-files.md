---
slug: sulla-save-work-in-files
label: Save finished work in Sulla Files
trigger_when: When you need to save a finished deliverable, plan, decision, reference document, or project file in the human's File Manager.
trigger_actions: [save a deliverable, create a document, update a file, restore a version, share a file]
trigger_phrases: [save this, put it in Files, File Manager, deliverable, finished document, restore the file, share link]
scope: [sulla-files]
---

**When:** Save only finished work the human would open. Files is the human's area, not a place for agent notes, scratch, logs, or build output.

**Do:**
1. Search for an existing file and destination before creating anything:
   `sulla files/search '{"query":"<topic>"}'`
   `sulla files/where '{"what":"<deliverable>","kind":"<document-kind>"}'`
2. Inspect the suggested folder. With the returned collection id, run:
   `sulla files/list '{"collection_id":"<collection-id>","path":"<folder>"}'`
   Also read `/mnt/sulla-files/<folder>/_folder-metadata.yaml` if it exists. Follow its description and naming hint.
3. Update the canonical existing file in place when one exists. Do not create `-v2`, `-new`, `-copy`, or `-final` names. If no described folder fits, create one with `sulla files/create_folder '{"collection_id":"<collection-id>","path":"<folder>","description":"<real purpose>"}'`; do not create a folder for one file.
4. Write the finished content to the chosen `/mnt/sulla-files/<folder>/<name>` path through the managed mount. Keep scratch, intermediate drafts, worker briefs, logs, test data, and build output in `/mnt/worktrees/_scratch/<job>/` or the agent workspace instead, and remove your own leftovers there.
5. Read the saved path back and check that it is the intended file, in the intended folder, with no duplicate or scratch companion. Do not delete or move any existing human file to tidy it without the human's tap.
6. Inspect versions with `sulla files/history '{"path":"/mnt/sulla-files/<folder>/<name>"}'` or `sulla files/versions '{"file_id":"<file-id>"}'`. A normal agent edit may be a draft; do not describe it as published until the returned state says so.
7. For an approval-controlled Use Case draft, request publication through Decide:
   `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<version-id>","reason":"Finished deliverable"}'`
   The human approves or rejects the request in Decide. Do not treat a draft as runtime-active.
8. For a share, prepare (but do not create without the human's tap): `sulla files/link '{"path":"/mnt/sulla-files/<folder>/<name>","access_mode":"view"}'`. Revoke an authorized link with `sulla files/revoke_link '{"id":"<share-id>"}'`.

**Check:** The file is readable at its canonical path, the folder is described, the version state is understood, and all agent scratch is outside Files and cleaned up. For a Use Case, publication is approved in Decide before claiming it is active.

**Don't:**
- Don't save thoughts, notes to self, logs, worker briefs, test data, build output, or drafts of drafts in Files.
- Don't invent a Files write tool or write directly to Postgres; the managed mount and Files service own versioning and audit.
- Don't delete, move, rename, publish, or externally share human Files without the required human action.
- Don't bypass a lock, retention rule, protected path, or Decide publication request.
