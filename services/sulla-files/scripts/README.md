# Search scale benchmark

Build `@sulla/files-service`, then point this harness only at a disposable corpus restore:

```sh
DATABASE_URL=postgres://... POTION_MODEL=/path/to/potion BENCH_RUNS=20 \
  node services/sulla-files/scripts/search-bench.mjs > benchmark.json
```

It emits counts and latency distributions only—never file paths, contents, snippets, or query results. It runs common, rare, multi-word, collection-scoped, folder-scoped, keyword, and semantic searches with four concurrent workers while revision and folder-list queries continuously measure foreground latency.

Targets: keyword p95 <300 ms; semantic p95 <150 ms; cheap-query p95 <20 ms under load.

## Rollout behaviour

Migration `045_pgvector_search.sql` only prepares structure (milliseconds). `src/vectorBackfill.ts` runs ~30 s after
startup, throttled and resumable: it copies JSON embeddings into `file_search_vectors` (halfvec), builds the HNSW index
(`CREATE INDEX CONCURRENTLY`), writes the `045_pgvector_backfill_complete` marker (search switches to halfvec only then),
and finally clears the JSON copies. Until the marker exists semantic search keeps using the bounded JSON fallback.
Rolling back to the stock Postgres image after the JSON copies are cleared keeps keyword search but loses semantic search
until re-indexed.
