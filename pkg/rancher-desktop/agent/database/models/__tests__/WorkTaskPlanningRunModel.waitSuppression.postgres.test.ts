import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { migrationsRegistry } from '../../migrations';
import { postgresClient } from '../../PostgresClient';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';
import { WorkTaskWaitModel } from '../WorkTaskWaitModel';

// Real migrated-Postgres coverage for the blocked -> planning claim boundary.
// Set SULLA_INTEGRATION_POSTGRES_URL to a reachable Postgres to exercise it;
// the suite provisions an isolated throwaway schema and drops it afterwards, so
// it never touches application data.
const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

// Only the work-item / wait / planning-run / dependency migrations are needed
// here; run them in registry order so numbering stays authoritative.
const NEEDED = new Set([
  '0044_create_work_items_tables',
  '0047_add_work_task_actor',
  '0061_add_work_task_activity',
  '0065_create_work_task_waits',
  '0072_create_work_task_planning_runs',
  '0083_create_work_task_dependencies',
]);

describeWithPostgres('WorkTaskPlanningRunModel blocked->planning wait suppression (postgres)', () => {
  let bootstrapPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  let original: Record<string, unknown> | null = null;
  const schema = `plan_wait_${ randomUUID().replaceAll('-', '') }`;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });
    for (const migration of migrationsRegistry) {
      if (NEEDED.has(migration.name)) await pool.query(migration.up);
    }

    original = {
      query:       (postgresClient as any).query,
      queryOne:    (postgresClient as any).queryOne,
      queryAll:    (postgresClient as any).queryAll,
      transaction: (postgresClient as any).transaction,
    };
    (postgresClient as any).query = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows[0] ?? null;
    (postgresClient as any).queryAll = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
    (postgresClient as any).transaction = async(callback: (client: any) => Promise<unknown>) => {
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
    };

    // Force the catalog-not-ready compatibility path so the claim boundary does
    // not depend on lane-catalog seeding; the durable-wait gate is the subject.
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'compatibility',
    } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
  });

  afterAll(async() => {
    if (original) Object.assign(postgresClient as any, original);
    jest.restoreAllMocks();
    if (pool) await pool.end();
    if (bootstrapPool) {
      if (schemaCreated) await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
      await bootstrapPool.end();
    }
  });

  afterEach(async() => {
    await pool.query('DELETE FROM work_task_planning_runs');
    await pool.query('DELETE FROM work_task_waits');
    await pool.query('DELETE FROM work_tasks');
    await pool.query('DELETE FROM work_epics');
    await pool.query('DELETE FROM work_projects');
  });

  async function seedBlockedTask(): Promise<string> {
    const projectId = `project-${ randomUUID() }`;
    const epicId = `epic-${ randomUUID() }`;
    const taskId = `task-${ randomUUID() }`;
    await pool.query(
      `INSERT INTO work_projects (id, slug, title) VALUES ($1, $2, 'Wait suppression')`,
      [projectId, `wait-${ randomUUID().slice(0, 8) }`],
    );
    await pool.query(
      `INSERT INTO work_epics (id, project_id, title) VALUES ($1, $2, 'Durable waits')`,
      [epicId, projectId],
    );
    await pool.query(
      `INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
       VALUES ($1, $2, $3, 'Gated task', 'blocked', 'heartbeat')`,
      [taskId, projectId, epicId],
    );
    return taskId;
  }

  function registerActiveWait(taskId: string) {
    return WorkTaskWaitModel.register({
      taskId, waitKind: 'external_job', targetKey: 'gate:test-merge',
      target: { pr: 1 }, fingerprint: 'fp-1',
    } as any);
  }

  async function countRuns(taskId: string): Promise<number> {
    const result = await pool.query('SELECT id FROM work_task_planning_runs WHERE task_id = $1', [taskId]);
    return result.rows.length;
  }

  it('does not claim planning for a blocked task while a durable wait is active', async() => {
    const taskId = await seedBlockedTask();
    await registerActiveWait(taskId);

    const claim = await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat');

    expect(claim).toBeNull();
    expect(await countRuns(taskId)).toBe(0);
  });

  it('does not re-enter planning on an unchanged repeat while the wait stays active', async() => {
    const taskId = await seedBlockedTask();
    await registerActiveWait(taskId);

    await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat');
    const second = await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat');

    expect(second).toBeNull();
    expect(await countRuns(taskId)).toBe(0);
  });

  it('permits the planning claim once the wait is cancelled', async() => {
    const taskId = await seedBlockedTask();
    const { wait } = await registerActiveWait(taskId);

    expect(await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat')).toBeNull();

    await WorkTaskWaitModel.cancel(wait.id, 'test: gate resolved');

    const claim = await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat');
    expect(claim).not.toBeNull();
    expect(claim?.run.status).toBe('active');
    expect(await countRuns(taskId)).toBe(1);
  });

  it('routes a satisfied wait to the next transition (in_review) rather than planning', async() => {
    const taskId = await seedBlockedTask();
    const { wait } = await registerActiveWait(taskId);

    await WorkTaskWaitModel.observe(wait.id, {
      fingerprint: 'fp-2', outcome: 'satisfied', summary: 'external job merged',
      nextCheckAt: new Date(Date.now() + 60_000),
    } as any);

    const taskRow = await pool.query('SELECT status FROM work_tasks WHERE id = $1', [taskId]);
    expect(taskRow.rows[0].status).toBe('in_review');

    expect(await WorkTaskPlanningRunModel.claim(taskId, 'blocked', 'heartbeat')).toBeNull();
    expect(await countRuns(taskId)).toBe(0);
  });
});
