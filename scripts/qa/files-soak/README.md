# Files durability soak and kill-test harness

`files-soak.sh` is a self-contained, standard-library-only QA harness for the Sulla Desktop Linux VM. Run it **inside the VM** as root, where Docker manages the Files services. It does not SSH or call the Mac host. It supersedes the earlier soak PR #2599 and is the measurement + kill-test harness for the Files FUSE reliability epic (see `Projects/` plan, step 0). The soak folder is created below the detected personal collection (`Files`, `Personal`, `My Files`, or an unambiguous non-organization root); organization collections are excluded.

```sh
cd /path/to/scripts/qa/files-soak
./files-soak.sh fuse-identity            # container id/created/startedAt/image (compare before and after a regen)
./files-soak.sh restart-propagation      # ENOTCONN check: fresh ls/read/write in a container that survived an adapter restart
./files-soak.sh outage                   # Files stop 45 s (A), then outage-b paused 120 s (B); recovery
./files-soak.sh outage-b [paused|stopped] # Sub-test B on its own: Files held down 120 s, probes every 10 s; recovery
./files-soak.sh handles                  # 100 concurrent open files in the VM and two test containers
SOAK_TOKEN_TEST=1 ./files-soak.sh token-empty   # opt-in: empties the adapter token for a bounded window, then restores it
./files-soak.sh lock-contention          # creates, mv-over-existing, mkdir/rmdir in one collection
./files-soak.sh latency                  # stat p50/p95 cold and warm (separately) over ~500 files, plus under write load
./files-soak.sh staleness                # API write -> mount visibility, and invalidation window
./files-soak.sh integrity                # every ledger write checksum-verified via mount, plus an API sample
./files-soak.sh eio-capture              # per-EIO adapter lines (eio-events.jsonl) and Files/adapter log lines within ±2 s
./files-soak.sh env-info                 # images, digests, migrations 067/068, Files metrics probe
./files-soak.sh all                      # full sequence (< ~25 min, < 500 MB of QA data)
./files-soak.sh summary                  # compact table for the latest run
./files-soak.sh before-after-summary <run> # one compact JSON object of key numbers for a run label
./files-soak.sh api-write <rel path> <content>  # write through the Files HTTP API (from inside sulla_files_fuse)
./files-soak.sh cleanup                  # removes the soak folder and test containers, separately
```

Legacy phases remain: `bulk`, `append`, `ops`, `crash`, `load`, `cloud`. `all` does not run `load` unless `SOAK_MINUTES` is set (the 30-minute default would blow the budget). `--with-app-restart` is opt-in for `crash`.

## Output

Every check prints one JSON line and appends it to `~/sulla-twodev/soak/results.jsonl`:

```json
{"check":"outage-b-stop","pass":true,"metrics":{"down_s":120,"hung":0,"max_ms":10002.1,"probes":13},"evidence":"...","ms":...,"phase":"outage","run":"20261118T..."}
```

`evidence` carries counts, errno text and status/code tokens only. The harness never prints tokens, file contents or user-data paths. Errors are shortened to the OS errno text (for example `Transport endpoint is not connected`).

## Layout detection and overrides

