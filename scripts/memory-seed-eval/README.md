# Memory seed evaluation

Run against the shipped pack:

```bash
NODE_PATH=/mnt/worktrees/sulla-desktop-perf-ttfr/node_modules /mnt/worktrees/sulla-desktop-perf-ttfr/node_modules/.bin/tsx scripts/memory-seed-eval/run.ts
```

Add `--fixtures` for the tiny smoke pack. Set `SULLA_SEED_EVAL_DATABASE_URL` to an admin connection for the app's PostgreSQL server when it does not use the local Desktop default. The script connects to that server, creates a uniquely named scratch database, applies the real 0133 and 0135 migrations, calls the real seeder and recall function, then terminates only scratch connections and drops that database in `finally`. It never connects to the `sulla` database.
