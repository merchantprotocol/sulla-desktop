# Outcome Ledger

The ledger at `~/sulla/ledger/` is the **one work-state store**. Autonomous cycles start at `LEDGER.md` WORKING, move one item, and write back.

## Tool

```bash
sulla ledger/ledger_scoreboard '{"days":7}'
```

Deterministic, zero LLM. Counts outcomes shipped in-window, WORKING / staged-at-gate rows, AUDIT lines, and flags the 7-day staleness rule. The heartbeat reads this each cycle; the human reads it as trust-ratchet evidence.

The ledger files themselves are maintained by the observation writer (post-turn) and by agents via `read_file` / `write_file`. This tool only measures.

## Layout

```
~/sulla/ledger/
├── LEDGER.md      # priority stack + WORKING table
├── OUTCOMES.md    # what shipped and what it changed
├── AUDIT.md       # one line per gate-free unilateral action
├── BACKLOG.md     # WANT / MIGHT
└── goals/         # goal files with epics + tasks
```

Scaffolded at boot if missing (template-only, never overwrites user content, no user data in shipped code).

## Structured store (migration 0044)

`LEDGER.md` is still the pick-path. The structured ending of "what exists,
what stage, what priority, when it last moved" lives in Postgres:

`work_projects` → `work_epics` → `work_tasks` → `work_task_comments`

See [`tools/work.md`](work.md). A runtime seeder imports this install's
`~/sulla/ledger/goals/*.md` on first boot. After that, prefer the work
tools over inventing a second markdown task list.

