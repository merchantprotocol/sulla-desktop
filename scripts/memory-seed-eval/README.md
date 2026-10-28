# Memory seed evaluation

Run against the shipped pack:

```bash
SULLA_MODELS_DIR=<dir containing potion-retrieval-32M/model.int8.bin> node_modules/.bin/tsx scripts/memory-seed-eval/run.ts
```

Add `--fixtures` for the tiny smoke pack. Set `SULLA_SEED_EVAL_DATABASE_URL` to an admin connection for the app's PostgreSQL server when it does not use the local Desktop default. The script connects to that server, creates a uniquely named scratch database, applies the real 0133 and 0135 migrations, calls the real seeder and recall function, then terminates only scratch connections and drops that database in `finally`. It never connects to the `sulla` database.

It needs installed dependencies (ESM imports ignore `NODE_PATH`) and the real Potion weights: `potion-retrieval-32M` with `model.int8.bin`, as produced by `scripts/dependencies/potion.ts`. Without the weights recall returns nothing and every cue misses. The script warms the store once so every cue is scored on vectors, and a cue passes when recall surfaces any one of its acceptable subjects (and, separately, skills).

Last run (seed v3, 2026-10-27): subjects 39/40, skills 39/39, first-turn recall block about 15k characters with the core `sulla.md` rules present.
