# v7 subject memory

v7 is an opt-in subject-scoped memory store. Set `subconsciousRecallMode` to
`v7` to use it. The default remains `ranked`; installing or merging the code
therefore does not change recall. v7 uses the bundled Potion embedder and
Postgres only—there is no Python process, network embedding call, or 10k-token
cap.

The `0133_create_v7_subject_memory` migration creates the `subject_memory`
schema. On the lab install it idempotently copies existing `brain_lab.v7_*`
rows. Clean installs simply create empty tables. To repeat that copy, run:

```sql
select subject_memory.import_brain_lab();
```

`exportV7SubjectMemory(file)` and `importV7SubjectMemory(file)` in
`agent/memory/V7SubjectMemoryTransfer.ts` are the portable file pair for an
isolated install. Exports are versioned JSON and written atomically with mode
0600; imports are idempotent. The migration also exposes
`subject_memory.export_json()` / `subject_memory.import_json(jsonb)` for admin
or recovery tooling.

Recall renders `human.md`, `project-<slug>.md`, `lessons.md`, and `skills.md`.
Its per-thread sent ledger suppresses repeats and is cleared after provider CLI
compaction or Sulla conversation summarization. With v7 enabled, this document
block replaces the old observation blocks. The post-turn elephant uses the
Settings subconscious model slot, runs asynchronously, appends factual episodes
and user-stated rules, and uses storage supersession rather than editing history.

## Rollback

1. Set `subconsciousRecallMode` back to `ranked` (immediate, no data loss).
2. If the stored v7 data must also be removed, export it first, then run the
   migration down (`DROP SCHEMA subject_memory CASCADE`). Dropping the schema is
   destructive and is not required merely to disable v7.

Not included in this integration: live goldfish review, the dreamer/sleep pass,
or the mid-loop watcher.
