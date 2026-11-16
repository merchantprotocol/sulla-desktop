# Files torture kit (end-to-end)

`files_torture.py` runs **inside a Sulla VM** and drives Sulla Files through the real FUSE mount at `/mnt/sulla-files`. It keeps its own checksum manifest (SQLite, outside Files) and proves that every file is listed, readable and intact.

```
python3 files_torture.py seed   --root Stress/torture --count 1000000 --threads 16 --fanout 100 --depth 2
python3 files_torture.py verify --root Stress/torture [--sample 50000]
python3 files_torture.py churn  --root Stress/torture --ops 20000
python3 files_torture.py report --root Stress/torture
```

- `seed` can be resumed: it skips paths that are already in the manifest.
- `verify` checks sha256 and size for every file, then compares each folder's directory listing with the manifest and counts missing and extra entries.
- `churn` makes edits (new versions), deletes and renames, and records them.
- Errors are counted by errno (EIO, ENOENT, etc.). It never prints file contents.
- `TORTURE_MOUNT=/some/dir` points the kit at a plain directory to self-test it.

**Never run it against a real user's Files.** Use a test machine. It writes under `--root`.

## Integrity check (`files_fsck.py`)

`files_fsck.py` finds files that are listed but cannot be read, on any install. Copy it **and** `files_fsck.mjs` into one folder in the Sulla VM and run:

```
python3 files_fsck.py --deep --mount /mnt/sulla-files --out /tmp/fsck.jsonl   # read-only
python3 files_fsck.py --repair --yes --out /tmp/fsck-repair.jsonl             # opt-in, lossless repairs only
python3 files_fsck.py --recheck-mount /mnt/sulla-files --out /tmp/fsck.jsonl  # re-read the files listed as problems
```

- It pipes `files_fsck.mjs` into `docker exec -i sulla_files node`, so it uses the service's own `pg` module, database and chunk volume. Nothing is installed. The default run uses a read-only database session.
- It pages through every live file (bounded memory, fine at a million files) and checks the current version the way the read path does: version row, manifest, chunk geometry, `chunks` rows, and the encrypted blob on disk at its exact size. `--deep` also parses each blob's encryption envelope. `--mount` reads problem files back through the mount (with `--deep`, every file), which proves decryption.
- Output is JSONL: one `problem` record per broken file (`fileId`, `path`, `versionId`, `failureClass`, `problems`) and a `summary`. Exit code 0 means clean, 1 means problems, 2 means the check failed.
- `--repair` never deletes anything. `chunk_row_missing` with the blob still on disk is repaired by registering the chunk row again, which loses no data. Anything else is only reported. With `--rollback-unrecoverable`, a new version restores the newest readable ancestor and the broken version stays in history. Every action is a `repair` record and an `audit_log` row (`files-fsck-repair`).
