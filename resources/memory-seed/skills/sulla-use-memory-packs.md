---
slug: sulla-use-memory-packs
label: Install, customize, sync, or uninstall memory packs
trigger_when: The human wants downloadable memory, a memory-pack skill, reusable knowledge, or to change the memories an installed pack carries.
trigger_actions: [install, customize, publish, sync, uninstall, validate]
trigger_phrases: [install memory pack, customize memory pack, sync memory pack, uninstall memory pack, make a memory pack]
scope: [sulla-memory]
---
# Use memory packs

Memory packs are skill Use Cases with `memory_pack: true` in `SKILL.md` and seed-format files under `memory/`. Only published Files versions are active. Draft edits do nothing until the human publishes them.

## Install a published pack

1. Confirm the skill is published under `Use Cases/skills/<slug>/`.
2. Run `sulla memory/pack_validate '{"slug":"<slug>"}'`.
3. Run `sulla memory/pack_install '{"slug":"<slug>"}'`.
4. Run `sulla memory/pack_list '{}'` and verify the slug and version.

A marketplace pack follows the same path after its Files version is published. Publishing or enabling it also installs it automatically.

## Customize and sync

1. Edit `memory/subjects/*.md` or `memory/skills/*.md` in the skill Use Case.
2. Increment `memory/manifest.json` version.
3. Request publication. Keep using the old memory until the human approves it.
4. The published version syncs automatically. To reconcile manually, run `sulla memory/pack_sync '{"slug":"<slug>"}'`.
5. Run `sulla memory/pack_list '{}'` and verify the new version and files hash.

Removed bullets are retired during sync. Do not edit runtime database rows directly.

## Uninstall

Run `sulla memory/pack_uninstall '{"slug":"<slug>"}'`. Disabling, deleting, or retiring its skill also uninstalls it. Seed or install-authored content that the pack temporarily overrode becomes effective again.

## Make a pack

Create `Use Cases/skills/<slug>/SKILL.md` with valid skill frontmatter and `memory_pack: true`. Add `memory/manifest.json`, `memory/subjects/<slug>.md`, and/or `memory/skills/<slug>.md` using the core memory-seed format. Validate the draft directory before publication with `sulla memory/pack_validate '{"path":"<directory>"}'`. Publish it through Files, then verify it with `memory/pack_list`.

Do not put secrets or private records in a distributable pack. Fix every validator error at its reported file and line before publishing.
