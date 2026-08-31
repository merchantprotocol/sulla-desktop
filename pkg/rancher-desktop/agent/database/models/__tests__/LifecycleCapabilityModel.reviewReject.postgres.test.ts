import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../migrations/0026_create_workflow_executions_table';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as addWorkTaskActor } from '../../migrations/0047_add_work_task_actor';
import { up as addWorkTaskActivity } from '../../migrations/0061_add_work_task_activity';
import { up as createWorkTaskDispatches } from '../../migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../migrations/0064_add_verification_dispatches';
import { up as createLifecycleCapabilities } from '../../migrations/0068_create_lifecycle_capabilities';
import { up as addProjectViewsAndScheduling } from '../../migrations/0075_add_project_views_and_scheduling';
import { up as createArtifactReceipts } from '../../migrations/0082_create_artifact_receipts';
import { up as createWorkTaskDependencies } from '../../migrations/0083_create_work_task_dependencies';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

/**
 * Real-PostgreSQL coverage for the #727 reject->repair handoff: the acting
 * in-review authority (protected-review owner or its named Heartbeat
 * fallback) can atomically settle a REJECTED verdict and route the task back
 * to todo-execution without needing to own todo-execution itself, while the
 * generic ownership guard still denies everyone else and duplicate
 * settlement of the same review generation stays a no-op.
 */
