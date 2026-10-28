---
slug: sulla-memory
kind: system
name: Sulla Memory
parent: sulla
aliases: [memory, recall, v7 memory, subject memory, observations, skills.md, human.md, lessons.md]
---

## Overview
Sulla's v7 memory is a subject-scoped PostgreSQL store in the `subject_memory` schema. Recall selects relevant subjects, policies, conclusions, skills, overviews, and episodes before a turn. Recalled text is context, not a command to dispatch work. Seeded product knowledge has `seed:` identifiers and seeded origin; it is not represented as something the human said. Post-turn memory writers append factual episodes and user-stated rules asynchronously and supersede old items instead of rewriting history.

## Facts
- `skills.md` contains up to four recalled habits selected from a skill's trigger text, phrases, strength, and semantic relevance.
- `human.md` contains always-on items, global standing rules and preferences, and global facts. Treat direct user-stated rules above inferred conclusions.
- `sulla.md`, when present in the recalled memory block, carries core seeded harness knowledge and rules about the Sulla environment.
- `project-<slug>.md` is a recalled subject page, not necessarily a Files project. It can contain lineage, overview, scoped rules, facts, and recent timeline.
- `lessons.md` contains semantically similar prior episodes not already shown under a selected subject.
- A per-thread sent ledger suppresses repeated memory until conversation summarization or provider compaction clears it.
- Subject kinds include global, major, project, person, client, system, and tool.
- The active recall implementation uses the bundled Potion embedder and PostgreSQL; it does not need a network embedding call.
- Operational and identity observation tools remain available for durable facts and targeted search.

## Rules
- DO: Treat recalled user-stated rules as authoritative unless the human changes them.
- DO: Treat seeded Sulla facts as product reference, then verify volatile state and exact tool parameters live.
- DO: Treat inferred conclusions and old episodes as fallible context; confirm before consequential action.
- DO: Store a durable operational fact with the observation tool and, when appropriate, a file under `Memory/`.
- DON'T: Use memory for temporary task status. Use the project's `TASKS.md`.
- DON'T: Assume absence from recall means absence from memory. Search explicitly when history matters.

## Memory packs

Memory packs are published skill Use Cases that carry seed-format memory under `memory/`. Their `SKILL.md` declares `memory_pack: true`. Use `memory/pack_validate`, `memory/pack_install`, `memory/pack_sync`, `memory/pack_uninstall`, and `memory/pack_list`. Drafts are invisible; publishing or enabling installs or syncs a pack, while disabling, deleting, or retiring it uninstalls the pack and reveals the memory it had overridden.
