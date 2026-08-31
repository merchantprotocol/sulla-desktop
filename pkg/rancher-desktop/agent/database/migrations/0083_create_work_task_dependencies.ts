import type { PoolClient } from 'pg';

/**
 * Upgrade the dependency table introduced by migration 0075 into the richer
 * first-class claim-gate schema without discarding existing links.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE work_task_dependencies
      RENAME COLUMN task_id TO dependent_task_id;

    ALTER TABLE work_task_dependencies
      ADD COLUMN id TEXT,
      ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'requires',
      ADD COLUMN acceptance_condition TEXT,
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN archived_at TIMESTAMPTZ;

    UPDATE work_task_dependencies
       SET id = 'dep-' || md5(dependent_task_id || ':' || depends_on_task_id),
           archived_at = CASE WHEN archived THEN now() ELSE NULL END;

    ALTER TABLE work_task_dependencies ALTER COLUMN id SET NOT NULL;
    ALTER TABLE work_task_dependencies DROP CONSTRAINT work_task_dependencies_pkey;
    ALTER TABLE work_task_dependencies ADD PRIMARY KEY (id);
    ALTER TABLE work_task_dependencies DROP COLUMN archived;

    ALTER TABLE work_task_dependencies
      ADD CONSTRAINT work_task_dependencies_relation_type
      CHECK (relation_type IN ('blocks', 'requires', 'ordered-after'));

    DROP INDEX IF EXISTS idx_work_task_dependencies_reverse;
    CREATE UNIQUE INDEX idx_wtd_active_unique
      ON work_task_dependencies (dependent_task_id, depends_on_task_id, relation_type)
      WHERE archived_at IS NULL;
    CREATE INDEX idx_wtd_dependent_lookup
      ON work_task_dependencies (dependent_task_id, archived_at);
    CREATE INDEX idx_wtd_depends_on_lookup
      ON work_task_dependencies (depends_on_task_id, archived_at);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DELETE FROM work_task_dependencies newer
     USING work_task_dependencies older
     WHERE newer.id > older.id
       AND newer.dependent_task_id = older.dependent_task_id
       AND newer.depends_on_task_id = older.depends_on_task_id;

    DROP INDEX IF EXISTS idx_wtd_active_unique;
    DROP INDEX IF EXISTS idx_wtd_dependent_lookup;
    DROP INDEX IF EXISTS idx_wtd_depends_on_lookup;
    ALTER TABLE work_task_dependencies DROP CONSTRAINT IF EXISTS work_task_dependencies_relation_type;
    ALTER TABLE work_task_dependencies DROP CONSTRAINT work_task_dependencies_pkey;
    ALTER TABLE work_task_dependencies ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
    UPDATE work_task_dependencies SET archived = archived_at IS NOT NULL;
    ALTER TABLE work_task_dependencies DROP COLUMN id;
    ALTER TABLE work_task_dependencies DROP COLUMN relation_type;
    ALTER TABLE work_task_dependencies DROP COLUMN acceptance_condition;
    ALTER TABLE work_task_dependencies DROP COLUMN updated_at;
    ALTER TABLE work_task_dependencies DROP COLUMN archived_at;
    ALTER TABLE work_task_dependencies RENAME COLUMN dependent_task_id TO task_id;
    ALTER TABLE work_task_dependencies ADD PRIMARY KEY (task_id, depends_on_task_id);
    CREATE INDEX idx_work_task_dependencies_reverse
      ON work_task_dependencies(depends_on_task_id) WHERE archived = false;
  `);
}
