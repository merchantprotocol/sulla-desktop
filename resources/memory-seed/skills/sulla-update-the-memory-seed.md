---
slug: sulla-update-the-memory-seed
label: Update the Sulla memory seed
trigger_when: When you need to add or correct a subject or skill in resources/memory-seed for a fresh Sulla Desktop install.
trigger_actions: [update memory seed, add memory subject, add memory skill, correct seeded docs, bump seed version]
trigger_phrases: [memory seed, seed pack, manifest.json, seeded subject, seeded skill]
scope: [sulla-repository]
---

**When:** You are changing the versioned memory seed pack.

**Do:**
1. Read `resources/memory-seed/README.md` first. Use one Markdown file per subject or skill with the required front matter.
2. Verify every path, tool name, parameter, port, setting key, and UI label against current source. Use `sulla meta/browse_tools` for live tool manifests.
3. Keep subjects under the existing tree. Use `parent: sulla` for features and a child of `sulla-repository` for repository internals.
4. Write short, concrete facts and imperative rules. Omit claims that cannot be verified. Do not include secrets, personal paths, dates, or marketing pricing.
5. Bump the integer `version` in `resources/memory-seed/manifest.json` whenever any seed file changes.
6. Review the pack for stale claims, malformed front matter, duplicate slugs, and references to files outside the repository. Do not run install, build, lint, or tests unless the task explicitly permits them.
7. Commit and push the seed changes with the task's required PR base and co-author line.

**Don't:**
- Put tool-category skills in a topic skill, or copy the old docs without source verification.
- edit the seed without bumping `manifest.json`.