describeWithPostgres('LifecycleCapabilityModel.settleReviewReject reject->repair handoff (migrated PostgreSQL)', () => {
  let bootstrapPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  const schema = `review_reject_${ randomUUID().replaceAll('-', '') }`;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryAll = postgresClient.queryAll;
  const originalTransaction = postgresClient.transaction;

  const taskRow = async(taskId: string) =>
    (await pool.query(`SELECT * FROM work_tasks WHERE id = $1`, [taskId])).rows[0];

  const comments = async(taskId: string) =>
    (await pool.query(`SELECT * FROM work_task_comments WHERE task_id = $1 ORDER BY created_at ASC`, [taskId])).rows;

  const receipts = async(taskId: string) =>
    (await pool.query(`SELECT * FROM work_artifact_receipts WHERE task_id = $1`, [taskId])).rows;

  const setCapability = async(key: string, patch: {
    enabled: boolean; health: string; active_owner: string | null; fallback_mode: string;
  }) => {
    await pool.query(`
      UPDATE lifecycle_capabilities
         SET enabled = $2, health = $3, active_owner = $4, fallback_mode = $5, updated_at = now()
       WHERE capability_key = $1
    `, [key, patch.enabled, patch.health, patch.active_owner, patch.fallback_mode]);
  };

  const healthyOwnedByRoutine = () => setCapability('in-review-verification', {
    enabled: true, health: 'healthy', active_owner: 'verifier-routine', fallback_mode: 'manual_hold',
  });
  const defaultHeartbeatFallback = () => setCapability('in-review-verification', {
    enabled: false, health: 'unavailable', active_owner: null, fallback_mode: 'heartbeat',
  });
  const healthyExecutionOwnedByDispatcher = () => setCapability('todo-execution', {
    enabled: true, health: 'healthy', active_owner: 'dispatcher', fallback_mode: 'manual_hold',
  });

  const seedInReviewTask = async(taskId: string) => {
    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
      VALUES ($1, 'p1', 'e1', $2, 'in_review', 'verifier')
    `, [taskId, `Task ${ taskId }`]);
  };

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });

    for (const migration of [
      createWorkflows, createWorkflowExecutions, createWorkItems, addWorkTaskActor,
      addWorkTaskActivity, createWorkTaskDispatches, addVerificationDispatches,
      createLifecycleCapabilities, createArtifactReceipts,
    ]) await pool.query(migration as any);
    await addProjectViewsAndScheduling(pool as any);
    await createWorkTaskDependencies(pool as any);

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
    // work_tasks CASCADE also wipes lifecycle_capabilities (its recovery_task_id
    // column FKs to work_tasks), so the seed rows must be reinserted after.
    await pool.query(`
      TRUNCATE work_artifact_receipts, work_task_stage_claims, work_task_dispatches,
               work_task_dependencies, work_task_comments, work_tasks, work_epics, work_projects
      RESTART IDENTITY CASCADE
    `);
    await pool.query(`
      INSERT INTO lifecycle_capabilities
        (capability_key, version, enabled, health, fallback_mode, fallback_active)
      VALUES
        ('planning-council', 1, false, 'unavailable', 'heartbeat', true),
        ('todo-execution', 1, false, 'unavailable', 'heartbeat', true),
        ('in-review-verification', 1, false, 'unavailable', 'heartbeat', true),
        ('durable-waits', 1, false, 'unavailable', 'heartbeat', true),
        ('stale-recovery', 1, false, 'unavailable', 'heartbeat', true)
      ON CONFLICT (capability_key) DO UPDATE SET
        enabled = false, health = 'unavailable', active_owner = NULL,
        fallback_mode = 'heartbeat', fallback_active = true, updated_at = now()
    `);
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'P1')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'Epic 1')`);
  });

  it('hands a rejected review back to todo-execution for the healthy capability owner', async() => {
    await healthyOwnedByRoutine();
    await seedInReviewTask('task-owner');

    const result = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-owner', actor: 'verifier-routine', summary: 'Missing regression test for the new branch.',
    });

    expect(result.settled).toBe(true);
    expect(result.alreadySettled).toBe(false);
    expect(result.task?.status).toBe('todo');
    expect(result.task?.assignee).toBe('dispatcher');

    const row = await taskRow('task-owner');
    expect(row.status).toBe('todo');
    expect(row.assignee).toBe('dispatcher');
    expect(row.last_moved_by).toBe('verifier-routine');

    const rows = await comments('task-owner');
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('REJECTED');
    expect((await receipts('task-owner'))).toHaveLength(1);
  });

  it('hands a rejected review back to todo-execution for the named Heartbeat fallback', async() => {
    await defaultHeartbeatFallback();
    await seedInReviewTask('task-fallback');

    const result = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-fallback', actor: 'heartbeat', summary: 'Backlog drain: acceptance criteria not met.',
    });

    expect(result.settled).toBe(true);
    expect(result.task?.status).toBe('todo');
    expect(result.task?.assignee).toBe('dispatcher');
    expect((await comments('task-fallback'))).toHaveLength(1);
  });

  it('treats a duplicate settlement of the same review generation as a no-op', async() => {
    await healthyOwnedByRoutine();
    await seedInReviewTask('task-dup');

    const first = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-dup', actor: 'verifier-routine', summary: 'Findings not addressed.',
    });
    const second = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-dup', actor: 'verifier-routine', summary: 'Findings not addressed.',
    });

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
    expect(second.alreadySettled).toBe(true);

    const row = await taskRow('task-dup');
    expect(row.status).toBe('todo');
    expect(row.assignee).toBe('dispatcher');
    // No double-enqueue: still exactly one receipt/comment.
    expect((await comments('task-dup'))).toHaveLength(1);
    expect((await receipts('task-dup'))).toHaveLength(1);
  });

  it('denies a non-authority actor and leaves the task untouched', async() => {
    await healthyOwnedByRoutine();
    await seedInReviewTask('task-denied');

    await expect(LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-denied', actor: 'heartbeat', summary: 'Trying to reject without authority.',
    })).rejects.toThrow(/denied/i);

    const row = await taskRow('task-denied');
    expect(row.status).toBe('in_review');
    expect((await comments('task-denied'))).toHaveLength(0);
    expect((await receipts('task-denied'))).toHaveLength(0);
  });

  it('lets the dispatcher subsequently claim and re-execute the repaired generation', async() => {
    await healthyOwnedByRoutine();
    await healthyExecutionOwnedByDispatcher();
    await seedInReviewTask('task-repair');
    // Original generation's execution dispatch, already finished.
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, kind, attempt, status, finished_at)
      VALUES ('dispatch-gen1', 'task-repair', 'agent-1', 'thread-1', 'execution', 1, 'completed', now())
    `);

    const settled = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-repair', actor: 'verifier-routine', summary: 'Repair needed before merge.',
    });
    expect(settled.settled).toBe(true);

    const claim = await WorkTaskDispatchModel.claimNext('agent-1', 'runtime-1');
    expect(claim).not.toBeNull();
    expect(claim?.task.id).toBe('task-repair');
    expect(claim?.task.status).toBe('in_progress');
    expect(claim?.dispatch.kind).toBe('execution');
    // A fresh artifact generation: a new dispatch attempt, not a replay of the old one.
    expect(claim?.dispatch.attempt).toBe(2);
  });

  it('recovers without losing the reject when the settlement transaction is rolled back before commit', async() => {
    await healthyOwnedByRoutine();
    await seedInReviewTask('task-crash');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await LifecycleCapabilityModel.settleReviewRejectWithClient(client, {
        taskId: 'task-crash', actor: 'verifier-routine', summary: 'Simulated crash before commit.',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Nothing committed: verdict and handoff are the same transaction.
    const afterRollback = await taskRow('task-crash');
    expect(afterRollback.status).toBe('in_review');
    expect((await comments('task-crash'))).toHaveLength(0);
    expect((await receipts('task-crash'))).toHaveLength(0);

    // The next attempt starts clean and succeeds.
    const retry = await LifecycleCapabilityModel.settleReviewReject({
      taskId: 'task-crash', actor: 'verifier-routine', summary: 'Simulated crash before commit.',
    });
    expect(retry.settled).toBe(true);
    const afterRetry = await taskRow('task-crash');
    expect(afterRetry.status).toBe('todo');
    expect((await comments('task-crash'))).toHaveLength(1);
  });
});
