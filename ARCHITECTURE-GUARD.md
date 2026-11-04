# Architecture guard

Part of the Sulla OOP rebuild (Laravel-style; see `Projects/sulla-desktop/oop-review/ARCHITECTURE-PLAN.md` in Sulla Files, §5 phase 0 and §10 item 4). It stops new procedural code from landing while the codebase is rebuilt.

**Run it:** `node scripts/architecture-guard/guard.mjs` (plain Node 18+, no install, a second or less). CI runs it on every PR and on pushes to `main` (`.github/workflows/architecture-guard.yml`).

## What fails a PR
Only production code is checked. Tests, fixtures, `node_modules`, build output, dot-folders and `.d.ts` files are skipped.

| Rule | Fails when | Fix |
|---|---|---|
| `mutable-state` | top-level `let`/`var`, a module-scope `new Map/Set/WeakMap/WeakSet`, or a module-scope array/object that the file mutates | keep state on a class instance and bind it in a ServiceProvider |
| `raw-sql` | SQL strings (`SELECT … FROM`, `INSERT INTO`, `UPDATE … SET`, `DELETE FROM`, `CREATE/ALTER/DROP TABLE`), `sql` tagged templates, or `db/pool/client/…​.query/prepare/exec/…(` calls outside `Repositories/`, `Models/` or `migrations/` folders | move the data access into a Repository |
| `long-file` | a file over 400 lines that isn't on the allowlist | split it into classes |
| `procedural-module` | a file that exports free functions doing I/O or business logic (await, fetch, fs, IPC, storage, db calls) and exports no class. UI components (`.vue/.tsx/.jsx`), `*.config.*` and `scripts/` are exempt | make it a Service, Repository or other class |

## The allowlist only shrinks
`architecture-guard.allowlist.json` lists today's offenders (file → rule counts + reason). The check fails when:
- a file not on the list breaks a rule;
- an allowlisted file gains more `mutable-state` or `raw-sql` occurrences than recorded;
- a PR adds a file or raises a count in the allowlist (compared with the PR's base branch);
- an entry is already fixed: run `node scripts/architecture-guard/guard.mjs --prune` and commit the smaller allowlist.

Allowlisted long files print a warning when they grow but don't fail, and allowlisted procedural modules may still be edited. Both stay on the list until they're converted.

Never hand-edit the allowlist to add entries. `--init` (rebuild from current code) is for first setup only.

## Limits (by design: fast and dependency-free)
It's a line and regex scan, not a type-aware parser. It can miss state that's mutated from another file, lowercase SQL, or unusually formatted code, and a string containing an apostrophe in JSX text can hide code that follows it. Reviewers still own architecture. Tighten the rules in `architecture-guard.config.json` (`maxLines`, `extra_ignore`, `extra_sqlAllowed`, `extra_proceduralExempt`, `extra_mutableStateExempt`).
