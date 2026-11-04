# Host dirty-edit reconciliation — 2026-11-03

Jonathon's Mac checkout had uncommitted edits in three cloud/memory-sync files while its `main` was at `9459bc989`. This audit compares those edits with current `main`. No source edit remains to port.

| Patch hunk | Disposition | Current-main evidence |
| --- | --- | --- |
| Remove the dead `memory` case from `countProjection` | Already in main | `f1a3ae9c5` (also shipped by `056665e53`, PR #1927) applies the identical deletion. |
| Treat `postgresClient.query()` results as row arrays in `pending`, `decide`, `rows`, record metadata/state queries, and `applyWithConflict` | Already in main, with stricter typing | `37c445bf5` introduced the row-array API migration; `056665e53` shipped it in PR #1927. Current main also uses typed query generics and `queryOne()` rather than the patch's untyped indexing. |
| Add an explicit `Promise<void>` return type to `MemorySyncV1Impl.run` | Already in main | `63289ed65` introduced the identical annotation; it shipped in `056665e53` / PR #1927. |
| Type decrypted `plain` as `Record<string, any>` | Superseded by a safer equivalent | `37c445bf5` / `056665e53` types it as `Record<string, unknown>`, retaining the intended property access without weakening the value type to `any`. |
| Declare the two `sulla-cloud-memory` IPC channels | Already in main, with stricter types | `4954850c5` added both declarations; they shipped in `056665e53` / PR #1927. Current main accepts `number \| string` generations and uses `unknown` record values to match database/runtime values. |

The original host patch is preserved in the named Git stash on Jonathon's Mac. This note is the repository audit trail; applying that older patch over current main would regress the typed Postgres query repair.
