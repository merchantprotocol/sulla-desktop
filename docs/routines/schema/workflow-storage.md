# Routine Storage — Postgres as the Source of Truth

Routines (formerly called workflows) live in a single Postgres table. Their definition — the node/edge graph authored on the canvas — is stored as JSONB. Functions live on disk at `~/sulla/functions/`. YAML becomes an export-only artifact for sharing and git. This document spells out the storage model, migration path, and how it wires into the existing codebase.

> **Terminology note.** The table is named `workflows` for historical reasons. It stores **routines**. "Workflow" and "routine" are the same concept in this codebase during the rename transition. See [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md).

---

## 1. The split — three layers, three places

| Layer                          | What it contains                                                    | Where it lives                         | Mutability                   |
|--------------------------------|---------------------------------------------------------------------|----------------------------------------|------------------------------|
| **Function library**           | Code, I/O schema, permission declarations                           | `~/sulla/functions/<slug>/` (files, each a git repo) | Mutable (git-tracked)        |
| **Routine definition**         | Graph: nodes (+ per-node config), edges, viewport, metadata         | Postgres `workflows.definition` JSONB  | Freely edited, audit-logged  |
| **Routine execution state**    | A single run: checkpoints, pending completions, outputs per node    | Postgres `workflow_checkpoints`, `workflow_pending_completions` (existing) | Append-only                  |

"Instance" means a *running execution*, not a placement. Per-placement config lives inside the routine's `definition` JSONB, under each node's `data.config`. No separate instances table.

---

## 2. Schema

Two new tables. Migrations follow the existing raw-SQL convention in `pkg/rancher-desktop/agent/database/migrations/`.

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id              VARCHAR(255) PRIMARY KEY,
  name            VARCHAR(500) NOT NULL,
  description     TEXT,
  version         VARCHAR(50),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'production', 'archive')),
  definition      JSONB NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflows_status      ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_enabled     ON workflows(enabled);
CREATE INDEX IF NOT EXISTS idx_workflows_definition  ON workflows USING GIN (definition);

