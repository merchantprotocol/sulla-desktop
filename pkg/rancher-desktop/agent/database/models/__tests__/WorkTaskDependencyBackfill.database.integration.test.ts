/** @jest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as workItemsMigration } from '../../migrations/0044_create_work_items_tables';
import { up as schedulingMigration } from '../../migrations/0075_add_project_views_and_scheduling';
import { up as dependencyMigration } from '../../migrations/0083_create_work_task_dependencies';
import { applyTaskDependencyBackfill, planTaskDependencyBackfill } from '../WorkTaskDependencyBackfill';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({
  electron:            undefined,
  '@pkg/main/ipcMain': { getIpcMainProxy: () => ({ handle: jest.fn() }) },
});

const databaseUrl = process.env.SULLA_INTEGRATION_POSTGRES_URL
  || process.env.SULLA_ASSOCIATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('WorkTaskDependencyBackfill on a migrated PostgreSQL database', () => {
  let pool: Pool;

  function routeModelToTestDatabase() {
    jest.spyOn(postgresClient, 'query').mockImplementation(async(text: string, params: any[] = []) => {
      const result = await pool.query(text, params);
      return result.rows as any;
    });
    jest.spyOn(postgresClient, 'transaction').mockImplementation(async(callback: any) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  beforeAll(async() => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await pool.query(workItemsMigration);
    await schedulingMigration(pool as any);
    await dependencyMigration(pool as any);
    routeModelToTestDatabase();
  });

  afterAll(async() => {
    jest.restoreAllMocks();
    await pool.end();
  });

  beforeEach(async() => {
    await pool.query('TRUNCATE work_task_dependencies, work_task_comments, work_tasks, work_epics, work_projects RESTART IDENTITY CASCADE');
    await pool.query("INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'P1')");
    await pool.query("INSERT INTO work_epics (id, project_id, slug, title) VALUES ('e1', 'p1', 'e1', 'E1')");
    await pool.query("INSERT INTO work_tasks (id, project_id, epic_id, title, status) VALUES ('t1', 'p1', 'e1', 't1', 'todo'), ('t3', 'p1', 'e1', 't3', 'todo')");
    await pool.query("INSERT INTO work_tasks (id, project_id, epic_id, parent_id, title, status) VALUES ('t2', 'p1', 'e1', 't1', 't2', 'todo')");
    await pool.query("INSERT INTO work_task_comments (id, task_id, body, author) VALUES ('c1', 't1', 'HOLD: blocked until t3 lands', 'a')");
    await pool.query("INSERT INTO work_task_comments (id, task_id, body, author) VALUES ('c2', 't2', 'HOLD external vendor signoff', 'a')");
  });

  it('dry run proposes recognizable links, reports unresolved HOLDs, and writes nothing', async() => {
    const audit = await planTaskDependencyBackfill();
    expect(audit.dryRun).toBe(true);
    expect(audit.proposals).toHaveLength(2);
    expect(audit.proposals.some(p => p.source === 'parent_child' && p.dependentTaskId === 't1' && p.dependsOnTaskId === 't2')).toBe(true);
    expect(audit.proposals.some(p => p.source === 'hold_comment' && p.dependentTaskId === 't1' && p.dependsOnTaskId === 't3')).toBe(true);
    expect(audit.unresolvedHolds).toHaveLength(1);
    expect(audit.unresolvedHolds[0].taskId).toBe('t2');
    const rows = await pool.query('SELECT count(*)::int AS n FROM work_task_dependencies');
    expect(rows.rows[0].n).toBe(0);
  });

  it('apply creates the proposed links and is idempotent', async() => {
    const applied = await applyTaskDependencyBackfill({ actor: 'test' });
    expect(applied.dryRun).toBe(false);
    expect(applied.created).toHaveLength(2);
    let n = (await pool.query('SELECT count(*)::int AS n FROM work_task_dependencies WHERE archived_at IS NULL')).rows[0].n;
    expect(n).toBe(2);
    await applyTaskDependencyBackfill({ actor: 'test' });
    n = (await pool.query('SELECT count(*)::int AS n FROM work_task_dependencies WHERE archived_at IS NULL')).rows[0].n;
    expect(n).toBe(2);
  });
});
