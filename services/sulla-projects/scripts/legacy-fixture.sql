-- Synthetic legacy Projects rows for migration acceptance only.
-- Keep these definitions aligned with the shipped Desktop migrations; this
-- fixture deliberately exercises every legacy table with sequence-backed IDs.

CREATE TABLE work_projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  outcome_metric TEXT,
  status TEXT NOT NULL DEFAULT 'working',
  priority TEXT NOT NULL DEFAULT 'p2',
  owner TEXT,
  due_at TIMESTAMPTZ,
  source TEXT,
  source_path TEXT,
  source_ref TEXT,
  github_repo TEXT,
  assigned_agent TEXT,
  dispatch_enabled BOOLEAN NOT NULL DEFAULT true,
  pipeline_template_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  last_moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES work_projects(id),
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'working',
  priority TEXT NOT NULL DEFAULT 'p2',
  position INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ,
  start_at TIMESTAMPTZ,
  milestone_at TIMESTAMPTZ,
  source TEXT,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  last_moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES work_projects(id),
  epic_id TEXT REFERENCES work_epics(id),
  parent_id TEXT REFERENCES work_tasks(id),
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'p2',
  assignee TEXT,
  due_at TIMESTAMPTZ,
  start_at TIMESTAMPTZ,
  milestone_at TIMESTAMPTZ,
  labels TEXT[] NOT NULL DEFAULT '{}',
  github_issue TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  source_ref TEXT,
  created_by TEXT,
  last_moved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  last_moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_project_domain_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES work_tasks(id),
  generation INTEGER NOT NULL,
  generation_hash TEXT,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  leased_until TIMESTAMPTZ,
  last_error TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE work_schedule_audit (
  id BIGSERIAL PRIMARY KEY,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TIMESTAMPTZ,
  new_value TIMESTAMPTZ,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_task_artifact_custody (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  transition TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  custody JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE github_pr_project_mirrors (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  task_id TEXT REFERENCES work_tasks(id),
  project_id TEXT NOT NULL REFERENCES work_projects(id),
  epic_id TEXT NOT NULL REFERENCES work_epics(id),
  parent_id TEXT REFERENCES work_tasks(id),
  snapshot_fingerprint TEXT,
  remote_updated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_generation INTEGER NOT NULL DEFAULT 0,
  remote_disposition TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

CREATE TABLE work_project_pipeline_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  system BOOLEAN NOT NULL DEFAULT false,
  locked BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

CREATE TABLE work_project_pipeline_template_stages (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES work_project_pipeline_templates(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  semantic_role TEXT,
  bundled_workflow_id TEXT,
  entry_policy JSONB NOT NULL DEFAULT '{}',
  wip_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  UNIQUE (template_id, stage_key),
  UNIQUE (template_id, position)
);

ALTER TABLE work_projects
  ADD CONSTRAINT work_projects_pipeline_template_fk
  FOREIGN KEY (pipeline_template_id) REFERENCES work_project_pipeline_templates(id);

CREATE TABLE work_task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES work_tasks(id),
  body TEXT NOT NULL,
  author TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_lane_definitions (
  id TEXT PRIMARY KEY,
  lane_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES work_projects(id),
  base_lane_key TEXT,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  semantic_role TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  archived BOOLEAN NOT NULL DEFAULT false,
  system_required BOOLEAN NOT NULL DEFAULT false,
  requires_human_approval BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  reset_at TIMESTAMPTZ
);

CREATE TABLE work_project_views (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES work_projects(id),
  name TEXT NOT NULL DEFAULT 'Default',
  view_type TEXT NOT NULL,
  configuration JSONB NOT NULL DEFAULT '{}',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_task_dependencies (
  dependent_task_id TEXT NOT NULL REFERENCES work_tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES work_tasks(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT 'sulla',
  id TEXT PRIMARY KEY,
  relation_type TEXT NOT NULL DEFAULT 'requires',
  acceptance_condition TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE knowledge_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL DEFAULT 'entity',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT,
  link_count INTEGER NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false,
  merged_into TEXT REFERENCES knowledge_nodes(id),
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary)) STORED
);

CREATE TABLE work_item_knowledge_links (
  id TEXT PRIMARY KEY,
  knowledge_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  project_id TEXT REFERENCES work_projects(id),
  epic_id TEXT REFERENCES work_epics(id),
  task_id TEXT REFERENCES work_tasks(id),
  relation_type TEXT NOT NULL DEFAULT 'related_to',
  note TEXT,
  source TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE work_artifact_receipts (
  id TEXT PRIMARY KEY,
  receipt_version INTEGER NOT NULL DEFAULT 1,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT,
  workflow_execution_id TEXT,
  dispatch_id TEXT,
  disposition TEXT,
  next_owner TEXT,
  validation_summary TEXT,
  artifacts JSONB NOT NULL DEFAULT '[]',
  content_hashes TEXT[] NOT NULL DEFAULT '{}',
  evidence_kind TEXT,
  evidence_ref TEXT,
  evidence_url TEXT,
  fingerprint TEXT NOT NULL,
  comment_id TEXT REFERENCES work_task_comments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation INTEGER
);

INSERT INTO work_projects (id, slug, title, source)
VALUES ('legacy-project', 'legacy', 'Legacy', 'synthetic-legacy');

INSERT INTO work_project_pipeline_templates (
  id, template_key, name, description, version, system, locked, enabled, created_by
) VALUES (
  'legacy-template', 'legacy-template-key', 'Legacy template', 'Synthetic template',
  4, false, false, true, 'synthetic-fixture'
);

INSERT INTO work_project_pipeline_template_stages (
  id, template_id, stage_key, display_name, description, position,
  semantic_role, bundled_workflow_id, entry_policy, wip_limit
) VALUES (
  'legacy-stage', 'legacy-template', 'legacy-stage', 'Legacy stage', 'Synthetic stage',
  17, 'execution', 'synthetic-workflow', '{"synthetic":true}'::jsonb, 3
);

UPDATE work_projects SET pipeline_template_id='legacy-template' WHERE id='legacy-project';

INSERT INTO work_epics (id, project_id, slug, title)
VALUES ('legacy-epic', 'legacy-project', 'legacy-epic', 'Legacy epic');

INSERT INTO work_tasks (id, project_id, epic_id, slug, title, source)
VALUES ('legacy-task', 'legacy-project', 'legacy-epic', 'legacy-task', 'Legacy task', 'synthetic-legacy');

INSERT INTO work_tasks (id, project_id, epic_id, parent_id, slug, title, source)
VALUES ('legacy-subtask', 'legacy-project', 'legacy-epic', 'legacy-task', 'legacy-subtask', 'Legacy subtask', 'synthetic-legacy');

INSERT INTO work_task_comments (id, task_id, body, author)
VALUES ('legacy-comment', 'legacy-task', 'Synthetic legacy comment', 'synthetic-fixture');

INSERT INTO work_lane_definitions (
  id, lane_key, scope, project_id, base_lane_key, display_name, description,
  color, icon, position, semantic_role, requires_human_approval, created_by
) VALUES (
  'legacy-lane', 'legacy-lane', 'project', 'legacy-project', 'todo', 'Legacy lane',
  'Synthetic lane', 'blue', 'circle', 22, 'execution', true, 'synthetic-fixture'
);

INSERT INTO work_project_views (
  id, project_id, name, view_type, configuration, is_default, created_by
) VALUES (
  'legacy-view', 'legacy-project', 'Legacy view', 'board', '{"synthetic":true}'::jsonb,
  true, 'synthetic-fixture'
);

INSERT INTO work_task_dependencies (
  id, dependent_task_id, depends_on_task_id, relation_type, acceptance_condition, created_by
) VALUES (
  'legacy-dependency', 'legacy-subtask', 'legacy-task', 'requires',
  'Synthetic dependency satisfied', 'synthetic-fixture'
);

INSERT INTO knowledge_nodes (
  id, node_type, title, summary, detail, link_count, recall_count, source
) VALUES (
  'legacy-knowledge-parent', 'entity', 'Legacy parent', 'Synthetic parent', 'Parent detail', 1, 2, 'synthetic-fixture'
);

INSERT INTO knowledge_nodes (
  id, node_type, title, summary, detail, merged_into, source
) VALUES (
  'legacy-knowledge-child', 'entity', 'Legacy child', 'Synthetic child', 'Child detail',
  'legacy-knowledge-parent', 'synthetic-fixture'
);

INSERT INTO work_item_knowledge_links (
  id, knowledge_node_id, task_id, relation_type, note, source, created_by
) VALUES (
  'legacy-knowledge-link', 'legacy-knowledge-parent', 'legacy-task', 'related_to',
  'Synthetic relation', 'synthetic-fixture', 'synthetic-fixture'
);

INSERT INTO work_artifact_receipts (
  id, receipt_version, task_id, event_type, actor, disposition, next_owner,
  validation_summary, artifacts, content_hashes, evidence_kind, evidence_ref,
  evidence_url, fingerprint, comment_id, generation
) VALUES (
  'legacy-receipt', 2, 'legacy-task', 'task.completed', 'synthetic-fixture',
  'accepted', 'human', 'Synthetic validation', '[{"kind":"synthetic"}]'::jsonb,
  ARRAY['synthetic-hash'], 'fixture', 'legacy-evidence', 'https://example.invalid/evidence',
  'legacy-receipt-fingerprint', 'legacy-comment', 3
);

INSERT INTO work_project_domain_events (
  id, task_id, generation, generation_hash, event_type, idempotency_key,
  payload, status, occurred_at
) VALUES (
  'legacy-event', 'legacy-task', 3, 'legacy-generation', 'task.updated',
  'legacy-event-key', '{"synthetic":true}'::jsonb, 'completed', now()
);

INSERT INTO work_schedule_audit (
  id, item_kind, item_id, field_name, old_value, new_value, actor
) VALUES (
  41, 'task', 'legacy-task', 'due_at', NULL, '2026-10-19T12:00:00Z', 'synthetic-fixture'
);

INSERT INTO work_task_artifact_custody (
  id, task_id, transition, work_kind, custody, created_by
) VALUES (
  'legacy-custody', 'legacy-task', 'done', 'code',
  '{"kind":"synthetic","verified":true}'::jsonb, 'synthetic-fixture'
);

INSERT INTO github_pr_project_mirrors (
  id, owner, repository, pull_number, task_id, project_id, epic_id,
  snapshot_fingerprint, remote_disposition
) VALUES (
  51, 'synthetic-owner', 'synthetic-repository', 7, 'legacy-task',
  'legacy-project', 'legacy-epic', 'legacy-snapshot', 'merged'
);
