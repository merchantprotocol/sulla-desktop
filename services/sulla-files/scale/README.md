# Files query scale harness

Measures representative SQL request shapes from `src/app.ts` and the #2302 Automerge retention candidate pass against a fresh disposable PostgreSQL database. It applies every Files migration in order, seeds metadata only, runs `EXPLAIN (ANALYZE, BUFFERS)` and each query, counts actual rows and PostgreSQL row bytes, records serialized client bytes, and captures Node RSS/heap/external/ArrayBuffer deltas. The full-tree query intentionally represents the current `/v1/fuse/tree` snapshot read and can report FAIL: this harness measures existing behavior, it doesn't make the endpoint bounded. The retention case measures the production pruning candidate-selection CTE without modifying the fixture.

```sh
cd services/sulla-files/scale
npm install --no-save --package-lock=false --ignore-scripts pg@8.18.0
node --input-type=module -e "import pg from 'pg'; const c=new pg.Client('postgres://postgres@127.0.0.1:55432/postgres'); await c.connect(); await c.query('CREATE DATABASE files_scale'); await c.end()"
PGURL='postgres://postgres@127.0.0.1:55432/files_scale' node --experimental-transform-types harness.mjs [--files 20000 | --scale]
```

Start a disposable Postgres 16 server first (the rootless fixture used for development is `/mnt/worktrees/_scratch/embpg/pg.sh start /mnt/worktrees/_scratch/files-harness-pg 55432`). Point `PGURL` at a fresh disposable database. Never use production or a database containing user data; migration scripts mutate the database. The harness requires at least 4 GiB free on `/mnt/worktrees`, checks database size after each seed stage and aborts above 1.5 GiB. Default seed: 200,000 files, 10,000 folders, 600,000 metadata versions and three 300 KB current Automerge docs, each with 1,000 historical version-head entries. Add `--scale` for 1,000,000 files / 3,000,000 metadata versions; same safety caps apply. Tune limits with `MAX_ROWS`, `MAX_RESULT_BYTES`, `MAX_MEMORY_BYTES`.

Artifacts `REPORT.md` and `report.json` contain timings, actual returned row/byte counts, Node memory deltas and query plans. Query bytes count the UTF-8 JSON representation returned by the Node PostgreSQL client. Per-query memory delta is the largest positive delta among RSS, heap, external and ArrayBuffers. Output is overwritten on each run.
