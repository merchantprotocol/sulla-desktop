# Files query scale harness

Measures representative SQL request shapes from `src/app.ts` against a fresh disposable PostgreSQL 16+ database. It applies every migration in order, creates synthetic metadata, runs `EXPLAIN (ANALYZE, BUFFERS)` and each query, counts returned rows/serialized bytes and captures process-memory deltas. The full-tree query intentionally represents the current `/v1/fuse/tree` snapshot read and can report FAIL: this harness measures existing behavior, it doesn't make the endpoint bounded.

```sh
cd services/sulla-files/scale
PGURL='postgres://postgres@127.0.0.1:55432/files_scale' node harness.mjs
```

Point `PGURL` at any fresh disposable Postgres database (16+ recommended). Do not use production or a database containing user data; migration scripts mutate the database. The selected database must be empty and must have at least 4 GiB free on `/mnt/worktrees`; seeding aborts below that threshold and aborts if database size exceeds 1.5 GiB. The default seed is 200,000 files, 10,000 folders, 600,000 metadata versions and three 100 KB current Automerge docs, each with 1,000 version-head entries. Add `--scale` for 1,000,000 files / 3,000,000 metadata versions; the 1.5 GiB ceiling remains in force. Tune limits with `MAX_ROWS`, `MAX_RESULT_BYTES`, `MAX_MEMORY_BYTES`.

Artifacts `REPORT.md` and `report.json` contain timings, actual returned row/byte counts, Node memory deltas and query plans. Query bytes count the UTF-8 JSON representation returned by the Node PostgreSQL client. Per-query memory delta is the largest positive delta among RSS, heap, external and ArrayBuffers. Output is overwritten on each run.
