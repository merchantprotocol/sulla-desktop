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
