# Rules — the guardrails the Security Conscience enforces

Sulla keeps a set of **rules** that the subconscious **Security Conscience**
agent reads every actionable turn and folds into a `<security_context>`
briefing for the primary agent — "confirm before touching prod", "never
deploy on Fridays", "always double-check the path before overwrite".

There are **two sources**, read together:

## 1. Global rules — files (product baselines)

Editable markdown under `~/sulla/rules/global/`:
- `security-global.md` — credential, host, database, privacy, untrusted-input boundaries
- `operational-global.md` — least privilege, verify-before-act, reversibility, honesty

Seeded on first boot; safe to edit (your edits are never overwritten). Read
them with `read_file` / `file_search`. Power users can also drop hand-authored
rule files under `~/sulla/rules/user/`.

## 2. User rules — database (`sulla_rules` table)

The rules THIS human added during conversation. Managed with these tools:

| Tool | Use |
|------|-----|
| `sulla rules/list_rules '{}'` | List active user rules (filter by `category`/`severity`). |
| `sulla rules/search_rules '{"query":"deploy"}'` | Find user rules relevant to an action. |
| `sulla rules/add_rule '{"content":"Always confirm before touching prod","severity":"high","category":"security"}'` | Add (or update a near-duplicate) rule. Pass `id` to update in place; `enabled:false` to pause. |
| `sulla rules/archive_rule '{"id":"a1B2"}'` | Soft-delete a rule (never hard-deleted). |

When the human says **"make a rule that…", "from now on always…", "never…"**,
that's an `add_rule`. Rules are soft-archived, never destroyed, so history is
always recoverable.

**Note:** the Security Conscience is READ-ONLY — it reminds, it never writes.
The primary agent does the writing via `add_rule` / `archive_rule`.
