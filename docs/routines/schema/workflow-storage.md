# Workflow Storage — Postgres as the Source of Truth

Workflow definitions move from YAML files on disk to a single Postgres table. Routine libraries stay on disk (immutable). YAML becomes an export-only artifact for sharing and git. This document spells out the storage model, migration path, and how it wires into the existing codebase.

---

## 1. The split — three layers, three places

| Layer                         | What it contains                                                    | Where it lives                         | Mutability                   |
|-------------------------------|---------------------------------------------------------------------|----------------------------------------|------------------------------|
| **Routine library**           | Code, I/O schema, permission declarations                           | `~/sulla/routines/<name>/` (files)     | Immutable once published     |
| **Workflow definition**       | Graph: nodes (+ per-node config), edges, viewport, metadata         | Postgres `workflows.definition` JSONB  | Freely edited, audit-logged  |
| **Workflow execution state**  | A single run: checkpoints, pending completions, outputs per node    | Postgres `workflow_checkpoints`, `workflow_pending_completions` (existing) | Append-only                  |

"Instance" means a *running execution*, not a placement. Per-placement config lives inside the workflow's `definition` JSONB, under each node's `data.config`. No separate instances table.

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

The `definition` JSONB is the entire workflow document — same shape as today's YAML (nodes, edges, viewport, metadata), just stored as a JSON column. The GIN index makes queries like "which workflows use routine X?" fast:

```sql
SELECT id, name FROM workflows
WHERE definition @> '{"nodes":[{"data":{"routineRef":"fetch-stripe-invoice@1.2.3"}}]}';
```

---

## 3. Per-node config lives inside `definition.nodes[].data.config`

Two placements of the same routine = two entries in the `nodes` array, each with its own config:

```json
{
  "id": "workflow-billing-notify",
  "nodes": [
    {
      "id": "node-notify-eng",
      "type": "workflow",
      "position": { "x": 500, "y": 200 },
      "data": {
        "subtype": "routine",
        "routineRef": "send-slack-message@1.0.0",
        "config": {
          "inputs": { "channel": "#engineering", "text": "{{ trigger.summary }}" },
          "vaultAccounts": {
            "SLACK_TOKEN": { "accountId": "acct-slack-eng", "secretPath": "slack/token" }
          }
        }
      }
    },
    {
      "id": "node-notify-billing",
      "type": "workflow",
      "position": { "x": 500, "y": 400 },
      "data": {
        "subtype": "routine",
        "routineRef": "send-slack-message@1.0.0",
        "config": {
          "inputs": { "channel": "#billing", "text": "{{ trigger.summary }}" },
          "vaultAccounts": {
            "SLACK_TOKEN": { "accountId": "acct-slack-billing", "secretPath": "slack/token" }
          }
        }
      }
    }
  ]
}
```

Same routine file, different node configs, different vault accounts. Routine files untouched.

---

## 4. Vault account binding

Routine declares *what* secret it needs (`spec.permissions.env: [STRIPE_KEY]`). Node config binds *which* account supplies it:

```json
"vaultAccounts": {
  "STRIPE_KEY": { "accountId": "acct-stripe-live-01", "secretPath": "stripe/api_key" }
}
```

At invocation: engine reads the vault, injects the value as an env var into the runtime container, clears after the call. Plaintext never touches disk in the runtime. Two instances can use two different accounts without code changes.

---

## 5. Save semantics

Canvas edit → single Postgres UPDATE (or INSERT for new workflows). Debounced ~500ms from the UI.

Every UPDATE also writes a row to `workflow_history` with the before/after definition. Audit trail is free. Rollback is a single query against the history table.

No file watchers. Notifications go through Postgres `LISTEN/NOTIFY` (or an in-app event bus fired from the IPC handler) to tell the renderer when to refresh.

---

## 6. Lifecycle

The existing `draft` / `production` / `archive` lifecycle is preserved — it becomes a `status` column instead of a directory.

- `draft` — editable, not scanned by triggers.
- `production` — active, scanned by HeartbeatNode / WorkflowSchedulerService / WorkflowRegistry.
- `archive` — retained for reference, not scanned.

Promotion is an UPDATE on `status`. Runs a validation pass first (all `routineRef`s resolve, no unbound vault accounts, no dangling edges).

---

## 7. What happens to the YAML files?

YAML becomes an **export format**, not storage:

- `sulla workflow export <id>` — serializes a row's `definition` + metadata to a `.yaml` file. Useful for git, sharing, backup.
- `sulla workflow import <file>` — parses a YAML, validates, INSERTs a new row. Prompts user to resolve vault account placeholders to local accounts.
- Existing YAML files under `~/sulla/workflows/{draft,production,archive}/` are imported once via a migration helper, then the directories are left alone.

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
10. `sulla workflow export` becomes the only way to get a YAML file back out.

No forced cutover. Each phase leaves the system in a runnable state.

---

## 10. Open questions

- **`changed_by` attribution** — do we capture the current user/agent id when writing to `workflow_history`? Needs a session concept in IPC. Proposed: yes, best-effort, null if unavailable.
- **Export format versioning** — if we later change the workflow definition schema, exported YAML needs to carry a `schemaVersion` field for reproducible imports. Worth adding now, not later.
- **Cross-machine sync** — if you run Sulla Desktop on two machines, they currently both read from `~/sulla/workflows/` independently. With DB storage, do they share a DB? That's a bigger question (multi-device Sulla), not solved here.
- **Concurrent edits** — if two canvas sessions edit the same workflow, last-write-wins today. Do we need optimistic locking on `updated_at`? Probably yes; add a check in Phase 2.
