/** @jest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as workItemsMigration } from '../../migrations/0044_create_work_items_tables';
import { up as schedulingMigration } from '../../migrations/0075_add_project_views_and_scheduling';
import { down as dependencyMigrationDown, up as dependencyMigration } from '../../migrations/0083_create_work_task_dependencies';
import { WorkTaskDependencyModel } from '../WorkTaskDependencyModel';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({
  electron:            undefined,
  '@pkg/main/ipcMain': { getIpcMainProxy: () => ({ handle: jest.fn() }) },
});

const databaseUrl = process.env.SULLA_INTEGRATION_POSTGRES_URL
  || process.env.SULLA_ASSOCIATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('WorkTaskDependencyModel on a migrated PostgreSQL database', () => {
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

  async function seedTasks() {
    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'Project One') ON CONFLICT (id) DO NOTHING;
      INSERT INTO work_epics (id, project_id, slug, title) VALUES ('e1', 'p1', 'e1', 'Epic One') ON CONFLICT (id) DO NOTHING;
    `);
    const rows: Array<[string, string]> = [['t1', 'todo'], ['t2', 'todo'], ['t3', 'todo'], ['t4', 'done'], ['t5', 'cancelled']];
    for (const [id, status] of rows) {
      await pool.query(
        `INSERT INTO work_tasks (id, project_id, epic_id, title, status) VALUES ($1, 'p1', 'e1', $1, $2)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [id, status]);
    }
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
    await pool.query('TRUNCATE work_task_dependencies, work_tasks, work_epics, work_projects RESTART IDENTITY CASCADE');
    await seedTasks();
  });

  it('migration upgrades the 0075 table and down restores its legacy shape', async() => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_task_dependencies'`);
    expect(cols.rows.map(r => r.column_name)).toEqual(expect.arrayContaining([
      'id', 'dependent_task_id', 'depends_on_task_id', 'relation_type',
      'acceptance_condition', 'created_by', 'created_at', 'updated_at', 'archived_at',
    ]));
    await dependencyMigrationDown(pool as any);
    const legacy = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_task_dependencies'`);
    expect(legacy.rows.map(r => r.column_name)).toEqual(expect.arrayContaining([
      'task_id', 'depends_on_task_id', 'archived',
    ]));
    await dependencyMigration(pool as any); // restore for later tests
  });

  it('creates a dependency with each relation type', async() => {
    for (const rel of ['blocks', 'requires', 'ordered-after'] as const) {
      const dep = await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2', relationType: rel });
      expect(dep.relation_type).toBe(rel);
      await WorkTaskDependencyModel.remove({ id: dep.id });
    }
  });

  it('rejects an unknown relation type', async() => {
    await expect(WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2', relationType: 'bogus' }))
      .rejects.toThrow(/Invalid relation_type/i);
  });

  it('rejects a self-link', async() => {
    await expect(WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't1' }))
      .rejects.toThrow(/cannot depend on itself/i);
  });

  it('rejects a direct cycle', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await expect(WorkTaskDependencyModel.create({ dependentTaskId: 't2', dependsOnTaskId: 't1' }))
      .rejects.toThrow(/cycle/i);
  });

  it('rejects a transitive cycle', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await WorkTaskDependencyModel.create({ dependentTaskId: 't2', dependsOnTaskId: 't3' });
    await expect(WorkTaskDependencyModel.create({ dependentTaskId: 't3', dependsOnTaskId: 't1' }))
      .rejects.toThrow(/cycle/i);
  });

  it('soft-archives on remove and reactivates the same row on re-create', async() => {
    const dep = await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    expect(await WorkTaskDependencyModel.remove({ id: dep.id })).toBe(true);
    expect(await WorkTaskDependencyModel.listDependencies('t1')).toHaveLength(0);
    const archived = await WorkTaskDependencyModel.listDependencies('t1', { includeArchived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].archived_at).not.toBeNull();
    const again = await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    expect(again.id).toBe(dep.id);
    expect(again.archived_at).toBeNull();
  });

  it('keeps at most one active row per (dependent, depends_on, relation)', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    const n = await pool.query(
      `SELECT count(*)::int AS n FROM work_task_dependencies
        WHERE dependent_task_id = 't1' AND depends_on_task_id = 't2' AND relation_type = 'requires' AND archived_at IS NULL`);
    expect(n.rows[0].n).toBe(1);
  });

  it('lists unresolved deps: done resolves, cancelled stays blocking (failed_terminal)', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't4' });
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't5' });
    const unresolved = await WorkTaskDependencyModel.listUnresolvedDependencies('t1');
    expect(unresolved.map(u => u.dependsOnTaskId).sort()).toEqual(['t2', 't5']);
    expect(unresolved.find(u => u.dependsOnTaskId === 't5')?.policy).toBe('failed_terminal');
  });

  it('assertClaimable fails closed when unresolved and passes once resolved', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await postgresClient.transaction(async(client: any) => {
      await expect(WorkTaskDependencyModel.assertClaimable('t1', client)).rejects.toMatchObject({ code: 'TASK_DEPENDENCY_UNRESOLVED' });
    });
    await pool.query(`UPDATE work_tasks SET status = 'done' WHERE id = 't2'`);
    await postgresClient.transaction(async(client: any) => {
      await expect(WorkTaskDependencyModel.assertClaimable('t1', client)).resolves.toBeUndefined();
    });
  });

  it('no scan->claim gap: a resolution committed before the claim check is observed', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await pool.query(`UPDATE work_tasks SET status = 'done' WHERE id = 't2'`);
    await postgresClient.transaction(async(client: any) => {
      await expect(WorkTaskDependencyModel.assertClaimable('t1', client)).resolves.toBeUndefined();
    });
  });

  it('claimExclusionSql excludes dependency-blocked tasks and keeps free/resolved ones', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' }); // t1 blocked (t2 todo)
    await WorkTaskDependencyModel.create({ dependentTaskId: 't3', dependsOnTaskId: 't4' }); // t3 free (t4 done)
    const sql = `SELECT t.id FROM work_tasks t WHERE t.status = 'todo' ${ WorkTaskDependencyModel.claimExclusionSql('t.id') } ORDER BY t.id`;
    const ids = (await pool.query(sql)).rows.map(r => r.id);
    expect(ids).toContain('t3');
    expect(ids).not.toContain('t1');
  });

  it('explainClaimability returns the transitive chain and blocking reason', async() => {
    await WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' });
    await WorkTaskDependencyModel.create({ dependentTaskId: 't2', dependsOnTaskId: 't3' });
    const ex = await WorkTaskDependencyModel.explainClaimability('t1');
    expect(ex.claimable).toBe(false);
    expect(ex.chain.map(c => c.taskId).sort()).toEqual(['t2', 't3']);
    expect(ex.reason).toMatch(/not claimable/i);
  });

  it('concurrent opposing edges: exactly one succeeds, the other is rejected as a cycle', async() => {
    const results = await Promise.allSettled([
      WorkTaskDependencyModel.create({ dependentTaskId: 't1', dependsOnTaskId: 't2' }),
      WorkTaskDependencyModel.create({ dependentTaskId: 't2', dependsOnTaskId: 't1' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason?.message)).toMatch(/cycle/i);
    const active = await pool.query(`SELECT count(*)::int AS n FROM work_task_dependencies WHERE archived_at IS NULL`);
    expect(active.rows[0].n).toBe(1);
  });
});
