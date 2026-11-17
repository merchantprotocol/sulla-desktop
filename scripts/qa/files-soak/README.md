# Files durability soak

`files-soak.sh` is a self-contained, standard-library-only QA harness for the Sulla Desktop Linux VM. Run it **inside the VM**, where `/mnt/sulla-files` is mounted and Docker manages the Files services. It does not SSH or call the Mac host. The soak folder is created below the detected personal collection (`Files`, `Personal`, `My Files`, or an unambiguous non-organization root); organization collections are excluded. Bulk data is about 225 MB on average and at most 300 MB, well below the iMac's 1.5 GB test-data budget.

```sh
cd /path/to/scripts/qa/files-soak
./files-soak.sh all
# Optional, only works when host macOS tools are exposed in this environment:
./files-soak.sh crash --with-app-restart
# Keep the default 30 minutes, or set a shorter/longer duration:
SOAK_MINUTES=2 ./files-soak.sh load
./files-soak.sh cleanup
```

Supported phases: `bulk`, `append`, `ops`, `crash`, `load`, `cloud`, `all`, and `cleanup`. `all` runs every test phase but never removes its data. Cleanup is deliberately separate. Checks print one JSON line each and append the same line to `~/sulla-twodev/soak/results.jsonl`; the script prints a short summary after the JSON lines. On any individual failure it records the failure and continues, then exits nonzero if a check failed. It never logs file contents, credentials, or host user data; evidence consists of check names, counts, hashes and bounded error descriptions.

`bulk` writes 2,000 1–8 KiB files and 15 10–20 MiB files, then compares SHA-256 digests. `append` uses eight processes and single `O_APPEND` record writes. `ops` checks truncate/rewrite/rename/move/delete; trash and historical restore are reported as skipped because there is no stable guest-side API contract for them. `crash` writes uniquely named, checksummed files while restarting `sulla_files` and killing the FUSE daemon child, waits up to 300 seconds for `ls`, and reports missing/corrupt successful writes as DATA LOSS. App restart is opt-in; the VM normally cannot access host `osascript`/`open`. `load` defaults to 30 minutes, probes every 10 seconds, and counts mount drops plus matching supervisor restart lines appended during the run. `cloud` is skipped: Files exposes cloud heads internally and `sync_state` through listing, but the latter is hydration/conflict state rather than a supported per-file cloud-commit status API.

Implementation evidence: `pkg/sulla-desktop/backend/sullaRuntimeBackend.ts:1519-1527` names the FUSE container `sulla_files_fuse` and Files service URL `https://sulla_files:8792`; `pkg/sulla-desktop/main/SullaFilesMountAdapterService.ts:83-84,113-121` addresses that container. `services/sulla-files-fuse/entrypoint.sh:86-103` starts the adapter daemon as `python3 /usr/local/libexec/sulla-files-fuse.py` and supervises its exit; killing that child is the daemon-level test. `pkg/sulla-desktop/backend/sullaRuntime/ManagedContainerHealthWatcher.ts:78-81` logs healing actions; `pkg/sulla-desktop/backend/sullaContainerHealth.ts:80-86` formats the unhealthy/restarting log line. The File listing's `sync_state` is assembled in `services/sulla-files/src/Repositories/FileListingRepository.ts:21` from conflict and hydration states.
