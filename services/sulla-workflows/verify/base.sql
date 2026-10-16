CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  definition JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_executions (
  execution_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT,
  workflow_slug TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  auto_restart BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_input TEXT,
  scope_task_id TEXT,
  scope_generation INTEGER,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error TEXT,
  owner_id TEXT,
  lease_token TEXT,
  leased_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  terminal_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT,
  node_id TEXT NOT NULL,
  node_label TEXT,
  node_subtype TEXT,
  sequence INTEGER NOT NULL,
  playbook_state JSONB NOT NULL,
  node_output JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_history (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  definition_before JSONB,
  definition_after JSONB NOT NULL,
  changed_by TEXT,
  change_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE function_definitions (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manifest JSONB NOT NULL,
  runtime TEXT NOT NULL,
  files JSONB NOT NULL DEFAULT '{}'::jsonb,
  version TEXT
);

CREATE TABLE function_runs (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  version TEXT,
  runtime TEXT,
  inputs JSONB,
  outputs JSONB,
  success BOOLEAN,
  error_stage TEXT,
  error TEXT,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
