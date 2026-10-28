---
slug: sulla-install-from-marketplace
label: Find and install a Sulla Marketplace use case
trigger_when: When you need to find an existing workflow, agent, skill, function, integration, recipe, or package instead of building one from scratch, then inspect and install it safely.
trigger_actions: [find marketplace use case, search marketplace, inspect marketplace listing, install marketplace artifact, update marketplace artifact]
trigger_phrases: [marketplace, catalog, existing use case, install add-on, download use case, find a skill, find a workflow]
scope: [sulla-marketplace, sulla-use-cases]
---

**When:** Search before building. Use the listing detail to check kind, version, publisher, permissions, install state, and whether the artifact is already local.

**Do:**
1. Search one or more kinds: `sulla marketplace/search '{"query":"<plain-language need>","kinds":["workflow","skill","function"],"limit":25}'`. Use `agent`, `integration`, `recipe`, or `package` when appropriate.
2. Read the candidate: `sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'`. Check the manifest metadata, publisher, version, local status, and any permissions or dependency notes.
3. For installable memory, search with `sulla marketplace/search '{"query":"<topic>","kind":"skill"}'` and look for the `[memory pack]` marker. Confirm `Memory pack: yes` with `marketplace/info`; the pack installs as a skill and carries its `memory/` subjects and skills with it.
4. Validate an already-local artifact: `sulla marketplace/validate '{"kind":"<kind>","slug":"<slug>"}'`; memory-pack validation checks its manifest, subject tree, skill scopes, slugs, secrets, and personal paths. For a workflow also run `sulla meta/validate_sulla_workflow` against its `routine.yaml`.
5. Download the approved listing: `sulla marketplace/download '{"kind":"<kind>","slug":"<slug>","overwrite":false}'`. Packages install their embedded artifacts atomically; standalone agent downloads may install to the database, while other agent-facing downloads are written to `Sulla/Use Cases/...` as Files drafts.
6. If the result is a Files draft, inspect the written `file_id` and `version_id`, then request activation with `sulla files/request_publish '{"file_id":"<file_id>","version_id":"<version_id>","reason":"Activate reviewed marketplace use case"}'`. The human approves the request in Decide; do not claim it is active before approval. A memory pack stays at `Use Cases/skills/<slug>/` with its `memory/` folder intact.
7. Verify with `sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'` or the relevant local listing tool before invoking it. Read warnings: package contents can be skipped.
8. For an installed listing update, first run `sulla marketplace/diff '{"kind":"<kind>","slug":"<slug>"}'`, then `sulla marketplace/update '{"kind":"<kind>","slug":"<slug>"}'` only if replacing local edits is intended.

**Don't:**
- Don't trust a name or download count as approval; inspect the manifest and publisher.
- Don't bypass validation, signature/integrity checks, permission grants, or Files/Decide approval.
- Don't overwrite local work without checking the diff.
