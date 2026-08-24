import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as addWorkTaskActor } from '../../migrations/0047_add_work_task_actor';
import { up as addWorkTaskActivity } from '../../migrations/0061_add_work_task_activity';
import { up as createWorkTaskWaits } from '../../migrations/0065_create_work_task_waits';
import { up as settleWaitsOnReplan } from '../../migrations/0078_settle_work_task_waits_on_replan';
import { WorkTaskWaitModel } from '../WorkTaskWaitModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

/**
 * Real-PostgreSQL coverage for durable-wait lifecycle guarantees (#715):
 * atomic idempotent registration, concurrency races, restart-safe scheduling,
 * settlement when a blocked task is replanned/reactivated, and rollback safety.
 */
describeWithPostgres('WorkTaskWaitModel durable-wait lifecycle (migrated PostgreSQL)', () => {
  let bootstrapPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  const schema = `wait_lifecycle_${ randomUUID().replaceAll('-', '') }`;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryAll = postgresClient.queryAll;
  const originalTransaction = postgresClient.transaction;

  const activeWaits = async(taskId: string) =>
    (await pool.query(
      `SELECT * FROM work_task_waits WHERE task_id = $1 AND status = 'active'`, [taskId],
    )).rows;

  const seedBlockedTaskWithWait = async(taskId: string, targetKey: string, pullNumber = 1) => {
    await pool.query(
      `INSERT INTO work_tasks (id, project_id, epic_id, title, status)
       VALUES ($1, 'p1', 'e1', $2, 'blocked')`,
      [taskId, `Task ${ taskId }`],
    );
    return WorkTaskWaitModel.register({
      taskId,
      waitKind:  'github_checks',
      targetKey,
      target:    { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber },
    });
  };

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${ schema }` });

    for (const migration of [
      createWorkItems,
      addWorkTaskActor,
      addWorkTaskActivity,
      createWorkTaskWaits,
      settleWaitsOnReplan,
    ]) await pool.query(migration);

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
  });

  afterAll(async() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryAll = originalQueryAll;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    if (schemaCreated) await bootstrapPool.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  beforeEach(async() => {
    await pool.query(
      'TRUNCATE work_task_waits, work_task_comments, work_tasks, work_epics, work_projects RESTART IDENTITY CASCADE',
    );
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'P1')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'Epic 1')`);
  });

  it('registers exactly one active wait and treats a repeat as idempotent', async() => {
    const first = await seedBlockedTaskWithWait('task-idem', 'merchantprotocol/sulla-desktop#1');
    const second = await WorkTaskWaitModel.register({
      taskId:    'task-idem',
      waitKind:  'github_checks',
      targetKey: 'merchantprotocol/sulla-desktop#1',
      target:    { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 1 },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.wait.id).toBe(first.wait.id);
    expect(await activeWaits('task-idem')).toHaveLength(1);
  });

  it('serializes concurrent registrations into a single active wait', async() => {
    await pool.query(
      `INSERT INTO work_tasks (id, project_id, epic_id, title, status)
       VALUES ('task-race', 'p1', 'e1', 'Race', 'blocked')`,
    );
    const input = {
      taskId:    'task-race',
      waitKind:  'github_checks' as const,
      targetKey: 'merchantprotocol/sulla-desktop#2',
      target:    { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 2 },
    };
    const results = await Promise.all([
      WorkTaskWaitModel.register(input),
      WorkTaskWaitModel.register(input),
      WorkTaskWaitModel.register(input),
    ]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(await activeWaits('task-race')).toHaveLength(1);
  });

  it('resumes scheduled monitoring by claiming due persisted waits', async() => {
    await seedBlockedTaskWithWait('task-resume', 'merchantprotocol/sulla-desktop#3', 3);
    const claimed = await WorkTaskWaitModel.claimDue(10);
    expect(claimed.map(wait => wait.task_id)).toContain('task-resume');
  });

  it('settles the active wait when a blocked task is replanned or reactivated', async() => {
    for (const nextStatus of ['planning', 'todo', 'in_progress']) {
      const taskId = `task-replan-${ nextStatus }`;
      await seedBlockedTaskWithWait(taskId, `merchantprotocol/sulla-desktop#${ taskId }`);
      expect(await activeWaits(taskId)).toHaveLength(1);
      await pool.query(
        `UPDATE work_tasks SET status = $2, last_moved_by = 'planning-council' WHERE id = $1`,
        [taskId, nextStatus],
      );
      expect(await activeWaits(taskId)).toHaveLength(0);
    }
  });

  it('keeps existing terminal-state settlement intact', async() => {
    await seedBlockedTaskWithWait('task-done', 'merchantprotocol/sulla-desktop#4', 4);
    await pool.query(`UPDATE work_tasks SET status = 'done' WHERE id = 'task-done'`);
    expect(await activeWaits('task-done')).toHaveLength(0);
  });

  it('does not settle waits while the task stays blocked', async() => {
    await seedBlockedTaskWithWait('task-stay', 'merchantprotocol/sulla-desktop#5', 5);
    await pool.query(`UPDATE work_tasks SET status = 'blocked', description = 'still waiting' WHERE id = 'task-stay'`);
    expect(await activeWaits('task-stay')).toHaveLength(1);
  });

  it('rolls back settlement when the leaving transition is aborted', async() => {
    await seedBlockedTaskWithWait('task-rollback', 'merchantprotocol/sulla-desktop#6', 6);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE work_tasks SET status = 'todo' WHERE id = 'task-rollback'`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await activeWaits('task-rollback')).toHaveLength(1);
  });

  it('asserts the settle-on-replan trigger ships in the migration', () => {
    expect(settleWaitsOnReplan).toContain('settle_work_task_waits_on_replan');
    expect(settleWaitsOnReplan).toContain("NEW.status NOT IN ('blocked', 'done', 'cancelled', 'parked')");
    expect(settleWaitsOnReplan).toContain('trg_settle_work_task_waits_on_replan');
  });
});