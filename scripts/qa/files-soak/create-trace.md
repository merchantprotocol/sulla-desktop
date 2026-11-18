# Create-latency trace (live, on the Desktop VM)

Question this answers: where the ~1.4 s p50 per `cp` into the Files mount goes. One `cp` is two Files requests: `POST /v1/fuse/files` (empty body, create) and `PUT /v1/fuse/files/:id/content` (on release). Each does staging (encrypt and fsync chunks) plus a `fuse-*` transaction, with an audit insert inside it.

Run `scripts/qa/files-soak/create-trace.sh` inside the VM as root. It needs only docker, python3 and the standard shell tools. It makes no change except the one-off `log_min_duration_statement` step, which `pg-count` reverts on exit.

## Procedure

1. **Build the instrumented images first.** The Files metrics and the adapter `files_ms` field only exist in the build under test. Do not run the trace on a build without them.
2. **Serial baseline, N = 30:**
   `./create-trace.sh run serial30 30 1`
3. **Eight-way contention, N = 80:**
   `./create-trace.sh run contend8 80 8`
4. **One statement and commit count** (about 12 s, counts only this create and an idle window):
   `./create-trace.sh pg-count one-create`
5. **Read the split** (run `summary` again if you want it again):
   `./create-trace.sh summary serial30`

Each `run` writes `metrics-before.json`, `metrics-after.json` (numbers only, read inside `sulla_files`), `adapter-ops.jsonl` (create, release, rename and mkdir op lines), `run.json` and `summary.json` to `$TRACE_OUT/<label>/`.

## Reading the numbers

- **Adapter vs Files split.** Each adapter op line has `ms` (kernel op total) and `files_ms` (sum of Files request time inside it). Adapter time is `ms - files_ms`. The summary prints both at p50 and p95.
- **Server side.** `files.txn`, `files.audit`, `files.fuseRoute`, `files.stage`, `files.chunkWrite` and `files.poolWait` in `summary.json` give the mean per interval (delta total ÷ delta count). The p50/p95 in the endpoint are over the most recent 512 samples only, so use the means from deltas for the run. `maxLifetimeMs` is since process start.
- **Statements and commits per create.** `pg-count.json` gives statements, commits, rollbacks and begins in the `oneCreate` window, with the `baselineIdle10s` window beside it for background noise. Expect about 1 BEGIN and 1 COMMIT per Files request, so 2 per `cp`. More than that means something else is committing too.
- **Release lines.** The adapter logs `release` (the write-release, where the PUT happens) at DEBUG only. Without DEBUG the summary has no `release` split and says so. Turning DEBUG on means changing the adapter's environment, which recreates the container, so get the manager's approval first.

## Reverting

`pg-count` reverts itself. To check or revert by hand:

```sh
docker exec sulla_postgres psql -U sulla -d sulla -At -c "ALTER SYSTEM RESET log_min_duration_statement"
docker exec sulla_postgres psql -U sulla -d sulla -At -c "SELECT pg_reload_conf()"
docker exec sulla_postgres psql -U sulla -d sulla -At -c "SHOW log_min_duration_statement"   # expect -1
```

## Cleanup

Delete `$TRACE_OUT/<label>/` once the numbers are recorded. The created test files live under `<mount>/QA/create-trace-<label>/`; remove that folder with `rm -r` (it is the run's own folder, not the Human's data).
