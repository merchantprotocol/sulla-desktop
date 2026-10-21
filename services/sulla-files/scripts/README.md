# Search scale benchmark

Build `@sulla/files-service`, then point this harness only at a disposable corpus restore:

```sh
DATABASE_URL=postgres://... POTION_MODEL=/path/to/potion BENCH_RUNS=20 \
  node services/sulla-files/scripts/search-bench.mjs > benchmark.json
```

It emits counts and latency distributions only—never file paths, contents, snippets, or query results. It runs common, rare, multi-word, collection-scoped, folder-scoped, keyword, and semantic searches with four concurrent workers while revision and folder-list queries continuously measure foreground latency.

Targets: keyword p95 <300 ms; semantic p95 <150 ms; cheap-query p95 <20 ms under load.
