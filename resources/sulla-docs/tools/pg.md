# PostgreSQL

Sulla's primary data store. Container `sulla_postgres` on port **30116** (host) inside Lima. Workflow, calendar, chat, settings, credentials, observations, rules, and project items. **Critical safety section below — some tables will corrupt Sulla if you write to them directly.**

## Connection

| Field | Value |
|-------|-------|
| Host | `127.0.0.1` |
| Port | `30116` |
| Database | `sulla` |
| User | `sulla` |
| Password | from `sulla_settings.property = 'sullaServicePassword'` (default `sulla_dev_password` in dev) |

The agent doesn't authenticate manually — the `pg_*` tools handle the connection via a pool (max 20 connections, 30s idle timeout, 2s connect timeout). Defined at `pkg/rancher-desktop/agent/database/PostgresClient.ts:23-28`.

## Tools

| Tool | Returns | Purpose |
|------|---------|---------|
| `sulla pg/pg_query` | `T[]` | Execute a SELECT and return all rows |
| `sulla pg/pg_queryall` | `T[]` | Same as above; explicit "give me everything" form |
| `sulla pg/pg_queryone` | `T \| null` | First row only — for unique lookups |
| `sulla pg/pg_count` | `number` | Optimized for COUNT(*) — returns scalar, not array |
| `sulla pg/pg_execute` | `{command, rowCount, rows}` | INSERT/UPDATE/DELETE — returns affected count |
| `sulla pg/pg_transaction` | `[{command, rowCount}, ...]` | Multiple statements separated by `;`, atomic (all or rollback) |

**Parameter binding:**
```bash
sulla pg/pg_queryall '{
  "sql": "SELECT id, name FROM workflows WHERE status = $1 LIMIT $2",
  "params": ["production", "20"]
}'
```
Params are typed `string[]` in manifests but `pg.Pool` coerces to the column type at bind.

## Tables (verified live — plus project items from migration 0044)

| Table | Purpose | Safe to read? | Safe to write? |
|-------|---------|---------------|----------------|
| `workflows` | Routine/playbook definitions (JSONB nodes/edges) | ✅ | ⚠️ Use workflow tools, not raw SQL |
| `workflow_history` | Audit trail of definition changes | ✅ | ❌ Owned by app |
| `workflow_checkpoints` | Per-node execution snapshots | ✅ | ❌ Writing breaks resume / replay |
| `workflow_pending_completions` | Async completions waiting for processing | ✅ | ❌ Writing breaks the pending queue |
| `calendar_events` | Calendar entries (synced + native) | ✅ | ⚠️ Use calendar tools |
| `claude_conversations` | Chat conversation metadata | ✅ | ⚠️ Use conversation API |
| `claude_messages` | Chat messages | ✅ | ⚠️ Use conversation API |
| `conversation_history` | Thread / session metadata | ✅ | ⚠️ App-owned |
| `integration_values` | **Encrypted** credentials (vault-backed) | ⚠️ counts only, never SELECT value | ❌ **Never write — use vault tool** |
| `oauth_tokens` | **Encrypted** OAuth tokens | Same as above | ❌ **Never write — use vault tool** |
| `sulla_settings` | Global app settings (property/value/cast) | ✅ | ⚠️ via SullaSettingsModel preferred |
| `agent_awareness` | Singleton agent state (id=1, JSONB data) | ✅ | ⚠️ App-owned |
| `sync_queue` | Pending mutations for mobile sync | ✅ debug | ❌ Writing breaks mobile sync |
| `library_drafts` | Editable skill/function/recipe drafts | ✅ | ⚠️ via library API |
| `knowledgebase_sections` | KB section taxonomy | ✅ | ⚠️ via KB UI |
| `knowledgebase_categories` | KB category taxonomy | ✅ | ⚠️ via KB UI |
| `sulla_migrations` | Migration tracking (infrastructure) | ✅ debug | ❌ App-owned |
| `sulla_seeders` | Seed data tracking (infrastructure) | ✅ debug | ❌ App-owned |
| `work_projects` | Operator projects (outcome + metric; status default `working`) | ✅ | ⚠️ Use project tools, not raw SQL |
| `work_epics` | Epics under a project (status default `working`) | ✅ | ⚠️ Use project tools |
| `work_tasks` | Tasks / subtasks (`parent_id`; status default `todo`) | ✅ | ⚠️ Use project tools |
| `work_task_comments` | Notes on a task (GitHub-issue style) | ✅ | ⚠️ Use `add_task_comment` |

## Schemas of the tables you'll query most

### `workflows` (verified live — 10 columns)
```sql
id                    VARCHAR NOT NULL PRIMARY KEY
name                  VARCHAR NOT NULL
description           TEXT
version               VARCHAR                   -- semver or tag
status                VARCHAR NOT NULL          -- 'draft' | 'production' | 'archive'
definition            JSONB NOT NULL            -- {nodes:[...], edges:[...]}
enabled               BOOLEAN NOT NULL DEFAULT true
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
source_template_slug  VARCHAR                   -- if instantiated from a routine template
```
Indexes: `status`, `enabled`, `definition` (GIN).

### `workflow_checkpoints`
```sql
id              SERIAL PRIMARY KEY
execution_id    VARCHAR
workflow_id     VARCHAR
node_id         VARCHAR
sequence        INTEGER       -- order within execution
playbook_state  JSONB         -- full WorkflowPlaybookState at this point
node_output     JSONB
created_at      TIMESTAMPTZ
```