| Layout | Mount seen by the VM | Test-container bind |
| --- | --- | --- |
| Current | `/mnt/sulla-files` | `/mnt/sulla-files:/mnt/sulla-files:rslave` |
| Future | `/mnt/sulla/files` (FUSE on the anchor's parent) | `/mnt/sulla:/mnt/sulla:rslave` |

The mount is `/mnt/sulla/files` when `mountpoint -q /mnt/sulla/files` succeeds, otherwise `/mnt/sulla-files`. Test containers always see the Files mount at the same path the VM uses (`/mnt/sulla/files` in the new layout). Overrides: `SOAK_MOUNT`, `SOAK_BIND_SPEC` (`src:dst:propagation`), `SOAK_FILES_CONTAINER` (default `sulla_files`), `SOAK_FUSE_CONTAINER` (`sulla_files_fuse`), `SOAK_PG_CONTAINER` / `SOAK_PG_USER` / `SOAK_PG_DB` (`sulla_postgres`, `sulla`, `sulla`), `SOAK_FUSE_TOKEN_FILE` (`/run/sulla-files-fuse/token`), `SOAK_FUSE_URL` (`https://sulla_files:8792`), `SOAK_TEST_IMAGE` (default order: the FUSE container's image first, then `alpine:*`, `busybox:*`; the first image with `sh`/`sleep`/`printf` wins, and one with `python3` is preferred).

Other knobs: `SOAK_INVALIDATE_WINDOW` (5 s), `SOAK_OUTAGE_A_SECONDS` (45), `SOAK_OUTAGE_B_SECONDS` (120), `SOAK_LOCK_SECONDS` (30), `SOAK_LATENCY_P95_MS` (1000), `SOAK_LATENCY_LOAD_SECONDS` (20), `SOAK_API_SAMPLE` (40), `SOAK_TOKEN_SECONDS` (20), `SOAK_DESKTOP_VERSION` (for `env-info`), `SOAK_RUN` (run id, summary selector).

## What each phase proves

- **restart-propagation** (acceptance 1): starts a throwaway `fusesoak-<ts>` container with no restart policy, bound the way agent containers bind Files, writes, runs `docker restart sulla_files_fuse`, waits for the VM mount, then does a new ls/write/read in the **same** container. It fails with the errno text if the mount stays dead for that container (`ENOTCONN`). This is the bind-layout check from the review: the fix to bind the anchor's parent should make it pass.
- **outage** (acceptance 2): four checksummed retrying writers run through the mount, started at 0, 1/4, 1/2 and 3/4 of the Files-down window, so writes begin at different points. A write is retried until it succeeds. One plain writer makes a single attempt every 2 s with no retry and reports each attempt as ok or errno with latency, grouped as before, down and after (`plain_by_phase`, `plain_attempts`). Sub-test A stops `sulla_files` for 45 s. Pass requires every write started in the window to eventually succeed (`writes_failed == 0`), every successful write to checksum, and Files still `exited` with the same `StartedAt` at window end (`valid`). Plain attempts are reported, not gated. `actual_down_s` is the real down time from `docker inspect` (FinishedAt of the stop to StartedAt of the start). Sub-test B holds Files down for 120 s with probes bounded at 150 s, in one of two variants (`outage-b-paused` by default, or `outage-b-stopped`). Docker state (`status`, `StartedAt`, `FinishedAt`, `RestartCount`) is sampled at the hold start, at every probe and at window end. The window is **valid** only if Files stayed in the expected state (`paused` or `exited`) with the same `StartedAt` and `RestartCount` the whole time. An invalid window is reported with an `INVALID` prefix and does not pass.

  - `paused` (`docker pause`): requests hang, then get a clean errno from the adapter's deadline. Desktop does not heal it: `ManagedContainerHealthWatcher` treats a paused container as present, and `sullaContainerHealth.ts` only heals unhealthy, restarting or missing containers. This is the variant that holds Files down.
  - `stopped` (`docker stop`): requests are refused. Desktop's watcher sees the exited container as missing within about 60 s and its reconcile starts it again (`sullaRuntimeBackend.ts`), so this variant is INVALID whenever Desktop heals it. Keeping it down needs a Desktop-side stop (the Docker tab), which the harness cannot do.

  Recovery is a fresh write+read. A `finally` always unpauses and restarts `sulla_files`.
- **mount readiness**: before each measured phase the mount must answer `ls` within 120 s. A recovery is recorded as `mount-recovery-before-<phase>` with its time.
- **handles** (acceptance 2): opens 100 files in the VM and in two test containers, holds them, writes and reads, then closes. The adapter cap (`MAX_OPEN_HANDLES = 32`) shows up here as EMFILE. Pass means all 100 open in every place.
- **token-empty** (acceptance 2, opt-in): backs up the token inside the FUSE container (`*.soak-bak`, never printed), empties it, restarts the adapter, waits, counts EACCES and retry log lines, then restores in a `finally`. Pass requires the restore and mount recovery within 120 s. Skipped by default and in `all`.
- **lock-contention** (acceptance 3): in one collection, runs creators, mv-over-existing movers and mkdir/rmdir loops in parallel for `SOAK_LOCK_SECONDS`. Counts EIO separately from other errors and reports latency per op kind.
- **latency** (acceptance 5): 500 files stat'd idle and under a 10 MiB write load; read first vs repeat p50 on 20 files.
- **staleness** (acceptance 5): writes a new file (POST `/v1/fuse/files`) and then modifies an existing one (PUT `/v1/fuse/files/{id}/content` with `If-Match` = the current version, `X-Sulla-Source-Hash` = sha256 of the base version read just before) from inside `sulla_files_fuse` (token stays there), then polls through the mount. The collection id comes from `/v1/collections` by name, or the home collection from `/v1/fuse/directory` when the mount root is the personal collection (`SOAK_PARENT`). Pass requires visibility within window + slack and no stale reads after the window.
- **eio-events.jsonl** (`~/sulla-twodev/soak/eio-events.jsonl`): every EIO in any phase, from any thread, appends one line: `time`, `phase`, `path` (the soak folder path), `op` (read, write, stat, probe, check or phase), `errno`, and up to 10 `files-request` lines the adapter logged within ±5 s (`docker logs --since`). Cleanup never deletes this file. The first 500 EIOs per process are captured live; later ones are logged without the adapter lines.
- **eio-capture** (acceptance 2): summarises the eio-events.jsonl rows for this soak root by phase and op, and pulls `docker logs -t --since` from `sulla_files` and `sulla_files_fuse` and counts status/code fields within ±2 s. Paths are dropped from the summary.
- **env-info**: container images, image IDs, repo digests, Desktop version (set `SOAK_DESKTOP_VERSION`; unknown otherwise), migrations 067/068 in `files_schema_migrations`, and `GET /v1/local/files-metrics` probed inside `sulla_files` with its local token (`x-sulla-files-token`). Only the numeric fields are recorded.
- **fuse-identity** (acceptance 4): prints the adapter's id, created, `State.StartedAt`, image, image ID and restart count. Run it before and after a Desktop compose regeneration and compare.
- **integrity** (acceptance 11): every ledger row written by any phase is checksum-verified through the mount. The phase fails on any EIO (`integrity-eio`, and `eio` in `integrity-mount` and `integrity-api`), not only on a checksum mismatch. A sample is verified through the Files API (via the in-container helper, token never leaves the container). Crash-phase writes are checksum-checked in the `crash` phase and added to the ledger for this integrity pass.

## Phases from before (unchanged behaviour)

`bulk` writes 2,000 1–8 KiB files and 15 10–20 MiB files and compares SHA-256 digests. `append` uses eight processes and single `O_APPEND` record writes. `ops` checks truncate/rewrite/rename/move/delete; trash and historical restore are reported as skipped because there is no stable guest-side API contract for them. `crash` restarts `sulla_files` and kills the FUSE daemon child while writing checksummed files, and reports missing or corrupt successful writes as DATA LOSS. `load` probes every 10 seconds for `SOAK_MINUTES` (default 30). `cloud` is skipped: there is no supported guest-side per-file cloud-commit status.

## Safety

- Test containers carry the label `sulla-soak=1`, use `sleep 1800`, and have no restart policy. `all` and each phase remove them in a `finally`, and `cleanup` removes any leftovers with that label.
- Only the per-run `files-soak-<stamp>` folder under the personal collection is written. `cleanup` refuses anything else.
- Kill tests (`restart-propagation`, `outage`, `crash`, `token-empty`) restart Files or the adapter. Run them on a VM where that is acceptable.
- Budget: `all` writes about 300 MB of QA data (bulk 225 MB, plus latency, outage, lock and staleness data). It takes about 20 to 25 minutes on a healthy VM.

## Notes

This branch was checked with `bash -n` and `py_compile` only. It has not been run against a live Desktop; the manager runs it on the iMac before and after the fixes.
