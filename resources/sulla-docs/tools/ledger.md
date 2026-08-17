# Outcome Ledger — historical archive

`~/sulla/ledger/` is **not** the work-state store. The pick-path is the
Postgres Projects tables — see [`tools/project.md`](project.md) and the Projects view.

These markdown files may still exist on an install that was seeded from
them. Treat them as a historical archive. Do not open `LEDGER.md` to pick
work. Do not append `OUTCOMES.md` / `AUDIT.md` as bookkeeping — write the
work item (`update_task`, `add_task_comment`).

## Leftover tool

```bash
sulla ledger/ledger_scoreboard '{"days":7}'
```

Deterministic, zero LLM. Counts leftover markdown outcomes / WORKING rows /
AUDIT lines. Useful only while an install still has those files. New
installs should ignore this tool and use `sulla project/report` +
`sulla project/list_project_items`.

## Layout (archive)

```
~/sulla/ledger/
├── LEDGER.md      # historical priority stack — do not pick from here
├── OUTCOMES.md    # historical shipped log
├── AUDIT.md       # historical gate-free action log
├── BACKLOG.md     # historical WANT / MIGHT
└── goals/         # imported into work_projects / work_epics / work_tasks
```

Scaffolded at boot if missing (template-only, never overwrites user
content, no user data in shipped code). After the work-tables seeder
runs, stop writing these files.