### `calendar_events`
```sql
id           SERIAL PRIMARY KEY
title        VARCHAR(500) NOT NULL
start_time   TIMESTAMPTZ NOT NULL
end_time     TIMESTAMPTZ NOT NULL
description  TEXT
location     VARCHAR(500)
people       JSONB DEFAULT '[]'
calendar_id  VARCHAR(100)
all_day      BOOLEAN DEFAULT false
status       VARCHAR(20)   -- 'active' | 'cancelled' | 'completed'
created_at, updated_at TIMESTAMPTZ
```

### `integration_values` (DO NOT WRITE — read with care)
```sql
value_id        SERIAL PRIMARY KEY
integration_id  VARCHAR(100)
account_id      VARCHAR(200) DEFAULT 'default'
property        VARCHAR(100)
value           TEXT          -- ENCRYPTED. Never SELECT value directly. Use vault tool.
is_default      BOOLEAN DEFAULT false
UNIQUE(integration_id, account_id, property)
```

### `sulla_settings`
```sql
property TEXT PRIMARY KEY
value    TEXT
cast     VARCHAR(20)  -- 'string' | 'number' | 'boolean' | 'json' | 'array'
```

## Common queries

### List active workflows
```bash
sulla pg/pg_queryall '{"sql":"SELECT id, name, status, updated_at FROM workflows WHERE status = $1 ORDER BY updated_at DESC LIMIT 20","params":["production"]}'
```

### Upcoming calendar events (next 30 days)
```bash
sulla pg/pg_queryall '{"sql":"SELECT id, title, start_time, end_time, calendar_id FROM calendar_events WHERE start_time >= NOW() AND start_time < NOW() + INTERVAL ''30 days'' ORDER BY start_time"}'
```

### Read a setting
```bash
sulla pg/pg_queryone '{"sql":"SELECT value, cast FROM sulla_settings WHERE property = $1","params":["heartbeatEnabled"]}'
```

### Count credentials per integration (safe — no plaintext)
```bash
sulla pg/pg_queryall '{"sql":"SELECT integration_id, COUNT(*) AS n FROM integration_values GROUP BY integration_id ORDER BY n DESC"}'
```

### Recent workflow runs for a workflow
```bash
sulla pg/pg_queryall '{"sql":"SELECT execution_id, MAX(sequence) AS last_seq, MAX(created_at) AS last_run FROM workflow_checkpoints WHERE workflow_id = $1 GROUP BY execution_id ORDER BY last_run DESC LIMIT 10","params":["my-workflow"]}'
```

### List all tables (general schema discovery)
```bash
sulla pg/pg_queryall '{"sql":"SELECT table_name FROM information_schema.tables WHERE table_schema = ''public'' ORDER BY table_name"}'
```

### Describe a table
```bash
sulla pg/pg_queryall '{"sql":"SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position","params":["calendar_events"]}'
```

## Hard rules — DO NOT WRITE TO

- **`integration_values`** — encrypted via vault. Direct writes bypass encryption and break decryption later. **Always use `sulla vault/*` tools.**
- **`oauth_tokens`** — same. Vault-managed. Refresh via the integration, never raw SQL.
- **`workflow_checkpoints`** — execution history. Writing here corrupts resume / restart-from-checkpoint logic.
- **`workflow_pending_completions`** — async queue for human approvals / LLM completions. Writing here makes workflows hang or skip steps.
- **`sync_queue`** — controls what gets synced to Sulla Mobile. Writing here puts the user's mobile app out of sync.

For everything in the "Safe to write?" column marked ⚠️, prefer the dedicated tool (workflow tools, calendar tools, vault tools, settings model). Raw SQL writes bypass invariants the app maintains (status transitions, reactive listeners, audit history).

## When you DO need raw writes

If you've genuinely thought it through and the dedicated tool can't do what you need, use `pg_execute` for a single statement or `pg_transaction` for atomic multi-statement work. Always:
1. Run the SELECT version first to preview what'll change
2. Confirm with the user for anything beyond a settings tweak
3. Wrap multi-step writes in `pg_transaction` so a partial failure rolls back

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/pg/`
- Manifest: `pkg/rancher-desktop/agent/tools/pg/manifests.ts`
- Pool config: `pkg/rancher-desktop/agent/database/PostgresClient.ts:23-28`
- Migrations: `pkg/rancher-desktop/agent/database/migrations/`
- Models (preferred over raw SQL): `pkg/rancher-desktop/agent/database/models/`

### `work_projects` / `work_epics` / `work_tasks` / `work_task_comments` (migration 0044)

Schema-only. Soft-archive, never hard-delete. No `bucket` column. `last_moved_at`
updates on status / priority / assignee / due-date / parent changes.

```
work_projects
  id TEXT PK · slug UNIQUE · title · description · outcome_metric
  status DEFAULT working · priority DEFAULT p2 · owner · github_repo · due_at
  source · source_path · source_ref · created_at · updated_at · last_moved_at · archived

work_epics
  id TEXT PK · project_id FK work_projects(id)
  slug · title · description · status DEFAULT working · priority DEFAULT p2
  position · due_at · source · source_ref · created_at · updated_at · last_moved_at · archived

work_tasks
  id TEXT PK · project_id FK work_projects(id)  -- required
  epic_id FK work_epics(id)                    -- optional
  parent_id FK work_tasks(id)                  -- NULL = task, set = subtask
  slug · title · description · status DEFAULT todo · priority DEFAULT p2
  due_at · github_issue · assignee · labels · position
  source · source_ref · created_at · updated_at · last_moved_at · completed_at · archived

work_task_comments
  id TEXT PK · task_id FK work_tasks(id) ON DELETE CASCADE
  author (default sulla; UI stamps human) · body · created_at · updated_at · archived
```

Closed statuses: `done` / `cancelled` / `parked`. Priority ranks p0–p4 plus
critical/high/medium/low. Not CRM. Do not write these with raw `pg_execute` —
use the `work/*` tools.

