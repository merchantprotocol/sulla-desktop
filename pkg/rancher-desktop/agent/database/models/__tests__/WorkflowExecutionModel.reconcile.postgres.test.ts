/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../migrations/0026_create_workflow_executions_table';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as createWorkTaskDispatches } from '../../migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../migrations/0064_add_verification_dispatches';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import { up as scopeLaneWorkflowExecutions } from '../../migrations/0071_scope_lane_workflow_executions';
import { up as extendDispatchCustody } from '../../migrations/0076_extend_work_task_dispatch_custody';
import { up as addWorkflowExecutionLeases } from '../../migrations/0081_add_workflow_execution_leases';
import { WorkflowLeaseHeartbeat } from '../../../workflow/WorkflowLeaseHeartbeat';
import { WorkLaneWorkflowBindingModel } from '../WorkLaneWorkflowBindingModel';
import { DISPATCHER_RECONCILED_LANE_MESSAGE, WorkflowExecutionModel } from '../WorkflowExecutionModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('WorkflowExecutionModel dispatcher reconciliation (migrated PostgreSQL)', () => {
  const schema = `reconcile_${ randomUUID().replaceAll('-', '') }`;
  let bootstrapPool: Pool;
  let pool: Pool;
  const originalTransaction = postgresClient.transaction;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${ schema }` });
    for (const migration of [
      createWorkflows, createWorkflowExecutions, createWorkItems,
      createWorkTaskDispatches, addVerificationDispatches,
      createLaneDefinitions, createLaneWorkflowBindings, scopeLaneWorkflowExecutions,
      extendDispatchCustody, addWorkflowExecutionLeases,
    ]) await pool.query(migration as any);
    await pool.query(`
      INSERT INTO workflows (id, name, status, definition)
      VALUES ('workflow-1', 'Workflow 1', 'production', '{}'::jsonb)`);
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'Reconcile')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'Reconcile')`);
    await pool.query(`INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('t1', 'p1', 'e1', 'Task 1')`);

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
    (postgresClient as any).query = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows[0] ?? null;
  }, 30_000);

  afterAll(async() => {
    (postgresClient as any).transaction = originalTransaction;
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    await pool?.end();
    await bootstrapPool?.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  it('admits exactly one simultaneous singleton and never recovers its expired lease', async() => {
    await pool.query(`INSERT INTO workflows (id, name, status, definition) VALUES ('singleton-workflow', 'Singleton', 'production', '{}'::jsonb)`);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      WorkflowExecutionModel.admitSingleton({ executionId: `singleton-${ index }`, workflowId: 'singleton-workflow', workflowName: 'Singleton', workflowSlug: 'singleton' })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rows = (await pool.query("SELECT * FROM workflow_executions WHERE workflow_id = 'singleton-workflow'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].auto_restart).toBe(false);
    await pool.query("UPDATE workflow_executions SET lease_expires_at = NOW() - INTERVAL '1 minute', attempt_count = max_attempts WHERE execution_id = $1", [rows[0].execution_id]);
    expect(await WorkflowExecutionModel.recover(rows[0].execution_id)).toBeNull();
    expect((await pool.query('SELECT status FROM workflow_executions WHERE execution_id = $1', [rows[0].execution_id])).rows[0].status).toBe('running');
    await WorkflowExecutionModel.admitSingleton({ executionId: 'independent-singleton', workflowId: 'workflow-1', workflowName: 'Independent', workflowSlug: 'independent' });
    await WorkflowExecutionModel.markCompleted('independent-singleton');
    await WorkflowExecutionModel.markSuspended(rows[0].execution_id);
    await expect(WorkflowExecutionModel.admitSingleton({ executionId: 'singleton-replacement', workflowId: 'singleton-workflow', workflowName: 'Singleton', workflowSlug: 'singleton' })).rejects.toThrow('active execution');
    await pool.query("UPDATE workflow_executions SET started_at = NOW() - INTERVAL '1 day', owner_id = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE execution_id = $1", [rows[0].execution_id]);
    expect(await WorkflowExecutionModel.reapStaleLeaselessExecutions()).not.toContain(rows[0].execution_id);
    await WorkflowExecutionModel.markCompleted(rows[0].execution_id);
    await WorkflowExecutionModel.admitSingleton({ executionId: 'singleton-next', workflowId: 'singleton-workflow', workflowName: 'Singleton', workflowSlug: 'singleton' });
  });

  it('keeps a slow node out of recovery and fences it after durable settlement', async() => {
    await WorkflowExecutionModel.markRunning({ executionId: 'slow-node', workflowId: 'workflow-1', workflowName: 'Slow node', workflowSlug: 'slow-node' });
    const token = randomUUID();
    await WorkflowExecutionModel.acquireLease('slow-node', 'slow-worker', 600, token);
    expect(await WorkflowExecutionModel.acquireLease('slow-node', 'slow-worker', 600, randomUUID())).toBeNull();
    expect(await WorkflowExecutionModel.renewHeartbeat('slow-node', 'slow-worker', 'stale-token', 600)).toBeNull();
    let lost = false;
    const heartbeat = new WorkflowLeaseHeartbeat(async() =>
      (await WorkflowExecutionModel.renewHeartbeat('slow-node', 'slow-worker', token, 600)) !== null,
    () => { lost = true; }, 50, 200);
    heartbeat.start();
    try {
      // Run multiple recovery sweeps across more than two original lease lifetimes.
      for (let sweep = 0; sweep < 8; sweep++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(await WorkflowExecutionModel.recover('slow-node', 'recovery-worker')).toBeNull();
      }
      const row = (await pool.query("SELECT status, attempt_count FROM workflow_executions WHERE execution_id = 'slow-node'")).rows[0];
      expect(row).toMatchObject({ status: 'running', attempt_count: 0 });
      await WorkflowExecutionModel.settle('slow-node', 'failed', 'external cancellation');
      await expect(heartbeat.assertOwned()).rejects.toThrow('terminal');
      expect(lost).toBe(true);
      const terminal = (await pool.query("SELECT status, terminal_reason FROM workflow_executions WHERE execution_id = 'slow-node'")).rows[0];
      expect(terminal).toMatchObject({ status: 'failed', terminal_reason: 'external cancellation' });
    } finally {
      heartbeat.stop();
    }
  });

  it('leaves a live lane-automation council alone after its originating dispatch settled terminal', async() => {
    // The MjXr repro: the task's mechanical dispatch settled 'blocked', the
    // blocked-lane council then launched as a task-scoped lane execution with
    // its own live lease and no dispatch row referencing it.
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, finished_at)
      VALUES ('d1', 't1', 'sulla-desktop', 'thread-1', 'blocked', now())`);
    await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, status, scope_task_id, scope_generation, started_at,
         owner_id, lease_token, leased_at, heartbeat_at, lease_expires_at)
      VALUES ('lane-exec-t1-2', 'core-routine-plan-project-task', 'running', 't1', 2, now(),
              'runtime-1', 'token-1', now(), now(), now() + interval '60 seconds')`);
    await pool.query(`
      INSERT INTO work_lane_entry_automations
        (id, task_id, generation, lane_key, resolution_source, status, execution_id, started_at)
      VALUES ('lane-entry-1', 't1', 2, 'blocked', 'core', 'running', 'lane-exec-t1-2', now())`);

    const reconciled = await WorkflowExecutionModel.reconcileDispatcherOwnedExecutions();

    expect(reconciled).toEqual([]);
    const execution = (await pool.query(`
      SELECT status, terminal_reason, lease_token FROM workflow_executions
       WHERE execution_id = 'lane-exec-t1-2'`)).rows[0];
    expect(execution).toMatchObject({ status: 'running', terminal_reason: null, lease_token: 'token-1' });
    const lane = (await pool.query(`
      SELECT status, outcome FROM work_lane_entry_automations WHERE id = 'lane-entry-1'`)).rows[0];
    expect(lane).toMatchObject({ status: 'running', outcome: null });
  });

  it('reaps a dispatch-parented execution once its parent settles, and spares one with a live parent', async() => {
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, kind, workflow_execution_id, finished_at)
      VALUES ('d2', 't1', 'sulla-desktop', 'thread-2', 'failed', 'verification', 'review-exec-dead', now())`);
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, kind, workflow_execution_id)
      VALUES ('d3', 't1', 'sulla-desktop', 'thread-3', 'running', 'verification', 'review-exec-live')`);
    await pool.query(`
      INSERT INTO workflow_executions (execution_id, workflow_id, status, scope_task_id, scope_generation, started_at)
      VALUES ('review-exec-dead', 'review-project-artifact-a', 'running', 't1', 3, now()),
             ('review-exec-live', 'review-project-artifact-b', 'running', 't1', 4, now())`);

    const reconciled = await WorkflowExecutionModel.reconcileDispatcherOwnedExecutions();

    expect(reconciled).toEqual(['review-exec-dead']);
    const dead = (await pool.query(`
      SELECT status, terminal_reason FROM workflow_executions WHERE execution_id = 'review-exec-dead'`)).rows[0];
    expect(dead).toMatchObject({ status: 'failed', terminal_reason: 'dispatcher_parent_terminal_or_missing' });
    const live = (await pool.query(`
      SELECT status, terminal_reason FROM workflow_executions WHERE execution_id = 'review-exec-live'`)).rows[0];
    expect(live).toMatchObject({ status: 'running', terminal_reason: null });
    // The lane council from the previous scenario is still untouched.
    const lane = (await pool.query(`
      SELECT status FROM work_lane_entry_automations WHERE id = 'lane-entry-1'`)).rows[0];
    expect(lane.status).toBe('running');
  });

  it('retries a reconciler-killed lane row only while its lane generation remains current', async() => {
    await pool.query(`UPDATE work_tasks SET status = 'blocked' WHERE id = 't1'`);
    await pool.query(`
      UPDATE work_lane_entry_automations
         SET status = 'failed', completed_at = now(),
             workflow_id = 'workflow-1',
             outcome = jsonb_build_object(
               'disposition', 'runtime_failed',
               'message', $1::text)
       WHERE id = 'lane-entry-1'`, [DISPATCHER_RECONCILED_LANE_MESSAGE]);
    await pool.query(`
      UPDATE workflow_executions SET status = 'failed', completed_at = now()
       WHERE execution_id = 'lane-exec-t1-2'`);

    expect((await WorkLaneWorkflowBindingModel.listRecoverable()).map(row => row.id))
      .toContain('lane-entry-1');
    await expect(WorkLaneWorkflowBindingModel.resetFailed('lane-entry-1'))
      .resolves.toMatchObject({ status: 'pending', execution_id: null, outcome: null });

    await pool.query(`
      INSERT INTO work_lane_entry_automations
        (id, task_id, generation, lane_key, resolution_source, status, workflow_id)
      VALUES ('lane-entry-newer', 't1', 3, 'blocked', 'core', 'pending',
              'workflow-1')`);
    await pool.query(`
      UPDATE work_lane_entry_automations
         SET status = 'failed', completed_at = now(),
             outcome = jsonb_build_object(
               'disposition', 'runtime_failed',
               'message', $1::text)
       WHERE id = 'lane-entry-1'`, [DISPATCHER_RECONCILED_LANE_MESSAGE]);

    expect((await WorkLaneWorkflowBindingModel.listRecoverable()).map(row => row.id))
      .not.toContain('lane-entry-1');
    await expect(WorkLaneWorkflowBindingModel.resetFailed('lane-entry-1')).resolves.toBeNull();
  });
});
