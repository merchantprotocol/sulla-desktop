-- SPDX-License-Identifier: GPL-2.0-or-later
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','production','archive')),
  definition JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_executions (
  execution_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT,
  workflow_slug TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','suspended','completed','failed')),
  auto_restart BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_input TEXT,
  scope_task_id TEXT,
  scope_generation INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_history (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  definition_before JSONB,
  definition_after JSONB NOT NULL,
  changed_by TEXT,
  change_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS function_definitions (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manifest JSONB NOT NULL,
  runtime TEXT NOT NULL,
  files JSONB NOT NULL DEFAULT '{}'::jsonb,
  version TEXT
);

CREATE TABLE IF NOT EXISTS function_runs (
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

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled);
CREATE INDEX IF NOT EXISTS idx_workflows_definition ON workflows USING GIN(definition);
CREATE INDEX IF NOT EXISTS idx_workflow_history_workflow ON workflow_history(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_created ON workflow_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_wf_executions_started ON workflow_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_execution ON workflow_checkpoints(execution_id);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_workflow ON workflow_checkpoints(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_exec_seq ON workflow_checkpoints(execution_id,sequence);
