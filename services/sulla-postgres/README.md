# sulla-postgres

PostgreSQL 16 on Alpine, with [pgvector](https://github.com/pgvector/pgvector) v0.8.7 compiled in. Desktop uses it for its single database (`sulla_postgres`). Files semantic search runs on it through an HNSW index.

Sulla is in alpha. The one install that matters is the developer's own machine, so this is a migration for a single user, not a fleet rollout.

## Why Alpine

The existing data directory was created by `postgres:16-alpine`, which uses musl libc. Text indexes are ordered by the libc collation that built them. If you start a glibc (Debian) image such as `pgvector/pgvector:pg16` on the same directory, text can sort differently and those indexes can be silently corrupted. This image is `FROM postgres:16-alpine` with only `vector.so` and its extension files added. The major version, libc, entrypoint, user and `PGDATA` layout all stay the same, so the volume mounts unchanged and no `pg_upgrade` or dump is needed. The build is multi-stage, so the final image carries no compiler. It is compiled with `OPTFLAGS=""` (no `-march=native`), so one binary runs on any amd64 or arm64 CPU.

Published as `ghcr.io/merchantprotocol/sulla-postgres:{latest,16-pgvector,sha-<12>}` for amd64 and arm64 by the workflow in `ci/sulla-postgres-image.yml`. **Move it to `.github/workflows/` to turn it on.** The token that pushed this branch had no `workflow` scope, so it couldn't add the file there itself (`git mv services/sulla-postgres/ci/sulla-postgres-image.yml .github/workflows/`). Until the image is published, Desktop just keeps using the stock fallback.

## How Desktop picks the image (fallback)

`pkg/rancher-desktop/backend/sullaPostgresImage.ts` runs while the compose file is prepared, before `docker compose up -d postgres redis`:

1. If `ghcr.io/merchantprotocol/sulla-postgres:latest` is already in the VM, Desktop uses it without a refresh pull. Postgres is only recreated when the image actually changes, which happens once, on the switch.
2. If it isn't there, Desktop runs `docker pull` with a 300 s timeout.
3. If the pull fails for any reason (offline, registry down), Desktop starts the stock `postgres:16-alpine`, logs one line, and the app still boots. Files then reports `vectorSearch: 'unavailable'` and search uses full text only.

`SULLA_POSTGRES_IMAGE` overrides the preferred image. The data volume (`sulla_postgres_data`) is never touched.

The fallback only protects the **first** start. After Files has added the `embedding vector(512)` column and HNSW index, the stock image can't open `file_search_chunks`: any query on it fails with `could not access file "$libdir/vector"`. That was verified on a throwaway copy. Other tables keep working. Desktop never prunes images, so this only happens if someone deletes the pgvector image by hand.

## The background upgrade (Files service)

`services/sulla-files/src/vectorUpgrade.ts` starts after Files unlocks. It never blocks startup, and each step can be safely re-run:

1. `CREATE EXTENSION IF NOT EXISTS vector`. If that fails, the status is `unavailable` and the upgrade stops.
2. `ALTER TABLE file_search_chunks ADD COLUMN IF NOT EXISTS embedding vector(512)`. This is a metadata-only change with a 5 s lock timeout and retries. New chunks write only this column from then on.
3. Backfill `embedding` from `embedding_json` in 2,000-row keyset batches with a 150 ms pause between batches. It uses `FOR UPDATE SKIP LOCKED`, so ingest is never blocked, and touches only rows `WHERE embedding IS NULL`, so an interrupted run resumes where it stopped. Progress is logged once every 30 s.
4. Repair: any chunk still missing a vector (bad or missing JSON, or written while pgvector was absent) is re-embedded from its stored `content` with the same local model.
5. Verify: all chunks have an embedding, and 200 random rows show cosine >= 0.9999 between the JSON and vector forms.
6. `CREATE INDEX CONCURRENTLY ... USING hnsw (embedding vector_cosine_ops)` with `maintenance_work_mem=1GB` and a serial build (Docker's 64 MB `/dev/shm` breaks parallel builds). If an interrupted build left an INVALID index, it is dropped and rebuilt.

Status is reported in `/healthz` as `vectorSearch` (`unavailable | backfilling | indexing | ready`) plus `vectorSearchStatus` (phase and counts).

## Reclaiming the JSON column (opt-in)

`embedding_json` is **not** dropped automatically. Run `reclaimJsonEmbeddings(db, embedder)` from `vectorUpgrade.ts`, or start Files once with `SULLA_FILES_RECLAIM_JSON_EMBEDDINGS=1`. It runs the same verification first, and only if that passes does it run `ALTER TABLE ... DROP COLUMN embedding_json` and then `VACUUM (FULL) file_search_chunks`. The run logs the bytes reclaimed (roughly 3 GB expected on the 3.66 GB table). `VACUUM FULL` holds an exclusive lock on the table while it rewrites it, so Files search and indexing pause for that time. It needs free disk space about the size of the rewritten table (around 1.5 GB). Embeddings are derived data and can be recomputed from `content`.

## Before the first start on the new image: back up

Run one of these first (both read-only against the live DB):

```sh
# Logical dump of the sulla database (inside the VM):
docker exec sulla_postgres pg_dump -U sulla -Fc sulla > /mnt/data/sulla-$(date +%Y%m%d).dump
# Or snapshot the volume while Postgres is stopped:
docker run --rm -v sulla_sulla_postgres_data:/v -v /mnt/data:/b alpine tar czf /b/sulla_postgres_data.tgz -C /v .
```

## Rollback

Restore the backup. Set `SULLA_POSTGRES_IMAGE=postgres:16-alpine`, then restore the dump (`pg_restore -U sulla -d sulla --clean`) or the volume tarball. If you haven't reclaimed, `embedding_json` is still intact. Don't just point the stock image at a database that already has the HNSW index (see above).
