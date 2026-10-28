---
slug: sulla-save-work-in-files
label: Save finished work in Sulla Files
trigger_when: When you need to create, update, organize, restore, or share a deliverable in the human's File Manager.
trigger_actions: [save a deliverable, create a document, update a file, restore a version, share a file]
trigger_phrases: [save this, put it in Files, File Manager, deliverable, restore the file, share link]
scope: [sulla-files]
---

**When:** Save human-facing work, not scratch or build output.

**Do:**
1. Find existing material: `sulla files/search '{"query":"<topic>"}'`.
2. Find the destination: `sulla files/where '{"what":"<deliverable>","kind":"<document-kind>"}'`.
3. Inspect the folder and read `_folder-metadata.yaml`.
4. Update the existing file in place when possible. Otherwise create one clear file name under `/mnt/sulla-files`.
5. Read the result back and check that no scratch or duplicate remains.
6. Get draft identifiers with `sulla files/versions '{"path":"<relative-path>"}'`.
7. Request publication when needed: `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<version-id>","reason":"Finished deliverable"}'`.

**Useful commands:**
- `sulla files/history '{"path":"<relative-path>"}'`: list versions.
- `sulla files/restore '{"path":"<relative-path>","version_id":"<version-id>"}'`: restore an older version as a new version.
- `sulla files/link '{"path":"<relative-path>","access_mode":"view"}'`: create a public share link only after the human's tap.

**Don't:**
- Don't save scratch, logs, worker briefs, test data, or build artifacts in Files.
- Don't make `-v2`, `-new`, `-copy`, or `-final` duplicates.
- Don't delete, move, rename, publish, or share externally without the required human action.
