/**
 * Migration 0063 — durable associations between Knowledge Base nodes and
 * exactly one Projects project, epic, or task.
 *
 * Associations are direct. Parent inheritance is computed by readers and is
 * never copied onto descendants. Rows are soft-archived so attribution and
 * unlink history survive. This migration intentionally depends on migration
 * 0029; it does not create a second knowledge-node store.
 */

export const up = `
  DO $$
  BEGIN
    IF to_regclass('knowledge_nodes') IS NULL THEN
      RAISE EXCEPTION 'migration 0063 requires knowledge_nodes from migration 0029';
    END IF;
  END $$;

  CREATE TABLE IF NOT EXISTS work_item_knowledge_links (
    id                TEXT        PRIMARY KEY,
    knowledge_node_id TEXT        NOT NULL REFERENCES knowledge_nodes(id),
    project_id        TEXT        REFERENCES work_projects(id),
    epic_id           TEXT        REFERENCES work_epics(id),
    task_id           TEXT        REFERENCES work_tasks(id),
    relation_type     TEXT        NOT NULL DEFAULT 'related_to',
    note              TEXT,
    source            TEXT,
    created_by        TEXT,
    updated_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived          BOOLEAN     NOT NULL DEFAULT false,
    CONSTRAINT work_item_knowledge_one_target
      CHECK (num_nonnulls(project_id, epic_id, task_id) = 1)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_wikl_active_project_unique
    ON work_item_knowledge_links (knowledge_node_id, project_id, relation_type)
    WHERE project_id IS NOT NULL AND archived = false;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wikl_active_epic_unique
    ON work_item_knowledge_links (knowledge_node_id, epic_id, relation_type)
    WHERE epic_id IS NOT NULL AND archived = false;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wikl_active_task_unique
    ON work_item_knowledge_links (knowledge_node_id, task_id, relation_type)
    WHERE task_id IS NOT NULL AND archived = false;

  CREATE INDEX IF NOT EXISTS idx_wikl_project_lookup
    ON work_item_knowledge_links (project_id, archived, relation_type)
    WHERE project_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wikl_epic_lookup
    ON work_item_knowledge_links (epic_id, archived, relation_type)
    WHERE epic_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wikl_task_lookup
    ON work_item_knowledge_links (task_id, archived, relation_type)
    WHERE task_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wikl_node_lookup
    ON work_item_knowledge_links (knowledge_node_id, archived, relation_type);
`;

export const down = `
  DROP TABLE IF EXISTS work_item_knowledge_links CASCADE;
`;