CREATE TABLE IF NOT EXISTS workflow_history (
  id                  BIGSERIAL PRIMARY KEY,
  workflow_id         VARCHAR(255) NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  definition_before   JSONB,
  definition_after    JSONB NOT NULL,
  changed_by          VARCHAR(255),
  change_reason       TEXT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_history_workflow ON workflow_history(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_created  ON workflow_history(created_at DESC);
```

The `definition` JSONB is the entire routine document — same shape as [routine.schema.json](./routine.schema.json) (nodes, edges, viewport, metadata), just stored as a JSON column. The GIN index makes queries like "which routines use function X?" fast:

```sql
SELECT id, name FROM workflows
WHERE definition @> '{"nodes":[{"data":{"config":{"functionRef":"dedupe-emails"}}}]}';
```

(The column can be renamed to `routines` in a later migration once the code-level rename lands. Not urgent.)

---

## 3. Per-node config lives inside `definition.nodes[].data.config`

Two placements of the same function = two entries in the `nodes` array, each with its own config:

```json
{
  "id": "workflow-billing-notify",
  "nodes": [
    {
      "id": "node-notify-eng",
      "type": "workflow",
      "position": { "x": 500, "y": 200 },
      "data": {
        "subtype": "function",
        "category": "agent",
        "label": "Notify engineering",
        "config": {
          "functionRef": "send-slack-message",
          "inputs": { "channel": "#engineering", "text": "{{ trigger.summary }}" },
          "vaultAccounts": {
            "SLACK_TOKEN": { "accountId": "acct-slack-eng", "secretPath": "slack/token" }
          },
          "timeoutOverride": null
        }
      }
    },
    {
      "id": "node-notify-billing",
      "type": "workflow",
      "position": { "x": 500, "y": 400 },
      "data": {
        "subtype": "function",
        "category": "agent",
        "label": "Notify billing",
        "config": {
          "functionRef": "send-slack-message",
          "inputs": { "channel": "#billing", "text": "{{ trigger.summary }}" },
          "vaultAccounts": {
            "SLACK_TOKEN": { "accountId": "acct-slack-billing", "secretPath": "slack/token" }
          },
          "timeoutOverride": null
        }
      }
    }
  ]
}
```

Same function on disk, two function nodes, different configs, different vault accounts. Function files untouched.

---

## 4. Vault account binding

Function declares *what* secret it needs (`spec.permissions.env: [STRIPE_KEY]`). Node config binds *which* account supplies it:

```json
"vaultAccounts": {
  "STRIPE_KEY": { "accountId": "acct-stripe-live-01", "secretPath": "stripe/api_key" }
}
```

At invocation: the playbook reads the vault, sends the value in the `/invoke` request's `env` field to the runtime, the runtime injects it into the function's namespace for that one call, clears after. Plaintext never touches disk in the runtime. Two function-node instances can use two different accounts without code changes.

---

## 5. Save semantics

Canvas edit → single Postgres UPDATE (or INSERT for new routines). Debounced ~500ms from the UI.

Every UPDATE also writes a row to `workflow_history` with the before/after definition. Audit trail is free. Rollback is a single query against the history table.

No file watchers. Notifications go through Postgres `LISTEN/NOTIFY` (or an in-app event bus fired from the IPC handler) to tell the renderer when to refresh.

---

## 6. Lifecycle

The existing `draft` / `production` / `archive` lifecycle is preserved — it becomes a `status` column instead of a directory.

- `draft` — editable, not scanned by triggers.
- `production` — active, scanned by HeartbeatNode / WorkflowSchedulerService / WorkflowRegistry.
- `archive` — retained for reference, not scanned.

Promotion is an UPDATE on `status`. Runs a validation pass first (all `functionRef`s resolve to a real function on disk, no unbound vault accounts, no dangling edges).

---

## 7. What happens to the YAML files?

YAML becomes an **export format**, not storage:

- `sulla routine export <id>` — serializes a row's `definition` + metadata to a `.yaml` file (matching [routine.schema.json](./routine.schema.json)). Useful for git, sharing, backup.
- `sulla routine import <file>` — parses a YAML, validates, INSERTs a new row. Prompts user to resolve vault account placeholders to local accounts.
- Existing YAML files under `~/sulla/workflows/{draft,production,archive}/` are imported once via a migration helper, then the directories are left alone.

(During the rename transition, `sulla workflow export` and `sulla routine export` are aliases.)

---

## 8. Wiring into existing code

Minimum viable cutover keeps runtime stable while moving authoring to the DB:

| Component                          | Today                                       | After                                            |
|------------------------------------|---------------------------------------------|--------------------------------------------------|
| `sullaWorkflowEvents.ts` (IPC)     | Reads/writes YAML                           | Reads/writes DB via `WorkflowModel`              |
| `WorkflowRegistry.findCandidates`  | Scans `~/sulla/workflows/production/` dirs  | `SELECT * FROM workflows WHERE status='production'` |
| `HeartbeatNode`                    | Scans production dir                        | DB query                                          |
| `WorkflowSchedulerService`         | Scans production dir                        | DB query                                          |
| File watcher (`workflow-watch-start`) | `fs.watch` + debounced notify             | Postgres LISTEN/NOTIFY or app-level event bus     |
| `WorkflowCheckpointModel`          | Already DB-backed                           | Unchanged                                         |
| `WorkflowPendingCompletionModel`   | Already DB-backed                           | Unchanged                                         |

All these components get one change: swap filesystem reads for `WorkflowModel` queries. No logic changes, no contract changes.

---

## 9. Incremental cutover (what we do first, what we defer)

**Phase 1 — foundation** (this session):

1. Migration `0023_create_workflows_table.ts`.
2. Register in `migrations/index.ts`.
3. `WorkflowModel.ts` + `WorkflowHistoryModel.ts` (extend `BaseModel`, match existing conventions).
4. `workflow-save` IPC handler **dual-writes** to DB in addition to YAML. DB failures log-and-continue — YAML remains the safety net.
5. New IPC handlers `workflow-db-list` and `workflow-db-get` for reading from the DB (used for verification / the new canvas path).

**Phase 2 — cut over reads** (next session):

6. `workflow-list` / `workflow-get` / `workflow-delete` / `workflow-move` read/write DB as primary, YAML becomes secondary.
7. One-time import: walk `~/sulla/workflows/` and INSERT every parseable YAML into `workflows` (skip if id already exists).
8. `WorkflowRegistry`, `HeartbeatNode`, `WorkflowSchedulerService` switch to DB queries.

**Phase 3 — retire YAML storage** (deferred):

9. Stop writing YAML on save. Replace file watcher with `LISTEN/NOTIFY`.
10. `sulla routine export` becomes the only way to get a YAML file back out.

**Phase 4 — rename workflow→routine in code** (later):

11. Rename IPC handlers, models, types, UI labels, and optionally the `workflows` table → `routines`.

No forced cutover. Each phase leaves the system in a runnable state.

---

## 10. Open questions

- **`changed_by` attribution** — do we capture the current user/agent id when writing to `workflow_history`? Needs a session concept in IPC. Proposed: yes, best-effort, null if unavailable.
- **Export format versioning** — exported YAML carries `version: 1` today (matching `WorkflowDefinition.version`). Revisit if the document shape changes breakingly.
- **Cross-machine sync** — if you run Sulla Desktop on two machines, they currently both read from local Postgres independently. Multi-device sync is a bigger design (not solved here).
- **Concurrent edits** — if two canvas sessions edit the same routine, last-write-wins today. Do we need optimistic locking on `updated_at`? Probably yes; add a check in Phase 2.
